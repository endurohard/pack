import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = path.join(process.cwd(), 'data');
const AUTH_PATH = path.join(DATA_DIR, 'auth.json');

/**
 * Hash password using SHA-256
 */
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

class AuthDatabase {
  constructor() {
    this.ensureDataDir();
    this.loadData();
  }

  ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  loadData() {
    if (fs.existsSync(AUTH_PATH)) {
      const data = fs.readFileSync(AUTH_PATH, 'utf-8');
      this.authData = JSON.parse(data);
    } else {
      // Initialize with default credentials
      this.authData = {
        username: 'admin',
        passwordHash: hashPassword('admin123'),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      this.saveData();
    }
  }

  saveData() {
    fs.writeFileSync(AUTH_PATH, JSON.stringify(this.authData, null, 2));
  }

  /**
   * Validate credentials
   */
  validateCredentials(username, password) {
    const passwordHash = hashPassword(password);
    return username === this.authData.username &&
           passwordHash === this.authData.passwordHash;
  }

  /**
   * Get current username
   */
  getUsername() {
    return this.authData.username;
  }

  /**
   * Change credentials
   */
  changeCredentials(currentPassword, newUsername, newPassword) {
    // Validate current password
    const currentPasswordHash = hashPassword(currentPassword);
    if (currentPasswordHash !== this.authData.passwordHash) {
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

    // Update credentials
    this.authData.username = newUsername.trim();
    this.authData.passwordHash = hashPassword(newPassword);
    this.authData.updatedAt = new Date().toISOString();
    this.saveData();

    return {
      username: this.authData.username,
      updatedAt: this.authData.updatedAt
    };
  }
}

export default new AuthDatabase();
