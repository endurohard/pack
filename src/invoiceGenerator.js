import PDFDocument from 'pdfkit';
import fs from 'fs';
import QRCode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';
import YandexDiskService from './yandexDiskService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Генератор счетов в PDF формате
 */
class InvoiceGenerator {
  /**
   * Создает объект позиции счета
   * @param {string} name - Наименование товара/услуги
   * @param {string} unit - Единица измерения
   * @param {number} quantity - Количество
   * @param {number} price - Цена за единицу
   * @returns {import('./types.js').InvoiceItem} Позиция счета
   */
  createItem(name, unit, quantity, price) {
    return {
      name,
      unit,
      quantity,
      price,
      amount: quantity * price
    };
  }

  /**
   * Создает объект скидки (процентная)
   * @param {number} percent - Процент скидки
   * @param {string} [description] - Описание скидки
   * @returns {import('./types.js').Discount} Скидка
   */
  createPercentDiscount(percent, description) {
    return {
      value: percent,
      type: 'percent',
      description
    };
  }

  /**
   * Создает объект скидки (фиксированная сумма)
   * @param {number} amount - Сумма скидки
   * @param {string} [description] - Описание скидки
   * @returns {import('./types.js').Discount} Скидка
   */
  createFixedDiscount(amount, description) {
    return {
      value: amount,
      type: 'fixed',
      description
    };
  }

  /**
   * Форматирует число как денежную сумму
   * @param {number} amount - Сумма
   * @returns {string} Отформатированная сумма
   */
  formatAmount(amount) {
    return amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }

