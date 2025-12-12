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

    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
  }

  async initialize() {
    try {
      console.log('📱 Инициализация WhatsApp Web через Puppeteer...');

      this.browser = await puppeteer.launch({
        headless: false,
        userDataDir: this.sessionDir,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu'
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

      await this.page.goto(`https://web.whatsapp.com/send?phone=${cleanPhone}&text=${encodeURIComponent(message)}`, {
        waitUntil: 'networkidle2',
        timeout: 30000
      });

      await this.page.waitForSelector('[data-testid="conversation-compose-box-input"]', { timeout: 15000 });
      await new Promise(resolve => setTimeout(resolve, 1000));

      const sendButton = await this.page.$('[data-testid="send"]');
      if (sendButton) {
        await sendButton.click();
        console.log('✅ Сообщение отправлено');
      }

      return { success: true, message: 'Сообщение отправлено' };
    } catch (error) {
      console.error('❌ Ошибка отправки сообщения:', error.message);
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

      await this.page.goto(`https://web.whatsapp.com/send?phone=${cleanPhone}`, {
        waitUntil: 'load',
        timeout: 60000
      });

      // Ждем исчезновения экрана загрузки и появления чата
      console.log('⏳ Ожидание загрузки чата...');

      // Даем время на начальную загрузку
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Ждем загрузки чата с несколькими возможными селекторами
      const chatLoaded = await Promise.race([
        this.page.waitForSelector('[data-testid="conversation-compose-box-input"]', { timeout: 25000 }).catch(() => null),
        this.page.waitForSelector('footer [contenteditable="true"]', { timeout: 25000 }).catch(() => null),
        this.page.waitForSelector('[data-testid="clip"]', { timeout: 25000 }).catch(() => null),
        this.page.waitForSelector('div[contenteditable="true"][data-tab="10"]', { timeout: 25000 }).catch(() => null),
      ]);

      if (!chatLoaded) {
        console.error('❌ Не удалось дождаться загрузки чата');
        await this.page.screenshot({ path: '/tmp/whatsapp_error.png' });
        throw new Error('Чат не загрузился');
      }

      console.log('✅ Чат загружен');
      await new Promise(resolve => setTimeout(resolve, 2000));

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

      console.log('📎 Нажимаю кнопку прикрепления...');
      await attachButton.click();
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Находим input для файла
      const fileInput = await this.page.$('input[type="file"][accept*="*"]');
      if (!fileInput) {
        await this.page.screenshot({ path: '/tmp/whatsapp_no_input.png' });
        throw new Error('Input для файла не найден');
      }

      console.log(`📤 Загружаю файл: ${path.basename(filePath)}...`);
      await fileInput.uploadFile(filePath);
      console.log(`✅ Файл загружен: ${path.basename(filePath)}`);

      // Ждем появления модального окна предпросмотра файла
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Проверяем появление модального окна
      const previewVisible = await Promise.race([
        this.page.waitForSelector('[data-testid="media-viewer"]', { timeout: 10000 }).catch(() => null),
        this.page.waitForSelector('.media-viewer', { timeout: 10000 }).catch(() => null),
        this.page.waitForSelector('[role="dialog"]', { timeout: 10000 }).catch(() => null),
      ]);

      if (!previewVisible) {
        console.error('⚠️ Модальное окно предпросмотра не появилось, но продолжаем...');
      } else {
        console.log('✅ Модальное окно предпросмотра открыто');
      }

      await new Promise(resolve => setTimeout(resolve, 2000));

      // Добавляем текст если есть
      if (message) {
        const captionSelectors = [
          '[data-testid="media-caption-input-container"] [contenteditable="true"]',
          'div[contenteditable="true"][data-lexical-editor="true"]',
          'div[contenteditable="true"][data-tab="10"]'
        ];

        let captionBox = null;
        for (const selector of captionSelectors) {
          captionBox = await this.page.$(selector);
          if (captionBox) break;
        }

        if (captionBox) {
          await captionBox.click();
          await new Promise(resolve => setTimeout(resolve, 300));
          await this.page.keyboard.type(message);
          await new Promise(resolve => setTimeout(resolve, 500));
          console.log('💬 Добавлено сообщение к файлу');
        }
      }

      // Отправляем с несколькими вариантами селектора
      let sendButton = await this.page.$('[data-testid="send"]');
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
        console.log('📤 Отправляю файл...');
        await sendButton.click();
        console.log('✅ Файл отправлен!');
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        await this.page.screenshot({ path: '/tmp/whatsapp_no_send.png' });
        throw new Error('Кнопка отправки не найдена');
      }

      return { success: true, message: 'Файл отправлен' };
    } catch (error) {
      console.error('❌ Ошибка отправки файла:', error.message);
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
    return await this.page.screenshot({ fullPage: false });
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
