import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class WhatsAppManager {
  constructor() {
    this.browser = null;
    this.page = null;
    this.isReady = false;
    this.sessionDir = path.join(__dirname, '../data/whatsapp-session');

    // Создаем директорию для сессии если её нет
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
  }

  /**
   * Инициализация браузера и WhatsApp Web
   */
  async initialize() {
    try {
      console.log('🚀 Запуск браузера для WhatsApp Web...');

      this.browser = await puppeteer.launch({
        headless: false, // Нужен non-headless для работы с WhatsApp Web
        userDataDir: this.sessionDir, // Сохраняем сессию
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--remote-debugging-port=9222', // Включаем удаленную отладку
          '--disable-blink-features=AutomationControlled'
        ]
      });

      this.page = await this.browser.newPage();
      await this.page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      console.log('🌐 Открытие WhatsApp Web...');
      await this.page.goto('https://web.whatsapp.com', {
        waitUntil: 'networkidle2',
        timeout: 60000
      });

      // Ждем либо QR-код, либо успешную авторизацию
      await this.waitForAuth();

      console.log('✅ WhatsApp Web готов к использованию!');
      this.isReady = true;

    } catch (error) {
      console.error('❌ Ошибка инициализации WhatsApp:', error.message);
      throw error;
    }
  }

  /**
   * Ожидание авторизации
   */
  async waitForAuth() {
    try {
      console.log('📱 Проверка авторизации...');

      // Ждем несколько секунд, чтобы страница загрузилась
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Проверяем, авторизованы ли мы уже - ищем элементы интерфейса WhatsApp
      const isAuthenticated = await this.page.evaluate(() => {
        // Ищем различные признаки авторизованного интерфейса
        const hasChats = document.querySelector('[role="grid"]') !== null ||
                        document.querySelector('[data-testid="chat-list"]') !== null ||
                        document.querySelector('#pane-side') !== null ||
                        document.querySelector('[aria-label*="Чат"]') !== null ||
                        document.querySelector('[aria-label*="Chat"]') !== null;

        const hasSearchBox = document.querySelector('[data-testid="chat-list-search"]') !== null ||
                             document.querySelector('input[type="text"]') !== null;

        return hasChats || hasSearchBox;
      });

      if (isAuthenticated) {
        console.log('✅ Сессия сохранена, авторизация не требуется');
        this.isReady = true;
        return;
      }

      console.log('📱 Требуется сканирование QR-кода...');
      console.log('⏳ Откройте WhatsApp на телефоне и отсканируйте QR-код в открывшемся браузере');

      // Ждем появления интерфейса WhatsApp (любой из признаков)
      await this.page.waitForFunction(() => {
        const hasChats = document.querySelector('[role="grid"]') !== null ||
                        document.querySelector('[data-testid="chat-list"]') !== null ||
                        document.querySelector('#pane-side') !== null;
        return hasChats;
      }, {
        timeout: 300000 // 5 минут на сканирование
      });

      console.log('✅ Авторизация успешна!');

      // Даем время загрузиться всем чатам
      await new Promise(resolve => setTimeout(resolve, 3000));
      this.isReady = true;

    } catch (error) {
      if (error.name === 'TimeoutError') {
        console.error('❌ Время ожидания сканирования QR-кода истекло');
      }
      throw error;
    }
  }

  /**
   * Отправка сообщения в WhatsApp
   */
  async sendMessage(phone, message) {
    if (!this.isReady) {
      throw new Error('WhatsApp Web не инициализирован');
    }

    try {
      // Нормализуем номер телефона
      let cleanPhone = phone.replace(/[^0-9]/g, '');
      if (cleanPhone.startsWith('8')) {
        cleanPhone = '7' + cleanPhone.substring(1);
      }
      if (!cleanPhone.startsWith('7')) {
        cleanPhone = '7' + cleanPhone;
      }

      const url = `https://web.whatsapp.com/send?phone=${cleanPhone}&text=${encodeURIComponent(message)}`;

      console.log(`📤 Открытие чата с номером ${cleanPhone}...`);
      await this.page.goto(url, { waitUntil: 'networkidle2' });

      // Ждем загрузки чата
      await this.page.waitForSelector('[data-testid="conversation-compose-box-input"]', {
        timeout: 10000
      });

      console.log('✅ Чат открыт, сообщение подготовлено');

      return {
        success: true,
        message: 'Чат открыт, сообщение готово к отправке'
      };

    } catch (error) {
      console.error('❌ Ошибка отправки:', error.message);
      throw error;
    }
  }

  /**
   * Отправка сообщения с файлом в WhatsApp
   */
  async sendMessageWithFile(phone, message, filePath) {
    if (!this.isReady) {
      throw new Error('WhatsApp Web не инициализирован');
    }

    try {
      // Нормализуем номер телефона
      let cleanPhone = phone.replace(/[^0-9]/g, '');
      if (cleanPhone.startsWith('8')) {
        cleanPhone = '7' + cleanPhone.substring(1);
      }
      if (!cleanPhone.startsWith('7')) {
        cleanPhone = '7' + cleanPhone;
      }

      console.log(`📤 Открытие чата с номером ${cleanPhone}...`);

      // Используем прямую навигацию через URL (самый надежный способ)
      const chatUrl = `https://web.whatsapp.com/send?phone=${cleanPhone}`;

      try {
        // Пробуем перейти по URL с длительным таймаутом
        await this.page.goto(chatUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 60000
        });
      } catch (error) {
        // Если goto не работает, пробуем через evaluate (но без ожидания результата)
        console.log('⚠️  Прямая навигация не удалась, пробуем альтернативный метод...');
      }

      // Даем время на загрузку чата (увеличиваем до 10 секунд)
      await new Promise(resolve => setTimeout(resolve, 10000));

      console.log('✅ Чат должен быть открыт, начинаем отправку файла');

      // Пробуем найти поле ввода (несколько вариантов селекторов)
      let inputBox = null;
      const selectors = [
        '[data-testid="conversation-compose-box-input"]',
        'div[contenteditable="true"][data-tab="10"]',
        'div[contenteditable="true"]',
        'footer div[contenteditable="true"]'
      ];

      for (const selector of selectors) {
        try {
          inputBox = await this.page.waitForSelector(selector, { timeout: 5000 });
          console.log(`✅ Найдено поле ввода с селектором: ${selector}`);
          break;
        } catch (e) {
          console.log(`⚠️  Селектор ${selector} не найден, пробуем следующий...`);
        }
      }

      if (!inputBox) {
        throw new Error('Не удалось найти поле ввода сообщения');
      }

      console.log('📎 Ищем кнопку прикрепления...');

      // Сначала пробуем найти и нажать кнопку прикрепления
      const attachResult = await this.page.evaluate(() => {
        // Ищем все возможные кнопки
        const buttons = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"]'));

        // Ищем кнопку с иконкой скрепки
        const attachButton = buttons.find(btn => {
          const hasClipIcon = btn.querySelector('[data-icon="clip"]') !== null;
          const hasAttachIcon = btn.querySelector('[data-icon="attach"]') !== null;
          const hasPlusIcon = btn.querySelector('[data-icon="plus"]') !== null;
          const ariaLabel = btn.getAttribute('aria-label') || '';
          const title = btn.getAttribute('title') || '';

          return hasClipIcon || hasAttachIcon || hasPlusIcon ||
                 ariaLabel.toLowerCase().includes('attach') ||
                 ariaLabel.toLowerCase().includes('прикреп') ||
                 title.toLowerCase().includes('attach') ||
                 title.toLowerCase().includes('прикреп');
        });

        if (attachButton) {
          attachButton.click();
          return { success: true, found: true };
        }

        return { success: false, found: false };
      });

      if (!attachResult.found) {
        throw new Error('❌ Не удалось найти кнопку прикрепления! Проверьте WhatsApp Web интерфейс.');
      }

      console.log('✅ Кнопка прикрепления нажата');
      await new Promise(resolve => setTimeout(resolve, 1500));

      // После нажатия кнопки ищем кнопку "Документ"
      const docResult = await this.page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"], li[role="button"]'));

        const docButton = buttons.find(btn => {
          const hasDocIcon = btn.querySelector('[data-icon="document"]') !== null;
          const ariaLabel = btn.getAttribute('aria-label') || '';
          const title = btn.getAttribute('title') || '';
          const text = btn.textContent || '';

          return hasDocIcon ||
                 ariaLabel.toLowerCase().includes('document') ||
                 ariaLabel.toLowerCase().includes('документ') ||
                 title.toLowerCase().includes('document') ||
                 title.toLowerCase().includes('документ') ||
                 text.toLowerCase().includes('document') ||
                 text.toLowerCase().includes('документ');
        });

        if (docButton) {
          docButton.click();
          return { success: true, found: true };
        }

        return { success: false, found: false };
      });

      if (!docResult.found) {
        throw new Error('❌ Не удалось найти кнопку "Документ"! Проверьте WhatsApp Web интерфейс.');
      }

      console.log('✅ Кнопка "Документ" нажата');
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Теперь находим input для загрузки файлов
      let fileInput = await this.page.$('input[type="file"]');

      if (!fileInput) {
        const allFileInputs = await this.page.$$('input[type="file"]');
        if (allFileInputs.length === 0) {
          throw new Error('Не удалось найти input для загрузки файлов');
        }
        fileInput = allFileInputs[0];
        console.log(`✅ Найдено ${allFileInputs.length} input элементов для файлов`);
      } else {
        console.log('✅ Найден input для загрузки файлов');
      }

      // Загружаем файл
      await fileInput.uploadFile(filePath);
      console.log(`📄 Файл загружен: ${filePath}`);

      // Ждем загрузки файла в превью
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Теперь вводим текст в поле подписи файла (caption)
      // Ищем поле для ввода подписи в превью
      const captionSelectors = [
        '[data-testid="media-caption-input-container"] div[contenteditable="true"]',
        'div[contenteditable="true"][data-tab="10"]',
        'div[contenteditable="true"][role="textbox"]',
        'div.copyable-text[contenteditable="true"]'
      ];

      let captionBox = null;
      for (const selector of captionSelectors) {
        try {
          captionBox = await this.page.waitForSelector(selector, { timeout: 3000 });
          console.log(`✅ Найдено поле подписи с селектором: ${selector}`);
          break;
        } catch (e) {
          console.log(`⚠️  Селектор подписи ${selector} не найден, пробуем следующий...`);
        }
      }

      if (captionBox) {
        // Вводим текст подписи
        await captionBox.click();
        await captionBox.type(message, { delay: 50 });
        console.log('📝 Текст подписи введен');
      } else {
        console.warn('⚠️  Поле для подписи не найдено, файл будет отправлен без текста');
      }

      // Даем время на рендеринг превью (увеличиваем до 5 секунд)
      console.log('⏳ Ожидание полной загрузки превью файла...');
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Пробуем найти кнопку отправки через JavaScript
      console.log('🔍 Ищем кнопку отправки через все доступные методы...');

      // Используем более надежный способ - через evaluate с прямым кликом
      const sendClicked = await this.page.evaluate(() => {
        // Ищем все кнопки на странице
        const buttons = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"]'));

        // Ищем кнопку с иконкой отправки или текстом
        const sendBtn = buttons.find(btn => {
          const ariaLabel = btn.getAttribute('aria-label') || '';
          const innerHTML = btn.innerHTML || '';
          const title = btn.getAttribute('title') || '';
          const dataIcon = btn.querySelector('[data-icon="send"]');

          // Проверяем на наличие "send", "отправить", или иконки send
          return ariaLabel.toLowerCase().includes('send') ||
                 ariaLabel.toLowerCase().includes('отправить') ||
                 title.toLowerCase().includes('send') ||
                 title.toLowerCase().includes('отправить') ||
                 dataIcon !== null;
        });

        if (sendBtn) {
          // Кликаем напрямую из контекста страницы
          sendBtn.click();
          return true;
        }
        return false;
      });

      if (sendClicked) {
        console.log('✅ Кнопка отправки найдена и нажата через JavaScript');

        // Ждем немного после клика
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Дополнительно нажимаем Enter для гарантии отправки
        await this.page.keyboard.press('Enter');
        console.log('✅ Дополнительно нажат Enter для подтверждения отправки');

        // Ждем закрытия превью (признак успешной отправки)
        console.log('⏳ Ожидание закрытия превью...');
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        console.warn('⚠️  Кнопка отправки не найдена через JavaScript, пробуем Keyboard.press');

        // Пробуем отправить через Enter
        try {
          await this.page.keyboard.press('Enter');
          console.log('✅ Нажат Enter для отправки');

          // Ждем немного и проверяем, если не отправилось, пробуем еще раз
          await new Promise(resolve => setTimeout(resolve, 1000));

          // Проверяем, закрылось ли превью (признак успешной отправки)
          const previewClosed = await this.page.evaluate(() => {
            // Если превью закрылось, значит отправка успешна
            return !document.querySelector('div[data-animate-modal-popup="true"]');
          });

          if (!previewClosed) {
            console.log('⚠️  Превью не закрылось, пробуем еще раз нажать Enter...');
            await this.page.keyboard.press('Enter');
            console.log('✅ Повторное нажатие Enter');

            await new Promise(resolve => setTimeout(resolve, 1000));

            // Последняя попытка - кликнуть в правый нижний угол где обычно кнопка отправки
            const viewportSize = await this.page.viewport();
            if (viewportSize) {
              // Кликаем в правый нижний угол превью (примерное расположение кнопки отправки)
              await this.page.mouse.click(viewportSize.width - 100, viewportSize.height - 100);
              console.log('✅ Клик по предполагаемому расположению кнопки отправки');
            }
          }
        } catch (error) {
          console.error('⚠️  Ошибка при нажатии Enter:', error.message);
          throw new Error('Не удалось отправить сообщение');
        }
      }

      console.log('✅ Сообщение с файлом отправлено!');

      return {
        success: true,
        message: 'Сообщение с файлом отправлено'
      };

    } catch (error) {
      console.error('❌ Ошибка отправки с файлом:', error.message);
      throw error;
    }
  }

  /**
   * Получение URL для просмотра WhatsApp Web в браузере
   */
  async getBrowserUrl() {
    if (!this.browser) {
      return null;
    }

    const pages = await this.browser.pages();
    if (pages.length > 0) {
      return pages[0].url();
    }

    return null;
  }

  /**
   * Получить скриншот текущей страницы WhatsApp
   */
  async getScreenshot() {
    if (!this.page) {
      throw new Error('WhatsApp Web не инициализирован');
    }

    return await this.page.screenshot({
      type: 'png',
      fullPage: false
    });
  }

  /**
   * Получить отладочный WebSocket endpoint
   */
  getDebuggerUrl() {
    return 'http://localhost:9222';
  }

  /**
   * Проверка статуса
   */
  getStatus() {
    return {
      isReady: this.isReady,
      browserActive: this.browser !== null,
      sessionExists: fs.existsSync(this.sessionDir)
    };
  }

  /**
   * Закрытие браузера
   */
  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
      this.isReady = false;
      console.log('🔒 Браузер WhatsApp закрыт');
    }
  }

  /**
   * Перезапуск (если что-то пошло не так)
   */
  async restart() {
    await this.close();
    await this.initialize();
  }
}

// Создаем единственный экземпляр
const whatsappManager = new WhatsAppManager();

export default whatsappManager;
