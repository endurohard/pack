// InvoiceDatabase передаётся через конструктор
import WhatsAppManager from './whatsappManager.js';
import { getInvoiceSentDate, daysBetween, getDaysWord, isMoscowWorkingHours, getMoscowHour } from './dateUtils.js';
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
  constructor(whatsappManager, db) {
    this.db = db;
    this.whatsappManager = whatsappManager;
    this.isProcessing = false;
    this.checkInterval = 24 * 60 * 60 * 1000; // 24 часа в миллисекундах
    this.sendDelay = 10 * 60 * 1000; // 10 минут задержка между отправками
    this.intervalId = null;
    this.checkHour = 7; // 7:00 UTC = 10:00 МСК // Время проверки - 10:00 утра

    // Очередь отправки напоминаний
    this.reminderQueue = [];
    this.currentSending = null;
    this.cancelledReminders = new Set(); // ID счетов, напоминание которых отменено
    this.manualQueue = [];
    this.isProcessingManual = false;
    this.MANUAL_QUEUE_DELAY = 5 * 60 * 1000; // 5 minutes between sends
  }

  /**
   * Запустить сервис
   */
  start() {
    console.log('[PaymentReminder] Сервис напоминаний об оплате запущен');
    console.log('[PaymentReminder] Время ежедневной проверки: 10:00 МСК (07:00 UTC)');

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
      // Проверяем рабочие часы по МСК (10:00-20:00)
      if (!isMoscowWorkingHours()) {
        console.log('[PaymentReminder] Сейчас нерабочее время по МСК (допустимо 10:00-20:00), пропускаем отправку');
        return;
      }

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

      // Счет должен быть отправлен через WhatsApp
      if (!invoice.lastWhatsAppSent) {
        return false;
      }

      // Есть номер телефона клиента
      if (!invoice.clientPhone) return false;

      // Проверяем, включены ли напоминания для этого счета
      // Если reminderEnabled явно установлен в false, пропускаем счет
      if (invoice.reminderEnabled === false) {
        return false;
      }

      // Напоминания отправляем по умолчанию для всех отправленных неоплаченных счетов
      // Используем дату отправки через WhatsApp, если есть, иначе дату отправки клиенту
      const sentDate = invoice.lastWhatsAppSent
        ? new Date(invoice.lastWhatsAppSent)
        : new Date(invoice.sentToClientAt);

      // Если счет отправлен сегодня (по календарному дню), не отправляем напоминание.
      // Сравниваем календарные дни, а не разницу в 24 часа: счет, отправленный вчера днем,
      // должен получить напоминание уже при утренней проверке.
      const sentDay = new Date(sentDate);
      sentDay.setHours(0, 0, 0, 0);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (sentDay.getTime() === today.getTime()) {
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
    // Дополнительная проверка: перечитываем счет из БД перед отправкой
    // (на случай если он был оплачен уже после попадания в очередь)
    const freshInvoice = this.db.getInvoiceById(invoice.id);
    if (!freshInvoice) {
      throw new Error('Счет не найден в базе данных');
    }

    // Проверяем, не оплачен ли счет
    if (freshInvoice.paid) {
      console.log(`[PaymentReminder] ⚠️ Счет №${invoice.invoiceNumber} уже оплачен, пропускаем напоминание`);
      throw new Error('Счет уже оплачен');
    }

    // Проверяем полную оплату через paidAmount
    const paidAmount = freshInvoice.paidAmount || 0;
    if (paidAmount >= freshInvoice.amount) {
      console.log(`[PaymentReminder] ⚠️ Счет №${invoice.invoiceNumber} полностью оплачен (${paidAmount} >= ${freshInvoice.amount}), пропускаем напоминание`);
      throw new Error('Счет полностью оплачен');
    }

    // Проверяем наличие номера телефона
    if (!freshInvoice.clientPhone) {
      throw new Error('У клиента не указан номер телефона');
    }

    // Нормализуем номер телефона
    let phone = freshInvoice.clientPhone.replace(/\D/g, '');
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

    // Получаем дату для расчета просрочки через централизованную функцию
    const sentDate = getInvoiceSentDate(freshInvoice) || new Date(freshInvoice.createdAt);
    const now = new Date();
    const daysPassed = daysBetween(sentDate, now);

    // Вычисляем остаток к оплате с учетом частичной оплаты
    const remainingAmount = freshInvoice.amount - paidAmount;
    const totalAmount = freshInvoice.amount;

    // Получаем шаблон сообщения
    const messageTemplate = this.getReminderMessageTemplate();

    // Формируем сообщение-напоминание, подставляя значения
    let message = messageTemplate
      .replace(/{номер}/g, freshInvoice.invoiceNumber)
      .replace(/{клиент}/g, freshInvoice.client)
      .replace(/{сумма}/g, totalAmount?.toLocaleString('ru-RU'))
      .replace(/{дата}/g, sentDate.toLocaleDateString('ru-RU'))
      .replace(/{дни}/g, `${daysPassed} ${getDaysWord(daysPassed)}`);

    // Если есть частичная оплата, добавляем информацию об остатке
    if (paidAmount > 0 && remainingAmount > 0) {
      message += `\n\n💰 Уже оплачено: ${paidAmount.toLocaleString('ru-RU')} ₽`;
      message += `\n⚠️ Остаток к оплате: ${remainingAmount.toLocaleString('ru-RU')} ₽`;
    }

    // Добавляем информацию о тестовом режиме
    if (settings.testMode && settings.testPhone && originalPhone !== settings.testPhone) {
      message = `🧪 ТЕСТОВОЕ НАПОМИНАНИЕ\nДля клиента: ${freshInvoice.client} (${originalPhone})\n\n` + message;
    }

    console.log(`[PaymentReminder] Отправка напоминания для счета №${freshInvoice.invoiceNumber}`);
    console.log(`[PaymentReminder] Телефон: ${phone}`);
    console.log(`[PaymentReminder] Сообщение (только текст, без файла):\n${message}`);

    // Отправляем только текст через WhatsApp (без PDF файла)
    // Retry один раз при ошибке "context destroyed" (навигация страницы)
    let result;
    try {
      result = await this.whatsappManager.sendMessage(phone, message);
    } catch (err) {
      if (err.message && err.message.includes('context was destroyed')) {
        console.log(`[PaymentReminder] Контекст уничтожен, повтор через 5 сек...`);
        await this.sleep(5000);
        result = await this.whatsappManager.sendMessage(phone, message);
      } else {
        throw err;
      }
    }

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

  addToManualQueue(invoiceIds) {
    const results = [];
    for (const invoiceId of invoiceIds) {
      const invoice = this.db.getInvoiceById(invoiceId);
      if (!invoice) { results.push({ invoiceId, success: false, error: 'Счет не найден' }); continue; }
      if (invoice.paid) { results.push({ invoiceId, success: false, error: 'Счет оплачен' }); continue; }
      if (!invoice.clientPhone) { results.push({ invoiceId, success: false, error: 'Нет номера телефона' }); continue; }
      if (this.manualQueue.some(item => item.invoice.id === invoiceId)) {
        results.push({ invoiceId, success: false, error: 'Уже в очереди' }); continue;
      }
      this.manualQueue.push({ invoice, status: 'pending', addedAt: new Date().toISOString() });
      results.push({ invoiceId, invoiceNumber: invoice.invoiceNumber, client: invoice.client, success: true });
    }
    if (!this.isProcessingManual && this.manualQueue.some(i => i.status === 'pending')) {
      this.processManualQueue();
    }
    return results;
  }

  async processManualQueue() {
    if (this.isProcessingManual) return;
    this.isProcessingManual = true;
    try {
      while (true) {
        const next = this.manualQueue.find(item => item.status === 'pending');
        if (!next) break;
        next.status = 'sending';
        console.log(`[ManualQueue] Отправка напоминания для счета №${next.invoice.invoiceNumber} (${next.invoice.client})`);
        try {
          await this.sendReminder(next.invoice);
          next.status = 'sent';
          next.sentAt = new Date().toISOString();
          this.db.updateInvoice(next.invoice.id, {
            lastReminderSentAt: next.sentAt,
            reminderCount: (next.invoice.reminderCount || 0) + 1
          });
          console.log(`[ManualQueue] ✅ Напоминание для счета №${next.invoice.invoiceNumber} отправлено`);
        } catch (error) {
          next.status = 'failed';
          next.error = error.message;
          console.error(`[ManualQueue] ❌ Ошибка для счета №${next.invoice.invoiceNumber}:`, error.message);
        }
        const hasMore = this.manualQueue.some(item => item.status === 'pending');
        if (hasMore) {
          console.log(`[ManualQueue] Ожидание 5 минут перед следующей отправкой...`);
          await this.sleep(this.MANUAL_QUEUE_DELAY);
        }
      }
    } finally {
      this.isProcessingManual = false;
    }
  }

  getManualQueueStatus() {
    return {
      items: this.manualQueue.map(item => ({
        invoiceId: item.invoice.id,
        invoiceNumber: item.invoice.invoiceNumber,
        client: item.invoice.client,
        phone: item.invoice.clientPhone,
        status: item.status,
        addedAt: item.addedAt,
        sentAt: item.sentAt || null,
        error: item.error || null
      })),
      isProcessing: this.isProcessingManual,
      pendingCount: this.manualQueue.filter(i => i.status === 'pending').length,
      sendingCount: this.manualQueue.filter(i => i.status === 'sending').length,
      sentCount: this.manualQueue.filter(i => i.status === 'sent').length,
      failedCount: this.manualQueue.filter(i => i.status === 'failed').length
    };
  }

  removeFromManualQueue(invoiceId) {
    const idx = this.manualQueue.findIndex(i => i.invoice.id === invoiceId && i.status === 'pending');
    if (idx !== -1) {
      this.manualQueue.splice(idx, 1);
      return { success: true };
    }
    return { success: false, error: 'Не найдено или уже отправляется' };
  }

  clearManualQueue() {
    const removed = this.manualQueue.filter(i => i.status === 'pending').length;
    this.manualQueue = this.manualQueue.filter(i => i.status !== 'pending');
    return { removed };
  }
}

export default PaymentReminderService;
