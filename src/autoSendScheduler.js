import InvoiceDatabase from './invoiceDatabase.js';
import WhatsAppManager from './whatsappManager.js';
import PhoneValidator from './phoneValidator.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Планировщик автоматической отправки счетов
 * Проверяет каждые 10 минут наличие счетов для отправки
 * Отправляет счета с интервалом 5 минут между разными компаниями
 */
class AutoSendScheduler {
  constructor(whatsappManager) {
    this.db = new InvoiceDatabase();
    this.whatsappManager = whatsappManager;
    this.phoneValidator = new PhoneValidator();
    this.isProcessing = false;
    this.checkInterval = 10 * 60 * 1000; // 10 минут в миллисекундах
    this.sendDelay = 5 * 60 * 1000; // 5 минут задержка между отправками
    this.intervalId = null;

    // Очередь отправки
    this.sendQueue = [];
    this.currentSending = null;
    this.cancelledInvoices = new Set(); // ID счетов, отправка которых отменена
  }

  /**
   * Запустить планировщик
   */
  start() {
    console.log('[AutoSend] Планировщик автоматической рассылки запущен');
    console.log('[AutoSend] Интервал проверки: 10 минут');
    console.log('[AutoSend] Задержка между отправками: 5 минут');

    // Первая проверка через 1 минуту после запуска
    setTimeout(() => {
      this.checkAndSend();
    }, 60 * 1000);

    // Последующие проверки каждые 10 минут
    this.intervalId = setInterval(() => {
      this.checkAndSend();
    }, this.checkInterval);
  }

  /**
   * Остановить планировщик
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[AutoSend] Планировщик остановлен');
    }
  }

  /**
   * Проверить, наступило ли время рассылки для конкретного счета
   */
  isTimeToSend(invoice) {
    if (!invoice.nextSendDate) {
      return false;
    }

    const now = new Date();
    const sendDate = new Date(invoice.nextSendDate);

    // Проверяем, что дата наступила
    if (sendDate > now) {
      return false;
    }

    // Проверяем, что не прошло больше 24 часов с момента планируемой отправки
    const diffMs = now - sendDate;
    const diffMinutes = diffMs / (1000 * 60);

    // Разрешаем отправку в течение 24 часов (1440 минут) после указанного времени
    return diffMinutes >= 0 && diffMinutes < 1440;
  }

  /**
   * Получить настройки из файла
   */
  getSettings() {
    try {
      const settingsPath = path.join(__dirname, '../data/whatsapp-settings.json');
      if (fs.existsSync(settingsPath)) {
        return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      }
    } catch (error) {
      console.error('[AutoSend] Ошибка чтения настроек:', error.message);
    }

    // Возвращаем настройки по умолчанию
    return {
      sendTimeHour: 10,
      sendTimeMinute: 0
    };
  }

  /**
   * Проверить, отправлялись ли сегодня счета этому клиенту
   */
  wasSentToClientToday(clientPhone) {
    const invoices = this.db.getAllInvoices();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Нормализуем входящий номер для сравнения
    const normalizedPhone = clientPhone.replace(/[^0-9]/g, '');

    return invoices.some(invoice => {
      if (!invoice.lastWhatsAppSent || !invoice.clientPhone) {
        return false;
      }

      // Нормализуем номер телефона из счета для сравнения
      const invoicePhone = invoice.clientPhone.replace(/[^0-9]/g, '');

      // Сравниваем нормализованные номера
      if (invoicePhone !== normalizedPhone) {
        return false;
      }

      const lastSent = new Date(invoice.lastWhatsAppSent);
      lastSent.setHours(0, 0, 0, 0);

      return lastSent.getTime() === today.getTime();
    });
  }

