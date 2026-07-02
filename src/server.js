import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import SimpleInvoiceService from './simpleInvoiceService.js';
import InvoiceDatabase from './invoiceDatabase.js';
import WarehouseDatabase from './warehouseDatabase.js';
import ClientsDatabase from './clientsDatabase.js';
import ExpenseCategories from './expenseCategories.js';
import whatsappManager from './whatsappManager.js';
import invoiceCounter from './invoiceCounter.js';
import AutoSendScheduler from './autoSendScheduler.js';
import PaymentReminderService from './paymentReminderService.js';
import InvoiceTelegramBot from './telegramBot.js';
import RecurringPaymentsDatabase from './recurringPaymentsDatabase.js';
import { authMiddleware, loginHandler, verifyHandler, logoutHandler, rateLimitMiddleware } from './authMiddleware.js';
import authDatabase from './authDatabase.js';
import { validate, validateInvoice, validateClient, validateProduct } from './validators.js';
import fs from 'fs';
import multer from 'multer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Загружаем переменные окружения в зависимости от NODE_ENV
const nodeEnv = process.env.NODE_ENV || 'development';
const envFile = nodeEnv === 'production' ? '.env.production' : '.env.development';
const envPath = path.join(__dirname, '..', envFile);

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
  console.log(`📋 Загружена конфигурация: ${envFile}`);
  console.log(`🌍 Окружение: ${nodeEnv}`);
  console.log(`🧪 Тестовый режим WhatsApp: ${process.env.WHATSAPP_TEST_MODE === 'true' ? 'ВКЛ' : 'ВЫКЛ'}`);
} else {
  console.warn(`⚠️  Файл ${envFile} не найден, используются переменные окружения системы`);
  dotenv.config(); // Fallback на .env
}

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Создаем папку для хранения фото товаров
const uploadsDir = path.join(__dirname, '../uploads/products');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Создаем папку для скриншотов
const screenshotsDir = path.join(__dirname, '../screenshots');
if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

// Раздаем статические файлы из папки uploads
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Раздаем скриншоты (без авторизации для удобства загрузки)
app.use('/screenshots', express.static(path.join(__dirname, '../screenshots')));

// Настройка multer для загрузки фото
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    // Генерируем уникальное имя файла: timestamp-randomstring.ext
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, 'product-' + uniqueSuffix + ext);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // Максимум 5MB
  },
  fileFilter: function (req, file, cb) {
    // Проверяем тип файла
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Разрешены только изображения (JPEG, PNG, GIF, WebP)'));
    }
  }
});

// Настройка multer для загрузки скриншотов
const screenshotStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, screenshotsDir);
  },
  filename: function (req, file, cb) {
    // Сохраняем оригинальное имя файла
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, originalName);
  }
});

const uploadScreenshot = multer({
  storage: screenshotStorage,
  limits: {
    fileSize: 10 * 1024 * 1024 // Максимум 10MB для скриншотов
  },
  fileFilter: function (req, file, cb) {
    const allowedTypes = /jpeg|jpg|png|gif|webp|bmp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Разрешены только изображения'));
    }
  }
});

// Добавляем middleware авторизации ДО всех остальных маршрутов
app.use(authMiddleware);

// API endpoints для авторизации с защитой от брутфорса
app.post('/api/auth/login', rateLimitMiddleware, loginHandler);
app.get('/api/auth/verify', verifyHandler);
app.post('/api/auth/logout', logoutHandler);

