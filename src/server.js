import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import SimpleInvoiceService from './simpleInvoiceService.js';
import InvoiceDatabase from './invoiceDatabase.js';
import WarehouseDatabase from './warehouseDatabase.js';
import ClientsDatabase from './clientsDatabase.js';
import whatsappManager from './whatsappManager.js';
import invoiceCounter from './invoiceCounter.js';
import AutoSendScheduler from './autoSendScheduler.js';
import { authMiddleware, loginHandler, verifyHandler, logoutHandler } from './authMiddleware.js';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Загружаем переменные окружения
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Добавляем middleware авторизации ДО всех остальных маршрутов
app.use(authMiddleware);

// API endpoints для авторизации (не требуют защиты, так как пропускаются в middleware)
app.post('/api/auth/login', loginHandler);
app.get('/api/auth/verify', verifyHandler);
app.post('/api/auth/logout', logoutHandler);

// Создаем сервис генерации счетов
const invoiceService = new SimpleInvoiceService({
  localOutputFolder: path.join(__dirname, '../output')
});

// Создаем базы данных
const db = new InvoiceDatabase();
const warehouseDb = new WarehouseDatabase();
const clientsDb = new ClientsDatabase();

// Создаем планировщик автоматической рассылки
let autoSendScheduler = null;

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

    // Если нужно загрузить на Яндекс.Диск и токен есть
    if (uploadToYandex && invoiceService.isYandexDiskConfigured()) {
      const localPath = path.join(__dirname, '../output', filename);
      const remotePath = `${process.env.YANDEX_DISK_FOLDER || '/Счета'}/${filename}`;

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

    res.json({
      success: true,
      filename: filename,
      localPath: path.join(__dirname, '../output', filename),
      yandexPath,
      publicUrl,
      invoiceId: savedInvoice.id
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

    // Если счет отмечен как оплаченный - автоматически создаем новый на следующий месяц
    if (paid && wasUnpaid) {  // Изменение статуса с неоплачен на оплачен
      try {
        console.log(`[AutoDuplicate] Счет №${invoice.invoiceNumber} оплачен, создаем новый счет на следующий месяц...`);

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

        // Генерируем имя файла
        const clientNameClean = sanitizeFilename(invoice.client);
        const dateStr = new Date().toISOString().split('T')[0];
        const filename = `Счет_${newInvoiceNumber}_${clientNameClean}_${dateStr}.pdf`;

        // Генерируем PDF
        await invoiceService.createInvoice(invoiceData, filename);

        // Вычисляем дату следующей отправки (следующий месяц, то же число)
        const nextSendDate = new Date();
        nextSendDate.setMonth(nextSendDate.getMonth() + 1);

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
          nextSendDate: nextSendDate.toISOString()  // Устанавливаем дату на следующий месяц
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

// Получить скриншот WhatsApp Web
app.get('/api/whatsapp/screenshot', async (req, res) => {
  try {
    const screenshot = await whatsappManager.getScreenshot();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
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

// Запуск сервера
app.listen(PORT, () => {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║   Сервер генератора счетов запущен!                   ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`🌐 Откройте браузер: http://localhost:${PORT}`);
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
  } catch (error) {
    console.error('❌ Ошибка инициализации WhatsApp:', error.message);
    console.error('   WhatsApp отправка будет недоступна');
  }
}