  /**
   * Проверить и отправить счета
   */
  async checkAndSend() {
    if (this.isProcessing) {
      console.log('[AutoSend] Предыдущая обработка еще не завершена, пропускаем');
      return;
    }

    try {
      this.isProcessing = true;

      console.log('[AutoSend] Проверка счетов для автоматической отправки...');

      const invoices = this.db.getInvoicesForAutoSend();

      if (invoices.length === 0) {
        console.log('[AutoSend] Нет счетов с включенной авторассылкой');
        return;
      }

      console.log(`[AutoSend] Найдено счетов с авторассылкой: ${invoices.length}`);

      // Фильтруем счета: проверяем время и исключаем уже отправленные сегодня
      const filteredInvoices = invoices.filter(invoice => {
        if (!invoice.clientPhone) {
          console.log(`[AutoSend] Пропускаем счет №${invoice.invoiceNumber}: нет номера телефона`);
          return false;
        }

        // Проверяем, наступило ли время для этого счета
        if (!this.isTimeToSend(invoice)) {
          const sendDate = new Date(invoice.nextSendDate);
          console.log(`[AutoSend] Пропускаем счет №${invoice.invoiceNumber}: время еще не наступило (запланировано на ${sendDate.toLocaleString('ru-RU')})`);
          return false;
        }

        if (this.wasSentToClientToday(invoice.clientPhone)) {
          console.log(`[AutoSend] Пропускаем счет №${invoice.invoiceNumber} для клиента ${invoice.client}: уже отправляли сегодня`);
          return false;
        }

        return true;
      });

      if (filteredInvoices.length === 0) {
        console.log('[AutoSend] Нет счетов для отправки после фильтрации (всем клиентам уже отправляли сегодня)');
        return;
      }

      console.log(`[AutoSend] После фильтрации осталось счетов для отправки: ${filteredInvoices.length}`);

      // Добавляем счета в очередь
      this.sendQueue = filteredInvoices;

      // Получаем настройки для всего цикла отправки
      const settings = this.getSettings();

      // Отправляем счета с задержкой между ними
      for (let i = 0; i < this.sendQueue.length; i++) {
        const invoice = this.sendQueue[i];

        // Проверяем, не была ли отменена отправка
        if (this.cancelledInvoices.has(invoice.id)) {
          console.log(`[AutoSend] ⚠️ Отправка счета №${invoice.invoiceNumber} отменена`);
          this.cancelledInvoices.delete(invoice.id);
          continue;
        }

        this.currentSending = invoice;
        console.log(`[AutoSend] Отправка счета ${i + 1}/${this.sendQueue.length}: №${invoice.invoiceNumber} для клиента ${invoice.client}`);

        try {
          await this.sendInvoice(invoice);

          // Обновляем дату следующей отправки (сдвигаем на месяц)
          this.db.updateNextSendDate(invoice.id);

          // Обновляем информацию об отправке через WhatsApp
          this.db.updateInvoice(invoice.id, {
            lastWhatsAppSent: new Date().toISOString(),
            whatsAppSentCount: (invoice.whatsAppSentCount || 0) + 1,
            // Автоматически включаем напоминания при автоматической отправке
            reminderEnabled: true
          });

          console.log(`[AutoSend] ✅ Счет №${invoice.invoiceNumber} успешно отправлен`);
          console.log(`[AutoSend] Следующая отправка: ${new Date(invoice.nextSendDate).toLocaleString('ru-RU')}`);

          // Перезагружаем WhatsApp после успешной отправки (если включено в настройках)
          if (settings.restartWhatsAppAfterSend !== false) { // По умолчанию true
            console.log(`[AutoSend] 🔄 Перезагрузка WhatsApp после отправки...`);
            try {
              await this.whatsappManager.restart();
              console.log(`[AutoSend] ✅ WhatsApp успешно перезагружен`);
              // Ждем 10 секунд после перезагрузки для стабилизации
              await this.sleep(10000);
            } catch (restartError) {
              console.error(`[AutoSend] ⚠️  Ошибка перезагрузки WhatsApp:`, restartError.message);
              // Продолжаем работу даже если перезагрузка не удалась
            }
          } else {
            console.log(`[AutoSend] ⏭️  Перезагрузка WhatsApp отключена в настройках`);
          }

        } catch (error) {
          console.error(`[AutoSend] ❌ Ошибка при отправке счета №${invoice.invoiceNumber}:`, error.message);
        }

        this.currentSending = null;

        // Ждем 5 минут перед следующей отправкой (кроме последнего)
        if (i < this.sendQueue.length - 1) {
          console.log(`[AutoSend] Ожидание 5 минут перед следующей отправкой...`);
          await this.sleep(this.sendDelay);
        }
      }

      console.log('[AutoSend] Все счета обработаны');
      this.sendQueue = [];

    } catch (error) {
      console.error('[AutoSend] Ошибка при обработке счетов:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Получить шаблон приветственного сообщения
   */
  getGreetingMessageTemplate() {
    try {
      const settingsPath = path.join(__dirname, '../data/whatsapp-settings.json');
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        if (settings.greeting) {
          return settings.greeting;
        }
      }
    } catch (error) {
      console.error('[AutoSend] Ошибка чтения шаблона приветствия:', error.message);
    }

    // Шаблон по умолчанию
    return 'Добрый день!\n\nВысылаю счет №{номер} на оплату.\n\nС уважением.';
  }

  /**
   * Получить шаблон сообщения-напоминания
   */
  getReminderMessageTemplate() {
    try {
      const settingsPath = path.join(__dirname, '../data/whatsapp-settings.json');
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        if (settings.reminder) {
          return settings.reminder;
        }
      }
    } catch (error) {
      console.error('[AutoSend] Ошибка чтения шаблона напоминания:', error.message);
    }

    // Шаблон по умолчанию
    return 'Добрый день!\n\nНапоминаем об оплате счета №{номер}.\n\nКлиент: {клиент}\nДата выставления: {дата}\nПросрочка: {дни}\n\nПожалуйста, произведите оплату в ближайшее время.\n\nС уважением.';
  }

  /**
   * Получить правильное склонение слова "день"
   */
  getDaysWord(days) {
    const lastDigit = days % 10;
    const lastTwoDigits = days % 100;

    if (lastTwoDigits >= 11 && lastTwoDigits <= 19) {
      return 'дней';
    }

    if (lastDigit === 1) {
      return 'день';
    }

    if (lastDigit >= 2 && lastDigit <= 4) {
      return 'дня';
    }

    return 'дней';
  }

  /**
   * Отправить счет через WhatsApp
   */
  async sendInvoice(invoice) {
    // Проверяем наличие номера телефона
    if (!invoice.clientPhone) {
      throw new Error('У клиента не указан номер телефона');
    }

    // Валидируем номер телефона клиента
    const validation = this.phoneValidator.validateInvoicePhone(invoice.client, invoice.clientPhone);

    if (!validation.valid) {
      console.warn(`[AutoSend] ⚠️  Предупреждение для счета №${invoice.invoiceNumber}:`, validation.message);

      // Если клиент найден, но номер не совпадает - пытаемся исправить
      if (validation.clientFound && validation.expectedPhone) {
        console.log(`[AutoSend] 🔧 Попытка исправить номер: ${invoice.clientPhone} → ${validation.expectedPhone}`);

        // Обновляем номер в счете
        this.db.updateInvoice(invoice.id, {
          clientPhone: validation.expectedPhone
        });

        invoice.clientPhone = validation.expectedPhone;
        console.log(`[AutoSend] ✅ Номер телефона исправлен`);
      } else {
        // Если клиент не найден или нет номера - выбрасываем ошибку
        throw new Error(validation.message);
      }
    }

    // Нормализуем номер телефона
    let phone = invoice.clientPhone.replace(/\D/g, '');
    if (phone.startsWith('8')) {
      phone = '7' + phone.substring(1);
    }
    if (!phone.startsWith('7')) {
      phone = '7' + phone;
    }

    // Проверяем тестовый режим
    const settings = this.getSettings();
    const originalPhone = phone;
    if (settings.testMode && settings.testPhone) {
      console.log(`[AutoSend] 🧪 ТЕСТОВЫЙ РЕЖИМ: Перенаправление с ${phone} на ${settings.testPhone}`);
      phone = settings.testPhone;
    }

    // Проверяем, был ли счет уже отправлен ранее
    const wasAlreadySent = !!invoice.lastWhatsAppSent;

    if (wasAlreadySent) {
      // Счет уже отправлялся - отправляем только напоминание (текст)
      console.log(`[AutoSend] Счет №${invoice.invoiceNumber} уже отправлялся ранее - отправляем напоминание`);

      // Вычисляем количество дней с момента создания счета
      const createdDate = new Date(invoice.createdAt);
      const now = new Date();
      const daysPassed = Math.floor((now - createdDate) / (1000 * 60 * 60 * 24));

      // Получаем шаблон напоминания
      const messageTemplate = this.getReminderMessageTemplate();

      // Формируем сообщение-напоминание, подставляя значения
      let message = messageTemplate
        .replace(/{номер}/g, invoice.invoiceNumber)
        .replace(/{клиент}/g, invoice.client)
        .replace(/{сумма}/g, invoice.amount?.toLocaleString('ru-RU'))
        .replace(/{дата}/g, createdDate.toLocaleDateString('ru-RU'))
        .replace(/{дни}/g, `${daysPassed} ${this.getDaysWord(daysPassed)}`);

      // Добавляем информацию о тестовом режиме
      if (settings.testMode && originalPhone !== phone) {
        message = `🧪 ТЕСТОВОЕ НАПОМИНАНИЕ\nДля клиента: ${invoice.client} (${originalPhone})\n\n` + message;
      }

      console.log(`[AutoSend] Отправка напоминания (только текст) на ${phone}...`);

      // Отправляем только текст через WhatsApp (без PDF файла)
      const result = await this.whatsappManager.sendMessage(phone, message);

      if (!result.success) {
        throw new Error(result.error || 'Не удалось отправить напоминание');
      }

      return result;

    } else {
      // Счет отправляется первый раз - отправляем PDF + текст
      console.log(`[AutoSend] Первая отправка счета №${invoice.invoiceNumber} - отправляем PDF + текст`);

      // Формируем сообщение из шаблона приветствия
      let messageTemplate = this.getGreetingMessageTemplate();
      let message = messageTemplate.replace(/{номер}/g, invoice.invoiceNumber);

      // Добавляем информацию о тестовом режиме
      if (settings.testMode && originalPhone !== phone) {
        message = `🧪 ТЕСТОВАЯ ОТПРАВКА\nДля клиента: ${invoice.client} (${originalPhone})\n\n` + message;
      }

      // Ищем PDF файл счета
      const invoicesDir = path.join(__dirname, '../output');
      const files = fs.readdirSync(invoicesDir);

      const pdfFile = files.find(f => {
        if (!f.endsWith('.pdf')) return false;

        // Проверяем новый формат: Счет_NUMBER_...
        const newFormatMatch = f.match(/^Счет_(\d+)_/);
        if (newFormatMatch && newFormatMatch[1] === String(invoice.invoiceNumber)) {
          return true;
        }

        // Проверяем старый формат: invoice_NUMBER_...
        const oldFormatMatch = f.match(/^invoice_(\d+)_/);
        if (oldFormatMatch && oldFormatMatch[1] === String(invoice.invoiceNumber)) {
          return true;
        }

        return false;
      });

      if (!pdfFile) {
        throw new Error(`PDF файл для счета №${invoice.invoiceNumber} не найден`);
      }

      const filePath = path.join(invoicesDir, pdfFile);

      // Отправляем через WhatsApp
      const result = await this.whatsappManager.sendMessageWithFile(phone, message, filePath);

      if (!result.success) {
        throw new Error(result.error || 'Не удалось отправить сообщение');
      }

      return result;
    }
  }

  /**
   * Задержка
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Получить очередь отправки
   */
  getQueue() {
    return {
      queue: this.sendQueue.map(invoice => ({
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        client: invoice.client,
        clientPhone: invoice.clientPhone,
        amount: invoice.amount,
        nextSendDate: invoice.nextSendDate,
        type: invoice.lastWhatsAppSent ? 'reminder' : 'invoice'
      })),
      currentSending: this.currentSending ? {
        id: this.currentSending.id,
        invoiceNumber: this.currentSending.invoiceNumber,
        client: this.currentSending.client,
        type: this.currentSending.lastWhatsAppSent ? 'reminder' : 'invoice'
      } : null,
      isProcessing: this.isProcessing
    };
  }

  /**
   * Отменить отправку счета
   */
  cancelInvoiceSending(invoiceId) {
    // Добавляем в список отмененных
    this.cancelledInvoices.add(invoiceId);

    // Удаляем из очереди, если там есть
    const index = this.sendQueue.findIndex(inv => inv.id === invoiceId);
    if (index !== -1) {
      this.sendQueue.splice(index, 1);
      console.log(`[AutoSend] Счет №${invoiceId} удален из очереди отправки`);
      return { success: true, message: 'Счет удален из очереди' };
    }

    // Проверяем, не отправляется ли сейчас
    if (this.currentSending && this.currentSending.id === invoiceId) {
      console.log(`[AutoSend] Отмена текущей отправки счета №${invoiceId}`);
      return { success: true, message: 'Текущая отправка будет отменена' };
    }

    return { success: false, message: 'Счет не найден в очереди' };
  }

  /**
   * Очистить отмену отправки (разрешить повторную отправку)
   */
  clearCancellation(invoiceId) {
    this.cancelledInvoices.delete(invoiceId);
    console.log(`[AutoSend] Отмена для счета №${invoiceId} снята`);
  }

  /**
   * Получить статус планировщика
   */
  getStatus() {
    return {
      isRunning: this.intervalId !== null,
      isProcessing: this.isProcessing,
      checkInterval: this.checkInterval,
      sendDelay: this.sendDelay,
      upcomingInvoices: this.db.getInvoicesForAutoSend().length,
      queueLength: this.sendQueue.length,
      currentSending: this.currentSending ? this.currentSending.invoiceNumber : null
    };
  }
}

export default AutoSendScheduler;
