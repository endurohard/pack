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

        // Открываем чат через внутреннюю навигацию (без перезагрузки страницы)
        await this.page.evaluate((phone) => {
          window.location.href = `https://web.whatsapp.com/send?phone=${phone}`;
        }, cleanPhone);

        // Даем время на начало навигации
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Ожидаем исчезновения спиннера загрузки (если он есть)
        console.log('⏳ Ожидание загрузки интерфейса...');
        try {
          await this.page.waitForSelector('div[data-testid="default-user"]', { timeout: 3000 });
          console.log('  Загрузка интерфейса...');
          await new Promise(resolve => setTimeout(resolve, 3000));
        } catch (e) {
          // Спиннер может не появиться, продолжаем
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      // Ждем появления чата
      console.log('⏳ Ожидание загрузки чата...');

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
      await new Promise(resolve => setTimeout(resolve, 1500));

      // ВАЖНО: Нужно кликнуть на пункт меню "Документ"
      console.log('📄 Ищу пункт меню "Документ"...');

      // Используем evaluate для поиска элемента по тексту
      const documentButton = await this.page.evaluate(() => {
        // Ищем все элементы, которые содержат текст "Документ"
        const elements = Array.from(document.querySelectorAll('span, div, li'));
        const docElement = elements.find(el => el.textContent.trim() === 'Документ');

        if (docElement) {
          // Находим кликабельный родительский элемент (обычно это li или button)
          let clickable = docElement;
          while (clickable && clickable.tagName !== 'LI' && clickable.tagName !== 'BUTTON') {
            clickable = clickable.parentElement;
          }

          if (clickable) {
            clickable.click();
            return true;
          }
        }

        return false;
      });

      if (!documentButton) {
        await this.page.screenshot({ path: '/tmp/whatsapp_no_doc_button.png' });
        console.error('❌ Пункт меню "Документ" не найден');
        throw new Error('Пункт меню "Документ" не найден');
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
