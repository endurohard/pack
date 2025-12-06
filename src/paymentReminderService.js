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

      // Отправляем напоминания с задержкой между ними
      for (let i = 0; i < unpaidInvoices.length; i++) {
        const invoice = unpaidInvoices[i];

        console.log(`[PaymentReminder] Отправка напоминания ${i + 1}/${unpaidInvoices.length}: №${invoice.invoiceNumber} для клиента ${invoice.client}`);

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

        // Ждем 10 минут перед следующей отправкой (кроме последнего)
        if (i < unpaidInvoices.length - 1) {
          console.log(`[PaymentReminder] Ожидание 10 минут перед следующей отправкой...`);
          await this.sleep(this.sendDelay);
        }
      }

      console.log('[PaymentReminder] Все напоминания отправлены');

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

      // Напоминания включены
      if (!invoice.reminderEnabled) return false;

      // Счет должен быть отправлен через WhatsApp хотя бы один раз
      if (!invoice.lastWhatsAppSent) {
        console.log(`[PaymentReminder] Счет №${invoice.invoiceNumber} пропущен - не был отправлен через WhatsApp`);
        return false;
      }

      // Есть номер телефона клиента
      if (!invoice.clientPhone) return false;

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
    return 'Добрый день!\n\nНапоминаем об оплате счета №{номер}.\n\nКлиент: {клиент}\nСумма: {сумма} ₽\nДата выставления: {дата}\nПросрочка: {дни}\n\nПожалуйста, произведите оплату в ближайшее время.\n\nС уважением.';
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

    // Вычисляем количество дней с момента создания счета
    const createdDate = new Date(invoice.createdAt);
    const now = new Date();
    const daysPassed = Math.floor((now - createdDate) / (1000 * 60 * 60 * 24));

    // Получаем шаблон сообщения
    const messageTemplate = this.getReminderMessageTemplate();

    // Формируем сообщение-напоминание, подставляя значения
    const message = messageTemplate
      .replace(/{номер}/g, invoice.invoiceNumber)
      .replace(/{клиент}/g, invoice.client)
      .replace(/{сумма}/g, invoice.amount?.toLocaleString('ru-RU'))
      .replace(/{дата}/g, createdDate.toLocaleDateString('ru-RU'))
      .replace(/{дни}/g, `${daysPassed} ${this.getDaysWord(daysPassed)}`);

    // Ищем PDF файл счета
    const invoicesDir = path.join(__dirname, '../output');
    const files = fs.readdirSync(invoicesDir);

    const pdfFile = files.find(f => {
      if (!f.endsWith('.pdf')) return false;

      // Приводим номер счета к числу для сравнения (убираем ведущие нули)
      const invoiceNum = parseInt(invoice.invoiceNumber, 10);

      // Проверяем новый формат: Счет_NUMBER_...
      const newFormatMatch = f.match(/^Счет_(\d+)_/);
      if (newFormatMatch && parseInt(newFormatMatch[1], 10) === invoiceNum) {
        return true;
      }

      // Проверяем старый формат: invoice_NUMBER_...
      const oldFormatMatch = f.match(/^invoice_(\d+)_/);
      if (oldFormatMatch && parseInt(oldFormatMatch[1], 10) === invoiceNum) {
        return true;
      }

      return false;
    });

    if (!pdfFile) {
      throw new Error(`PDF файл для счета №${invoice.invoiceNumber} не найден`);
    }

    const filePath = path.join(invoicesDir, pdfFile);

    console.log(`[PaymentReminder] Отправка напоминания для счета №${invoice.invoiceNumber}`);
    console.log(`[PaymentReminder] Телефон: ${phone}`);
    console.log(`[PaymentReminder] Файл: ${pdfFile}`);
    console.log(`[PaymentReminder] Сообщение:\n${message}`);

    // Отправляем через WhatsApp
    const result = await this.whatsappManager.sendMessageWithFile(phone, message, filePath);

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
   * Получить статус сервиса
   */
  getStatus() {
    return {
      isRunning: this.intervalId !== null,
      isProcessing: this.isProcessing,
      checkInterval: this.checkInterval,
      sendDelay: this.sendDelay,
      upcomingReminders: this.getUnpaidInvoicesWithReminders().length
    };
  }
}

export default PaymentReminderService;
