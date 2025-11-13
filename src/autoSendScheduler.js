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
        console.log('[AutoSend] Нет счетов для отправки');
        return;
      }

      console.log(`[AutoSend] Найдено счетов для отправки: ${invoices.length}`);

      // Отправляем счета с задержкой между ними
      for (let i = 0; i < invoices.length; i++) {
        const invoice = invoices[i];

        console.log(`[AutoSend] Отправка счета ${i + 1}/${invoices.length}: №${invoice.invoiceNumber} для клиента ${invoice.client}`);

        try {
          await this.sendInvoice(invoice);

          // Обновляем дату следующей отправки (сдвигаем на месяц)
          this.db.updateNextSendDate(invoice.id);

          console.log(`[AutoSend] ✅ Счет №${invoice.invoiceNumber} успешно отправлен`);
          console.log(`[AutoSend] Следующая отправка: ${new Date(invoice.nextSendDate).toLocaleString('ru-RU')}`);

        } catch (error) {
          console.error(`[AutoSend] ❌ Ошибка при отправке счета №${invoice.invoiceNumber}:`, error.message);
        }

        // Ждем 10 минут перед следующей отправкой (кроме последнего)
        if (i < invoices.length - 1) {
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

    // Формируем сообщение
    const message = `Добрый день! Направляем счет №${invoice.invoiceNumber} на оплату.\n\nКлиент: ${invoice.client}\nСумма: ${invoice.amount?.toLocaleString('ru-RU')} ₽`;

    // Ищем PDF файл счета
    const invoicesDir = path.join(__dirname, '../invoices');
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
