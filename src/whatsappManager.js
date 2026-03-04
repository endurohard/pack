import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class WhatsAppManager {
  constructor() {
    this.browser = null;
    this.page = null;
    this.isReady = false;
    this.sessionDir = path.join(__dirname, '../data/whatsapp-session');
    this.testMode = process.env.WHATSAPP_TEST_MODE === 'true';
    this.testPhone = process.env.WHATSAPP_TEST_PHONE || '79999999999';

    if (this.testMode) {
      console.log('🧪 WhatsApp в ТЕСТОВОМ режиме - сообщения НЕ будут отправляться');
      console.log(`🧪 Тестовый номер: ${this.testPhone}`);
    }

    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
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
    // В тестовом режиме браузер не запускаем
    if (this.testMode) {
      console.log('🧪 ТЕСТОВЫЙ РЕЖИМ: Браузер не запускается');
      this.isReady = true;
      return;
    }

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
          '--disable-blink-features=AutomationControlled', // Скрыть automation
          '--disable-web-security', // Отключить CORS для работы WhatsApp
          '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
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
      console.log('📱 Отсканируйте QR-код в браузере (если требуется)');

      // Проверяем авторизацию (несколько вариантов селекторов)
      let checkCount = 0;
      const maxChecks = 60; // 60 проверок * 5 сек = 5 минут

      const checkAuth = setInterval(async () => {
        try {
          checkCount++;

          const pageState = await this.page.evaluate(() => {
            // Проверяем несколько возможных селекторов для авторизованной страницы
            const hasChats = document.querySelector('[data-testid="chat-list"]') !== null;
            const hasSidebar = document.querySelector('#side') !== null;
            const hasUserAvatar = document.querySelector('[data-testid="default-user"]') !== null;
            const noLanding = document.querySelector('.landing-main') === null;
            const hasQR = document.querySelector('[data-testid="qrcode"]') !== null;
            const pageText = document.body.textContent || '';

            return {
              hasChats,
              hasSidebar,
              hasUserAvatar,
              noLanding,
              hasQR,
              hasConnectionError: pageText.includes('Connecting') || pageText.includes('Подключение'),
              url: window.location.href
            };
          });

          // Логируем состояние каждые 10 секунд
          if (checkCount % 2 === 0) {
            console.log(`[WhatsApp] Проверка ${checkCount}/${maxChecks}:`, {
              chats: pageState.hasChats,
              sidebar: pageState.hasSidebar,
              avatar: pageState.hasUserAvatar,
              qr: pageState.hasQR,
              url: pageState.url.substring(0, 50)
            });
          }

          // Если есть хотя бы 2 признака авторизации
          const authCount = [
            pageState.hasChats,
            pageState.hasSidebar,
            pageState.hasUserAvatar,
            pageState.noLanding
          ].filter(Boolean).length;

          const isAuthenticated = authCount >= 2;

          if (isAuthenticated) {
            clearInterval(checkAuth);
            this.isReady = true;
            console.log('✅ WhatsApp Web готов к использованию!');
          } else if (checkCount >= maxChecks) {
            clearInterval(checkAuth);
            console.error('❌ Таймаут ожидания авторизации WhatsApp (5 минут)');
            console.log('📱 Попробуйте перезапустить через API: POST /api/whatsapp/restart');
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
    // Обработка тестового режима
    if (this.testMode) {
      let cleanPhone = phone.replace(/[^0-9]/g, '');
      if (cleanPhone.startsWith('8')) {
        cleanPhone = '7' + cleanPhone.substring(1);
      }
      if (!cleanPhone.startsWith('7')) {
        cleanPhone = '7' + cleanPhone;
      }

      console.log('🧪 ТЕСТОВЫЙ РЕЖИМ: Сообщение НЕ отправлено');
      console.log(`  📱 Получатель: ${cleanPhone}`);
      console.log(`  💬 Сообщение: ${message.substring(0, 100)}${message.length > 100 ? '...' : ''}`);

      return {
        success: true,
        message: 'Сообщение отправлено (ТЕСТОВЫЙ РЕЖИМ)',
        testMode: true,
        recipient: cleanPhone
      };
    }

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
        await this.page.evaluate((phone) => {
          window.location.href = `https://web.whatsapp.com/send?phone=${phone}`;
        }, cleanPhone);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Ждем появления чата
      console.log('⏳ Ожидание загрузки чата...');

      // Даем время на появление модальных окон (ошибок или загрузки чата)
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Проверяем наличие ошибки подключения к WhatsApp
      try {
        const connectionError = await this.page.evaluate(() => {
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

  async sendMessageWithFile(phone, message, filePath) {
    // Обработка тестового режима
    if (this.testMode) {
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

      const fileSize = fs.statSync(filePath).size;
      const fileName = path.basename(filePath);

      console.log('🧪 ТЕСТОВЫЙ РЕЖИМ: Файл НЕ отправлен');
      console.log(`  📱 Получатель: ${cleanPhone}`);
      console.log(`  📄 Файл: ${fileName} (${fileSize} байт)`);
      console.log(`  💬 Сопроводительный текст: ${message || '(нет)'}`);

      return {
        success: true,
        message: 'Файл отправлен (ТЕСТОВЫЙ РЕЖИМ)',
        testMode: true,
        recipient: cleanPhone,
        file: fileName
      };
    }

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

      // Даем время на появление модальных окон (ошибок или загрузки чата)
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Проверяем наличие ошибки подключения к WhatsApp
      try {
        const connectionError = await this.page.evaluate(() => {
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

      // ВАЖНО: Нужно кликнуть на пункт меню "Документ" (или "Document")
      console.log('📄 Ищу пункт меню "Документ"...');

      // Используем evaluate для поиска элемента по тексту (русский/английский)
      const documentButton = await this.page.evaluate(() => {
        // Ищем все элементы, которые содержат текст "Документ" или "Document"
        const elements = Array.from(document.querySelectorAll('span, div, li, button'));

        // Ищем элемент с точным текстом "Документ"
        let docElement = elements.find(el => {
          const text = el.textContent.trim();
          return text === 'Документ' || text === 'Document';
        });

        // Если не нашли точное совпадение, ищем частичное
        if (!docElement) {
          docElement = elements.find(el => {
            const text = el.textContent.trim().toLowerCase();
            return text.includes('документ') || text.includes('document');
          });
        }

        if (docElement) {
          // Пробуем кликнуть на сам элемент
          docElement.click();

          // Также пробуем кликнуть на родительские элементы
          let clickable = docElement.parentElement;
          let maxDepth = 10; // Увеличиваем глубину поиска
          while (clickable && maxDepth > 0) {
            // Кликаем на любой родительский элемент с cursor pointer или role
            const style = window.getComputedStyle(clickable);
            const hasRole = clickable.getAttribute('role');
            const hasClick = clickable.onclick || style.cursor === 'pointer';

            if (hasRole || hasClick || clickable.tagName === 'LI' || clickable.tagName === 'BUTTON') {
              clickable.click();
              return { success: true, text: docElement.textContent.trim().substring(0, 50), tag: clickable.tagName };
            }
            clickable = clickable.parentElement;
            maxDepth--;
          }

          // Если ничего не сработало, возвращаем успех от клика на сам элемент
          return { success: true, text: docElement.textContent.trim().substring(0, 50), tag: 'SPAN' };
        }

        // Если не нашли, пробуем найти по data-testid
        const docByTestId = document.querySelector('[data-testid*="document"], [data-testid*="attach-document"]');
        if (docByTestId) {
          docByTestId.click();
          return { success: true, text: 'testid', tag: 'TESTID' };
        }

        return { success: false };
      });

      if (!documentButton.success) {
        // Сохраняем скриншот и HTML для анализа
        await this.page.screenshot({ path: '/tmp/whatsapp_no_doc_button.png' });

        // Получаем текст всех элементов в меню для отладки
        const menuItems = await this.page.evaluate(() => {
          const items = Array.from(document.querySelectorAll('span, li, button'));
          return items.map(el => el.textContent.trim()).filter(t => t.length > 0 && t.length < 50);
        });

        console.error('❌ Пункт меню "Документ" не найден');
        console.log('📋 Доступные пункты меню:', menuItems.slice(0, 20));
        throw new Error('Пункт меню "Документ" не найден');
      }

      console.log('✅ Кликнул на пункт "Документ":', documentButton.text);

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
      sessionExists: fs.existsSync(this.sessionDir),
      testMode: this.testMode
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