  /**
   * Генерирует QR-код для платежной информации
   * @param {Object} payment - Платежная информация
   * @returns {Promise<string>} Base64 строка изображения QR-кода
   */
  async generateQRCode(payment) {
    const qrData = `Оплата по карте: ${payment.cardNumber}\nСБП ${payment.sbpBank}: ${payment.sbpPhone}`;
    try {
      const qrCodeDataUrl = await QRCode.toDataURL(qrData, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 150
      });
      return qrCodeDataUrl;
    } catch (err) {
      console.error('Ошибка генерации QR-кода:', err);
      return null;
    }
  }

  /**
   * Генерирует PDF счет
   * @param {import('./types.js').InvoiceData} invoiceData - Данные счета
   * @param {string} outputPath - Путь для сохранения PDF
   * @returns {Promise<string>} Путь к созданному файлу
   */
  async generateInvoice(invoiceData, outputPath) {
    return new Promise(async (resolve, reject) => {
      try {
        // Создаем PDF документ
        const doc = new PDFDocument({
          size: 'A4',
          margins: { top: 50, bottom: 50, left: 50, right: 50 }
        });

        // Создаем поток для записи
        const stream = fs.createWriteStream(outputPath);
        doc.pipe(stream);

        // Регистрируем русский шрифт
        const fontPath = path.join(__dirname, '../fonts/DejaVuSans.ttf');
        const fontBoldPath = path.join(__dirname, '../fonts/DejaVuSans-Bold.ttf');

        // Проверяем наличие шрифтов, если нет - используем встроенные
        const useCustomFont = fs.existsSync(fontPath);

        if (useCustomFont) {
          doc.registerFont('DejaVu', fontPath);
          doc.registerFont('DejaVuBold', fontBoldPath);
        }

        // Заголовок
        doc.fontSize(16)
           .font(useCustomFont ? 'DejaVuBold' : 'Helvetica-Bold')
           .text(`Счет № ${invoiceData.invoiceNumber}`, { align: 'center' });

        // Клиент
        if (invoiceData.clientName) {
          doc.moveDown(0.5);
          doc.fontSize(11)
             .font(useCustomFont ? 'DejaVu' : 'Helvetica')
             .text(`Клиент: ${invoiceData.clientName}`, { align: 'center' });
        }

        doc.moveDown(2);

        // Таблица с товарами
        const tableTop = doc.y;
        const colWidths = {
          num: 30,
          name: 200,
          unit: 50,
          quantity: 60,
          price: 80,
          amount: 80
        };

        // Заголовки таблицы
        doc.fontSize(10)
           .font(useCustomFont ? 'DejaVuBold' : 'Helvetica-Bold');

        let x = 50;
        doc.rect(x, tableTop, 495, 30).stroke();

        // Рисуем заголовки
        doc.text('№', x + 5, tableTop + 10, { width: colWidths.num - 10, align: 'center' });
        x += colWidths.num;
        doc.rect(x, tableTop, colWidths.name, 30).stroke();
        doc.text('Наименование', x + 5, tableTop + 10, { width: colWidths.name - 10, align: 'center' });
        x += colWidths.name;
        doc.rect(x, tableTop, colWidths.unit, 30).stroke();
        doc.text('Ед.\nизм', x + 5, tableTop + 5, { width: colWidths.unit - 10, align: 'center' });
        x += colWidths.unit;
        doc.rect(x, tableTop, colWidths.quantity, 30).stroke();
        doc.text('Кол-во', x + 5, tableTop + 10, { width: colWidths.quantity - 10, align: 'center' });
        x += colWidths.quantity;
        doc.rect(x, tableTop, colWidths.price, 30).stroke();
        doc.text('Цена', x + 5, tableTop + 10, { width: colWidths.price - 10, align: 'center' });
        x += colWidths.price;
        doc.rect(x, tableTop, colWidths.amount, 30).stroke();
        doc.text('Сумма', x + 5, tableTop + 10, { width: colWidths.amount - 10, align: 'center' });

        // Строки с товарами
        let currentY = tableTop + 30;
        doc.font(useCustomFont ? 'DejaVu' : 'Helvetica');

        let totalQuantity = 0;
        let totalAmount = 0;

        invoiceData.items.forEach((item, index) => {
          totalQuantity += item.quantity;
          totalAmount += item.amount;

          const rowHeight = 30;
          x = 50;

          // Номер
          doc.rect(x, currentY, colWidths.num, rowHeight).stroke();
          doc.text(String(index + 1), x + 5, currentY + 10, { width: colWidths.num - 10, align: 'center' });
          x += colWidths.num;

          // Наименование
          doc.rect(x, currentY, colWidths.name, rowHeight).stroke();
          doc.text(item.name, x + 5, currentY + 10, { width: colWidths.name - 10 });
          x += colWidths.name;

          // Единица измерения
          doc.rect(x, currentY, colWidths.unit, rowHeight).stroke();
          doc.text(item.unit, x + 5, currentY + 10, { width: colWidths.unit - 10, align: 'center' });
          x += colWidths.unit;

          // Количество
          doc.rect(x, currentY, colWidths.quantity, rowHeight).stroke();
          doc.text(String(item.quantity), x + 5, currentY + 10, { width: colWidths.quantity - 10, align: 'center' });
          x += colWidths.quantity;

          // Цена
          doc.rect(x, currentY, colWidths.price, rowHeight).stroke();
          doc.text(this.formatAmount(item.price), x + 5, currentY + 10, { width: colWidths.price - 10, align: 'right' });
          x += colWidths.price;

          // Сумма
          doc.rect(x, currentY, colWidths.amount, rowHeight).stroke();
          doc.text(this.formatAmount(item.amount), x + 5, currentY + 10, { width: colWidths.amount - 10, align: 'right' });

          currentY += rowHeight;
        });

        // Итого
        const totalRowHeight = 30;
        x = 50;
        doc.font(useCustomFont ? 'DejaVuBold' : 'Helvetica-Bold');

        doc.rect(x, currentY, colWidths.num, totalRowHeight).stroke();
        x += colWidths.num;
        doc.rect(x, currentY, colWidths.name, totalRowHeight).stroke();
        doc.text('Итого:', x + 5, currentY + 10, { width: colWidths.name - 10 });
        x += colWidths.name;
        doc.rect(x, currentY, colWidths.unit, totalRowHeight).stroke();
        x += colWidths.unit;
        doc.rect(x, currentY, colWidths.quantity, totalRowHeight).stroke();
        doc.text(String(totalQuantity), x + 5, currentY + 10, { width: colWidths.quantity - 10, align: 'center' });
        x += colWidths.quantity;
        doc.rect(x, currentY, colWidths.price, totalRowHeight).stroke();
        x += colWidths.price;
        doc.rect(x, currentY, colWidths.amount, totalRowHeight).stroke();
        doc.text(this.formatAmount(totalAmount), x + 5, currentY + 10, { width: colWidths.amount - 10, align: 'right' });

        currentY += totalRowHeight;

        // Скидка (если есть)
        let discountAmount = 0;
        let finalAmount = totalAmount;

        if (invoiceData.discount) {
          currentY += 5;

          if (invoiceData.discount.type === 'percent') {
            discountAmount = totalAmount * (invoiceData.discount.value / 100);
          } else if (invoiceData.discount.type === 'fixed') {
            discountAmount = invoiceData.discount.value;
          }

          finalAmount = totalAmount - discountAmount;

          // Строка скидки
          doc.font(useCustomFont ? 'DejaVu' : 'Helvetica').fontSize(10);
          const discountLabel = invoiceData.discount.description
            ? `Скидка (${invoiceData.discount.description}):`
            : invoiceData.discount.type === 'percent'
              ? `Скидка (${invoiceData.discount.value}%):`
              : 'Скидка:';

          doc.text(discountLabel, 50, currentY, { width: 385, align: 'right' });
          doc.text(`-${this.formatAmount(discountAmount)}`, 435, currentY, { width: 110, align: 'right' });

          currentY += 20;

          // Итого к оплате
          doc.font(useCustomFont ? 'DejaVuBold' : 'Helvetica-Bold').fontSize(12);
          doc.text('Итого к оплате:', 50, currentY, { width: 385, align: 'right' });
          doc.text(this.formatAmount(finalAmount), 435, currentY, { width: 110, align: 'right' });
        }

        currentY += 20;

        // Платежная информация
        doc.font(useCustomFont ? 'DejaVu' : 'Helvetica')
           .fontSize(10);

        doc.text(`Оплату произвести по номеру карты ${invoiceData.payment.cardNumber}`, 50, currentY);
        doc.text(`СБП ${invoiceData.payment.sbpBank} - ${invoiceData.payment.sbpPhone}`, 50, currentY + 15);

        // QR-код
        const qrCodeImage = await this.generateQRCode(invoiceData.payment);
        if (qrCodeImage) {
          const qrY = currentY + 40;
          doc.image(qrCodeImage, 50, qrY, { width: 150 });
        }

        // Номер страницы
        const pageHeight = doc.page.height;
        doc.fontSize(9)
           .text(`Страница № 1`, 50, pageHeight - 50, { align: 'right' });

        // Завершаем документ
        doc.end();

        stream.on('finish', () => {
          resolve(outputPath);
        });

        stream.on('error', (err) => {
          reject(err);
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Генерирует счет и загружает его на Яндекс.Диск
   * @param {import('./types.js').InvoiceData} invoiceData - Данные счета
   * @param {string} outputPath - Локальный путь для сохранения PDF
   * @param {string} yandexToken - OAuth токен Яндекс.Диска
   * @param {string} remotePath - Путь на Яндекс.Диске (например, '/Счета/invoice_672.pdf')
   * @param {Object} options - Дополнительные опции
   * @param {boolean} options.createFolder - Создавать папку, если не существует
   * @param {boolean} options.publish - Сделать файл публичным
   * @param {boolean} options.deleteLocal - Удалить локальный файл после загрузки
   * @returns {Promise<Object>} Результат с путями и ссылками
   */
  async generateAndUploadToYandexDisk(invoiceData, outputPath, yandexToken, remotePath, options = {}) {
    const {
      createFolder = true,
      publish = false,
      deleteLocal = false
    } = options;

    try {
      // Генерируем PDF
      const localPath = await this.generateInvoice(invoiceData, outputPath);

      // Создаем сервис Яндекс.Диска
      const yandexDisk = new YandexDiskService(yandexToken);

      // Создаем папку, если нужно
      if (createFolder) {
        const folderPath = path.dirname(remotePath);
        if (folderPath !== '/' && folderPath !== '.') {
          await yandexDisk.createFolder(folderPath);
        }
      }

      // Загружаем файл
      const uploadResult = await yandexDisk.uploadFile(localPath, remotePath);

      let publicUrl = null;

      // Публикуем файл, если нужно
      if (publish) {
        publicUrl = await yandexDisk.publishFile(remotePath);
      }

      // Удаляем локальный файл, если нужно
      if (deleteLocal && fs.existsSync(localPath)) {
        fs.unlinkSync(localPath);
      }

      return {
        success: true,
        localPath: deleteLocal ? null : localPath,
        remotePath: remotePath,
        publicUrl: publicUrl,
        uploadResult: uploadResult
      };

    } catch (error) {
      throw new Error(`Ошибка генерации и загрузки счета: ${error.message}`);
    }
  }
}

export default InvoiceGenerator;
