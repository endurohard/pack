import InvoiceGenerator from './invoiceGenerator.js';
import YandexDiskService from './yandexDiskService.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Упрощенный сервис для генерации и загрузки счетов
 * Работает "из коробки" с минимальной настройкой
 */
class SimpleInvoiceService {
  constructor(config = {}) {
    // Загружаем переменные окружения
    dotenv.config();

    this.generator = new InvoiceGenerator();

    // Конфигурация по умолчанию
    this.config = {
      yandexToken: process.env.YANDEX_DISK_TOKEN || config.yandexToken,
      yandexFolder: process.env.YANDEX_DISK_FOLDER || config.yandexFolder || '/Счета',
      localOutputFolder: config.localOutputFolder || path.join(__dirname, '../output'),
      autoUpload: config.autoUpload !== false, // По умолчанию включено
      createFolder: config.createFolder !== false, // По умолчанию включено
      publishLinks: config.publishLinks || false,
      keepLocalCopy: config.keepLocalCopy !== false // По умолчанию сохраняем
    };

    // Проверяем наличие папки для локальных файлов
    if (!fs.existsSync(this.config.localOutputFolder)) {
      fs.mkdirSync(this.config.localOutputFolder, { recursive: true });
    }

    // Инициализируем Яндекс.Диск, если есть токен
    if (this.config.yandexToken) {
      this.yandexDisk = new YandexDiskService(this.config.yandexToken);
      this.yandexEnabled = true;
    } else {
      this.yandexEnabled = false;
      console.warn('⚠️  Токен Яндекс.Диска не найден. Файлы будут сохраняться только локально.');
      console.warn('   Запустите: node src/setupYandexDisk.js для настройки.');
    }
  }

  /**
   * Создает счет и автоматически загружает его (если настроен Яндекс.Диск)
   * @param {Object} invoiceData - Данные счета
   * @param {string} [filename] - Имя файла (опционально, генерируется автоматически)
   * @returns {Promise<Object>} Результат с путями и ссылками
   */
  async createInvoice(invoiceData, filename) {
    // Генерируем имя файла, если не указано
    if (!filename) {
      filename = `invoice_${invoiceData.invoiceNumber}_${Date.now()}.pdf`;
    }

    // Убеждаемся, что есть расширение .pdf
    if (!filename.endsWith('.pdf')) {
      filename += '.pdf';
    }

    const localPath = path.join(this.config.localOutputFolder, filename);
    const remotePath = `${this.config.yandexFolder}/${filename}`;

    try {
      // Если Яндекс.Диск настроен и автозагрузка включена
      if (this.yandexEnabled && this.config.autoUpload) {
        console.log(`📄 Генерация счета №${invoiceData.invoiceNumber}...`);

        const result = await this.generator.generateAndUploadToYandexDisk(
          invoiceData,
          localPath,
          this.config.yandexToken,
          remotePath,
          {
            createFolder: this.config.createFolder,
            publish: this.config.publishLinks,
            deleteLocal: !this.config.keepLocalCopy
          }
        );

        console.log(`✅ Счет создан и загружен на Яндекс.Диск`);
        if (result.localPath) {
          console.log(`   Локально: ${result.localPath}`);
        }
        console.log(`   На диске: ${result.remotePath}`);
        if (result.publicUrl) {
          console.log(`   Публичная ссылка: ${result.publicUrl}`);
        }

        return result;

      } else {
        // Только локальное сохранение
        console.log(`📄 Генерация счета №${invoiceData.invoiceNumber}...`);
        await this.generator.generateInvoice(invoiceData, localPath);

        console.log(`✅ Счет создан локально: ${localPath}`);

        return {
          success: true,
          localPath: localPath,
          remotePath: null,
          publicUrl: null
        };
      }

    } catch (error) {
      console.error(`❌ Ошибка создания счета: ${error.message}`);
      throw error;
    }
  }

  /**
   * Создает позицию счета
   */
  createItem(name, unit, quantity, price) {
    return this.generator.createItem(name, unit, quantity, price);
  }

  /**
   * Создает процентную скидку
   */
  createPercentDiscount(percent, description) {
    return this.generator.createPercentDiscount(percent, description);
  }

  /**
   * Создает фиксированную скидку
   */
  createFixedDiscount(amount, description) {
    return this.generator.createFixedDiscount(amount, description);
  }

  /**
   * Получает список счетов на Яндекс.Диске
   */
  async listInvoices() {
    if (!this.yandexEnabled) {
      throw new Error('Яндекс.Диск не настроен');
    }

    try {
      const files = await this.yandexDisk.listFiles(this.config.yandexFolder);
      return files.filter(f => f.name.endsWith('.pdf'));
    } catch (error) {
      console.error(`❌ Ошибка получения списка: ${error.message}`);
      throw error;
    }
  }

  /**
   * Получает информацию о диске
   */
  async getDiskInfo() {
    if (!this.yandexEnabled) {
      throw new Error('Яндекс.Диск не настроен');
    }

    return await this.yandexDisk.getDiskInfo();
  }

  /**
   * Проверяет настройку Яндекс.Диска
   */
  isYandexDiskConfigured() {
    return this.yandexEnabled;
  }
}

export default SimpleInvoiceService;
