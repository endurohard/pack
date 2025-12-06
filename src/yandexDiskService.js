import axios from 'axios';
import fs from 'fs';
import path from 'path';

/**
 * Сервис для работы с Яндекс.Диском
 */
class YandexDiskService {
  /**
   * @param {string} oauthToken - OAuth токен для доступа к Яндекс.Диску
   */
  constructor(oauthToken) {
    if (!oauthToken) {
      throw new Error('OAuth токен обязателен для работы с Яндекс.Диском');
    }

    this.oauthToken = oauthToken;
    this.apiUrl = 'https://cloud-api.yandex.net/v1/disk';

    this.client = axios.create({
      baseURL: this.apiUrl,
      headers: {
        'Authorization': `OAuth ${this.oauthToken}`,
        'Content-Type': 'application/json'
      }
    });
  }

  /**
   * Получает информацию о диске
   * @returns {Promise<Object>} Информация о диске
   */
  async getDiskInfo() {
    try {
      const response = await this.client.get('/');
      return response.data;
    } catch (error) {
      throw new Error(`Ошибка получения информации о диске: ${error.message}`);
    }
  }

  /**
   * Создает папку на Яндекс.Диске
   * @param {string} folderPath - Путь к папке (например, '/Счета')
   * @param {number} retries - Количество попыток при ошибке
   * @returns {Promise<Object>} Информация о созданной папке
   */
  async createFolder(folderPath, retries = 3) {
    let lastError;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await this.client.put('/resources', null, {
          params: {
            path: folderPath
          }
        });
        return response.data;
      } catch (error) {
        // Если папка уже существует, это не ошибка
        if (error.response && error.response.status === 409) {
          return { message: 'Папка уже существует' };
        }

        // Если это ошибка 503 (Service Unavailable) или 429 (Too Many Requests), пробуем снова
        if (error.response && (error.response.status === 503 || error.response.status === 429)) {
          lastError = error;
          if (attempt < retries) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // Экспоненциальная задержка
            console.log(`Попытка ${attempt}/${retries} создания папки не удалась (${error.response.status}). Повтор через ${delay}мс...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
        }

        // Для других ошибок сразу выбрасываем исключение
        throw new Error(`Ошибка создания папки: ${error.response?.status || 'неизвестна'} - ${error.message}`);
      }
    }

    // Если все попытки исчерпаны
    throw new Error(`Ошибка создания папки после ${retries} попыток: Яндекс.Диск временно недоступен (${lastError.response?.status})`);
  }

  /**
   * Получает ссылку для загрузки файла
   * @param {string} remotePath - Путь на Яндекс.Диске
   * @param {boolean} overwrite - Перезаписывать файл, если существует
   * @param {number} retries - Количество попыток при ошибке
   * @returns {Promise<string>} URL для загрузки
   */
  async getUploadUrl(remotePath, overwrite = true, retries = 3) {
    let lastError;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await this.client.get('/resources/upload', {
          params: {
            path: remotePath,
            overwrite: overwrite
          }
        });
        return response.data.href;
      } catch (error) {
        // Если это ошибка 503 или 429, пробуем снова
        if (error.response && (error.response.status === 503 || error.response.status === 429)) {
          lastError = error;
          if (attempt < retries) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
            console.log(`Попытка ${attempt}/${retries} получения ссылки для загрузки не удалась (${error.response.status}). Повтор через ${delay}мс...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
        }

        throw new Error(`Ошибка получения ссылки для загрузки: ${error.response?.status || 'неизвестна'} - ${error.message}`);
      }
    }

