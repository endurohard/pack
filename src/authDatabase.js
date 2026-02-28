import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = path.join(process.cwd(), 'data');
const AUTH_PATH = path.join(DATA_DIR, 'auth.json');

// Настройки для PBKDF2 (безопасная альтернатива bcrypt, встроенная в Node.js)
const PBKDF2_ITERATIONS = 100000; // 100k итераций (рекомендация OWASP 2023)
const PBKDF2_KEYLEN = 64; // 64 байта = 512 бит
const PBKDF2_DIGEST = 'sha512';

/**
 * Генерация случайной соли (16 байт)
 */
function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Безопасное хеширование пароля с использованием PBKDF2 + salt
 * PBKDF2 - это стандарт NIST, используется в iOS, Android, Windows
 */
function hashPasswordPBKDF2(password, salt) {
  return crypto.pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITERATIONS,
    PBKDF2_KEYLEN,
    PBKDF2_DIGEST
  ).toString('hex');
}

/**
 * Легаси функция для SHA-256 (только для миграции старых паролей)
 */
function legacyHashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

class AuthDatabase {
  constructor() {
    this.authData = null;
    this.saveQueue = Promise.resolve();
    this.initialized = false;
    this.initPromise = this.initialize();
  }

  async initialize() {
    await this.ensureDataDir();
    await this.loadData();
    this.initialized = true;
  }

  async ensureDataDir() {
    try {
      await fsPromises.access(DATA_DIR);
    } catch {
      await fsPromises.mkdir(DATA_DIR, { recursive: true });
    }
  }

  async loadData() {
    try {
      await fsPromises.access(AUTH_PATH);
      const data = await fsPromises.readFile(AUTH_PATH, 'utf-8');
      this.authData = JSON.parse(data);

      // Проверяем и дополняем недостающие поля
      if (!this.authData.hashType) {
        this.authData.hashType = 'sha256';
        this.authData.salt = null;
        await this.saveData();
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Initialize with default credentials (SHA-256 для обратной совместимости)
        console.log('[AuthDB] 🆕 Создание нового файла аутентификации');
        this.authData = {
          username: 'admin',
          passwordHash: legacyHashPassword('admin123'),
          salt: null,
          hashType: 'sha256', // Метка для миграции
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        await this.saveData();
      } else {
        throw error;
      }
    }
  }

  // Синхронное чтение данных для быстрого доступа
  loadDataSync() {
    try {
      const data = fs.readFileSync(AUTH_PATH, 'utf-8');
      this.authData = JSON.parse(data);

      // Проверяем и дополняем недостающие поля
      if (!this.authData.hashType) {
        this.authData.hashType = 'sha256';
        this.authData.salt = null;
        this.saveDataSync();
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Initialize with default credentials
        console.log('[AuthDB] 🆕 Создание нового файла аутентификации');
        this.authData = {
          username: 'admin',
          passwordHash: legacyHashPassword('admin123'),
          salt: null,
          hashType: 'sha256',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        this.saveDataSync();
      } else {
        throw error;
      }
    }
  }

  async saveData() {
    this.saveQueue = this.saveQueue.then(async () => {
      try {
        await fsPromises.writeFile(AUTH_PATH, JSON.stringify(this.authData, null, 2));
      } catch (error) {
        console.error('❌ Ошибка сохранения auth.json:', error.message);
        throw error;
      }
    });
    return this.saveQueue;
  }

  // Синхронная версия для срочных случаев
  saveDataSync() {
    try {
      fs.writeFileSync(AUTH_PATH, JSON.stringify(this.authData, null, 2));
    } catch (error) {
      console.error('❌ Ошибка синхронного сохранения auth:', error.message);
    }
  }

  /**
   * Validate credentials с автоматической миграцией на PBKDF2
   */
  validateCredentials(username, password) {
    // ВАЖНО: всегда перечитываем данные из файла перед проверкой
    this.loadDataSync();

    if (username !== this.authData.username) {
      return false;
    }

    // Проверяем тип хеша
    if (this.authData.hashType === 'sha256') {
      // Старый SHA-256 хеш - проверяем и мигрируем
      const legacyHash = legacyHashPassword(password);

      if (legacyHash === this.authData.passwordHash) {
        // ✅ Пароль верный! Автоматически мигрируем на PBKDF2
        console.log('[AuthDB] 🔄 Автоматическая миграция пароля с SHA-256 на PBKDF2...');
        const salt = generateSalt();
        this.authData.salt = salt;
        this.authData.passwordHash = hashPasswordPBKDF2(password, salt);
        this.authData.hashType = 'pbkdf2';
        this.authData.updatedAt = new Date().toISOString();
        this.saveData().catch(err => console.error('Ошибка сохранения auth:', err));
        console.log('[AuthDB] ✅ Пароль успешно мигрирован на PBKDF2 с солью');
        return true;
      }

      return false;
    }

    // Современный PBKDF2 хеш
    if (this.authData.hashType === 'pbkdf2') {
      const hash = hashPasswordPBKDF2(password, this.authData.salt);
      return hash === this.authData.passwordHash;
    }

    // Неизвестный тип хеша
    console.error('[AuthDB] ❌ Неизвестный тип хеша:', this.authData.hashType);
    return false;
  }

  /**
   * Get current username
   */
  getUsername() {
    // ВАЖНО: всегда перечитываем данные из файла
    this.loadDataSync();
    return this.authData.username;
  }

  /**
   * Change credentials с PBKDF2
   */
  changeCredentials(currentPassword, newUsername, newPassword) {
    // ВАЖНО: перечитываем данные из файла перед изменением
    this.loadDataSync();

    // Validate current password
    if (!this.validateCredentials(this.authData.username, currentPassword)) {
      throw new Error('Неверный текущий пароль');
    }

    // Validate new username
    if (!newUsername || newUsername.trim().length < 3) {
      throw new Error('Логин должен содержать минимум 3 символа');
    }

    // Validate new password
    if (!newPassword || newPassword.length < 6) {
      throw new Error('Пароль должен содержать минимум 6 символов');
    }

    // Update credentials with PBKDF2
    const salt = generateSalt();
    this.authData.username = newUsername.trim();
    this.authData.salt = salt;
    this.authData.passwordHash = hashPasswordPBKDF2(newPassword, salt);
    this.authData.hashType = 'pbkdf2';
    this.authData.updatedAt = new Date().toISOString();
    this.saveData();

    console.log('[AuthDB] 🔐 Учётные данные обновлены с PBKDF2');

    // ВАЖНО: перезагружаем данные из файла
    this.loadDataSync();

    return {
      username: this.authData.username,
      updatedAt: this.authData.updatedAt
    };
  }

  /**
   * Проверить, нужна ли миграция
   */
  needsMigration() {
    this.loadDataSync();
    return this.authData.hashType !== 'pbkdf2';
  }

  /**
   * Получить информацию о безопасности
   */
  getSecurityInfo() {
    this.loadDataSync();
    return {
      hashType: this.authData.hashType,
      needsMigration: this.needsMigration(),
      lastUpdated: this.authData.updatedAt
    };
  }
}

export default new AuthDatabase();
