import InvoiceDatabase from './invoiceDatabase.js';
import WhatsAppManager from './whatsappManager.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Планировщик автоматической отправки счетов
 * Проверяет каждые 10 минут наличие счетов для отправки
 * Отправляет счета с интервалом 10 минут между разными компаниями
 */
class AutoSendScheduler {
  constructor(whatsappManager) {
    this.db = new InvoiceDatabase();
    this.whatsappManager = whatsappManager;
    this.isProcessing = false;
    this.checkInterval = 10 * 60 * 1000; // 10 минут в миллисекундах
    this.sendDelay = 10 * 60 * 1000; // 10 минут задержка между отправками
    this.intervalId = null;
  }

  /**
   * Запустить планировщик
   */
  start() {
    console.log('[AutoSend] Планировщик автоматической рассылки запущен');
    console.log('[AutoSend] Интервал проверки: 10 минут');
    console.log('[AutoSend] Задержка между отправками: 10 минут');

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
   * Проверить, наступило ли время рассылки
   */
  isTimeToSend() {
    const settings = this.getSettings();
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    const targetHour = settings.sendTimeHour || 10;
    const targetMinute = settings.sendTimeMinute || 0;

    // Проверяем, что текущее время находится в пределах 10 минут от целевого времени
    // (так как проверка происходит каждые 10 минут)
    const currentTotalMinutes = currentHour * 60 + currentMinute;
    const targetTotalMinutes = targetHour * 60 + targetMinute;

    // Разрешаем отправку в течение 10 минут после указанного времени
    const diff = currentTotalMinutes - targetTotalMinutes;
    return diff >= 0 && diff < 10;
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

      // Проверяем, наступило ли время рассылки
      if (!this.isTimeToSend()) {
        const settings = this.getSettings();
        console.log(`[AutoSend] Время рассылки еще не наступило. Запланировано на ${settings.sendTimeHour}:${String(settings.sendTimeMinute).padStart(2, '0')}`);
        return;
      }

      console.log('[AutoSend] Время рассылки наступило! Проверка счетов для автоматической отправки...');

      const invoices = this.db.getInvoicesForAutoSend();

      if (invoices.length === 0) {
        console.log('[AutoSend] Нет счетов для отправки');
        return;
      }

      console.log(`[AutoSend] Найдено счетов для отправки: ${invoices.length}`);

      // Фильтруем счета: исключаем клиентов, которым уже отправляли сегодня
      const filteredInvoices = invoices.filter(invoice => {
        if (!invoice.clientPhone) {
          console.log(`[AutoSend] Пропускаем счет №${invoice.invoiceNumber}: нет номера телефона`);
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

      // Отправляем счета с задержкой между ними
      for (let i = 0; i < filteredInvoices.length; i++) {
        const invoice = filteredInvoices[i];

        console.log(`[AutoSend] Отправка счета ${i + 1}/${filteredInvoices.length}: №${invoice.invoiceNumber} для клиента ${invoice.client}`);

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

        } catch (error) {
          console.error(`[AutoSend] ❌ Ошибка при отправке счета №${invoice.invoiceNumber}:`, error.message);
        }

        // Ждем 10 минут перед следующей отправкой (кроме последнего)
        if (i < filteredInvoices.length - 1) {
          console.log(`[AutoSend] Ожидание 10 минут перед следующей отправкой...`);
          await this.sleep(this.sendDelay);
        }
      }

      console.log('[AutoSend] Все счета обработаны');

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
   * Отправить счет через WhatsApp
   */
  async sendInvoice(invoice) {
    // Проверяем наличие номера телефона
    if (!invoice.clientPhone) {
      throw new Error('У клиента не указан номер телефона');
    }

    // Нормализуем номер телефона
    let phone = invoice.clientPhone.replace(/\D/g, '');
    if (phone.startsWith('8')) {
      phone = '7' + phone.substring(1);
    }
    if (!phone.startsWith('7')) {
      phone = '7' + phone;
    }

    // Формируем сообщение из шаблона
    let messageTemplate = this.getGreetingMessageTemplate();
    const message = messageTemplate.replace(/{номер}/g, invoice.invoiceNumber);

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

  /**
   * Задержка
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
      upcomingInvoices: this.db.getInvoicesForAutoSend().length
    };
  }
}

export default AutoSendScheduler;
