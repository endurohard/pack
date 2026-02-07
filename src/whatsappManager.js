import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import pkg from 'whatsapp-web.js';
const { MessageMedia } = pkg;

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class WhatsAppManager {
  constructor() {
    this.browser = null;
    this.page = null;
    this.isReady = false;
    this.sessionDir = path.join(__dirname, '../data/whatsapp-session');

    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
  }

  /**
   * Валидация пути к файлу с нормализацией и проверкой существования
   *
   * Проверяет:
   * - Нормализует путь к абсолютному (Puppeteer требует абсолютные пути)
   * - Существование файла
   * - Размер файла (лимит WhatsApp: 100MB)
   *
   * @param {string} filePath - Путь к файлу (относительный или абсолютный)
   * @returns {{ valid: boolean, absolutePath: string, error?: string, size?: number }} - Результат валидации
   */
  validateFilePath(filePath) {
    // Нормализуем путь к абсолютному (Puppeteer требует абсолютные пути)
    const absolutePath = path.resolve(filePath);

    // Проверяем существование файла
    if (!fs.existsSync(absolutePath)) {
      return {
        valid: false,
        absolutePath,
        error: `Файл не существует: ${absolutePath}`
      };
    }

    // Получаем информацию о файле
    const stats = fs.statSync(absolutePath);
    const fileSizeBytes = stats.size;
    const fileSizeMB = fileSizeBytes / (1024 * 1024);

    // Лимит WhatsApp: 100MB для файлов
    const WHATSAPP_FILE_LIMIT_MB = 100;
    if (fileSizeMB > WHATSAPP_FILE_LIMIT_MB) {
      return {
        valid: false,
        absolutePath,
        size: fileSizeBytes,
        error: `Файл слишком большой: ${fileSizeMB.toFixed(2)}MB (лимит WhatsApp: ${WHATSAPP_FILE_LIMIT_MB}MB)`
      };
    }

    return {
      valid: true,
      absolutePath,
      size: fileSizeBytes
    };
  }

  async cleanupOldBrowserProcesses() {
    try {
      console.log('🔍 Проверка зависших процессов Chrome...');

      // Проверяем, есть ли Singleton файлы (признак работающего браузера)
      const singletonFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
      let hasSingletonFiles = false;

      for (const file of singletonFiles) {
        const filePath = path.join(this.sessionDir, file);
        if (fs.existsSync(filePath)) {
          hasSingletonFiles = true;
          console.log(`⚠️  Найден файл блокировки: ${file}`);
        }
      }

      if (hasSingletonFiles) {
        console.log('🧹 Очистка зависших процессов Chrome...');

        // Завершаем все процессы Chrome
        try {
          await execAsync('pkill -9 chrome 2>/dev/null || true');
          await execAsync('pkill -9 chromium 2>/dev/null || true');
          console.log('✅ Процессы Chrome завершены');
        } catch (e) {
          // Игнорируем ошибки, если процессов нет
        }

        // Ждем завершения процессов
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Удаляем Singleton файлы
        for (const file of singletonFiles) {
          const filePath = path.join(this.sessionDir, file);
          try {
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
              console.log(`🗑️  Удален ${file}`);
            }
          } catch (e) {
            console.error(`⚠️  Не удалось удалить ${file}:`, e.message);
          }
        }

        console.log('✅ Очистка завершена');
      } else {
        console.log('✅ Зависших процессов не обнаружено');
      }
    } catch (error) {
      console.error('⚠️  Ошибка очистки процессов:', error.message);
      // Не бросаем ошибку, продолжаем инициализацию
    }
  }

  async initialize() {
    try {
      console.log('📱 Инициализация WhatsApp Web через Puppeteer...');

      // Проверяем и очищаем зависшие процессы Chrome перед запуском
      await this.cleanupOldBrowserProcesses();

      this.browser = await puppeteer.launch({
        headless: false,
        userDataDir: this.sessionDir,
        protocolTimeout: 300000, // 5 минут вместо дефолтных 180 секунд
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--proxy-server=socks5://127.0.0.1:1080'
        ]
      });

      this.page = await this.browser.newPage();
      await this.page.setViewport({ width: 1280, height: 720 });

      console.log('🌐 Открываю web.whatsapp.com...');
      await this.page.goto('https://web.whatsapp.com', {
        waitUntil: 'networkidle2',
        timeout: 60000
      });

      console.log('⏳ Ожидание загрузки WhatsApp Web...');
      console.log('📱 Отсканируйте QR-код в браузере');

      // Проверяем авторизацию (несколько вариантов селекторов)
      const checkAuth = setInterval(async () => {
        try {
          const isAuthenticated = await this.page.evaluate(() => {
            // Проверяем несколько возможных селекторов для авторизованной страницы
            const hasChats = document.querySelector('[data-testid="chat-list"]') !== null;
            const hasSidebar = document.querySelector('#side') !== null;
            const hasUserAvatar = document.querySelector('[data-testid="default-user"]') !== null;
            const noLanding = document.querySelector('.landing-main') === null;

            // Если есть хотя бы 2 признака авторизации
            const authCount = [hasChats, hasSidebar, hasUserAvatar, noLanding].filter(Boolean).length;
            return authCount >= 2;
          });

          if (isAuthenticated) {
            clearInterval(checkAuth);
            this.isReady = true;
            console.log('✅ WhatsApp Web готов к использованию!');
          }
        } catch (e) {
          // Игнорируем ошибки при проверке
          console.log('⚠️  Ошибка проверки авторизации:', e.message);
        }
      }, 5000);

    } catch (error) {
      console.error('❌ Ошибка инициализации WhatsApp:', error.message);
      throw error;
    }
  }

  async handleTimeoutError(error, operation) {
    if (error.message && (
      error.message.includes('timed out') ||
      error.message.includes('timeout') ||
      error.message.includes('Navigation failed')
    )) {
      console.log('⚠️  Обнаружен таймаут, попытка перезапуска браузера...');
      try {
        await this.restart();
        console.log('✅ Браузер перезапущен успешно');
        return true;
      } catch (restartError) {
        console.error('❌ Не удалось перезапустить браузер:', restartError.message);
        return false;
      }
    }
    return false;
  }

  async sendMessage(phone, message) {
    if (!this.isReady || !this.page) {
      throw new Error('WhatsApp Web не готов');
    }

    try {
      let cleanPhone = phone.replace(/[^0-9]/g, '');
      if (cleanPhone.startsWith('8')) {
        cleanPhone = '7' + cleanPhone.substring(1);
      }
      if (!cleanPhone.startsWith('7')) {
        cleanPhone = '7' + cleanPhone;
      }

      console.log(`📤 Отправка сообщения на ${cleanPhone}...`);

      // Открываем чат
      const currentUrl = this.page.url();
      if (!currentUrl.includes('web.whatsapp.com')) {
        console.log('🌐 Открываю WhatsApp Web...');
        await this.page.goto(`https://web.whatsapp.com/send?phone=${cleanPhone}`, {
          waitUntil: 'networkidle2',
          timeout: 60000
        });
      } else {
        console.log('✅ WhatsApp Web уже открыт, открываю чат...');
        // Используем Promise.all чтобы дождаться завершения навигации
        await Promise.all([
          this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {
            console.log('  ⚠️  Навигация не завершилась корректно, продолжаем...');
          }),
          this.page.evaluate((phone) => {
            window.location.href = `https://web.whatsapp.com/send?phone=${phone}`;
          }, cleanPhone)
        ]);

        // Дополнительная задержка после навигации
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      // Ждем появления чата
      console.log('⏳ Ожидание загрузки чата...');

      // Даем время на появление модальных окон (ошибок или загрузки чата)
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Ждем стабилизации страницы после навигации (защита от "Execution context destroyed")
      console.log('⏳ Ожидание стабилизации страницы...');
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Проверяем наличие ошибки подключения к WhatsApp
      let connectionError = false;
      try {
        connectionError = await this.page.evaluate(() => {
          const text = document.body.textContent || '';
          return text.includes('Подключение к WhatsApp') ||
                 text.includes('Connecting to WhatsApp') ||
                 text.includes('Телефон не подключен') ||
                 text.includes('Phone not connected');
        });

        console.log(`  Ошибка подключения обнаружена: ${connectionError}`);

        if (connectionError) {
          console.log('⚠️  Обнаружена ошибка подключения WhatsApp, ждем восстановления...');
          // Ждем исчезновения ошибки подключения (до 30 секунд)
          await this.page.waitForFunction(
            () => {
              const text = document.body.textContent || '';
              return !text.includes('Подключение к WhatsApp') &&
                     !text.includes('Connecting to WhatsApp') &&
                     !text.includes('Телефон не подключен') &&
                     !text.includes('Phone not connected');
            },
            { timeout: 30000 }
          ).catch(() => {
            throw new Error('WhatsApp потерял соединение. Проверьте подключение к интернету');
          });
          console.log('✅ Соединение восстановлено');
          // Даем время на стабилизацию
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      } catch (e) {
        console.error('❌ Ошибка проверки соединения:', e.message);
        await this.page.screenshot({ path: '/tmp/whatsapp_connection_error.png' });
        throw e;
      }

      // Проверяем наличие ошибки "Номер телефона недействителен"
      try {
        const invalidPhoneError = await this.page.evaluate(() => {
          const text = document.body.textContent || '';
          return text.includes('Номер телефона') && text.includes('недействителен') ||
                 text.includes('phone number') && text.includes('invalid');
        });

        if (invalidPhoneError) {
          console.error('❌ Номер телефона недействителен');
          await this.page.screenshot({ path: '/tmp/whatsapp_invalid_phone.png' });
          throw new Error('Номер телефона недействителен. Проверьте правильность номера.');
        }
      } catch (e) {
        if (e.message.includes('Номер телефона недействителен')) {
          throw e;
        }
        // Другие ошибки игнорируем
      }

      // Сначала ждем исчезновения модального окна "Начало чата", если оно есть
      try {
        const chatStartModal = await this.page.waitForFunction(
          () => {
            const text = document.body.textContent || '';
            return text.includes('Начало чата');
          },
          { timeout: 5000 }
        ).catch(() => null);

        if (chatStartModal) {
          console.log('  Ожидание окончания загрузки чата...');
          await this.page.waitForFunction(
            () => {
              const text = document.body.textContent || '';
              return !text.includes('Начало чата');
            },
            { timeout: 40000 }
          );
          console.log('  Модальное окно загрузки исчезло');
        }
      } catch (e) {
        console.log('  Модального окна загрузки нет, продолжаем...');
      }

      // Теперь ждем появления элементов чата
      const chatLoaded = await Promise.race([
        this.page.waitForSelector('[data-testid="conversation-compose-box-input"]', { timeout: 30000 }).catch(() => null),
        this.page.waitForSelector('footer [contenteditable="true"]', { timeout: 30000 }).catch(() => null),
        this.page.waitForSelector('div[contenteditable="true"][data-tab="10"]', { timeout: 30000 }).catch(() => null),
      ]);

      if (!chatLoaded) {
        console.error('❌ Не удалось дождаться загрузки чата');
        await this.page.screenshot({ path: '/tmp/whatsapp_chat_error.png' });
        throw new Error('Чат не загрузился');
      }

      console.log('✅ Чат загружен');
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Ищем поле ввода
      const inputSelectors = [
        '[data-testid="conversation-compose-box-input"]',
        'footer [contenteditable="true"]',
        'div[contenteditable="true"][data-tab="10"]'
      ];

      let inputBox = null;
      for (const selector of inputSelectors) {
        inputBox = await this.page.$(selector);
        if (inputBox) {
          console.log(`  Найдено поле ввода: ${selector}`);
          break;
        }
      }

      if (!inputBox) {
        throw new Error('Поле ввода сообщения не найдено');
      }

      // Кликаем на поле ввода и вводим текст
      await inputBox.click();
      await new Promise(resolve => setTimeout(resolve, 500));
      await this.page.keyboard.type(message);
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Нажимаем кнопку отправки
      const sendButtonSelectors = [
        '[data-testid="send"]',
        'span[data-icon="send"]',
        'button[aria-label*="Send"]',
        'button[aria-label*="Отправить"]',
        'span[data-testid="send"]'
      ];

      let sendButton = null;
      for (const selector of sendButtonSelectors) {
        sendButton = await this.page.$(selector);
        if (sendButton) {
          console.log(`  Найдена кнопка отправки: ${selector}`);
          break;
        }
      }

      if (!sendButton) {
        // Последняя попытка - ищем через evaluate
        const clicked = await this.page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, span[role="button"]'));
          for (const btn of buttons) {
            const ariaLabel = btn.getAttribute('aria-label') || '';
            const testId = btn.getAttribute('data-testid') || '';
            const innerHTML = btn.innerHTML || '';

            if (ariaLabel.toLowerCase().includes('send') ||
                ariaLabel.toLowerCase().includes('отправить') ||
                testId === 'send' ||
                innerHTML.includes('data-icon="send"')) {
              btn.click();
              return true;
            }
          }
          return false;
        });

        if (clicked) {
          console.log('✅ Сообщение отправлено через JavaScript evaluation');
          await new Promise(resolve => setTimeout(resolve, 1000));
          return { success: true, message: 'Сообщение отправлено' };
        } else {
          throw new Error('Кнопка отправки не найдена');
        }
      }

      if (sendButton) {
        await sendButton.click();
        console.log('✅ Сообщение отправлено');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      return { success: true, message: 'Сообщение отправлено' };
    } catch (error) {
      console.error('❌ Ошибка отправки сообщения:', error.message);

      // Пытаемся обработать таймаут и перезапустить браузер
      const restarted = await this.handleTimeoutError(error);
      if (restarted) {
        throw new Error('Браузер был перезапущен из-за таймаута. Повторите попытку через минуту.');
      }

      throw error;
    }
  }

  async sendImage(phone, message, imagePath) {
    if (!this.isReady || !this.page) {
      throw new Error('WhatsApp Web не готов');
    }

    try {
      if (!fs.existsSync(imagePath)) {
        throw new Error(`Изображение не найдено: ${imagePath}`);
      }

      let cleanPhone = phone.replace(/[^0-9]/g, '');
      if (cleanPhone.startsWith('8')) {
        cleanPhone = '7' + cleanPhone.substring(1);
      }
      if (!cleanPhone.startsWith('7')) {
        cleanPhone = '7' + cleanPhone;
      }

      console.log(`📤 Отправка изображения на ${cleanPhone}...`);
      console.log(`📸 Файл: ${path.basename(imagePath)} (${fs.statSync(imagePath).size} байт)`);

      // Открываем чат
      const currentUrl = this.page.url();
      if (!currentUrl.includes('web.whatsapp.com')) {
        await this.page.goto(`https://web.whatsapp.com/send?phone=${cleanPhone}`, {
          waitUntil: 'load',
          timeout: 60000
        });
      } else {
        await this.page.evaluate((phone) => {
          window.location.href = `https://web.whatsapp.com/send?phone=${phone}`;
        }, cleanPhone);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Ждем загрузки чата
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Проверяем соединение
      const connectionError = await this.page.evaluate(() => {
        const text = document.body.textContent || '';
        return text.includes('Подключение к WhatsApp') ||
               text.includes('Connecting to WhatsApp') ||
               text.includes('Телефон не подключен') ||
               text.includes('Phone not connected');
      });

      if (connectionError) {
        await this.page.waitForFunction(
          () => {
            const text = document.body.textContent || '';
            return !text.includes('Подключение к WhatsApp') &&
                   !text.includes('Connecting to WhatsApp') &&
                   !text.includes('Телефон не подключен') &&
                   !text.includes('Phone not connected');
          },
          { timeout: 30000 }
        ).catch(() => {
          throw new Error('WhatsApp потерял соединение');
        });
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      // Ждем загрузки чата
      const chatLoaded = await Promise.race([
        this.page.waitForSelector('[data-testid="conversation-compose-box-input"]', { timeout: 30000 }).catch(() => null),
        this.page.waitForSelector('footer [contenteditable="true"]', { timeout: 30000 }).catch(() => null),
        this.page.waitForSelector('[data-testid="clip"]', { timeout: 30000 }).catch(() => null),
      ]);

      if (!chatLoaded) {
        throw new Error('Чат не загрузился');
      }

      console.log('✅ Чат загружен');

      // Находим кнопку прикрепления - пробуем разные варианты
      let attachButton = await this.page.$('[data-testid="clip"]');
      if (!attachButton) attachButton = await this.page.$('[data-icon="clip"]');
      if (!attachButton) attachButton = await this.page.$('span[data-icon="plus"]');
      if (!attachButton) attachButton = await this.page.$('[aria-label*="Прикрепить"]');
      if (!attachButton) attachButton = await this.page.$('button[aria-label*="Attach"]');

      // Если не нашли стандартными способами, ищем через evaluate
      if (!attachButton) {
        const buttonFound = await this.page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('footer button, footer span[role="button"], footer div[role="button"]'));
          for (const btn of buttons) {
            const html = btn.innerHTML || '';
            const ariaLabel = btn.getAttribute('aria-label') || '';
            if (html.includes('clip') || html.includes('plus') || html.includes('+') ||
                ariaLabel.toLowerCase().includes('attach') || ariaLabel.toLowerCase().includes('прикреп')) {
              btn.scrollIntoView();
              return true;
            }
          }
          return false;
        });

        if (buttonFound) {
          // Пробуем найти кнопку снова после скролла
          await new Promise(resolve => setTimeout(resolve, 500));
          attachButton = await this.page.$('[data-testid="clip"]') ||
                        await this.page.$('[data-icon="clip"]') ||
                        await this.page.$('span[data-icon="plus"]');
        }
      }

      if (!attachButton) {
        console.warn('⚠️  Кнопка прикрепления не найдена, пробую прямой доступ к input...');
        await this.page.screenshot({ path: '/tmp/whatsapp_no_attach_button.png' });

        // АЛЬТЕРНАТИВНЫЙ СПОСОБ: напрямую ищем input для файлов
        const directInputs = await this.page.$$('input[type="file"]');
        let imageInput = null;

        for (const input of directInputs) {
          const accept = await this.page.evaluate(el => el.getAttribute('accept'), input);
          if (accept && accept.includes('image')) {
            imageInput = input;
            console.log('✓ Найден input для изображений напрямую');
            break;
          }
        }

        if (!imageInput && directInputs.length > 0) {
          imageInput = directInputs[0];
          console.log('⚠️  Использую первый найденный input');
        }

        if (imageInput) {
          console.log('📤 Загружаю изображение напрямую через input...');
          await imageInput.uploadFile(imagePath);
          await new Promise(resolve => setTimeout(resolve, 3000));

          // Добавляем подпись (обязательно, чтобы не отправилось как стикер)
          try {
            const captionText = message || ' '; // Минимум один пробел чтобы не было стикера
            await new Promise(resolve => setTimeout(resolve, 1000));

            const captionBox = await this.page.$('[data-testid="media-caption-input"]') ||
                              await this.page.$('div[contenteditable="true"][data-tab="10"]') ||
                              await this.page.$('div[contenteditable="true"][data-lexical-editor="true"]');

            if (captionBox) {
              console.log('📝 Добавляю подпись к изображению...');
              await captionBox.click();
              await new Promise(resolve => setTimeout(resolve, 500));
              await this.page.keyboard.type(captionText);
              console.log('✅ Подпись добавлена');
            } else {
              console.warn('⚠️  Поле подписи не найдено, изображение может быть отправлено как стикер');
            }
          } catch (err) {
            console.error('❌ Ошибка добавления подписи:', err.message);
          }

          // Ищем и нажимаем кнопку отправки
          await new Promise(resolve => setTimeout(resolve, 2000));
          const sendResult = await this.page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"]'));
            const sendButton = buttons.find(btn => btn.querySelector('[data-icon*="send"]'));
            if (sendButton) {
              const rect = sendButton.getBoundingClientRect();
              return { success: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
            }
            return { success: false };
          });

          if (sendResult.success) {
            await this.page.mouse.click(sendResult.x, sendResult.y);
            await new Promise(resolve => setTimeout(resolve, 2000));
            return { success: true, message: 'Изображение отправлено (прямой метод)' };
          }
        }

        throw new Error('Не удалось найти способ загрузить изображение');
      }

      console.log('📎 Нажимаю кнопку прикрепления...');
      await attachButton.click();
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Логируем доступные кнопки для отладки
      const availableButtons = await this.page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, li[role="button"], span[role="button"]'));
        return buttons.slice(0, 30).map(btn => ({
          text: (btn.textContent || '').trim().substring(0, 100),
          ariaLabel: btn.getAttribute('aria-label') || '',
          title: btn.getAttribute('title') || ''
        }));
      });
      console.log('📋 Все доступные кнопки после прикрепления:', JSON.stringify(availableButtons, null, 2));

      // Ищем и нажимаем кнопку "Документ" (чтобы отправить как файл, а не как стикер)
      console.log('📄 Поиск кнопки "Документ"...');

      const documentButton = await this.page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, li[role="button"], span[role="button"]'));
        const docBtn = buttons.find(btn => {
          const text = btn.textContent || '';
          const ariaLabel = btn.getAttribute('aria-label') || '';
          const title = btn.getAttribute('title') || '';
          // Ищем "Документ" или "Document"
          return ariaLabel.includes('Документ') || ariaLabel.includes('Document') ||
                 text.includes('Документ') || text.includes('Document') ||
                 title.includes('Документ') || title.includes('Document');
        });
        if (docBtn) {
          console.log('Найдена кнопка Документ:', docBtn.getAttribute('aria-label'));
          const rect = docBtn.getBoundingClientRect();
          return { success: true, label: docBtn.getAttribute('aria-label'), x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
        }
        return { success: false };
      });

      if (documentButton.success) {
        console.log(`✓ Нажимаю кнопку "Документ" (${documentButton.label})`);
        await this.page.mouse.click(documentButton.x, documentButton.y);
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        console.log('⚠️  Кнопка "Документ" не найдена, пытаюсь напрямую');
      }

      // Ищем input для изображений
      console.log('🔍 Поиск input для изображений...');
      const fileInputs = await this.page.$$('input[type="file"]');

      let imageInput = null;
      for (const input of fileInputs) {
        const accept = await this.page.evaluate(el => el.getAttribute('accept'), input);
        // Ищем input для изображений (accept="image/*")
        if (accept && accept.includes('image')) {
          imageInput = input;
          console.log(`✓ Найден input для изображений (accept="${accept}")`);
          break;
        }
      }

      if (!imageInput && fileInputs.length > 0) {
        // Берем первый input (обычно для фото/видео)
        imageInput = fileInputs[0];
        console.log('⚠️  Использую первый input');
      }

      if (!imageInput) {
        throw new Error('Input для изображения не найден');
      }

      // Загружаем файл
      console.log(`📤 Загружаю изображение...`);
      await imageInput.uploadFile(imagePath);
      console.log('✅ Изображение загружено в input');

      // Ждем обработки
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Ждем появления окна предпросмотра
      console.log('⏳ Ожидание окна предпросмотра...');
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Добавляем подпись (обязательно, чтобы не отправилось как стикер)
      console.log('💬 Добавление подписи к изображению...');
      try {
        const captionText = message || ' '; // Минимум один пробел чтобы не было стикера

        const captionSelectors = [
          '[data-testid="media-caption-input"]',
          'div[contenteditable="true"][data-tab="10"]',
          'div[contenteditable="true"][data-lexical-editor="true"]',
          'footer [contenteditable="true"]'
        ];

        let captionBox = null;
        for (const selector of captionSelectors) {
          captionBox = await this.page.$(selector);
          if (captionBox) {
            console.log(`  Найдено поле подписи: ${selector}`);
            break;
          }
        }

        if (captionBox) {
          await captionBox.click();
          await new Promise(resolve => setTimeout(resolve, 500));
          await this.page.keyboard.type(captionText);
          await new Promise(resolve => setTimeout(resolve, 500));
          console.log('✅ Подпись добавлена');
        } else {
          console.warn('⚠️  Поле подписи не найдено, изображение может быть отправлено как стикер');
        }
      } catch (err) {
        console.error('❌ Ошибка добавления подписи:', err.message);
      }

      // Ищем и нажимаем кнопку отправки
      console.log('🔍 Поиск кнопки отправки...');

      const sendResult = await this.page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"]'));

        // Ищем кнопку с иконкой send
        const sendButton = buttons.find(btn => {
          const hasIcon = btn.querySelector('[data-icon*="send"]');
          return hasIcon !== null;
        });

        if (sendButton) {
          const rect = sendButton.getBoundingClientRect();
          return {
            success: true,
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2)
          };
        }
        return { success: false };
      });

      if (sendResult.success) {
        console.log(`📤 Отправка изображения...`);
        await this.page.mouse.click(sendResult.x, sendResult.y);
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Проверяем отправку
        console.log('⏳ Проверка отправки...');
        let messageSent = false;
        for (let attempt = 1; attempt <= 5; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 2000));

          messageSent = await this.page.evaluate(() => {
            const messages = Array.from(document.querySelectorAll('[data-testid="msg-container"]'));
            if (messages.length === 0) return false;
            const lastMessage = messages[messages.length - 1];
            const hasImage = lastMessage.querySelector('img[src*="blob:"], img[src*="data:image"]');
            return hasImage !== null;
          });

          if (messageSent) {
            console.log(`✅ Изображение успешно отправлено (попытка ${attempt})`);
            break;
          }
        }

        if (!messageSent) {
          console.warn('⚠️  Не удалось подтвердить отправку изображения');
        }

        return { success: true, message: 'Изображение отправлено' };
      } else {
        throw new Error('Кнопка отправки не найдена');
      }
    } catch (error) {
      console.error('❌ Ошибка отправки изображения:', error.message);
      try {
        await this.page.screenshot({ path: '/tmp/whatsapp_image_error.png' });
      } catch (e) {}
      throw error;
    }
  }

  async sendMessageWithFile(phone, message, filePath) {
    if (!this.isReady || !this.page) {
      throw new Error('WhatsApp Web не готов');
    }

    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`Файл не найден: ${filePath}`);
      }

      let cleanPhone = phone.replace(/[^0-9]/g, '');
      if (cleanPhone.startsWith('8')) {
        cleanPhone = '7' + cleanPhone.substring(1);
      }
      if (!cleanPhone.startsWith('7')) {
        cleanPhone = '7' + cleanPhone;
      }

      console.log(`📤 Отправка файла на ${cleanPhone}...`);

      // Проверяем, загружен ли уже интерфейс WhatsApp
      const currentUrl = this.page.url();

      if (!currentUrl.includes('web.whatsapp.com')) {
        console.log('⏳ Открываю WhatsApp Web...');
        await this.page.goto(`https://web.whatsapp.com/send?phone=${cleanPhone}`, {
          waitUntil: 'load',
          timeout: 60000
        });
      } else {
        console.log('✅ WhatsApp Web уже открыт, открываю чат...');

        // Используем Promise.all чтобы дождаться завершения навигации
        await Promise.all([
          this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {
            console.log('  ⚠️  Навигация не завершилась корректно, продолжаем...');
          }),
          this.page.evaluate((phone) => {
            window.location.href = `https://web.whatsapp.com/send?phone=${phone}`;
          }, cleanPhone)
        ]);

        // Ожидаем исчезновения спиннера загрузки (если он есть)
        console.log('⏳ Ожидание загрузки интерфейса...');
        try {
          await this.page.waitForSelector('div[data-testid="default-user"]', { timeout: 3000 });
          console.log('  Загрузка интерфейса...');
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (e) {
          // Спиннер может не появиться, продолжаем
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
      }

      // Ждем появления чата
      console.log('⏳ Ожидание загрузки чата...');

      // Даем время на появление модальных окон (ошибок или загрузки чата)
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Ждем стабилизации страницы после навигации (защита от "Execution context destroyed")
      console.log('⏳ Ожидание стабилизации страницы...');
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Проверяем наличие ошибки подключения к WhatsApp
      let connectionError = false;
      try {
        connectionError = await this.page.evaluate(() => {
          const text = document.body.textContent || '';
          return text.includes('Подключение к WhatsApp') ||
                 text.includes('Connecting to WhatsApp') ||
                 text.includes('Телефон не подключен') ||
                 text.includes('Phone not connected');
        });

        console.log(`  Ошибка подключения обнаружена: ${connectionError}`);

        if (connectionError) {
          console.log('⚠️  Обнаружена ошибка подключения WhatsApp, ждем восстановления...');
          // Ждем исчезновения ошибки подключения (до 30 секунд)
          await this.page.waitForFunction(
            () => {
              const text = document.body.textContent || '';
              return !text.includes('Подключение к WhatsApp') &&
                     !text.includes('Connecting to WhatsApp') &&
                     !text.includes('Телефон не подключен') &&
                     !text.includes('Phone not connected');
            },
            { timeout: 30000 }
          ).catch(() => {
            throw new Error('WhatsApp потерял соединение. Проверьте подключение к интернету');
          });
          console.log('✅ Соединение восстановлено');
          // Даем время на стабилизацию
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      } catch (e) {
        console.error('❌ Ошибка проверки соединения:', e.message);
        await this.page.screenshot({ path: '/tmp/whatsapp_connection_error.png' });
        throw e;
      }

      // Проверяем наличие ошибки "Номер телефона недействителен"
      try {
        const invalidPhoneError = await this.page.evaluate(() => {
          const text = document.body.textContent || '';
          return text.includes('Номер телефона') && text.includes('недействителен') ||
                 text.includes('phone number') && text.includes('invalid');
        });

        if (invalidPhoneError) {
          console.error('❌ Номер телефона недействителен');
          await this.page.screenshot({ path: '/tmp/whatsapp_invalid_phone.png' });
          throw new Error('Номер телефона недействителен. Проверьте правильность номера.');
        }
      } catch (e) {
        if (e.message.includes('Номер телефона недействителен')) {
          throw e;
        }
        // Другие ошибки игнорируем
      }

      // Сначала ждем исчезновения модального окна "Начало чата", если оно есть
      try {
        const chatStartModal = await this.page.waitForFunction(
          () => {
            const text = document.body.textContent || '';
            return text.includes('Начало чата');
          },
          { timeout: 5000 }
        ).catch(() => null);

        if (chatStartModal) {
          console.log('  Ожидание окончания загрузки чата...');
          // Ждем исчезновения текста "Начало чата"
          await this.page.waitForFunction(
            () => {
              const text = document.body.textContent || '';
              return !text.includes('Начало чата');
            },
            { timeout: 40000 }
          );
          console.log('  Модальное окно загрузки исчезло');
        }
      } catch (e) {
        // Модальное окно может не появиться, продолжаем
        console.log('  Модального окна загрузки нет, продолжаем...');
      }

      // Теперь ждем появления элементов чата
      const chatLoaded = await Promise.race([
        this.page.waitForSelector('[data-testid="conversation-compose-box-input"]', { timeout: 30000 }).catch(() => null),
        this.page.waitForSelector('footer [contenteditable="true"]', { timeout: 30000 }).catch(() => null),
        this.page.waitForSelector('[data-testid="clip"]', { timeout: 30000 }).catch(() => null),
        this.page.waitForSelector('div[contenteditable="true"][data-tab="10"]', { timeout: 30000 }).catch(() => null),
      ]);

      if (!chatLoaded) {
        console.error('❌ Не удалось дождаться загрузки чата');
        await this.page.screenshot({ path: '/tmp/whatsapp_chat_error.png' });
        throw new Error('Чат не загрузился');
      }

      console.log('✅ Чат загружен');
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Находим кнопку прикрепления с несколькими вариантами
      let attachButton = await this.page.$('[data-testid="clip"]');
      if (!attachButton) {
        attachButton = await this.page.$('[data-icon="clip"]');
      }
      if (!attachButton) {
        attachButton = await this.page.$('span[data-icon="plus"]');
      }
      if (!attachButton) {
        attachButton = await this.page.$('[aria-label*="Прикрепить"]');
      }
      if (!attachButton) {
        attachButton = await this.page.$('button[aria-label*="Attach"]');
      }
      if (!attachButton) {
        // Пробуем найти любую кнопку с иконкой плюс около поля ввода
        const buttons = await this.page.$$('footer button, footer span[role="button"]');
        for (const btn of buttons) {
          const html = await this.page.evaluate(el => el.innerHTML, btn);
          if (html.includes('plus') || html.includes('+')) {
            attachButton = btn;
            break;
          }
        }
      }

      if (!attachButton) {
        console.error('❌ Кнопка прикрепления не найдена');
        await this.page.screenshot({ path: '/tmp/whatsapp_no_clip.png' });
        throw new Error('Кнопка прикрепления не найдена');
      }

      // Проверяем что файл существует ПЕРЕД началом
      if (!fs.existsSync(filePath)) {
        throw new Error(`Файл не существует: ${filePath}`);
      }
      console.log(`✅ Файл для отправки: ${path.basename(filePath)} (${fs.statSync(filePath).size} байт)`);

      console.log('📎 Нажимаю кнопку прикрепления...');
      await attachButton.click();

      // Ждем появления меню с опциями
      console.log('⏳ Ожидание меню прикрепления...');
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Проверяем что меню действительно открылось
      const menuOpened = await this.page.evaluate(() => {
        // Ищем элементы меню - они должны быть видны
        const menuItems = document.querySelectorAll('li[role="button"]');
        const visibleMenuItems = Array.from(menuItems).filter(item => {
          const style = window.getComputedStyle(item);
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        });
        console.log(`[WhatsApp] Найдено видимых пунктов меню: ${visibleMenuItems.length}`);
        return visibleMenuItems.length > 0;
      });

      if (!menuOpened) {
        console.log('⚠️  Меню прикрепления не открылось, пробую еще раз...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        await attachButton.click();
        await new Promise(resolve => setTimeout(resolve, 2500));
      }

      // ВАЖНО: Нужно кликнуть на пункт меню "Документ"
      console.log('📄 Ищу пункт меню "Документ"...');

      // Используем evaluate для поиска элемента по тексту
      const documentButton = await this.page.evaluate(() => {
        // Сначала выведем отладочную информацию о меню
        const menuItems = document.querySelectorAll('li[role="button"]');
        console.log(`[WhatsApp] Пунктов меню всего: ${menuItems.length}`);
        menuItems.forEach((item, index) => {
          const text = item.textContent.trim();
          const icon = item.querySelector('span[data-icon]');
          const iconName = icon ? icon.getAttribute('data-icon') : 'нет';
          console.log(`[WhatsApp] Пункт ${index + 1}: "${text}" (иконка: ${iconName})`);
        });

        // МЕТОД 1: Поиск по data-icon="document" (самый надежный)
        let iconElement = document.querySelector('span[data-icon="document"]');
        if (iconElement) {
          const listItem = iconElement.closest('li, button, div[role="button"]');
          if (listItem) {
            console.log('[WhatsApp] Найден элемент по data-icon="document"');
            listItem.click();
            return true;
          }
        }

        // МЕТОД 2: Поиск по классу иконки документа
        const docIcons = document.querySelectorAll('svg');
        for (const svg of docIcons) {
          const paths = svg.querySelectorAll('path');
          // Фиолетовая иконка документа обычно имеет специфический path
          for (const path of paths) {
            const fill = path.getAttribute('fill');
            if (fill && (fill.includes('#7f66ff') || fill.includes('rgb(127, 102, 255)'))) {
              const listItem = svg.closest('li, button, div[role="button"]');
              if (listItem) {
                console.log('[WhatsApp] Найден элемент по цвету иконки документа');
                listItem.click();
                return true;
              }
            }
          }
        }

        // МЕТОД 3: Поиск по тексту "Документ"
        const elements = Array.from(document.querySelectorAll('span, div, li, button'));
        const searchTexts = ['Документ', 'Document', 'документ', 'document'];
        let docElement = null;

        for (const searchText of searchTexts) {
          docElement = elements.find(el => {
            const text = el.textContent.trim();
            return text === searchText || text.toLowerCase() === searchText.toLowerCase();
          });
          if (docElement) {
            console.log('[WhatsApp] Найден элемент по тексту:', searchText);
            break;
          }
        }

        if (docElement) {
          // Находим кликабельный родительский элемент
          let clickable = docElement.closest('li, button, div[role="button"]');
          if (clickable) {
            clickable.click();
            return true;
          }
        }

        // МЕТОД 4: Поиск первого элемента списка в меню прикрепления
        const allMenuItems = document.querySelectorAll('li[role="button"], ul > li');
        if (allMenuItems.length > 0) {
          // Обычно "Документ" первый в списке
          console.log('[WhatsApp] Кликаю на первый элемент меню (предположительно Документ)');
          allMenuItems[0].click();
          return true;
        }

        return false;
      });

      if (!documentButton) {
        await this.page.screenshot({ path: '/tmp/whatsapp_no_doc_button.png' });
        console.log('⚠️  Пункт меню "Документ" не найден, пробую альтернативный метод...');

        // АЛЬТЕРНАТИВНЫЙ МЕТОД: Пробуем найти input для документов напрямую
        console.log('🔄 Альтернативный метод: поиск input для документов...');
        const allInputs = await this.page.$$('input[type="file"]');
        console.log(`📋 Найдено ${allInputs.length} input элементов`);

        let documentInput = null;
        for (const input of allInputs) {
          const accept = await this.page.evaluate(el => el.getAttribute('accept'), input);
          // Ищем input для документов (обычно accept="*" или содержит "application/")
          if (!accept || accept === '*' || accept.includes('application/') || accept.includes('.pdf')) {
            documentInput = input;
            console.log(`✓ Найден input для документов (accept="${accept}")`);
            break;
          }
        }

        if (!documentInput && allInputs.length > 0) {
          // Используем последний input
          documentInput = allInputs[allInputs.length - 1];
          console.log('⚠️  Используем последний input');
        }

        if (documentInput) {
          // Загружаем файл через виртуальный буфер (более надежный способ)
          console.log('📁 Чтение файла в память...');
          const fileBuffer = fs.readFileSync(filePath);
          const fileName = path.basename(filePath);

          // Создаем виртуальный файл в браузере
          const fileHandle = await this.page.evaluateHandle((buffer, name) => {
            const arr = new Uint8Array(buffer);
            const blob = new Blob([arr], { type: 'application/pdf' });
            const file = new File([blob], name, { type: 'application/pdf' });
            return file;
          }, Array.from(fileBuffer), fileName);

          // Загружаем виртуальный файл в input
          await documentInput.evaluateHandle((input, file) => {
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(file);
            input.files = dataTransfer.files;

            // Триггерим событие change
            const event = new Event('change', { bubbles: true });
            input.dispatchEvent(event);
          }, fileHandle);

          console.log('✅ Файл загружен через альтернативный метод (виртуальный буфер)');

          // Ждем появления окна предпросмотра
          console.log('⏳ Ожидание окна предпросмотра файла...');
          try {
            // Ждем появления элементов предпросмотра документа
            await this.page.waitForFunction(
              () => {
                // Ищем признаки окна предпросмотра:
                // 1. Превью PDF документа
                const pdfPreview = document.querySelector('[data-testid="media-viewer"], .document-viewer, [role="dialog"]');
                // 2. Заголовок файла с расширением .pdf
                const fileTitle = Array.from(document.querySelectorAll('*')).find(el =>
                  el.textContent && el.textContent.includes('.pdf')
                );
                // 3. Поле ввода для подписи к файлу
                const captionInput = document.querySelector('[contenteditable="true"][data-tab="10"]');

                return pdfPreview !== null || fileTitle !== null || captionInput !== null;
              },
              { timeout: 10000 }
            );
            console.log('✅ Окно предпросмотра открылось');
          } catch (e) {
            console.log('⚠️  Окно предпросмотра не обнаружено, ждем дополнительно...');
          }

          // Дополнительная задержка для стабилизации
          await new Promise(resolve => setTimeout(resolve, 2000));

          // Ждем исчезновения индикатора загрузки (спиннера/прогресс-бара)
          console.log('⏳ Ожидание завершения загрузки файла на сервер WhatsApp...');
          try {
            // Ищем индикатор загрузки и ждем его исчезновения
            await this.page.waitForFunction(
              () => {
                // Ищем спиннеры, прогресс-бары и другие индикаторы загрузки
                const spinners = document.querySelectorAll('[role="progressbar"], .progress-bar, [data-testid*="progress"], [aria-label*="Loading"], [aria-label*="Загрузка"]');
                const loadingElements = Array.from(document.querySelectorAll('*')).filter(el => {
                  const style = window.getComputedStyle(el);
                  return el.textContent.includes('Loading') ||
                         el.textContent.includes('Загрузка') ||
                         el.className.includes('loading') ||
                         el.className.includes('spinner');
                });

                // Файл готов, когда нет индикаторов загрузки И есть кнопка отправки
                const noSpinners = spinners.length === 0 && loadingElements.length === 0;
                const sendButton = document.querySelector('[data-icon*="send"]');

                return noSpinners && sendButton !== null;
              },
              { timeout: 30000 }
            );
            console.log('✅ Файл загружен на сервер WhatsApp и готов к отправке');
          } catch (err) {
            console.log('⚠️  Не удалось дождаться индикатора загрузки, продолжаем...');
            // Дополнительное ожидание на всякий случай (увеличиваем до 10 секунд)
            console.log('⏳ Дополнительное ожидание 10 секунд для загрузки файла...');
            await new Promise(resolve => setTimeout(resolve, 10000));
          }

          // Делаем скриншот после загрузки файла для отладки
          await this.page.screenshot({ path: '/tmp/whatsapp_after_upload.png' });
          console.log('📸 Скриншот после загрузки файла сохранен');

          // Ищем и кликаем кнопку отправки в модальном окне предпросмотра
          console.log('🔍 Поиск кнопки отправки в окне предпросмотра файла...');

          // ПОЛУАВТОМАТИЧЕСКИЙ РЕЖИМ: Открываем окно предпросмотра и ждем действий пользователя
          console.log('👤 Полуавтоматический режим: файл готов к отправке');
          console.log('⏳ Ожидание ручной отправки пользователем...');
          console.log('💡 ИНСТРУКЦИЯ: Откройте браузер и нажмите кнопку отправки в WhatsApp Web');

          // Ждем 2 минуты, чтобы пользователь мог вручную нажать кнопку отправки
          const maxWaitTime = 120000; // 2 минуты
          const checkInterval = 2000; // Проверяем каждые 2 секунды
          let elapsed = 0;

          while (elapsed < maxWaitTime) {
            await new Promise(resolve => setTimeout(resolve, checkInterval));
            elapsed += checkInterval;

            // Проверяем, отправился ли файл
            const fileSent = await this.page.evaluate(() => {
              const messages = Array.from(document.querySelectorAll('[data-testid="msg-container"]'));
              if (messages.length === 0) return false;
              const lastMessage = messages[messages.length - 1];
              const hasDocument = lastMessage.querySelector('[data-testid="document-with-caption"], .document-thumb, [data-icon="document"]');
              return hasDocument !== null;
            });

            if (fileSent) {
              console.log(`✅ Файл отправлен вручную пользователем! (через ${Math.round(elapsed / 1000)} секунд)`);
              return { success: true, method: 'manual-user-send' };
            }

            // Проверяем, закрылось ли окно предпросмотра (пользователь отменил или произошла ошибка)
            const previewClosed = await this.page.evaluate(() => {
              const preview = document.querySelector('[data-testid="media-viewer"], .document-viewer, [role="dialog"]');
              const captionInput = document.querySelector('[contenteditable="true"][data-tab="10"]');
              return preview === null && captionInput === null;
            });

            if (previewClosed) {
              console.log('⚠️  Окно предпросмотра закрыто без отправки файла');
              break;
            }

            // Показываем прогресс каждые 10 секунд
            if (elapsed % 10000 === 0) {
              const secondsLeft = Math.round((maxWaitTime - elapsed) / 1000);
              console.log(`  ⏱️  Ожидание... (осталось ${secondsLeft} секунд)`);
            }
          }

          if (elapsed >= maxWaitTime) {
            console.log('⏱️  Время ожидания истекло (2 минуты)');
          }

          // Способ 1: Поиск кнопки отправки с иконкой "send" В ПРАВОЙ ЧАСТИ ЭКРАНА
          console.log('🔄 Метод 1: Поиск кнопки отправки в окне предпросмотра...');
          const sendResult = await this.page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"]'));

            // ВАЖНО: Ищем кнопки только в правой части экрана (где окно предпросмотра)
            const rightSideButtons = buttons.filter(btn => {
              const rect = btn.getBoundingClientRect();
              // Окно предпросмотра занимает правую часть экрана (примерно от 40% ширины)
              const inRightSide = rect.left > window.innerWidth * 0.4;
              // Кнопка должна быть видимой
              const isVisible = rect.width > 0 && rect.height > 0;
              return inRightSide && isVisible;
            });

            console.log(`[WhatsApp] Кнопок в правой части экрана: ${rightSideButtons.length}`);

            // Приоритет 1: ТОЛЬКО кнопка с иконкой send в правой части
            const sendButtons = rightSideButtons.filter(btn => {
              const hasIcon = btn.querySelector('[data-icon*="send"]');
              // ВАЖНО: только кнопки С ИКОНКОЙ send, не просто круглые!
              return hasIcon !== null;
            });

            if (sendButtons.length > 0) {
              console.log(`[WhatsApp] Найдено кнопок отправки: ${sendButtons.length}`);
              // Собираем информацию о всех найденных кнопках
              const buttonsInfo = sendButtons.map((btn, i) => {
                const rect = btn.getBoundingClientRect();
                const style = window.getComputedStyle(btn);
                const aria = btn.getAttribute('aria-label');
                const testid = btn.getAttribute('data-testid');
                const hasIcon = btn.querySelector('[data-icon]');
                const iconType = hasIcon ? hasIcon.getAttribute('data-icon') : 'none';
                return {
                  index: i,
                  bg: style.backgroundColor,
                  br: style.borderRadius,
                  width: Math.round(rect.width),
                  height: Math.round(rect.height),
                  x: Math.round(rect.left),
                  y: Math.round(rect.top),
                  aria: aria,
                  testid: testid,
                  icon: iconType
                };
              });

              // Возвращаем информацию о кнопке для клика через Puppeteer
              const firstButton = sendButtons[0];
              const rect = firstButton.getBoundingClientRect();
              return {
                success: true,
                method: 'send-icon-button-found-right-side',
                buttonsFound: sendButtons.length,
                buttonsInfo: buttonsInfo,
                clickTarget: {
                  x: Math.round(rect.left + rect.width / 2),
                  y: Math.round(rect.top + rect.height / 2)
                }
              };
            }

            // Приоритет 2: Любая круглая кнопка в правом нижнем углу (где обычно кнопка отправки)
            // НО НЕ кнопка прикрепления!
            const roundButtonsBottomRight = rightSideButtons.filter(btn => {
              const rect = btn.getBoundingClientRect();
              const style = window.getComputedStyle(btn);
              const borderRadius = parseFloat(style.borderRadius);
              const isRound = borderRadius > 25 || style.borderRadius.includes('%');
              // В нижней половине экрана
              const inBottomHalf = rect.top > window.innerHeight * 0.5;
              // Размер примерно 50-70px (типичный размер кнопки отправки)
              const rightSize = rect.width >= 40 && rect.width <= 80 && rect.height >= 40 && rect.height <= 80;
              // НЕ кнопка прикрепления, смайликов, голосового сообщения и т.д.
              const aria = btn.getAttribute('aria-label')?.toLowerCase() || '';
              const isNotWrongButton = !aria.includes('прикреп') && !aria.includes('attach') && !aria.includes('clip') &&
                                      !aria.includes('смайлик') && !aria.includes('emoji') && !aria.includes('expression') &&
                                      !aria.includes('голосов') && !aria.includes('voice') && !aria.includes('mic');
              // НЕ кнопка с иконками plus, expressions, mic
              const hasWrongIcon = btn.querySelector('[data-icon*="plus"], [data-icon*="expression"], [data-icon*="mic"]');
              const hasCorrectIcon = hasWrongIcon === null;

              return isRound && inBottomHalf && rightSize && isNotWrongButton && hasCorrectIcon;
            });

            if (roundButtonsBottomRight.length > 0) {
              console.log(`[WhatsApp] Найдено круглых кнопок в правом нижнем углу: ${roundButtonsBottomRight.length}`);
              const firstButton = roundButtonsBottomRight[0];
              const rect = firstButton.getBoundingClientRect();
              return {
                success: true,
                method: 'round-button-bottom-right',
                buttonsFound: roundButtonsBottomRight.length,
                clickTarget: {
                  x: Math.round(rect.left + rect.width / 2),
                  y: Math.round(rect.top + rect.height / 2)
                }
              };
            }

            // Приоритет 3: Ищем span с data-icon="send" В ПРАВОЙ ЧАСТИ
            const sendIcons = Array.from(document.querySelectorAll('span[data-icon="send"]'));
            for (const sendIcon of sendIcons) {
              const rect = sendIcon.getBoundingClientRect();
              if (rect.left > window.innerWidth * 0.4) {
                const btn = sendIcon.closest('button, div[role="button"], span[role="button"]');
                if (btn) {
                  console.log('✓ Найдена кнопка с иконкой send в правой части');
                  const btnRect = btn.getBoundingClientRect();
                  return {
                    success: true,
                    method: 'send-icon-right',
                    clickTarget: {
                      x: Math.round(btnRect.left + btnRect.width / 2),
                      y: Math.round(btnRect.top + btnRect.height / 2)
                    }
                  };
                }
              }
            }

            // Приоритет 4: Поиск зеленых кнопок и выбор самой большой справа
            const greenButtons = rightSideButtons.filter(btn => {
              const style = window.getComputedStyle(btn);
              const bgColor = style.backgroundColor;
              // Зеленая кнопка WhatsApp
              return bgColor.includes('0, 168') || bgColor.includes('0,168') ||
                     bgColor.includes('rgb(0, 150') || bgColor.includes('00a884') ||
                     bgColor.includes('37, 211') || bgColor.includes('25, 206');
            });

            console.log(`[WhatsApp] Найдено зеленых кнопок в правой части: ${greenButtons.length}`);

            if (greenButtons.length > 0) {
              // Выбираем самую большую зеленую кнопку
              const largestBtn = greenButtons.reduce((largest, btn) => {
                const rect = btn.getBoundingClientRect();
                const largestRect = largest.getBoundingClientRect();
                return (rect.width * rect.height) > (largestRect.width * largestRect.height) ? btn : largest;
              });
              console.log('[WhatsApp] Найдена зеленая кнопка в правой части');
              const rect = largestBtn.getBoundingClientRect();
              return {
                success: true,
                method: 'green-right-button',
                clickTarget: {
                  x: Math.round(rect.left + rect.width / 2),
                  y: Math.round(rect.top + rect.height / 2)
                }
              };
            }

            // Приоритет 5: Поиск по aria-label "Send" / "Отправить" В ПРАВОЙ ЧАСТИ
            let sendBtn = rightSideButtons.find(btn => {
              const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || '';
              return ariaLabel.includes('send') || ariaLabel.includes('отправить') || ariaLabel.includes('enviar');
            });
            if (sendBtn) {
              console.log('[WhatsApp] Найдена кнопка по aria-label в правой части');
              const rect = sendBtn.getBoundingClientRect();
              return {
                success: true,
                method: 'aria-label-right',
                clickTarget: {
                  x: Math.round(rect.left + rect.width / 2),
                  y: Math.round(rect.top + rect.height / 2)
                }
              };
            }

            // Способ 3: Поиск по data-testid
            sendBtn = document.querySelector('[data-testid="send-button"]');
            if (sendBtn) {
              console.log('✓ Найдена кнопка по data-testid="send-button"');
              sendBtn.click();
              return { success: true, method: 'data-testid' };
            }

            // Способ 3: Поиск кнопки с иконкой отправки (SVG с path)
            const svgButtons = buttons.filter(btn => btn.querySelector('svg'));
            sendBtn = svgButtons.find(btn => {
              const svg = btn.querySelector('svg');
              const title = svg?.querySelector('title')?.textContent?.toLowerCase() || '';
              return title.includes('send') || title.includes('отправить');
            });
            if (sendBtn) {
              console.log('✓ Найдена кнопка по SVG title');
              sendBtn.click();
              return { success: true, method: 'svg-title' };
            }

            // Способ 4: Поиск по классу span._3y5oW (WhatsApp send icon wrapper)
            const spanWithIcon = document.querySelector('span[data-icon="send"]');
            if (spanWithIcon) {
              const btn = spanWithIcon.closest('button, div[role="button"], span[role="button"]');
              if (btn) {
                console.log('✓ Найдена кнопка по data-icon="send"');
                btn.click();
                return { success: true, method: 'data-icon' };
              }
            }

            // Способ 5: Поиск зеленой кнопки в footer области (где обычно кнопка отправки)
            const footer = document.querySelector('footer, div[role="contentinfo"]');
            if (footer) {
              const greenButtons = Array.from(footer.querySelectorAll('button, div[role="button"], span[role="button"]')).filter(btn => {
                const style = window.getComputedStyle(btn);
                const bgColor = style.backgroundColor;
                // Зеленая кнопка WhatsApp примерно rgb(0, 168, 132)
                return bgColor.includes('0, 168') || bgColor.includes('rgb(0, 150') || btn.className.includes('send');
              });
              if (greenButtons.length > 0) {
                console.log('✓ Найдена зеленая кнопка в footer');
                greenButtons[0].click();
                return { success: true, method: 'green-button' };
              }
            }

            return { success: false, buttonsFound: buttons.length, debug: buttons.slice(0, 5).map(b => ({
              tag: b.tagName,
              aria: b.getAttribute('aria-label'),
              testid: b.getAttribute('data-testid'),
              class: b.className
            })) };
          });

          if (sendResult.success) {
            console.log(`✅ Кнопка отправки найдена (метод: ${sendResult.method})`);
            if (sendResult.buttonsInfo) {
              console.log(`🔍 Найдено кнопок с send иконкой: ${sendResult.buttonsFound}`);
              sendResult.buttonsInfo.forEach(info => {
                console.log(`  Кнопка ${info.index}: ${info.width}x${info.height} at (${info.x},${info.y}), aria="${info.aria}", icon="${info.icon}"`);
              });
            }

            // Кликаем через Puppeteer mouse.click() по координатам кнопки
            if (sendResult.clickTarget) {
              console.log(`🖱️  Подготовка к клику по координатам: (${sendResult.clickTarget.x}, ${sendResult.clickTarget.y})`);

              // Добавляем задержку перед кликом
              await new Promise(resolve => setTimeout(resolve, 1000));

              // Пробуем тройной клик с задержками
              console.log('  Попытка 1: одиночный клик');
              await this.page.mouse.click(sendResult.clickTarget.x, sendResult.clickTarget.y);
              await new Promise(resolve => setTimeout(resolve, 500));

              // Проверяем, отправился ли файл после первого клика
              let quickCheck1 = await this.page.evaluate(() => {
                const messages = Array.from(document.querySelectorAll('[data-testid="msg-container"]'));
                if (messages.length === 0) return false;
                const lastMessage = messages[messages.length - 1];
                const hasDocument = lastMessage.querySelector('[data-testid="document-with-caption"], .document-thumb, [data-icon="document"]');
                return hasDocument !== null;
              });

              if (quickCheck1) {
                console.log('✅ Файл отправлен после первого клика!');
              } else {
                console.log('  Попытка 2: двойной клик');
                await this.page.mouse.click(sendResult.clickTarget.x, sendResult.clickTarget.y, { clickCount: 2 });
                await new Promise(resolve => setTimeout(resolve, 500));

                let quickCheck2 = await this.page.evaluate(() => {
                  const messages = Array.from(document.querySelectorAll('[data-testid="msg-container"]'));
                  if (messages.length === 0) return false;
                  const lastMessage = messages[messages.length - 1];
                  const hasDocument = lastMessage.querySelector('[data-testid="document-with-caption"], .document-thumb, [data-icon="document"]');
                  return hasDocument !== null;
                });

                if (quickCheck2) {
                  console.log('✅ Файл отправлен после двойного клика!');
                } else {
                  console.log('  Попытка 3: удержание и отпускание мыши');
                  await this.page.mouse.move(sendResult.clickTarget.x, sendResult.clickTarget.y);
                  await this.page.mouse.down();
                  await new Promise(resolve => setTimeout(resolve, 100));
                  await this.page.mouse.up();
                  console.log('✅ Клики выполнены');
                }
              }
            }

            // Ждем отправки и проверяем что сообщение появилось
            console.log('⏳ Ожидание подтверждения отправки (15 сек)...');

            // Пробуем несколько раз с интервалом
            let messageSent = false;
            for (let attempt = 1; attempt <= 5; attempt++) {
              await new Promise(resolve => setTimeout(resolve, 3000));
              console.log(`  Проверка ${attempt}/5...`);

              messageSent = await this.page.evaluate(() => {
                // Ищем последнее сообщение в чате
                const messages = Array.from(document.querySelectorAll('[data-testid="msg-container"]'));
                if (messages.length === 0) return false;

                const lastMessage = messages[messages.length - 1];
                // Проверяем что это исходящее сообщение (есть класс message-out или находится справа)
                const isOutgoing = lastMessage.querySelector('[data-testid="msg-meta"]')?.closest('[class*="message-out"]') ||
                                  lastMessage.classList.toString().includes('message-out');

                // Проверяем что есть документ/файл
                const hasDocument = lastMessage.querySelector('[data-testid="audio-play"], [data-testid="document-with-caption"], .document-thumb, [data-icon="document"]');

                return isOutgoing && hasDocument;
              });

              if (messageSent) {
                console.log(`✅ Файл успешно отправлен и появился в чате (попытка ${attempt})`);
                break;
              }
            }

            if (messageSent) {
              return { success: true, method: 'alternative-' + sendResult.method };
            } else {
              console.warn('⚠️  Кнопка нажата, но сообщение не появилось в чате после 15 секунд ожидания');
              await this.page.screenshot({ path: '/tmp/whatsapp_message_not_sent.png' });
              throw new Error('Сообщение не появилось в чате после нажатия кнопки отправки');
            }
          } else {
            console.error('❌ Не удалось найти кнопку отправки');
            console.error(`   Найдено кнопок: ${sendResult.buttonsFound}`);
            console.error(`   Отладка первых 5 кнопок:`, sendResult.debug);
            await this.page.screenshot({ path: '/tmp/whatsapp_no_send_button.png' });

            // Последняя попытка: нажать Enter
            console.log('🔄 Последняя попытка: нажатие Enter...');
            await this.page.keyboard.press('Enter');

            // Проверяем несколько раз, отправился ли файл
            let finalCheck = false;
            for (let i = 0; i < 5; i++) {
              await new Promise(resolve => setTimeout(resolve, 3000));
              console.log(`  Финальная проверка ${i + 1}/5...`);

              finalCheck = await this.page.evaluate(() => {
                const messages = Array.from(document.querySelectorAll('[data-testid="msg-container"]'));
                if (messages.length === 0) return false;
                const lastMessage = messages[messages.length - 1];
                const hasDocument = lastMessage.querySelector('[data-testid="document-with-caption"], .document-thumb, [data-icon="document"]');
                return hasDocument !== null;
              });

              if (finalCheck) {
                console.log(`✅ Файл отправлен (метод: Enter key, проверка ${i + 1})`);
                return { success: true, method: 'keyboard-enter' };
              }
            }

            // Если файл так и не отправился
            console.error('❌ Файл не отправился даже после нажатия Enter');
            await this.page.screenshot({ path: '/tmp/whatsapp_enter_failed.png' });
            throw new Error('Не удалось отправить файл даже через Enter');
          }
        } else {
          throw new Error('Не удалось найти input для загрузки файлов');
        }
      }

      console.log('✅ Кликнул на пункт "Документ"');

      // Даем время на активацию input для документов
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Теперь ищем input для документов
      console.log('🔍 Поиск input для загрузки документов...');
      const fileInputs = await this.page.$$('input[type="file"]');
      console.log(`📋 Найдено ${fileInputs.length} input элементов для файлов`);

      // Выбираем последний добавленный input (для документов)
      let fileInput = null;
      for (const input of fileInputs) {
        const accept = await this.page.evaluate(el => el.getAttribute('accept'), input);
        console.log(`  - Input с accept="${accept}"`);
        // Ищем input который принимает любые файлы (это для документов)
        if (!accept || accept === '*' || accept.includes('application/')) {
          fileInput = input;
          console.log(`  ✓ Выбран этот input для документов`);
        }
      }

      if (!fileInput && fileInputs.length > 0) {
        // Берем последний input (обычно это документный)
        fileInput = fileInputs[fileInputs.length - 1];
        console.log('  ⚠️ Использую последний input');
      }

      if (!fileInput) {
        await this.page.screenshot({ path: '/tmp/whatsapp_no_input.png' });
        console.error('❌ Input для файла не найден');
        throw new Error('Input для файла не найден');
      }

      // ЭМУЛЯЦИЯ ОТКРЫТИЯ ФАЙЛОВОГО ДИАЛОГА: сначала фокусируемся на input
      console.log('🎯 Фокусировка на input...');
      await this.page.evaluate((el) => {
        el.style.display = 'block';
        el.style.visibility = 'visible';
        el.focus();
      }, fileInput);

      await new Promise(resolve => setTimeout(resolve, 500));

      console.log(`📤 Загружаю файл: ${path.basename(filePath)}...`);

      // Загружаем файл
      await fileInput.uploadFile(filePath);
      console.log(`✅ Файл загружен в input`);

      // Триггерим все необходимые события для полной эмуляции
      console.log('🔄 Триггер событий input, change, blur...');
      await this.page.evaluate((el) => {
        // Триггерим события как при реальном выборе файла
        const events = ['input', 'change', 'blur'];
        events.forEach(eventType => {
          const event = new Event(eventType, { bubbles: true, cancelable: true });
          el.dispatchEvent(event);
        });
      }, fileInput);

      // Даем время WhatsApp обработать файл
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Проверяем появление модального окна предпросмотра - используем более надежную проверку
      console.log('⏳ Ожидание модального окна предпросмотра...');
      const previewVisible = await Promise.race([
        this.page.waitForSelector('[data-testid="media-viewer"]', { timeout: 15000 }).catch(() => null),
        this.page.waitForSelector('.media-viewer', { timeout: 15000 }).catch(() => null),
        this.page.waitForSelector('[role="dialog"]', { timeout: 15000 }).catch(() => null),
        this.page.waitForSelector('div[data-animate-modal-popup="true"]', { timeout: 15000 }).catch(() => null),
      ]);

      await new Promise(resolve => setTimeout(resolve, 1000));

      if (!previewVisible) {
        console.error('⚠️ Модальное окно предпросмотра не появилось!');
        await this.page.screenshot({ path: '/tmp/whatsapp_no_preview.png' });
        // Проверим что на странице вообще есть
        const pageContent = await this.page.evaluate(() => document.body.innerText);
        console.log('Текст на странице:', pageContent.substring(0, 200));
      } else {
        console.log('✅ Модальное окно предпросмотра открыто');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      await new Promise(resolve => setTimeout(resolve, 2000));

      // Ищем кнопку отправки ВНУТРИ модального окна
      let sendButton = null;

      // Попробуем найти кнопку внутри модального окна
      const sendButtonSelectors = [
        '[role="dialog"] [data-testid="send"]',
        '[role="dialog"] span[data-icon="send"]',
        'div[data-animate-modal-popup] [data-testid="send"]',
        'div[data-animate-modal-popup] span[data-icon="send"]',
        // На случай если модального окна нет (старая логика)
        '[data-testid="send"]',
        'span[data-icon="send"]'
      ];

      for (const selector of sendButtonSelectors) {
        sendButton = await this.page.$(selector);
        if (sendButton) {
          console.log(`✅ Найдена кнопка отправки: ${selector}`);
          break;
        }
      }

      if (!sendButton) {
        sendButton = await this.page.$('span[data-icon="send"]');
      }
      if (!sendButton) {
        sendButton = await this.page.$('[aria-label*="Send"]');
      }
      if (!sendButton) {
        sendButton = await this.page.$('[aria-label*="Отправить"]');
      }
      if (!sendButton) {
        // Ищем круглую кнопку отправки в модальном окне
        const buttons = await this.page.$$('button[aria-label], span[role="button"]');
        for (const btn of buttons) {
          const ariaLabel = await this.page.evaluate(el => el.getAttribute('aria-label'), btn);
          if (ariaLabel && (ariaLabel.includes('Send') || ariaLabel.includes('Отправить') || ariaLabel.includes('send'))) {
            sendButton = btn;
            break;
          }
        }
      }
      if (!sendButton) {
        // Последняя попытка - ищем любую кнопку с SVG внутри в правом нижнем углу модального окна
        const buttons = await this.page.$$('[role="dialog"] button, [data-testid="media-viewer"] button');
        for (const btn of buttons) {
          const html = await this.page.evaluate(el => el.outerHTML, btn);
          if (html.includes('svg') || html.includes('Send')) {
            sendButton = btn;
            break;
          }
        }
      }

      // Если все еще не нашли - пробуем JavaScript evaluation для прямого поиска и клика
      if (!sendButton) {
        console.log('⚠️ Стандартные селекторы не сработали, пробую JavaScript evaluation...');
        const clicked = await this.page.evaluate(() => {
          // Ищем все кнопки на странице
          const allButtons = Array.from(document.querySelectorAll('button, span[role="button"]'));

          // Фильтруем по видимости и позиции (правый нижний угол)
          for (const btn of allButtons) {
            const rect = btn.getBoundingClientRect();
            const ariaLabel = btn.getAttribute('aria-label') || '';
            const innerHTML = btn.innerHTML || '';

            // Проверяем: кнопка видима, находится в правой части экрана, содержит send-подобные признаки
            if (rect.width > 0 && rect.height > 0 &&
                rect.right > window.innerWidth * 0.5 &&
                rect.bottom > window.innerHeight * 0.3 &&
                (ariaLabel.toLowerCase().includes('send') ||
                 ariaLabel.toLowerCase().includes('отправить') ||
                 innerHTML.includes('send') ||
                 innerHTML.includes('<svg'))) {
              btn.click();
              return true;
            }
          }
          return false;
        });

        if (clicked) {
          console.log('✅ Файл отправлен через JavaScript evaluation!');
          await new Promise(resolve => setTimeout(resolve, 2000));
          return { success: true, message: 'Файл отправлен' };
        }
      }

      if (sendButton) {
        console.log('📤 Нажимаю кнопку отправки...');
        await sendButton.click();
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Ждем исчезновения модального окна - это означает что файл отправился
        console.log('⏳ Ожидание исчезновения модального окна (файл отправляется)...');
        try {
          await this.page.waitForFunction(() => {
            const modal = document.querySelector('[role="dialog"]') ||
                         document.querySelector('[data-testid="media-viewer"]') ||
                         document.querySelector('.media-viewer');
            return !modal;
          }, { timeout: 10000 });
          console.log('✅ Модальное окно закрылось - файл отправлен!');
        } catch (e) {
          console.log('⚠️  Модальное окно не исчезло за 10 секунд, но возможно файл все равно отправился');
          await this.page.screenshot({ path: '/tmp/whatsapp_after_send.png' });
        }

        // Дополнительная пауза для завершения отправки
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        await this.page.screenshot({ path: '/tmp/whatsapp_no_send.png' });
        throw new Error('Кнопка отправки не найдена');
      }

      // Отправляем текст отдельным сообщением, если он был передан
      if (message) {
        console.log('💬 Отправка текста отдельным сообщением...');
        try {
          // Ждем появления поля ввода сообщения
          await new Promise(resolve => setTimeout(resolve, 2000));

          const inputSelectors = [
            '[data-testid="conversation-compose-box-input"]',
            'footer [contenteditable="true"]',
            'div[contenteditable="true"][data-tab="10"]'
          ];

          let inputBox = null;
          for (const selector of inputSelectors) {
            inputBox = await this.page.$(selector);
            if (inputBox) {
              console.log(`  Найдено поле ввода: ${selector}`);
              break;
            }
          }

          if (inputBox) {
            // Кликаем на поле ввода и вводим текст
            await inputBox.click();
            await new Promise(resolve => setTimeout(resolve, 500));
            await this.page.keyboard.type(message);
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Нажимаем кнопку отправки - пробуем разные варианты
            const sendButtonSelectors = [
              '[data-testid="send"]',
              'span[data-icon="send"]',
              'button[aria-label*="Send"]',
              'button[aria-label*="Отправить"]',
              'span[data-testid="send"]'
            ];

            let sendButton = null;
            for (const selector of sendButtonSelectors) {
              sendButton = await this.page.$(selector);
              if (sendButton) {
                console.log(`  Найдена кнопка отправки: ${selector}`);
                break;
              }
            }

            if (!sendButton) {
              // Последняя попытка - ищем через evaluate
              const clicked = await this.page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button, span[role="button"]'));
                for (const btn of buttons) {
                  const ariaLabel = btn.getAttribute('aria-label') || '';
                  const testId = btn.getAttribute('data-testid') || '';
                  const innerHTML = btn.innerHTML || '';

                  if (ariaLabel.toLowerCase().includes('send') ||
                      ariaLabel.toLowerCase().includes('отправить') ||
                      testId === 'send' ||
                      innerHTML.includes('data-icon="send"')) {
                    btn.click();
                    return true;
                  }
                }
                return false;
              });

              if (clicked) {
                console.log('✅ Текст отправлен отдельным сообщением (через evaluate)');
              } else {
                console.error('⚠️ Кнопка отправки текста не найдена');
              }
            } else {
              await sendButton.click();
              await new Promise(resolve => setTimeout(resolve, 1000));
              console.log('✅ Текст отправлен отдельным сообщением');
            }
          } else {
            console.error('⚠️ Поле ввода текста не найдено');
          }
        } catch (error) {
          console.error('⚠️ Ошибка отправки текстового сообщения:', error.message);
          // Не бросаем ошибку, так как файл уже отправлен успешно
        }
      }

      return { success: true, message: 'Файл отправлен' };
    } catch (error) {
      console.error('❌ Ошибка отправки файла:', error.message);

      // Пытаемся обработать таймаут и перезапустить браузер
      const restarted = await this.handleTimeoutError(error);
      if (restarted) {
        throw new Error('Браузер был перезапущен из-за таймаута. Повторите попытку через минуту.');
      }

      // Сохраняем скриншот для отладки
      try {
        await this.page.screenshot({ path: '/tmp/whatsapp_send_error.png' });
        console.log('📸 Скриншот ошибки сохранен: /tmp/whatsapp_send_error.png');
      } catch (screenshotError) {
        console.error('Не удалось сохранить скриншот:', screenshotError.message);
      }
      throw error;
    }
  }

  async getScreenshot() {
    if (!this.page) {
      throw new Error('Страница не инициализирована');
    }
    try {
      // Добавляем таймаут на создание скриншота
      const screenshot = await Promise.race([
        this.page.screenshot({
          fullPage: false,
          type: 'png'
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Таймаут создания скриншота')), 10000)
        )
      ]);
      return screenshot;
    } catch (error) {
      console.error('❌ Ошибка создания скриншота:', error.message);
      // Возвращаем пустое изображение или бросаем ошибку
      throw new Error('Не удалось создать скриншот: ' + error.message);
    }
  }

  getQRCode() {
    return null; // QR в браузере
  }

  getStatus() {
    return {
      isReady: this.isReady,
      browserActive: this.browser !== null && this.page !== null,
      sessionExists: fs.existsSync(this.sessionDir)
    };
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
      this.isReady = false;
      console.log('🔒 WhatsApp закрыт');
    }
  }

  async restart() {
    console.log('🔄 Перезапуск WhatsApp...');
    await this.close();
    await new Promise(resolve => setTimeout(resolve, 2000));
    await this.initialize();
  }
}

const whatsappManager = new WhatsAppManager();
export default whatsappManager;