    throw new Error(`Ошибка получения ссылки после ${retries} попыток: Яндекс.Диск временно недоступен (${lastError.response?.status})`);
  }

  /**
   * Загружает файл на Яндекс.Диск
   * @param {string} localFilePath - Путь к локальному файлу
   * @param {string} remotePath - Путь на Яндекс.Диске
   * @param {boolean} overwrite - Перезаписывать файл, если существует
   * @param {number} retries - Количество попыток при ошибке
   * @returns {Promise<Object>} Результат загрузки
   */
  async uploadFile(localFilePath, remotePath, overwrite = true, retries = 3) {
    // Проверяем существование файла
    if (!fs.existsSync(localFilePath)) {
      throw new Error(`Файл не найден: ${localFilePath}`);
    }

    let lastError;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        // Получаем ссылку для загрузки
        const uploadUrl = await this.getUploadUrl(remotePath, overwrite, retries);

        // Читаем файл
        const fileStream = fs.createReadStream(localFilePath);
        const fileStats = fs.statSync(localFilePath);

        // Загружаем файл
        const response = await axios.put(uploadUrl, fileStream, {
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Length': fileStats.size
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          timeout: 30000 // 30 секунд таймаут
        });

        return {
          success: true,
          remotePath: remotePath,
          localPath: localFilePath,
          size: fileStats.size,
          message: 'Файл успешно загружен на Яндекс.Диск'
        };
      } catch (error) {
        // Если это сетевая ошибка или ошибка 503/429, пробуем снова
        const isRetryable =
          error.code === 'ECONNRESET' ||
          error.code === 'ETIMEDOUT' ||
          (error.response && (error.response.status === 503 || error.response.status === 429));

        if (isRetryable) {
          lastError = error;
          if (attempt < retries) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
            console.log(`Попытка ${attempt}/${retries} загрузки файла не удалась. Повтор через ${delay}мс...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
        }

        throw new Error(`Ошибка загрузки файла: ${error.response?.status || error.code || 'неизвестна'} - ${error.message}`);
      }
    }

    throw new Error(`Ошибка загрузки файла после ${retries} попыток: ${lastError.message}`);
  }

  /**
   * Получает публичную ссылку на файл
   * @param {string} remotePath - Путь к файлу на Яндекс.Диске
   * @param {number} retries - Количество попыток при ошибке
   * @returns {Promise<string>} Публичная ссылка
   */
  async publishFile(remotePath, retries = 3) {
    let lastError;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await this.client.put('/resources/publish', null, {
          params: {
            path: remotePath
          }
        });

        // Получаем информацию о файле, чтобы получить публичную ссылку
        const fileInfo = await this.client.get('/resources', {
          params: {
            path: remotePath
          }
        });

        return fileInfo.data.public_url;
      } catch (error) {
        // Если это ошибка 503 или 429, пробуем снова
        if (error.response && (error.response.status === 503 || error.response.status === 429)) {
          lastError = error;
          if (attempt < retries) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
            console.log(`Попытка ${attempt}/${retries} публикации файла не удалась (${error.response.status}). Повтор через ${delay}мс...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
        }

        throw new Error(`Ошибка публикации файла: ${error.response?.status || 'неизвестна'} - ${error.message}`);
      }
    }

    throw new Error(`Ошибка публикации файла после ${retries} попыток: Яндекс.Диск временно недоступен (${lastError.response?.status})`);
  }

  /**
   * Удаляет файл с Яндекс.Диска
   * @param {string} remotePath - Путь к файлу на Яндекс.Диске
   * @param {boolean} permanently - Удалить навсегда (не в корзину)
   * @returns {Promise<Object>} Результат удаления
   */
  async deleteFile(remotePath, permanently = false) {
    try {
      const response = await this.client.delete('/resources', {
        params: {
          path: remotePath,
          permanently: permanently
        }
      });
      return {
        success: true,
        message: 'Файл удален'
      };
    } catch (error) {
      throw new Error(`Ошибка удаления файла: ${error.message}`);
    }
  }

  /**
   * Получает список файлов в папке
   * @param {string} folderPath - Путь к папке
   * @param {number} limit - Максимальное количество файлов
   * @returns {Promise<Array>} Список файлов
   */
  async listFiles(folderPath, limit = 100) {
    try {
      const response = await this.client.get('/resources', {
        params: {
          path: folderPath,
          limit: limit
        }
      });
      return response.data._embedded.items;
    } catch (error) {
      throw new Error(`Ошибка получения списка файлов: ${error.message}`);
    }
  }
}

export default YandexDiskService;
