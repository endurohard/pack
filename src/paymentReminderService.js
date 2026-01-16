import InvoiceDatabase from './invoiceDatabase.js';
import WhatsAppManager from './whatsappManager.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Сервис для автоматических напоминаний об оплате
 * Проверяет раз в день неоплаченные счета и отправляет напоминания
 */
class PaymentReminderService {
  constructor(whatsappManager) {
    this.db = new InvoiceDatabase();
    this.whatsappManager = whatsappManager;
    this.isProcessing = false;
    this.checkInterval = 24 * 60 * 60 * 1000; // 24 часа в миллисекундах
    this.sendDelay = 10 * 60 * 1000; // 10 минут задержка между отправками
    this.intervalId = null;
    this.checkHour = 10; // Время проверки - 10:00 утра

    // Очередь отправки напоминаний
    this.reminderQueue = [];
    this.currentSending = null;
    this.cancelledReminders = new Set(); // ID счетов, напоминание которых отменено
  }

  /**
   * Запустить сервис
   */
  start() {
    console.log('[PaymentReminder] Сервис напоминаний об оплате запущен');
    console.log('[PaymentReminder] Время ежедневной проверки: 10:00');

    // Планируем первую проверку на ближайшее 10:00
    this.scheduleNextCheck();
  }

  /**
   * Остановить сервис
   */
  stop() {
    if (this.intervalId) {
      clearTimeout(this.intervalId);
      this.intervalId = null;
      console.log('[PaymentReminder] Сервис напоминаний остановлен');
    }
  }

  /**
   * Планировать следующую проверку
   */
  scheduleNextCheck() {
    const now = new Date();
    const nextCheck = new Date();
    nextCheck.setHours(this.checkHour, 0, 0, 0);

    // Если уже прошло 10:00 сегодня, планируем на завтра
    if (now >= nextCheck) {
      nextCheck.setDate(nextCheck.getDate() + 1);
    }

    const delay = nextCheck - now;
    console.log(`[PaymentReminder] Следующая проверка: ${nextCheck.toLocaleString('ru-RU')}`);

    this.intervalId = setTimeout(() => {
      this.checkAndSendReminders();
      // Планируем следующую проверку через 24 часа
      this.scheduleNextCheck();
    }, delay);
  }