// API endpoints для управления учетными данными
app.get('/api/auth/current-user', (req, res) => {
  try {
    const username = authDatabase.getUsername();
    res.json({ username });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/change-credentials', (req, res) => {
  try {
    const { currentPassword, newUsername, newPassword } = req.body;

    if (!currentPassword || !newUsername || !newPassword) {
      return res.status(400).json({
        error: 'Все поля обязательны для заполнения'
      });
    }

    const result = authDatabase.changeCredentials(currentPassword, newUsername, newPassword);
    res.json({
      success: true,
      message: 'Учетные данные успешно изменены',
      ...result
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Создаем сервис генерации счетов
const invoiceService = new SimpleInvoiceService({
  localOutputFolder: path.join(__dirname, '../output'),
  autoUpload: false // Отключаем автозагрузку по умолчанию, будем управлять вручную
});

// Создаем базы данных
const db = new InvoiceDatabase();
invoiceCounter.setDatabase(db); // счётчик номеров сверяется с базой, чтобы не выдавать занятые номера
const warehouseDb = new WarehouseDatabase();
const clientsDb = new ClientsDatabase();
const categoriesDb = new ExpenseCategories();
const recurringPaymentsDb = new RecurringPaymentsDatabase();

// Создаем планировщик автоматической рассылки
let autoSendScheduler = null;

// Создаем сервис напоминаний об оплате
let paymentReminderService = null;
let recurringReminder = null;

// Создаем Telegram бота
let telegramBot = null;

// Функция для очистки имени файла
function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '') // Удаляем недопустимые символы
    .replace(/\s+/g, '_') // Заменяем пробелы на подчеркивания
    .replace(/[«»""]/g, '') // Удаляем кавычки
    .slice(0, 50); // Ограничиваем длину
}

// API endpoint для создания счета
app.post('/api/invoice', async (req, res) => {
  try {
    const { invoiceNumber, invoiceDate, clientName, clientPhone, isRecurring, paymentDeadlineDay, items, discount, payment, uploadToYandex, getPublicLink } = req.body;

    // Валидация данных
    if (!invoiceNumber || !clientName || !items || !items.length || !payment) {
      return res.status(400).json({ error: 'Не все обязательные поля заполнены' });
    }

    // Проверка на дублирование номера счета
    const existingInvoice = db.getInvoiceByNumber(invoiceNumber);
    if (existingInvoice) {
      console.warn(`⚠️  Попытка создания дублирующего счета №${invoiceNumber}. Существующий счет: клиент "${existingInvoice.client}", дата "${existingInvoice.invoiceDate}"`);
      return res.status(400).json({
        error: `Счет с номером ${invoiceNumber} уже существует`,
        details: {
          existingClient: existingInvoice.client,
          existingDate: existingInvoice.invoiceDate,
          existingAmount: existingInvoice.amount
        }
      });
    }

    // Подготавливаем данные счета
    const invoiceData = {
      invoiceNumber,
      invoiceDate: invoiceDate || new Date().toISOString(),
      clientName,
      isRecurring: isRecurring || false,
      items: items.map(item => ({
        name: item.name,
        unit: item.unit,
        quantity: item.quantity,
        price: item.price,
        cost: item.cost || 0,
        amount: item.quantity * item.price
      })),
      payment
    };

    // Добавляем скидку, если есть
    if (discount && discount.type && discount.value) {
      invoiceData.discount = discount;
    }

    // Вычисляем общую сумму
    let totalAmount = invoiceData.items.reduce((sum, item) => sum + item.amount, 0);
    if (invoiceData.discount) {
      if (invoiceData.discount.type === 'percent') {
        totalAmount -= totalAmount * (invoiceData.discount.value / 100);
      } else if (invoiceData.discount.type === 'fixed') {
        totalAmount -= invoiceData.discount.value;
      }
    }

    // Генерируем имя файла на основе названия клиента и даты счета
    const clientNameClean = sanitizeFilename(clientName);
    const dateStr = invoiceData.invoiceDate.split('T')[0]; // YYYY-MM-DD из даты счета
    const filename = `Счет_${invoiceNumber}_${clientNameClean}_${dateStr}.pdf`;

    let yandexPath = null;
    let publicUrl = null;
    let uploadError = null;

    // Если нужно загрузить на Яндекс.Диск и токен есть
    if (uploadToYandex && invoiceService.isYandexDiskConfigured()) {
      const localPath = path.join(__dirname, '../output', filename);
      const remotePath = `${process.env.YANDEX_DISK_FOLDER || '/Счета'}/${filename}`;

      try {
        const result = await invoiceService.generator.generateAndUploadToYandexDisk(
          invoiceData,
          localPath,
          process.env.YANDEX_DISK_TOKEN,
          remotePath,
          {
            createFolder: true,
            publish: getPublicLink,
            deleteLocal: false
          }
        );

        yandexPath = result.remotePath;
        publicUrl = result.publicUrl;
      } catch (yandexError) {
        // Если загрузка на Яндекс.Диск не удалась, сохраняем локально
        console.error('⚠️  Ошибка загрузки на Яндекс.Диск:', yandexError.message);
        uploadError = yandexError.message;
        await invoiceService.createInvoice(invoiceData, filename);
      }
    } else {
      // Только локальное сохранение
      await invoiceService.createInvoice(invoiceData, filename);
    }

    // Сохраняем в базу данных
    const savedInvoice = db.addInvoice({
      invoiceNumber,
      invoiceDate: invoiceData.invoiceDate,
      filename,
      amount: totalAmount,
      items: invoiceData.items,
      discount: invoiceData.discount,
      client: clientName,
      clientPhone: clientPhone || '',
      isRecurring: isRecurring || false,
      paymentDeadlineDay: paymentDeadlineDay ? parseInt(paymentDeadlineDay) : null,
      payment: invoiceData.payment,
      yandexPath,
      publicUrl
    });

    // Номер берётся из peekNextNumber() (макс. номер в базе + 1) — отдельный инкремент больше не нужен

    // Автоматически создаем расходы для товаров с себестоимостью
    const itemsWithCost = invoiceData.items.filter(item => item.cost && item.cost > 0);
    if (itemsWithCost.length > 0) {
      const expenseDate = new Date().toISOString().split('T')[0]; // Текущая дата
      itemsWithCost.forEach(item => {
        const totalCost = item.cost * item.quantity;
        const expense = {
          date: expenseDate,
          category: 'Себестоимость товара',
          description: `${item.name} (${item.quantity} ${item.unit}) - Счет №${invoiceNumber}`,
          amount: totalCost
        };
        db.addExpense(savedInvoice.id, expense);
        console.log(`✅ Автоматически создан расход: ${expense.description} - ${totalCost} ₽`);
      });
    }

    res.json({
      success: true,
      filename: filename,
      localPath: path.join(__dirname, '../output', filename),
      yandexPath,
      publicUrl,
      invoiceId: savedInvoice.id,
      warning: uploadError ? `Счет сохранен локально. ${uploadError}` : null
    });

  } catch (error) {
    console.error('Ошибка создания счета:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint для просмотра PDF (без скачивания)
app.get('/view/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, '../output', filename);

  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'application/pdf');
    // Правильное экранирование имени файла для заголовка
    const safeFilename = encodeURIComponent(filename).replace(/[()]/g, escape);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${safeFilename}`);
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.status(404).json({ error: 'Файл не найден' });
  }
});

// Endpoint для скачивания PDF
app.get('/download/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, '../output', filename);

  if (fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    res.status(404).json({ error: 'Файл не найден' });
  }
});

// Endpoint для получения статуса Яндекс.Диска
app.get('/api/status', async (req, res) => {
  try {
    const yandexConfigured = invoiceService.isYandexDiskConfigured();

    if (yandexConfigured) {
      const diskInfo = await invoiceService.getDiskInfo();
      const usedGB = (diskInfo.used_space / 1024 / 1024 / 1024).toFixed(2);
      const totalGB = (diskInfo.total_space / 1024 / 1024 / 1024).toFixed(2);

      res.json({
        yandexConfigured: true,
        diskInfo: {
          usedGB,
          totalGB,
          freeGB: (totalGB - usedGB).toFixed(2)
        }
      });
    } else {
      res.json({
        yandexConfigured: false,
        message: 'Яндекс.Диск не настроен. Запустите: npm run setup'
      });
    }
  } catch (error) {
    res.json({
      yandexConfigured: false,
      error: error.message
    });
  }
});

// Endpoint для списка счетов
app.get('/api/invoices', async (req, res) => {
  try {
    const outputDir = path.join(__dirname, '../output');

    // Получаем локальные файлы
    const localFiles = fs.existsSync(outputDir)
      ? fs.readdirSync(outputDir)
          .filter(f => f.endsWith('.pdf'))
          .map(f => {
            const stat = fs.statSync(path.join(outputDir, f));
            return {
              name: f,
              size: stat.size,
              created: stat.birthtime,
              local: true
            };
          })
      : [];

    // Пытаемся получить файлы с Яндекс.Диска
    let yandexFiles = [];
    if (invoiceService.isYandexDiskConfigured()) {
      try {
        yandexFiles = await invoiceService.listInvoices();
        yandexFiles = yandexFiles.map(f => ({
          name: f.name,
          size: f.size,
          created: f.created,
          local: false
        }));
      } catch (error) {
        console.error('Ошибка получения файлов с Яндекс.Диска:', error.message);
      }
    }

    res.json({
      local: localFiles,
      yandex: yandexFiles
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Новые API endpoints для управления счетами

// Получить список всех счетов с статистикой
app.get('/api/invoices/list', (req, res) => {
  try {
    const invoices = db.getAllInvoices();
    const statistics = db.getStatistics();

    res.json({
      invoices,
      statistics
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Получить счет по ID
app.get('/api/invoices/:id', (req, res) => {
  try {
    const { id } = req.params;
    const invoice = db.getInvoiceById(id);

    if (invoice) {
      res.json({ success: true, invoice });
    } else {
      res.status(404).json({ error: 'Счет не найден' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Получить оплаченные счета для аналитики
app.get('/api/invoices/paid/list', (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const allInvoices = db.getAllInvoices();

    // Фильтруем оплаченные и частично оплаченные счета
    let paidInvoices = allInvoices.filter(invoice => {
      // Включаем полностью оплаченные или частично оплаченные счета
      return invoice.paid || (invoice.paidAmount && invoice.paidAmount > 0);
    });

    // Фильтруем по датам если указаны (используем дату оплаты - paidAt или updatedAt, а не дату создания)
    if (startDate || endDate) {
      paidInvoices = paidInvoices.filter(invoice => {
        // Используем дату оплаты для фильтрации (когда деньги пришли в кассу)
        const paymentDate = new Date(invoice.paidAt || invoice.updatedAt || invoice.createdAt);

        // Убираем время, сравниваем только даты
        paymentDate.setHours(0, 0, 0, 0);

        const start = startDate ? new Date(startDate) : null;
        const end = endDate ? new Date(endDate) : null;

        if (start) {
          start.setHours(0, 0, 0, 0);
          if (paymentDate < start) return false;
        }

        if (end) {
          end.setHours(23, 59, 59, 999);
          if (paymentDate > end) return false;
        }

        return true;
      });
    }

    // Вычисляем общую сумму прихода (учитываем частичную оплату)
    const totalIncome = paidInvoices.reduce((sum, invoice) => {
      // Используем paidAmount если он есть, иначе полную сумму
      const income = invoice.paidAmount || invoice.amount;
      return sum + income;
    }, 0);

    // Вычисляем общую сумму расходов по всем оплаченным счетам
    const totalExpenses = paidInvoices.reduce((sum, invoice) => {
      const invoiceExpenses = (invoice.expenses || []).reduce((expSum, expense) => expSum + expense.amount, 0);
      return sum + invoiceExpenses;
    }, 0);

    res.json({
      invoices: paidInvoices,
      totalIncome,
      totalExpenses,
      totalProfit: totalIncome - totalExpenses,
      count: paidInvoices.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Обновить счет
app.put('/api/invoices/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { invoiceNumber, invoiceDate, clientName, clientPhone, isRecurring, paymentDeadlineDay, items, discount, payment } = req.body;

    // Получаем существующий счет
    const existingInvoice = db.getInvoiceById(id);
    if (!existingInvoice) {
      return res.status(404).json({ error: 'Счет не найден' });
    }

    // Если номер счета изменился, проверяем на дублирование
    if (invoiceNumber !== existingInvoice.invoiceNumber) {
      const duplicateInvoice = db.getInvoiceByNumber(invoiceNumber);
      if (duplicateInvoice) {
        console.warn(`⚠️  Попытка изменить номер счета на существующий №${invoiceNumber}`);
        return res.status(400).json({
          error: `Счет с номером ${invoiceNumber} уже существует`,
          details: {
            existingClient: duplicateInvoice.client,
            existingDate: duplicateInvoice.invoiceDate
          }
        });
      }
    }

    // Подготавливаем данные счета
    const invoiceData = {
      invoiceNumber,
      invoiceDate: invoiceDate || existingInvoice.invoiceDate || new Date().toISOString(),
      clientName,
      isRecurring: isRecurring || false,
      items: items.map(item => ({
        name: item.name,
        unit: item.unit,
        quantity: item.quantity,
        price: item.price,
        cost: item.cost || 0,
        amount: item.quantity * item.price
      })),
      payment
    };

    // Добавляем скидку, если есть
    if (discount && discount.type && discount.value) {
      invoiceData.discount = discount;
    }

    // Вычисляем общую сумму
    let totalAmount = invoiceData.items.reduce((sum, item) => sum + item.amount, 0);
    if (invoiceData.discount) {
      if (invoiceData.discount.type === 'percent') {
        totalAmount -= totalAmount * (invoiceData.discount.value / 100);
      } else if (invoiceData.discount.type === 'fixed') {
        totalAmount -= invoiceData.discount.value;
      }
    }

    // Генерируем новое имя файла на основе даты счета
    const clientNameClean = sanitizeFilename(clientName);
    const dateStr = invoiceData.invoiceDate.split('T')[0]; // YYYY-MM-DD из даты счета
    const filename = `Счет_${invoiceNumber}_${clientNameClean}_${dateStr}.pdf`;

    // Удаляем старый PDF файл
    const oldFilePath = path.join(__dirname, '../output', existingInvoice.filename);
    if (fs.existsSync(oldFilePath)) {
      fs.unlinkSync(oldFilePath);
    }

    // Генерируем новый PDF
    await invoiceService.createInvoice(invoiceData, filename);

    // Если invoiceDate изменился и авторассылка включена — обновляем nextSendDate
    const updateData = {
      invoiceNumber,
      invoiceDate: invoiceData.invoiceDate,
      filename,
      amount: totalAmount,
      items: invoiceData.items,
      discount: invoiceData.discount,
      client: clientName,
      clientPhone: clientPhone || '',
      isRecurring: isRecurring || false,
      payment: invoiceData.payment
    };

    // Синхронизируем nextSendDate с invoiceDate при редактировании
    if (existingInvoice.autoSendEnabled && invoiceData.invoiceDate !== existingInvoice.invoiceDate) {
      updateData.nextSendDate = invoiceData.invoiceDate;
      updateData.createdAt = invoiceData.invoiceDate;
      console.log(`[UpdateInvoice] Счет №${invoiceNumber}: nextSendDate обновлен на ${invoiceData.invoiceDate}`);
    }

    // Обновляем данные в базе
    const updatedInvoice = db.updateInvoice(id, updateData);

    res.json({
      success: true,
      invoice: updatedInvoice,
      filename: filename
    });

  } catch (error) {
    console.error('Ошибка обновления счета:', error);
    res.status(500).json({ error: error.message });
  }
});

// Обновить статус оплаты
app.put('/api/invoices/:id/payment', async (req, res) => {
  try {
    const { id } = req.params;
    const { paid } = req.body;

    // Сначала получаем текущий счет ДО обновления
    const oldInvoice = db.getInvoiceById(id);
    if (!oldInvoice) {
      return res.status(404).json({ error: 'Счет не найден' });
    }

    // Запоминаем старый статус
    const wasUnpaid = !oldInvoice.paid;

    // Обновляем статус
    const invoice = db.updatePaymentStatus(id, paid);

    // Отключаем напоминания при полной оплате
    if (paid) {
      db.updateInvoice(id, { reminderEnabled: false });
    }

    if (!invoice) {
      return res.status(404).json({ error: 'Счет не найден' });
    }

    // Если счет отмечен как оплаченный И включен абонемент - автоматически создаем новый на следующий месяц
    if (paid && wasUnpaid && invoice.isRecurring) {  // Изменение статуса с неоплачен на оплачен + абонемент включен
      try {
        console.log(`[AutoDuplicate] Счет №${invoice.invoiceNumber} оплачен (абонемент), создаем новый счет на следующий месяц...`);

        // Получаем новый номер счета
        const newInvoiceNumber = invoiceCounter.getNextInvoiceNumber();

        // Подготавливаем данные для нового счета
        const invoiceData = {
          invoiceNumber: newInvoiceNumber,
          clientName: invoice.client,
          isRecurring: invoice.isRecurring || false,
          paymentDeadlineDay: invoice.paymentDeadlineDay || null,
          items: invoice.items,
          payment: invoice.payment
        };

        // Добавляем скидку, если была
        if (invoice.discount) {
          invoiceData.discount = invoice.discount;
        }

        // Вычисляем сумму
        let totalAmount = invoiceData.items.reduce((sum, item) => sum + item.amount, 0);
        if (invoiceData.discount) {
          if (invoiceData.discount.type === 'percent') {
            totalAmount -= totalAmount * (invoiceData.discount.value / 100);
          } else if (invoiceData.discount.type === 'fixed') {
            totalAmount -= invoiceData.discount.value;
          }
        }

        // Вычисляем даты для нового счета
        // Дата нового счета = invoiceDate оплаченного + 1 месяц (сохраняем число месяца)
        // Например: счет от 01.03 -> новый на 01.04, счет от 14.03 -> новый на 14.04
        const { addMonth } = await import('./dateUtils.js');
        const baseDate = invoice.invoiceDate
          ? new Date(invoice.invoiceDate)
          : invoice.createdAt
            ? new Date(invoice.createdAt)
            : new Date();
        const nextMonthDate = addMonth(baseDate); // Дата нового счета (invoiceDate + 1 месяц)
        const nextSendDate = new Date(nextMonthDate); // Отправлять в дату нового счета

        // Подготавливаем данные для генерации PDF с правильной датой счета
        invoiceData.invoiceDate = nextMonthDate.toISOString();

        // Генерируем имя файла с датой следующего месяца
        const clientNameClean = sanitizeFilename(invoice.client);
        const dateStr = nextMonthDate.toISOString().split('T')[0];
        const filename = `Счет_${newInvoiceNumber}_${clientNameClean}_${dateStr}.pdf`;

        // Генерируем PDF
        await invoiceService.createInvoice(invoiceData, filename);

        // Сохраняем в базу данных с включенной авторассылкой
        const newInvoice = db.addInvoice({
          invoiceNumber: newInvoiceNumber,
          filename,
          amount: totalAmount,
          items: invoiceData.items,
          discount: invoiceData.discount,
          client: invoice.client,
          clientPhone: invoice.clientPhone || '',
          isRecurring: invoice.isRecurring || false,
          paymentDeadlineDay: invoice.paymentDeadlineDay || null,
          payment: invoiceData.payment,
          invoiceDate: nextMonthDate.toISOString(),
          yandexPath: null,
          publicUrl: null,
          autoSendEnabled: true,  // Включаем авторассылку
          nextSendDate: nextSendDate.toISOString(),  // Устанавливаем дату на следующий месяц
          createdAt: nextMonthDate.toISOString()  // Устанавливаем дату создания на следующий месяц
        });

        // ВАЖНО: Отключаем авторассылку у оплаченного счета, чтобы не было дублирования
        if (invoice.autoSendEnabled) {
          db.setAutoSend(invoice.id, false, null);
          console.log(`[AutoDuplicate] Авторассылка отключена для оплаченного счета №${invoice.invoiceNumber}`);
        }

        console.log(`[AutoDuplicate] ✅ Создан новый счет №${newInvoiceNumber} с авторассылкой на ${nextSendDate.toLocaleDateString('ru-RU')}`);

        res.json({
          success: true,
          invoice: db.getInvoiceById(invoice.id),  // Возвращаем обновленный счет
          newInvoice,  // Возвращаем информацию о созданном счете
          message: `Счет оплачен! Автоматически создан новый счет №${newInvoiceNumber} на следующий месяц`
        });
      } catch (duplicateError) {
        console.error('[AutoDuplicate] Ошибка автоматического дублирования:', duplicateError);
        // Не прерываем операцию, просто возвращаем обычный ответ
        res.json({ success: true, invoice, error: 'Счет оплачен, но не удалось создать новый автоматически' });
      }
    } else {
      res.json({ success: true, invoice });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Обновить частичную оплату
app.put('/api/invoices/:id/partial-payment', async (req, res) => {
  try {
    const { id } = req.params;
    const { paidAmount } = req.body;

    const invoice = db.getInvoiceById(id);
    if (!invoice) {
      return res.status(404).json({ error: 'Счет не найден' });
    }

    // Запоминаем был ли счет неоплачен до обновления
    const wasUnpaid = !invoice.paid && (invoice.paidAmount || 0) < invoice.amount;
    const willBeFullyPaid = paidAmount >= invoice.amount;

    // Обновляем сумму частичной оплаты
    const updatedInvoice = db.updateInvoice(id, {
      paidAmount: paidAmount,
      // Если оплачена полная сумма или больше - помечаем как оплаченный
      paid: willBeFullyPaid,
      // Устанавливаем дату оплаты для корректной работы аналитики
      paidAt: new Date().toISOString(),
      // Отключаем напоминания при полной оплате
      reminderEnabled: willBeFullyPaid ? false : invoice.reminderEnabled
    });

    console.log(`[PartialPayment] Счет №${invoice.invoiceNumber}: оплачено ${paidAmount} ₽ из ${invoice.amount} ₽`);

    // Если счет полностью оплачен И включен абонемент - автоматически создаем новый на следующий месяц
    let newInvoice = null;
    if (willBeFullyPaid && wasUnpaid && invoice.isRecurring) {
      try {
        console.log(`[PartialPayment] Счет №${invoice.invoiceNumber} полностью оплачен (абонемент), создаем новый счет на следующий месяц...`);

        // Получаем новый номер счета
        const newInvoiceNumber = invoiceCounter.getNextInvoiceNumber();

        // Подготавливаем данные для нового счета
        const invoiceData = {
          invoiceNumber: newInvoiceNumber,
          clientName: invoice.client,
          isRecurring: invoice.isRecurring || false,
          paymentDeadlineDay: invoice.paymentDeadlineDay || null,
          items: invoice.items,
          payment: invoice.payment
        };

        // Добавляем скидку, если была
        if (invoice.discount) {
          invoiceData.discount = invoice.discount;
        }

        // Вычисляем сумму
        let totalAmount = invoiceData.items.reduce((sum, item) => sum + item.amount, 0);
        if (invoiceData.discount) {
          if (invoiceData.discount.type === 'percent') {
            totalAmount -= totalAmount * (invoiceData.discount.value / 100);
          } else if (invoiceData.discount.type === 'fixed') {
            totalAmount -= invoiceData.discount.value;
          }
        }

        // Вычисляем даты для нового счета
        // Дата нового счета = invoiceDate оплаченного + 1 месяц (сохраняем число месяца)
        const { addMonth } = await import('./dateUtils.js');
        const baseDate = invoice.invoiceDate
          ? new Date(invoice.invoiceDate)
          : invoice.createdAt
            ? new Date(invoice.createdAt)
            : new Date();
        const nextMonthDate = addMonth(baseDate); // Дата нового счета
        const nextSendDate = new Date(nextMonthDate); // Отправлять в дату нового счета

        // Генерируем имя файла с датой следующего месяца
        const clientNameClean = sanitizeFilename(invoice.client);
        const dateStr = nextMonthDate.toISOString().split('T')[0];
        const filename = `Счет_${newInvoiceNumber}_${clientNameClean}_${dateStr}.pdf`;

        // Генерируем PDF
        await invoiceService.createInvoice(invoiceData, filename);

        // Сохраняем в базу данных с включенной авторассылкой
        newInvoice = db.addInvoice({
          invoiceNumber: newInvoiceNumber,
          filename,
          amount: totalAmount,
          items: invoiceData.items,
          discount: invoiceData.discount,
          client: invoice.client,
          clientPhone: invoice.clientPhone || '',
          isRecurring: invoice.isRecurring || false,
          paymentDeadlineDay: invoice.paymentDeadlineDay || null,
          payment: invoiceData.payment,
          invoiceDate: nextMonthDate.toISOString(),
          yandexPath: null,
          publicUrl: null,
          autoSendEnabled: true,  // Включаем авторассылку
          nextSendDate: nextSendDate.toISOString(),  // Устанавливаем дату на следующий месяц
          createdAt: nextMonthDate.toISOString()  // Устанавливаем дату создания на следующий месяц
        });

        // ВАЖНО: Отключаем авторассылку у оплаченного счета, чтобы не было дублирования
        if (invoice.autoSendEnabled) {
          db.setAutoSend(invoice.id, false, null);
          console.log(`[PartialPayment] Авторассылка отключена для оплаченного счета №${invoice.invoiceNumber}`);
        }

        console.log(`[PartialPayment] ✅ Создан новый счет №${newInvoiceNumber} с авторассылкой на ${nextSendDate.toLocaleDateString('ru-RU')}`);
      } catch (error) {
        console.error(`[PartialPayment] Ошибка создания нового счета:`, error);
        // Продолжаем выполнение, даже если не удалось создать новый счет
      }
    }

    if (newInvoice) {
      res.json({
        success: true,
        invoice: updatedInvoice,
        newInvoice,
        message: `Счет оплачен! Автоматически создан новый счет №${newInvoice.invoiceNumber} на следующий месяц`
      });
    } else {
      res.json(updatedInvoice);
    }
  } catch (error) {
    console.error('Ошибка обновления частичной оплаты:', error);
    res.status(500).json({ error: error.message });
  }
});

// Удалить счет
app.delete('/api/invoices/:id', (req, res) => {
  try {
    const { id } = req.params;
    const invoice = db.deleteInvoice(id);

    if (invoice) {
      // Удаляем PDF файл
      const filePath = path.join(__dirname, '../output', invoice.filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      res.json({ success: true, message: 'Счет удален' });
    } else {
      res.status(404).json({ error: 'Счет не найден' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API для работы с расходами

// Добавить расход к счету
app.post('/api/invoices/:id/expenses', (req, res) => {
  try {
    const { id } = req.params;
    const { date, amount, description, category } = req.body;

    if (!amount) {
      return res.status(400).json({ error: 'Сумма расхода обязательна' });
    }

    const expense = db.addExpense(id, {
      date,
      amount: parseFloat(amount),
      description,
      category
    });

    if (expense) {
      res.json({ success: true, expense });
    } else {
      res.status(404).json({ error: 'Счет не найден' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Получить все расходы по счету
app.get('/api/invoices/:id/expenses', (req, res) => {
  try {
    const { id } = req.params;
    const expenses = db.getExpenses(id);
    const totalExpenses = db.getTotalExpenses(id);

    res.json({
      expenses,
      totalExpenses
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Удалить расход
app.delete('/api/invoices/:invoiceId/expenses/:expenseId', (req, res) => {
  try {
    const { invoiceId, expenseId } = req.params;
    const expense = db.deleteExpense(invoiceId, expenseId);

    if (expense) {
      res.json({ success: true, message: 'Расход удален' });
    } else {
      res.status(404).json({ error: 'Расход не найден' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============= API ENDPOINTS ДЛЯ КАТЕГОРИЙ РАСХОДОВ =============

// Получить все категории
app.get('/api/expense-categories', (req, res) => {
  try {
    const categories = categoriesDb.getAllCategories();
    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Добавить новую категорию
app.post('/api/expense-categories', (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Название категории обязательно' });
    }

    const category = categoriesDb.addCategory({ name, description });
    res.json({ success: true, category });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Обновить категорию
app.put('/api/expense-categories/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;

    const category = categoriesDb.updateCategory(id, { name, description });
    res.json({ success: true, category });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Удалить категорию
app.delete('/api/expense-categories/:id', (req, res) => {
  try {
    const { id } = req.params;
    const category = categoriesDb.deleteCategory(id);
    res.json({ success: true, message: 'Категория удалена', category });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ============= API: Регулярные платежи =============

// Получить все регулярные платежи
app.get('/api/recurring-payments', (req, res) => {
  try {
    const payments = recurringPaymentsDb.getAllPayments();
    res.json({ payments });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Добавить регулярный платеж
app.post('/api/recurring-payments', (req, res) => {
  try {
    const payment = recurringPaymentsDb.addPayment(req.body);
    res.json({ success: true, payment });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Обновить регулярный платеж
app.put('/api/recurring-payments/:id', (req, res) => {
  try {
    const payment = recurringPaymentsDb.updatePayment(req.params.id, req.body);
    res.json({ success: true, payment });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Удалить регулярный платеж
app.delete('/api/recurring-payments/:id', (req, res) => {
  try {
    const payment = recurringPaymentsDb.deletePayment(req.params.id);
    res.json({ success: true, message: 'Платеж удален', payment });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Статус платежей за месяц (текущий или указанный)
app.get('/api/recurring-payments/status/:month?', (req, res) => {
  try {
    const month = req.params.month || null;
    const status = recurringPaymentsDb.getMonthStatus(month);
    const currentMonth = recurringPaymentsDb.getCurrentMonth();
    res.json({ month: month || currentMonth, payments: status });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Отметить платеж как оплаченный
app.post('/api/recurring-payments/:id/pay', (req, res) => {
  try {
    const entry = recurringPaymentsDb.markAsPaid(req.params.id, req.body.via || 'web');
    res.json({ success: true, entry });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Снять отметку оплаты
app.post('/api/recurring-payments/:id/unpay', (req, res) => {
  try {
    const removed = recurringPaymentsDb.markAsUnpaid(req.params.id);
    if (removed) {
      res.json({ success: true, message: 'Отметка оплаты снята' });
    } else {
      res.status(404).json({ error: 'Запись оплаты не найдена за текущий месяц' });
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Настройки напоминаний
app.get('/api/recurring-payments/settings', (req, res) => {
  try {
    const settings = recurringPaymentsDb.getSettings();
    res.json({ settings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/recurring-payments/settings', (req, res) => {
  try {
    const settings = recurringPaymentsDb.updateSettings(req.body);
    res.json({ success: true, settings });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Тестовая отправка напоминания о регулярных платежах
app.post('/api/recurring-payments/test-remind', async (req, res) => {
  try {
    if (!recurringReminder) {
      return res.status(400).json({ error: 'Сервис напоминаний не инициализирован' });
    }
    const result = await recurringReminder.sendTestReminder();
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Дублировать счет (создать новый с тем же содержанием, но новым номером)
app.post('/api/invoices/:id/duplicate', async (req, res) => {
  try {
    const { id } = req.params;
    // Опциональные параметры из формы: своя дата нового счёта и настройки авторассылки
    const { invoiceDate: customDate, autoSendEnabled, nextSendDate } = req.body || {};

    // Получаем оригинальный счет
    const originalInvoice = db.getInvoiceById(id);
    if (!originalInvoice) {
      return res.status(404).json({ error: 'Счет не найден' });
    }

    // Получаем новый номер счета
    const newInvoiceNumber = invoiceCounter.getNextInvoiceNumber();

    // Проверка на дублирование номера счета (на всякий случай)
    const duplicateCheck = db.getInvoiceByNumber(newInvoiceNumber);
    if (duplicateCheck) {
      console.error(`❌ КРИТИЧЕСКАЯ ОШИБКА: Счетчик сгенерировал существующий номер ${newInvoiceNumber}`);
      return res.status(500).json({
        error: `Ошибка генерации номера счета. Номер ${newInvoiceNumber} уже используется.`,
        suggestion: 'Проверьте счетчик счетов в настройках'
      });
    }

    // Подготавливаем данные для нового счета
    const invoiceData = {
      invoiceNumber: newInvoiceNumber,
      clientName: originalInvoice.client,
      isRecurring: originalInvoice.isRecurring || false,
      items: originalInvoice.items,
      payment: originalInvoice.payment
    };

    // Добавляем скидку, если была
    if (originalInvoice.discount) {
      invoiceData.discount = originalInvoice.discount;
    }

    // Вычисляем сумму
    let totalAmount = invoiceData.items.reduce((sum, item) => sum + item.amount, 0);
    if (invoiceData.discount) {
      if (invoiceData.discount.type === 'percent') {
        totalAmount -= totalAmount * (invoiceData.discount.value / 100);
      } else if (invoiceData.discount.type === 'fixed') {
        totalAmount -= invoiceData.discount.value;
      }
    }

    // Дата нового счёта: либо указанная в форме, либо следующий месяц от оригинала
    let newInvoiceDate;
    if (customDate) {
      // Принимаем YYYY-MM-DD или ISO — приводим к YYYY-MM-DD
      newInvoiceDate = String(customDate).split('T')[0];
    } else if (originalInvoice.invoiceDate) {
      const originalDate = new Date(originalInvoice.invoiceDate);
      newInvoiceDate = new Date(originalDate);
      newInvoiceDate.setMonth(newInvoiceDate.getMonth() + 1);
      newInvoiceDate = newInvoiceDate.toISOString().split('T')[0];
    } else {
      newInvoiceDate = new Date().toISOString().split('T')[0];
    }

    // Генерируем имя файла
    const clientNameClean = sanitizeFilename(originalInvoice.client);
    const filename = `Счет_${newInvoiceNumber}_${clientNameClean}_${newInvoiceDate}.pdf`;

    // Добавляем дату счета в данные для генерации PDF
    invoiceData.invoiceDate = newInvoiceDate;

    // Генерируем PDF
    await invoiceService.createInvoice(invoiceData, filename);

    // Дата следующей авторассылки: указанная в форме, иначе = дата нового счёта (10:00)
    let resolvedNextSendDate = null;
    if (autoSendEnabled) {
      if (nextSendDate) {
        resolvedNextSendDate = new Date(nextSendDate).toISOString();
      } else {
        const dt = new Date(newInvoiceDate);
        dt.setHours(10, 0, 0, 0);
        resolvedNextSendDate = dt.toISOString();
      }
    }

    // Сохраняем в базу данных
    const newInvoice = db.addInvoice({
      invoiceNumber: newInvoiceNumber,
      filename,
      amount: totalAmount,
      items: invoiceData.items,
      discount: invoiceData.discount,
      client: originalInvoice.client,
      clientPhone: originalInvoice.clientPhone || '',
      isRecurring: originalInvoice.isRecurring || false,
      paymentDeadlineDay: originalInvoice.paymentDeadlineDay || null,
      payment: invoiceData.payment,
      invoiceDate: newInvoiceDate,
      yandexPath: null,
      publicUrl: null,
      autoSendEnabled: !!autoSendEnabled,
      nextSendDate: resolvedNextSendDate
    });

    const sendMsg = autoSendEnabled && resolvedNextSendDate
      ? ` Авторассылка включена на ${new Date(resolvedNextSendDate).toLocaleDateString('ru-RU')} (далее — ежемесячно).`
      : '';

    res.json({
      success: true,
      invoice: newInvoice,
      message: `Создан новый счёт №${newInvoiceNumber} на основе счёта №${originalInvoice.invoiceNumber}.${sendMsg}`
    });

  } catch (error) {
    console.error('Ошибка дублирования счета:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== СКЛАД API ====================

// Получить все товары
app.get('/api/warehouse/products', (req, res) => {
  try {
    const products = warehouseDb.getAllProducts();
    const statistics = warehouseDb.getWarehouseStatistics();
    res.json({ products, statistics });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Загрузить фото товара
app.post('/api/warehouse/products/upload-image', upload.single('image'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Файл не загружен' });
    }

    // Возвращаем URL к загруженному файлу
    const imageUrl = `/uploads/products/${req.file.filename}`;
    res.json({
      success: true,
      imageUrl: imageUrl,
      filename: req.file.filename
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Удалить фото товара
app.delete('/api/warehouse/products/delete-image', (req, res) => {
  try {
    const { filename } = req.body;
    if (!filename) {
      return res.status(400).json({ error: 'Имя файла не указано' });
    }

    const filePath = path.join(uploadsDir, filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      res.json({ success: true, message: 'Фото удалено' });
    } else {
      res.status(404).json({ error: 'Файл не найден' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Добавить товар
app.post('/api/warehouse/products', validate(validateProduct), (req, res) => {
  try {
    const product = warehouseDb.addProduct(req.body);
    res.json({ success: true, product });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Обновить товар
app.put('/api/warehouse/products/:id', validate(validateProduct), (req, res) => {
  try {
    const product = warehouseDb.updateProduct(req.params.id, req.body);
    if (product) {
      res.json({ success: true, product });
    } else {
      res.status(404).json({ error: 'Товар не найден' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Удалить товар
app.delete('/api/warehouse/products/:id', (req, res) => {
  try {
    const product = warehouseDb.deleteProduct(req.params.id);
    if (product) {
      res.json({ success: true, message: 'Товар удален' });
    } else {
      res.status(404).json({ error: 'Товар не найден' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Добавить движение (приход/расход)
app.post('/api/warehouse/movements', (req, res) => {
  try {
    const movement = warehouseDb.addMovement(req.body);
    res.json({ success: true, movement });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Получить все движения
app.get('/api/warehouse/movements', (req, res) => {
  try {
    const movements = warehouseDb.getAllMovements();
    res.json({ movements });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Получить движения по товару
app.get('/api/warehouse/movements/product/:productId', (req, res) => {
  try {
    const movements = warehouseDb.getMovementsByProduct(req.params.productId);
    res.json({ movements });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Анализ доходности
app.get('/api/warehouse/profitability', (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const analysis = warehouseDb.getProfitabilityAnalysis(startDate, endDate);
    res.json(analysis);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Товары с низким остатком
app.get('/api/warehouse/low-stock', (req, res) => {
  try {
    const threshold = parseInt(req.query.threshold) || 5;
    const products = warehouseDb.getLowStockProducts(threshold);
    res.json({ products });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Получить список всех поставщиков
app.get('/api/warehouse/suppliers', (req, res) => {
  try {
    const suppliers = warehouseDb.getAllSuppliers();
    res.json({ suppliers });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Получить товары по поставщику
app.get('/api/warehouse/suppliers/:supplier/products', (req, res) => {
  try {
    const supplier = decodeURIComponent(req.params.supplier);
    const products = warehouseDb.getProductsBySupplier(supplier);
    res.json({ supplier, products });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Применить наценку к товарам поставщика
app.post('/api/warehouse/suppliers/:supplier/apply-markup', (req, res) => {
  try {
    const supplier = decodeURIComponent(req.params.supplier);
    const { markup, mode } = req.body;

    if (markup === undefined || markup === null) {
      return res.status(400).json({ error: 'Наценка не указана' });
    }

    const updated = warehouseDb.applyMarkupToSupplier(supplier, markup, mode || 'percentage');
    res.json({
      success: true,
      updated,
      message: `Обновлено ${updated} товаров`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Обновить цену отдельного товара
app.put('/api/warehouse/products/:id/price', (req, res) => {
  try {
    const { id } = req.params;
    const { sellingPrice } = req.body;

    if (sellingPrice === undefined || sellingPrice === null) {
      return res.status(400).json({ error: 'Цена не указана' });
    }

    const product = warehouseDb.updateProductPrice(id, sellingPrice);
    if (product) {
      res.json({ success: true, product });
    } else {
      res.status(404).json({ error: 'Товар не найден' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== КЛИЕНТЫ API ====================

// Получить всех клиентов
app.get('/api/clients', (req, res) => {
  try {
    const clients = clientsDb.getAllClients();
    res.json({ clients });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Получить клиента по ID
app.get('/api/clients/:id', (req, res) => {
  try {
    const client = clientsDb.getClientById(req.params.id);
    if (client) {
      res.json({ success: true, client });
    } else {
      res.status(404).json({ error: 'Клиент не найден' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Добавить клиента
app.post('/api/clients', validate(validateClient), (req, res) => {
  try {
    const client = clientsDb.addClient(req.body);
    res.json({ success: true, client });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Обновить клиента
app.put('/api/clients/:id', validate(validateClient), (req, res) => {
  try {
    const existing = clientsDb.getClientById(req.params.id);
    const oldPhone = existing ? existing.phone : null;
    const client = clientsDb.updateClient(req.params.id, req.body);
    if (client) {
      // Авто-проброс нового номера в активные (неоплаченные) счета клиента:
      // напоминания/авто-отправка берут номер из счёта, а не из карточки.
      let syncedInvoices = [];
      if (oldPhone && client.phone && oldPhone !== client.phone) {
        syncedInvoices = db.syncClientPhone(oldPhone, client.phone, client.name);
      }
      res.json({ success: true, client, syncedInvoices });
    } else {
      res.status(404).json({ error: 'Клиент не найден' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Удалить клиента
app.delete('/api/clients/:id', (req, res) => {
  try {
    const client = clientsDb.deleteClient(req.params.id);
    if (client) {
      res.json({ success: true, message: 'Клиент удален' });
    } else {
      res.status(404).json({ error: 'Клиент не найден' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Поиск клиентов
app.get('/api/clients/search/:query', (req, res) => {
  try {
    const clients = clientsDb.searchClients(req.params.query);
    res.json({ clients });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== СТРАНИЦЫ ====================

// Главная страница
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Страница со списком счетов
app.get('/invoices', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/invoices.html'));
});

// WhatsApp API endpoints

// Получить статус WhatsApp
app.get('/api/whatsapp/status', (req, res) => {
  const status = whatsappManager.getStatus();
  res.json(status);
});

// Отправить сообщение через WhatsApp
app.post('/api/whatsapp/send', async (req, res) => {
  try {
    const { phone, message } = req.body;

    if (!phone || !message) {
      return res.status(400).json({ error: 'Требуются параметры phone и message' });
    }

    const result = await whatsappManager.sendMessage(phone, message);
    res.json(result);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Отправить сообщение с файлом через WhatsApp
app.post('/api/whatsapp/send-file', async (req, res) => {
  try {
    const { phone, message, invoiceId } = req.body;

    if (!phone || !message || !invoiceId) {
      return res.status(400).json({ error: 'Требуются параметры phone, message и invoiceId' });
    }

    // Ищем PDF файл в папке output
    const outputDir = path.join(__dirname, '../output');
    const files = fs.readdirSync(outputDir);

    // Ищем все файлы, которые содержат номер счета
    const matchingFiles = files.filter(f => {
      if (!f.endsWith('.pdf')) return false;

      // Поддерживаем разные форматы:
      // - invoice_1_1763023324124.pdf (старый формат с timestamp)
      // - Счет_17_Salat_2025-11-13.pdf (новый формат с именем клиента)

      // Проверяем новый формат: Счет_NUMBER_...
      const newFormatMatch = f.match(/^Счет_(\d+)_/);
      if (newFormatMatch && newFormatMatch[1] === String(invoiceId)) {
        return true;
      }

      // Проверяем старый формат: invoice_NUMBER_...
      const oldFormatMatch = f.match(/^invoice_(\d+)_/);
      if (oldFormatMatch && oldFormatMatch[1] === String(invoiceId)) {
        return true;
      }

      return false;
    });

    if (matchingFiles.length === 0) {
      console.error(`PDF файл для счета ${invoiceId} не найден в ${outputDir}`);
      console.error(`Доступные файлы:`, files.filter(f => f.endsWith('.pdf')));
      return res.status(404).json({ error: 'PDF файл не найден' });
    }

    // Получаем информацию о счете из базы данных для проверки имени клиента
    const invoice = db.getInvoiceByNumber(invoiceId);

    // Если найдено несколько файлов с одним номером, выбираем по имени клиента или по дате
    let pdfFile = matchingFiles[0];
    if (matchingFiles.length > 1) {
      console.warn(`⚠️  Найдено ${matchingFiles.length} файлов для счета ${invoiceId}: ${matchingFiles.join(', ')}`);

      // Если есть информация о клиенте из БД, пытаемся найти файл с его именем
      if (invoice && invoice.client) {
        const clientNameClean = sanitizeFilename(invoice.client);
        const fileWithClientName = matchingFiles.find(f => f.includes(clientNameClean));

        if (fileWithClientName) {
          pdfFile = fileWithClientName;
          console.log(`✅ Выбран файл по имени клиента "${invoice.client}": ${pdfFile}`);
        } else {
          console.warn(`⚠️  Файл с именем клиента "${clientNameClean}" не найден, выбираем по дате модификации`);

          // Если не нашли по имени, выбираем самый свежий
          const filesWithStats = matchingFiles.map(f => {
            const filePath = path.join(outputDir, f);
            const stats = fs.statSync(filePath);
            return { name: f, mtime: stats.mtime };
          });

          filesWithStats.sort((a, b) => b.mtime - a.mtime);
          pdfFile = filesWithStats[0].name;
          console.log(`✅ Выбран самый свежий файл: ${pdfFile} (изменен: ${filesWithStats[0].mtime.toISOString()})`);
        }
      } else {
        // Если нет информации о клиенте, выбираем по дате модификации
        const filesWithStats = matchingFiles.map(f => {
          const filePath = path.join(outputDir, f);
          const stats = fs.statSync(filePath);
          return { name: f, mtime: stats.mtime };
        });

        filesWithStats.sort((a, b) => b.mtime - a.mtime);
        pdfFile = filesWithStats[0].name;
        console.log(`✅ Выбран самый свежий файл: ${pdfFile} (изменен: ${filesWithStats[0].mtime.toISOString()})`);
      }
    }

    const pdfPath = path.join(outputDir, pdfFile);
    console.log(`Найден PDF файл: ${pdfPath}`);

    const result = await whatsappManager.sendMessageWithFile(phone, message, pdfPath);

    // Если отправка успешна, обновляем информацию о счете
    if (result.success && invoice) {
      const isFirstSend = !invoice.whatsAppSentCount || invoice.whatsAppSentCount === 0;
      const currentDate = new Date().toISOString();

      const updateData = {
        lastWhatsAppSent: currentDate,
        whatsAppSentCount: (invoice.whatsAppSentCount || 0) + 1,
        // Автоматически включаем напоминания при первой отправке
        reminderEnabled: isFirstSend ? true : invoice.reminderEnabled
      };

      // При первой отправке устанавливаем дату выставления счета
      if (isFirstSend) {
        updateData.invoiceDate = currentDate;
        console.log(`📅 Счет №${invoiceId}: установлена дата выставления ${new Date(currentDate).toLocaleDateString('ru-RU')}`);
      }

      db.updateInvoice(invoice.id, updateData);
      console.log(`Счет №${invoiceId} отмечен как отправленный через WhatsApp (отправка №${updateData.whatsAppSentCount})`);
    }

    res.json(result);

  } catch (error) {
    console.error('Ошибка отправки через WhatsApp:', error);
    res.status(500).json({ error: error.message });
  }
});

// Перезапустить WhatsApp (если возникли проблемы)
app.post('/api/whatsapp/restart', async (req, res) => {
  try {
    await whatsappManager.restart();
    res.json({ success: true, message: 'WhatsApp перезапущен' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Получить QR-код для авторизации
app.get('/api/whatsapp/qr', async (req, res) => {
  try {
    const qr = whatsappManager.getQRCode();
    const status = whatsappManager.getStatus();

    res.json({
      qr: qr,
      status: status
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Получить скриншот WhatsApp Web
app.get('/api/whatsapp/screenshot', async (req, res) => {
  try {
    const screenshot = await whatsappManager.getScreenshot();
    res.set('Content-Type', 'image/png');
    res.send(screenshot);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Страница просмотра WhatsApp Web
app.get('/whatsapp-viewer', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/whatsapp-viewer.html'));
});

// API для счетчика номеров счетов

// Получить следующий номер счета
app.get('/api/invoice-counter/next', (req, res) => {
  try {
    const nextNumber = invoiceCounter.getNextInvoiceNumber();
    res.json({ number: nextNumber });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Получить текущий номер без инкремента
app.get('/api/invoice-counter/current', (req, res) => {
  try {
    const currentNumber = invoiceCounter.peekNextNumber();
    res.json({ number: currentNumber });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Сбросить счетчик
app.post('/api/invoice-counter/reset', (req, res) => {
  try {
    invoiceCounter.resetCounter();
    res.json({ success: true, message: 'Счетчик сброшен' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Установить значение счетчика
app.post('/api/invoice-counter/set', (req, res) => {
  try {
    const { value } = req.body;
    if (value === undefined) {
      return res.status(400).json({ error: 'Требуется параметр value' });
    }
    invoiceCounter.setCounter(value);
    res.json({ success: true, message: 'Счетчик установлен', value: value });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== АВТОРАССЫЛКА API ====================

// Включить/выключить автоматическую рассылку для счета
app.post('/api/invoices/:id/auto-send', (req, res) => {
  try {
    const { id } = req.params;
    const { enabled, nextSendDate } = req.body;

    const invoice = db.setAutoSend(id, enabled, nextSendDate);

    if (invoice) {
      res.json({ success: true, invoice });
    } else {
      res.status(404).json({ error: 'Счет не найден' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Получить список счетов для авторассылки
app.get('/api/auto-send/invoices', (req, res) => {
  try {
    const invoices = db.getInvoicesForAutoSend();
    res.json({ invoices });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Получить статус планировщика
app.get('/api/auto-send/status', (req, res) => {
  try {
    if (autoSendScheduler) {
      const status = autoSendScheduler.getStatus();
      res.json(status);
    } else {
      res.json({
        isRunning: false,
        isProcessing: false,
        message: 'Планировщик не инициализирован'
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Запустить проверку вручную (для тестирования)
app.post('/api/auto-send/check-now', async (req, res) => {
  try {
    if (!autoSendScheduler) {
      return res.status(400).json({ error: 'Планировщик не инициализирован' });
    }

    // Запускаем проверку в фоновом режиме
    autoSendScheduler.checkAndSend().catch(err => {
      console.error('Ошибка при ручной проверке авторассылки:', err);
    });

    res.json({ success: true, message: 'Проверка запущена' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API endpoint для отметки счета как отправленного клиенту
app.post('/api/invoices/:id/mark-sent', (req, res) => {
  try {
    const { id } = req.params;
    const { sentDate } = req.body;

    const invoice = db.updateInvoice(id, {
      sentToClient: sentDate || new Date().toISOString()
    });

    if (invoice) {
      console.log(`[Invoice] ✅ Счет №${invoice.invoiceNumber} отмечен как отправленный клиенту`);
      res.json({ success: true, invoice });
    } else {
      res.status(404).json({ error: 'Счет не найден' });
    }
  } catch (error) {
    console.error('[Invoice] ❌ Ошибка отметки счета как отправленного:', error);
    res.status(500).json({ error: error.message });
  }
});

// API endpoint для включения/выключения напоминаний об оплате
app.post('/api/invoices/:id/reminder', (req, res) => {
  try {
    const { id } = req.params;
    const { enabled } = req.body;

    const invoice = db.updateInvoice(id, {
      reminderEnabled: enabled
    });

    if (invoice) {
      res.json({ success: true, invoice });
    } else {
      res.status(404).json({ error: 'Счет не найден' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Получить статус сервиса напоминаний
app.get('/api/payment-reminders/status', (req, res) => {
  try {
    if (paymentReminderService) {
      const status = paymentReminderService.getStatus();
      res.json(status);
    } else {
      res.json({ isRunning: false, message: 'Сервис напоминаний не инициализирован' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Ручная проверка и отправка напоминаний
app.post('/api/payment-reminders/check-now', async (req, res) => {
  try {
    if (!paymentReminderService) {
      return res.status(400).json({ error: 'Сервис напоминаний не инициализирован' });
    }

    // Запускаем проверку в фоновом режиме
    paymentReminderService.checkAndSendReminders().catch(err => {
      console.error('Ошибка при ручной проверке напоминаний:', err);
    });

    res.json({ success: true, message: 'Проверка напоминаний запущена' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Отправить напоминание для конкретного счета прямо сейчас
app.post('/api/payment-reminders/send-now', async (req, res) => {
  try {
    const { invoiceId } = req.body;

    if (!invoiceId) {
      return res.status(400).json({ error: 'Не указан ID счета' });
    }

    if (!paymentReminderService) {
      return res.status(400).json({ error: 'Сервис напоминаний не инициализирован' });
    }

    // Получаем счет
    const invoice = db.getInvoiceById(invoiceId);
    if (!invoice) {
      return res.status(404).json({ error: 'Счет не найден' });
    }

    // Проверки
    if (invoice.paid) {
      return res.status(400).json({ error: 'Счет уже оплачен' });
    }

    if (!invoice.clientPhone) {
      return res.status(400).json({ error: 'У клиента не указан номер телефона' });
    }

    // Отправляем напоминание
    const result = await paymentReminderService.sendReminder(invoice);

    if (result.success) {
      // Обновляем счет
      db.updateInvoice(invoiceId, {
        lastReminderSentAt: new Date().toISOString(),
        reminderCount: (invoice.reminderCount || 0) + 1
      });

      res.json({
        success: true,
        message: `Напоминание отправлено клиенту ${invoice.client}`
      });
    } else {
      res.status(500).json({ error: result.error || 'Ошибка отправки напоминания' });
    }
  } catch (error) {
    console.error('Ошибка отправки напоминания:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/payment-reminders/bulk-queue', (req, res) => {
  try {
    const { invoiceIds } = req.body;
    if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
      return res.status(400).json({ error: 'Необходимо указать массив ID счетов' });
    }
    if (!paymentReminderService) {
      return res.status(400).json({ error: 'Сервис напоминаний не инициализирован' });
    }
    const results = paymentReminderService.addToManualQueue(invoiceIds);
    const added = results.filter(r => r.success).length;
    const errors = results.filter(r => !r.success);
    res.json({ success: true, results, added, errors });
  } catch (error) {
    console.error('Ошибка добавления в очередь:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/payment-reminders/manual-queue', (req, res) => {
  if (!paymentReminderService) {
    return res.json({ items: [], isProcessing: false, pendingCount: 0, sentCount: 0, failedCount: 0 });
  }
  res.json(paymentReminderService.getManualQueueStatus());
});

app.delete('/api/payment-reminders/manual-queue/:invoiceId', (req, res) => {
  if (!paymentReminderService) {
    return res.status(400).json({ error: 'Сервис не инициализирован' });
  }
  const result = paymentReminderService.removeFromManualQueue(req.params.invoiceId);
  res.json(result);
});

app.post('/api/payment-reminders/manual-queue/clear', (req, res) => {
  if (!paymentReminderService) {
    return res.status(400).json({ error: 'Сервис не инициализирован' });
  }
  const result = paymentReminderService.clearManualQueue();
  res.json({ success: true, ...result });
});


// ===== ОЧЕРЕДЬ ОТПРАВКИ СЧЕТОВ (PDF) =====
const invoiceSendQueue = {
  items: [],
  isProcessing: false,
  DELAY_MS: 30000, // 30 сек между отправками

  addInvoices(invoiceNumbers) {
    const results = [];
    for (const num of invoiceNumbers) {
      const inv = db.getInvoiceByNumber(String(num)) || db.getAllInvoices().find(i => String(i.id) === String(num) || String(i.invoiceNumber) === String(num));
      if (!inv) { results.push({ invoiceNumber: num, success: false, error: 'Счет не найден' }); continue; }
      if (!inv.clientPhone) { results.push({ invoiceNumber: num, success: false, error: 'Нет номера телефона' }); continue; }
      if (this.items.some(i => String(i.invoice.invoiceNumber) === String(inv.invoiceNumber) && i.status === 'pending')) {
        results.push({ invoiceNumber: num, success: false, error: 'Уже в очереди' }); continue;
      }
      this.items.push({ invoice: inv, status: 'pending', addedAt: new Date().toISOString(), sentAt: null, error: null });
      results.push({ invoiceNumber: inv.invoiceNumber, client: inv.client, success: true });
    }
    if (!this.isProcessing && this.items.some(i => i.status === 'pending')) {
      this.process();
    }
    return results;
  },

  addByClientIds(clientIds) {
    const allInvoices = db.getAllInvoices();
    const clients = clientIds.map(id => clientsDb.getClientById(id)).filter(Boolean);
    const invoiceNumbers = [];
    const notFound = [];
    for (const client of clients) {
      const found = allInvoices.filter(inv =>
        !inv.paid && inv.clientPhone &&
        (inv.client === client.name ||
          (client.phone && inv.clientPhone.replace(/\D/g,'').endsWith(client.phone.replace(/\D/g,'').slice(-10))))
      ).sort((a, b) => new Date(b.invoiceDate || b.createdAt) - new Date(a.invoiceDate || a.createdAt));
      if (found.length > 0) invoiceNumbers.push(found[0].invoiceNumber);
      else notFound.push({ clientId: client.id, name: client.name, error: 'Нет неоплаченных счетов' });
    }
    const results = this.addInvoices(invoiceNumbers);
    return { results, notFound };
  },

  async process() {
    if (this.isProcessing) return;
    this.isProcessing = true;
    try {
      while (true) {
        const next = this.items.find(i => i.status === 'pending');
        if (!next) break;
        next.status = 'sending';
        try {
          const inv = next.invoice;
          let phone = (inv.clientPhone || '').replace(/\D/g, '');
          if (phone.startsWith('8')) phone = '7' + phone.slice(1);
          if (!phone.startsWith('7')) phone = '7' + phone;

          // Загружаем шаблон сообщения
          let msgTemplate = 'Добрый день!\n\nВысылаю счет №{номер} на оплату.\n\nС уважением.';
          try {
            const settingsPath = path.join(__dirname, '../data/whatsapp-settings.json');
            if (fs.existsSync(settingsPath)) {
              const s = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
              if (s.greeting) msgTemplate = s.greeting;
            }
          } catch(e) {}
          const message = msgTemplate.replace('{номер}', inv.invoiceNumber);

          // Ищем PDF файл
          const outputDir = path.join(__dirname, '../output');
          const files = fs.readdirSync(outputDir).filter(f => {
            if (!f.endsWith('.pdf')) return false;
            const m1 = f.match(/^Счет_(\d+)_/);
            if (m1 && m1[1] === String(inv.invoiceNumber)) return true;
            const m2 = f.match(/^invoice_(\d+)_/);
            if (m2 && m2[1] === String(inv.invoiceNumber)) return true;
            return false;
          });
          if (files.length === 0) throw new Error('PDF файл не найден');

          let pdfFile = files[0];
          if (files.length > 1) {
            const clientClean = sanitizeFilename(inv.client || '');
            pdfFile = files.find(f => f.includes(clientClean)) || files.sort((a,b) => {
              return fs.statSync(path.join(outputDir,b)).mtime - fs.statSync(path.join(outputDir,a)).mtime;
            })[0];
          }
          const pdfPath = path.join(outputDir, pdfFile);

          const result = await whatsappManager.sendMessageWithFile(phone, message, pdfPath);
          if (!result.success) throw new Error(result.error || 'Ошибка WhatsApp');

          // Обновляем счет
          const currentDate = new Date().toISOString();
          const isFirst = !inv.whatsAppSentCount || inv.whatsAppSentCount === 0;
          db.updateInvoice(inv.id, {
            lastWhatsAppSent: currentDate,
            whatsAppSentCount: (inv.whatsAppSentCount || 0) + 1,
            reminderEnabled: isFirst ? true : inv.reminderEnabled,
            ...(isFirst ? { invoiceDate: currentDate } : {})
          });

          next.status = 'sent';
          next.sentAt = currentDate;
          console.log(`[InvoiceQueue] ✅ Счет №${inv.invoiceNumber} отправлен клиенту ${inv.client}`);
        } catch(err) {
          next.status = 'failed';
          next.error = err.message;
          console.error(`[InvoiceQueue] ❌ Ошибка счет №${next.invoice.invoiceNumber}:`, err.message);
        }
        const hasMore = this.items.some(i => i.status === 'pending');
        if (hasMore) {
          console.log(`[InvoiceQueue] Ожидание ${this.DELAY_MS/1000}с перед следующей отправкой...`);
          await new Promise(r => setTimeout(r, this.DELAY_MS));
        }
      }
    } finally {
      this.isProcessing = false;
    }
  },

  getStatus() {
    return {
      items: this.items.map(i => ({
        invoiceNumber: i.invoice.invoiceNumber,
        invoiceId: i.invoice.id,
        client: i.invoice.client,
        phone: i.invoice.clientPhone,
        status: i.status,
        addedAt: i.addedAt,
        sentAt: i.sentAt,
        error: i.error
      })),
      isProcessing: this.isProcessing,
      pendingCount: this.items.filter(i => i.status === 'pending').length,
      sendingCount: this.items.filter(i => i.status === 'sending').length,
      sentCount: this.items.filter(i => i.status === 'sent').length,
      failedCount: this.items.filter(i => i.status === 'failed').length
    };
  },

  remove(invoiceNumber) {
    const idx = this.items.findIndex(i => String(i.invoice.invoiceNumber) === String(invoiceNumber) && i.status === 'pending');
    if (idx !== -1) { this.items.splice(idx, 1); return { success: true }; }
    return { success: false, error: 'Не найдено или уже отправляется' };
  },

  clear() {
    const removed = this.items.filter(i => i.status === 'pending').length;
    this.items = this.items.filter(i => i.status !== 'pending');
    return { removed };
  },

  clearAll() {
    this.items = [];
    return { success: true };
  }
};

// API: добавить счета в очередь отправки
app.post('/api/invoice-queue/add', (req, res) => {
  try {
    const { invoiceNumbers } = req.body;
    if (!Array.isArray(invoiceNumbers) || invoiceNumbers.length === 0)
      return res.status(400).json({ error: 'Необходим массив invoiceNumbers' });
    const results = invoiceSendQueue.addInvoices(invoiceNumbers);
    const added = results.filter(r => r.success).length;
    res.json({ success: true, added, results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// API: добавить по клиентам (находит последний неоплаченный счет)
app.post('/api/invoice-queue/add-by-clients', (req, res) => {
  try {
    const { clientIds } = req.body;
    if (!Array.isArray(clientIds) || clientIds.length === 0)
      return res.status(400).json({ error: 'Необходим массив clientIds' });
    const { results, notFound } = invoiceSendQueue.addByClientIds(clientIds);
    const added = results.filter(r => r.success).length;
    res.json({ success: true, added, notFound, results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// API: статус очереди
app.get('/api/invoice-queue/status', (req, res) => {
  res.json(invoiceSendQueue.getStatus());
});

// API: убрать из очереди
app.delete('/api/invoice-queue/:invoiceNumber', (req, res) => {
  res.json(invoiceSendQueue.remove(req.params.invoiceNumber));
});

// API: очистить ожидающие
app.post('/api/invoice-queue/clear', (req, res) => {
  res.json(invoiceSendQueue.clear());
});

// API: очистить все (включая отправленные/ошибки)
app.post('/api/invoice-queue/clear-all', (req, res) => {
  res.json(invoiceSendQueue.clearAll());
});

// API endpoint для сохранения настроек WhatsApp сообщений
app.post('/api/whatsapp/settings', (req, res) => {
  try {
    const { greeting, reminder, sendTimeHour, sendTimeMinute } = req.body;
    const settingsPath = path.join(__dirname, '../data/whatsapp-settings.json');

    const settings = {
      greeting: greeting || '',
      reminder: reminder || '',
      sendTimeHour: sendTimeHour !== undefined ? parseInt(sendTimeHour) : 10,
      sendTimeMinute: sendTimeMinute !== undefined ? parseInt(sendTimeMinute) : 0
    };

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

    res.json({ success: true, message: 'Настройки сохранены' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API endpoint для получения настроек WhatsApp сообщений
app.get('/api/whatsapp/settings', (req, res) => {
  try {
    const settingsPath = path.join(__dirname, '../data/whatsapp-settings.json');

    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      res.json({ success: true, settings });
    } else {
      // Возвращаем настройки по умолчанию
      res.json({
        success: true,
        settings: {
          greeting: 'Добрый день!\n\nВысылаю счет №{номер} на оплату.\n\nС уважением.',
          reminder: 'Добрый день!\n\nНапоминаем об оплате счета №{номер}.\n\nКлиент: {клиент}\nСумма: {сумма} ₽\nДата выставления: {дата}\nПросрочка: {дни}\n\nПожалуйста, произведите оплату в ближайшее время.\n\nС уважением.',
          sendTimeHour: 10,
          sendTimeMinute: 0
        }
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Страница склада
app.get('/warehouse', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/warehouse.html'));
});

// Страница аналитики
app.get('/analytics', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/analytics.html'));
});

// Страница клиентов
app.get('/clients', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/clients.html'));
});

// Страница настроек
app.get('/settings', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/settings.html'));
});

// Страница заказов поставщикам
app.get('/supplier-orders', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/supplier-orders.html'));
});

// Публичный каталог товаров и услуг
app.get('/catalog', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/catalog.html'));
});

// Розничная продажа (с авторизацией)
app.get('/retail', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/retail.html'));
});

// ==================== ЗАГРУЗКА СКРИНШОТОВ ====================
// Этот endpoint НЕ требует авторизации для удобства

// POST endpoint для загрузки скриншотов
app.post('/api/upload-screenshot', uploadScreenshot.single('screenshot'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Файл не загружен' });
    }

    console.log(`📸 Скриншот загружен: ${req.file.filename}`);

    res.json({
      success: true,
      filename: req.file.filename,
      path: `/screenshots/${req.file.filename}`,
      url: `http://176.98.155.17:10801/screenshots/${req.file.filename}`
    });
  } catch (error) {
    console.error('Ошибка загрузки скриншота:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET endpoint для просмотра всех скриншотов
app.get('/api/screenshots', (req, res) => {
  try {
    const files = fs.readdirSync(screenshotsDir)
      .filter(f => /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(f))
      .map(f => {
        const stats = fs.statSync(path.join(screenshotsDir, f));
        return {
          filename: f,
          url: `/screenshots/${f}`,
          size: stats.size,
          created: stats.birthtime
        };
      })
      .sort((a, b) => b.created - a.created); // Новые первыми

    res.json({ screenshots: files });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Страница для просмотра скриншотов
app.get('/screenshots-viewer', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/screenshots-viewer.html'));
});

// Страница скачивания инструментов
app.get('/download-tools', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/download-tools.html'));
});

// Endpoint для скачивания файлов
app.get('/api/download/:filename', (req, res) => {
  const filename = req.params.filename;
  const allowedFiles = [
    'Upload-Screenshot.bat',
    'upload-screenshot.ps1',
    'SCREENSHOT_UPLOAD_GUIDE.md'
  ];

  if (!allowedFiles.includes(filename)) {
    return res.status(404).json({ error: 'Файл не найден' });
  }

  const filePath = path.join(__dirname, '..', filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Файл не найден на сервере' });
  }

  res.download(filePath, filename);
});

// Запуск сервера с ожиданием инициализации БД
async function startServer() {
  // Ждем инициализации всех баз данных
  console.log('⏳ Инициализация баз данных...');
  await Promise.all([
    db.initPromise,
    warehouseDb.initPromise || Promise.resolve(),
    clientsDb.initPromise || Promise.resolve(),
    authDatabase.initPromise || Promise.resolve()
  ]);
  console.log('✅ Базы данных готовы\n');

  // Синхронизируем счетчик с базой данных
  console.log('🔄 Синхронизация счетчика счетов...');
  invoiceCounter.syncWithDatabase(db);
  console.log('');

  app.listen(PORT, () => {
    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║   Сервер генератора счетов запущен!                   ║');
    console.log('╚════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`🌐 Откройте браузер: http://localhost:${PORT}`);
  });

  // Дополнительный порт 10801 для внешнего доступа
  const EXTERNAL_PORT = 10801;
  app.listen(EXTERNAL_PORT, () => {
    console.log(`🌐 Внешний доступ: http://localhost:${EXTERNAL_PORT}`);
    console.log('');

    if (invoiceService.isYandexDiskConfigured()) {
      console.log('✅ Яндекс.Диск: настроен');
    } else {
      console.log('⚠️  Яндекс.Диск: не настроен');
      console.log('   Для настройки запустите: npm run setup');
    }

    console.log('');
    console.log('Для остановки нажмите Ctrl+C');
    console.log('');

    // Инициализируем WhatsApp Manager
    initWhatsApp();
  });
}

// Запускаем сервер
startServer().catch(err => {
  console.error('❌ Ошибка запуска сервера:', err);
  process.exit(1);
});

// Запуск сервисов, зависящих от WhatsApp (после успешной инициализации)
function startWhatsAppDependentServices() {
  if (autoSendScheduler) return; // уже запущены (повторный вызов после ретрая)

  // Запускаем планировщик автоматической рассылки после инициализации WhatsApp
  autoSendScheduler = new AutoSendScheduler(whatsappManager, db);
  autoSendScheduler.start();

  // Запускаем сервис напоминаний об оплате
  paymentReminderService = new PaymentReminderService(whatsappManager, db);
  paymentReminderService.start();

  // Telegram-бот мог быть создан раньше с paymentReminderService = null
  if (telegramBot) {
    telegramBot.paymentReminderService = paymentReminderService;
  }
}

// Повторные попытки инициализации WhatsApp: если при старте прокси/браузер
// был недоступен, без ретрая авторассылка и напоминания мертвы до ручного рестарта
const WHATSAPP_RETRY_INTERVAL_MS = 10 * 60 * 1000;

async function retryWhatsAppInit(attempt) {
  try {
    console.log('');
    console.log(`📱 Повторная инициализация WhatsApp Web (попытка ${attempt})...`);
    try { await whatsappManager.close(); } catch (e) { /* браузер мог не подняться */ }
    await whatsappManager.initialize();
    startWhatsAppDependentServices();
    console.log('✅ WhatsApp инициализирован после ретрая, авторассылка запущена');
  } catch (error) {
    console.error(`❌ Ретрай WhatsApp #${attempt} не удался: ${error.message}`);
    console.error('   Следующая попытка через 10 минут');
    setTimeout(() => retryWhatsAppInit(attempt + 1), WHATSAPP_RETRY_INTERVAL_MS);
  }
}

// Инициализация WhatsApp
async function initWhatsApp() {
  try {
    console.log('');
    console.log('📱 Инициализация WhatsApp Web...');
    await whatsappManager.initialize();
    startWhatsAppDependentServices();
  } catch (error) {
    console.error('❌ Ошибка инициализации WhatsApp:', error.message);
    console.error('   WhatsApp отправка недоступна, повторная попытка через 10 минут');
    setTimeout(() => retryWhatsAppInit(1), WHATSAPP_RETRY_INTERVAL_MS);
  }

  // Запускаем Telegram бота (независимо от состояния WhatsApp)
  try {
    console.log('');
    console.log('🤖 Инициализация Telegram бота...');
    telegramBot = new InvoiceTelegramBot(db, clientsDb, warehouseDb, whatsappManager, invoiceService, paymentReminderService, recurringPaymentsDb);
  } catch (error) {
    console.error('❌ Ошибка инициализации Telegram бота:', error.message);
  }

  // Запускаем сервис напоминаний о регулярных платежах
  try {
    console.log('');
    console.log('📅 Инициализация сервиса напоминаний о регулярных платежах...');
    const { default: RecurringPaymentsReminder } = await import('./recurringPaymentsReminder.js');
    recurringReminder = new RecurringPaymentsReminder(recurringPaymentsDb, telegramBot);
    recurringReminder.start();
    console.log('✅ Сервис напоминаний о регулярных платежах запущен');
  } catch (error) {
    console.error('❌ Ошибка инициализации сервиса регулярных платежей:', error.message);
  }
}
