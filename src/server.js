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
import { authMiddleware, loginHandler, verifyHandler, logoutHandler } from './authMiddleware.js';
import authDatabase from './authDatabase.js';
import fs from 'fs';
import multer from 'multer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Загружаем переменные окружения
dotenv.config();

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

// API endpoints для авторизации (не требуют защиты, так как пропускаются в middleware)
app.post('/api/auth/login', loginHandler);
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
const warehouseDb = new WarehouseDatabase();
const clientsDb = new ClientsDatabase();
const categoriesDb = new ExpenseCategories();

// Создаем планировщик автоматической рассылки
let autoSendScheduler = null;

// Создаем сервис напоминаний об оплате
let paymentReminderService = null;

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
    const { invoiceNumber, clientName, clientPhone, isRecurring, items, discount, payment, uploadToYandex, getPublicLink } = req.body;

    // Валидация данных
    if (!invoiceNumber || !clientName || !items || !items.length || !payment) {
      return res.status(400).json({ error: 'Не все обязательные поля заполнены' });
    }

    // Подготавливаем данные счета
    const invoiceData = {
      invoiceNumber,
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

    // Генерируем имя файла на основе названия клиента
    const clientNameClean = sanitizeFilename(clientName);
    const dateStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
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
      filename,
      amount: totalAmount,
      items: invoiceData.items,
      discount: invoiceData.discount,
      client: clientName,
      clientPhone: clientPhone || '',
      isRecurring: isRecurring || false,
      payment: invoiceData.payment,
      yandexPath,
      publicUrl
    });

    // Инкрементируем счетчик ТОЛЬКО после успешного сохранения
    invoiceCounter.getNextInvoiceNumber();

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
    const { invoiceNumber, clientName, clientPhone, isRecurring, items, discount, payment } = req.body;

    // Получаем существующий счет
    const existingInvoice = db.getInvoiceById(id);
    if (!existingInvoice) {
      return res.status(404).json({ error: 'Счет не найден' });
    }

    // Подготавливаем данные счета
    const invoiceData = {
      invoiceNumber,
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

    // Генерируем новое имя файла
    const clientNameClean = sanitizeFilename(clientName);
    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `Счет_${invoiceNumber}_${clientNameClean}_${dateStr}.pdf`;

    // Удаляем старый PDF файл
    const oldFilePath = path.join(__dirname, '../output', existingInvoice.filename);
    if (fs.existsSync(oldFilePath)) {
      fs.unlinkSync(oldFilePath);
    }

    // Генерируем новый PDF
    await invoiceService.createInvoice(invoiceData, filename);

    // Обновляем данные в базе
    const updatedInvoice = db.updateInvoice(id, {
      invoiceNumber,
      filename,
      amount: totalAmount,
      items: invoiceData.items,
      discount: invoiceData.discount,
      client: clientName,
      clientPhone: clientPhone || '',
      isRecurring: isRecurring || false,
      payment: invoiceData.payment
    });

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

        // Вычисляем дату следующей отправки (текущая дата + 1 месяц, то же число)
        const nextSendDate = new Date();
        nextSendDate.setMonth(nextSendDate.getMonth() + 1);

        // ✅ ИСПРАВЛЕНО: Дата создания нового счета = дата следующей отправки (следующий месяц)
        const nextMonthDate = new Date(nextSendDate);

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
          payment: invoiceData.payment,
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
      paidAt: new Date().toISOString()
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

        // Вычисляем дату следующей отправки (текущая дата + 1 месяц, то же число)
        const nextSendDate = new Date();
        nextSendDate.setMonth(nextSendDate.getMonth() + 1);

        // Дата создания нового счета = дата следующей отправки (следующий месяц)
        const nextMonthDate = new Date(nextSendDate);

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
          payment: invoiceData.payment,
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

// Дублировать счет (создать новый с тем же содержанием, но новым номером)
app.post('/api/invoices/:id/duplicate', async (req, res) => {
  try {
    const { id } = req.params;

    // Получаем оригинальный счет
    const originalInvoice = db.getInvoiceById(id);
    if (!originalInvoice) {
      return res.status(404).json({ error: 'Счет не найден' });
    }

    // Получаем новый номер счета
    const newInvoiceNumber = invoiceCounter.getNextInvoiceNumber();

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

    // Генерируем имя файла
    const clientNameClean = sanitizeFilename(originalInvoice.client);
    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `Счет_${newInvoiceNumber}_${clientNameClean}_${dateStr}.pdf`;

    // Генерируем PDF
    await invoiceService.createInvoice(invoiceData, filename);

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
      payment: invoiceData.payment,
      yandexPath: null,
      publicUrl: null
    });

    res.json({
      success: true,
      invoice: newInvoice,
      message: `Создан новый счет №${newInvoiceNumber} на основе счета №${originalInvoice.invoiceNumber}`
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
app.post('/api/warehouse/products', (req, res) => {
  try {
    const product = warehouseDb.addProduct(req.body);
    res.json({ success: true, product });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Обновить товар
app.put('/api/warehouse/products/:id', (req, res) => {
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
app.post('/api/clients', (req, res) => {
  try {
    const client = clientsDb.addClient(req.body);
    res.json({ success: true, client });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Обновить клиента
app.put('/api/clients/:id', (req, res) => {
  try {
    const client = clientsDb.updateClient(req.params.id, req.body);
    if (client) {
      res.json({ success: true, client });
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

    // Ищем файл, который содержит номер счета
    const pdfFile = files.find(f => {
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

    if (!pdfFile) {
      console.error(`PDF файл для счета ${invoiceId} не найден в ${outputDir}`);
      console.error(`Доступные файлы:`, files.filter(f => f.endsWith('.pdf')));
      return res.status(404).json({ error: 'PDF файл не найден' });
    }

    const pdfPath = path.join(outputDir, pdfFile);
    console.log(`Найден PDF файл: ${pdfPath}`);

    const result = await whatsappManager.sendMessageWithFile(phone, message, pdfPath);

    // Если отправка успешна, обновляем информацию о счете
    if (result.success) {
      // Находим счет по номеру
      const invoice = db.getInvoiceByNumber(invoiceId);
      if (invoice) {
        db.updateInvoice(invoice.id, {
          lastWhatsAppSent: new Date().toISOString(),
          whatsAppSentCount: (invoice.whatsAppSentCount || 0) + 1,
          // Автоматически включаем напоминания при первой отправке
          reminderEnabled: invoice.reminderEnabled !== undefined ? invoice.reminderEnabled : true
        });
        console.log(`Счет №${invoiceId} отмечен как отправленный через WhatsApp`);
      }
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
    const currentNumber = invoiceCounter.getCurrentNumber();
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
        lastReminderSent: new Date().toISOString(),
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

// Запуск сервера
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

// Инициализация WhatsApp
async function initWhatsApp() {
  try {
    console.log('');
    console.log('📱 Инициализация WhatsApp Web...');
    await whatsappManager.initialize();

    // Запускаем планировщик автоматической рассылки после инициализации WhatsApp
    autoSendScheduler = new AutoSendScheduler(whatsappManager);
    autoSendScheduler.start();

    // Запускаем сервис напоминаний об оплате
    paymentReminderService = new PaymentReminderService(whatsappManager);
    paymentReminderService.start();
  } catch (error) {
    console.error('❌ Ошибка инициализации WhatsApp:', error.message);
    console.error('   WhatsApp отправка будет недоступна');
  }

  // Запускаем Telegram бота (независимо от состояния WhatsApp)
  try {
    console.log('');
    console.log('🤖 Инициализация Telegram бота...');
    telegramBot = new InvoiceTelegramBot(db, clientsDb, warehouseDb, whatsappManager, invoiceService, paymentReminderService);
  } catch (error) {
    console.error('❌ Ошибка инициализации Telegram бота:', error.message);
  }
}