  /**
   * Проверить и отправить напоминания
   */
  async checkAndSendReminders() {
    if (this.isProcessing) {
      console.log('[PaymentReminder] Предыдущая обработка еще не завершена, пропускаем');
      return;
    }

    try {
      this.isProcessing = true;
      console.log('[PaymentReminder] Проверка неоплаченных счетов...');

      const unpaidInvoices = this.getUnpaidInvoicesWithReminders();

      if (unpaidInvoices.length === 0) {
        console.log('[PaymentReminder] Нет неоплаченных счетов с включенными напоминаниями');
        return;
      }

      console.log(`[PaymentReminder] Найдено неоплаченных счетов: ${unpaidInvoices.length}`);

      // Добавляем счета в очередь
      this.reminderQueue = unpaidInvoices;

      // Отправляем напоминания с задержкой между ними
      for (let i = 0; i < this.reminderQueue.length; i++) {
        const invoice = this.reminderQueue[i];

        // Проверяем, не была ли отменена отправка
        if (this.cancelledReminders.has(invoice.id)) {
          console.log(`[PaymentReminder] ⚠️ Отправка напоминания для счета №${invoice.invoiceNumber} отменена`);
          this.cancelledReminders.delete(invoice.id);
          continue;
        }

        this.currentSending = invoice;
        console.log(`[PaymentReminder] Отправка напоминания ${i + 1}/${this.reminderQueue.length}: №${invoice.invoiceNumber} для клиента ${invoice.client}`);

        try {
          await this.sendReminder(invoice);

          // Обновляем дату последнего напоминания
          this.db.updateInvoice(invoice.id, {
            lastReminderSentAt: new Date().toISOString()
          });

          console.log(`[PaymentReminder] ✅ Напоминание для счета №${invoice.invoiceNumber} отправлено`);

        } catch (error) {
          console.error(`[PaymentReminder] ❌ Ошибка при отправке напоминания для счета №${invoice.invoiceNumber}:`, error.message);
        }

        this.currentSending = null;

        // Ждем 10 минут перед следующей отправкой (кроме последнего)
        if (i < this.reminderQueue.length - 1) {
          console.log(`[PaymentReminder] Ожидание 10 минут перед следующей отправкой...`);
          await this.sleep(this.sendDelay);
        }
      }

      console.log('[PaymentReminder] Все напоминания отправлены');
      this.reminderQueue = [];

    } catch (error) {
      console.error('[PaymentReminder] Ошибка при обработке напоминаний:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Получить неоплаченные счета с включенными напоминаниями
   */
  getUnpaidInvoicesWithReminders() {
    const allInvoices = this.db.getAllInvoices();

    return allInvoices.filter(invoice => {
      // Счет не оплачен
      if (invoice.paid) return false;

      // Проверяем, не оплачен ли счет полностью через paidAmount
      const paidAmount = invoice.paidAmount || 0;
      if (paidAmount >= invoice.amount) {
        return false;
      }

      // Счет должен быть отправлен через WhatsApp или вручную клиенту
      if (!invoice.lastWhatsAppSent && !invoice.sentToClientAt) {
        return false;
      }

      // Есть номер телефона клиента
      if (!invoice.clientPhone) return false;

      // Напоминания отправляем по умолчанию для всех отправленных неоплаченных счетов
      // Используем дату отправки через WhatsApp, если есть, иначе дату отправки клиенту
      const sentDate = invoice.lastWhatsAppSent
        ? new Date(invoice.lastWhatsAppSent)
        : new Date(invoice.sentToClientAt);
      const daysSinceSent = Math.floor((new Date() - sentDate) / (1000 * 60 * 60 * 24));

      // Если счет только что отправлен (сегодня), не отправляем напоминание
      if (daysSinceSent === 0) {
        return false;
      }

      // Проверяем, не отправляли ли уже напоминание сегодня
      if (invoice.lastReminderSentAt) {
        const lastReminderDate = new Date(invoice.lastReminderSentAt);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        lastReminderDate.setHours(0, 0, 0, 0);

        // Если напоминание уже отправлялось сегодня, пропускаем
        if (lastReminderDate.getTime() === today.getTime()) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Получить шаблон сообщения-напоминания
   */
  getReminderMessageTemplate() {
    try {
      // Пытаемся прочитать файл настроек, если существует
      const settingsPath = path.join(__dirname, '../data/whatsapp-settings.json');
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        if (settings.reminder) {
          return settings.reminder;
        }
      }
    } catch (error) {
      console.error('[PaymentReminder] Ошибка чтения шаблона сообщения:', error.message);
    }

    // Шаблон по умолчанию
    return 'Добрый день!\n\nНапоминаем об оплате счета №{номер}.\n\n📊 Сумма счета: {сумма} ₽\n📅 Дата выставления: {дата}\n⏰ Прошло: {дни}\n\nПожалуйста, произведите оплату в ближайшее время.\n\nС уважением.';
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
      console.error('[PaymentReminder] Ошибка чтения настроек:', error.message);
    }
    return {};
  }

  /**
   * Отправить напоминание через WhatsApp
   */
  async sendReminder(invoice) {
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

    // Проверяем тестовый режим
    const settings = this.getSettings();
    const originalPhone = phone;
    if (settings.testMode && settings.testPhone) {
      console.log(`[PaymentReminder] 🧪 ТЕСТОВЫЙ РЕЖИМ: Перенаправление с ${phone} на ${settings.testPhone}`);
      phone = settings.testPhone;
    }

    // Вычисляем количество дней с момента ОТПРАВКИ счета (не создания!)
    // Используем дату отправки через WhatsApp, если есть
    // Иначе дату отправки клиенту вручную (sentToClientAt)
    // Иначе дату создания счета
    const sentDate = invoice.lastWhatsAppSent
      ? new Date(invoice.lastWhatsAppSent)
      : invoice.sentToClientAt
        ? new Date(invoice.sentToClientAt)
        : new Date(invoice.createdAt);
    const now = new Date();
    const daysPassed = Math.floor((now - sentDate) / (1000 * 60 * 60 * 24));

    // Вычисляем остаток к оплате с учетом частичной оплаты
    const paidAmount = invoice.paidAmount || 0;
    const remainingAmount = invoice.amount - paidAmount;
    const totalAmount = invoice.amount;

    // Получаем шаблон сообщения
    const messageTemplate = this.getReminderMessageTemplate();

    // Формируем сообщение-напоминание, подставляя значения
    let message = messageTemplate
      .replace(/{номер}/g, invoice.invoiceNumber)
      .replace(/{клиент}/g, invoice.client)
      .replace(/{сумма}/g, totalAmount?.toLocaleString('ru-RU'))
      .replace(/{дата}/g, sentDate.toLocaleDateString('ru-RU'))
      .replace(/{дни}/g, `${daysPassed} ${this.getDaysWord(daysPassed)}`);

    // Если есть частичная оплата, добавляем информацию об остатке
    if (paidAmount > 0 && remainingAmount > 0) {
      message += `\n\n💰 Уже оплачено: ${paidAmount.toLocaleString('ru-RU')} ₽`;
      message += `\n⚠️ Остаток к оплате: ${remainingAmount.toLocaleString('ru-RU')} ₽`;
    }

    // Добавляем информацию о тестовом режиме
    if (settings.testMode && settings.testPhone && originalPhone !== settings.testPhone) {
      message = `🧪 ТЕСТОВОЕ НАПОМИНАНИЕ\nДля клиента: ${invoice.client} (${originalPhone})\n\n` + message;
    }

    console.log(`[PaymentReminder] Отправка напоминания для счета №${invoice.invoiceNumber}`);
    console.log(`[PaymentReminder] Телефон: ${phone}`);
    console.log(`[PaymentReminder] Сообщение (только текст, без файла):\n${message}`);

    // Отправляем только текст через WhatsApp (без PDF файла)
    const result = await this.whatsappManager.sendMessage(phone, message);

    if (!result.success) {
      throw new Error(result.error || 'Не удалось отправить сообщение');
    }

    return result;
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
   * Задержка
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Получить очередь напоминаний
   */
  getQueue() {
    return {
      queue: this.reminderQueue.map(invoice => ({
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        client: invoice.client,
        clientPhone: invoice.clientPhone,
        amount: invoice.amount,
        lastReminderSentAt: invoice.lastReminderSentAt,
        type: 'reminder'
      })),
      currentSending: this.currentSending ? {
        id: this.currentSending.id,
        invoiceNumber: this.currentSending.invoiceNumber,
        client: this.currentSending.client,
        type: 'reminder'
      } : null,
      isProcessing: this.isProcessing
    };
  }

  /**
   * Отменить отправку напоминания
   */
  cancelReminder(invoiceId) {
    // Добавляем в список отмененных
    this.cancelledReminders.add(invoiceId);

    // Удаляем из очереди, если там есть
    const index = this.reminderQueue.findIndex(inv => inv.id === invoiceId);
    if (index !== -1) {
      this.reminderQueue.splice(index, 1);
      console.log(`[PaymentReminder] Напоминание для счета №${invoiceId} удалено из очереди`);
      return { success: true, message: 'Напоминание удалено из очереди' };
    }

    // Проверяем, не отправляется ли сейчас
    if (this.currentSending && this.currentSending.id === invoiceId) {
      console.log(`[PaymentReminder] Отмена текущей отправки напоминания для счета №${invoiceId}`);
      return { success: true, message: 'Текущая отправка будет отменена' };
    }

    return { success: false, message: 'Напоминание не найдено в очереди' };
  }

  /**
   * Очистить отмену напоминания
   */
  clearCancellation(invoiceId) {
    this.cancelledReminders.delete(invoiceId);
    console.log(`[PaymentReminder] Отмена напоминания для счета №${invoiceId} снята`);
  }

  /**
   * Получить статус сервиса
   */
  getStatus() {
    return {
      isRunning: this.intervalId !== null,
      isProcessing: this.isProcessing,
      checkInterval: this.checkInterval,
      sendDelay: this.sendDelay,
      upcomingReminders: this.getUnpaidInvoicesWithReminders().length,
      queueLength: this.reminderQueue.length,
      currentSending: this.currentSending ? this.currentSending.invoiceNumber : null
    };
  }
}

export default PaymentReminderService;
