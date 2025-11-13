import crypto from 'crypto';
import dotenv from 'dotenv';
import authDatabase from './authDatabase.js';

dotenv.config();

// Хранилище токенов в памяти
const tokens = new Map();

/**
 * Генерация случайного токена
 */
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Проверка учетных данных через базу данных
 */
export function validateCredentials(username, password) {
  return authDatabase.validateCredentials(username, password);
}

/**
 * Создание нового токена для пользователя
 */
export function createToken(username) {
  const token = generateToken();
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 часа

  tokens.set(token, {
    username,
    expiresAt
  });

  return token;
}

/**
 * Проверка валидности токена
 */
export function verifyToken(token) {
  const tokenData = tokens.get(token);

  if (!tokenData) {
    return { valid: false };
  }

  // Проверка истечения срока действия
  if (tokenData.expiresAt < Date.now()) {
    tokens.delete(token);
    return { valid: false };
  }

  return {
    valid: true,
    username: tokenData.username
  };
}

/**
 * Удаление токена (выход)
 */
export function revokeToken(token) {
  tokens.delete(token);
}

/**
 * Middleware для проверки авторизации
 */
export function authMiddleware(req, res, next) {
  // Пропускаем страницу логина, все API и статические ресурсы, и все HTML страницы
  // Авторизация для HTML страниц проверяется на клиенте через auth.js
  if (req.path === '/login.html' ||
      req.path === '/login' ||
      req.path.startsWith('/api/') ||
      req.path.endsWith('.html') ||
      req.path.endsWith('.css') ||
      req.path.endsWith('.js') ||
      req.path.endsWith('.png') ||
      req.path.endsWith('.jpg') ||
      req.path.endsWith('.jpeg') ||
      req.path.endsWith('.gif') ||
      req.path.endsWith('.svg') ||
      req.path.endsWith('.ico') ||
      req.path.endsWith('.woff') ||
      req.path.endsWith('.woff2') ||
      req.path.endsWith('.ttf') ||
      req.path.endsWith('.eot') ||
      req.path.endsWith('.pdf') ||
      req.path === '/' ||
      req.path === '/invoices' ||
      req.path === '/clients' ||
      req.path === '/warehouse' ||
      req.path === '/analytics' ||
      req.path === '/settings' ||
      req.path === '/whatsapp-viewer') {
    return next();
  }

  // Получаем токен из заголовка Authorization
  const authHeader = req.headers.authorization;
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  }

  if (!token) {
    // Для HTML запросов - редирект на логин
    if (req.accepts('html')) {
      return res.redirect('/login.html');
    }
    // Для API запросов - 401
    return res.status(401).json({ error: 'Требуется авторизация' });
  }

  // Проверяем токен
  const verification = verifyToken(token);

  if (!verification.valid) {
    if (req.accepts('html')) {
      return res.redirect('/login.html');
    }
    return res.status(401).json({ error: 'Недействительный токен' });
  }

  // Добавляем информацию о пользователе в запрос
  req.user = {
    username: verification.username
  };

  next();
}

/**
 * Обработчик логина
 */
export function loginHandler(req, res) {
  const { username, password } = req.body;

  if (!validateCredentials(username, password)) {
    return res.status(401).json({
      success: false,
      error: 'Неверный логин или пароль'
    });
  }

  const token = createToken(username);

  res.json({
    success: true,
    token,
    username
  });
}

/**
 * Обработчик проверки токена
 */
export function verifyHandler(req, res) {
  const authHeader = req.headers.authorization;
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  }

  if (!token) {
    return res.json({ valid: false });
  }

  const verification = verifyToken(token);
  res.json(verification);
}

/**
 * Обработчик выхода
 */
export function logoutHandler(req, res) {
  const authHeader = req.headers.authorization;
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  }

  if (token) {
    revokeToken(token);
  }

  res.json({ success: true });
}
