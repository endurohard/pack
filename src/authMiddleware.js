import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

// Получаем логин и пароль из переменных окружения
const AUTH_USERNAME = process.env.AUTH_USERNAME || 'admin';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || 'admin123';

// Простое хранилище токенов (в продакшене используйте Redis или БД)
const tokens = new Map();

/**
 * Генерировать случайный токен
 */
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Проверить логин и пароль
 */
export function validateCredentials(username, password) {
  return username === AUTH_USERNAME && password === AUTH_PASSWORD;
}

/**
 * Создать токен для пользователя
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
 * Проверить токен
 */
export function verifyToken(token) {
  const tokenData = tokens.get(token);

  if (!tokenData) {
    return { valid: false };
  }

  // Проверяем срок действия
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
 * Удалить токен (выход)
 */
export function revokeToken(token) {
  tokens.delete(token);
}

/**
 * Middleware для защиты маршрутов
 */
export function authMiddleware(req, res, next) {
  // Пропускаем страницу логина и API авторизации
  if (req.path === '/login.html' || req.path.startsWith('/api/auth/')) {
    return next();
  }

  // Получаем токен из заголовка или cookie
  const authHeader = req.headers.authorization;
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  }

  if (!token) {
    // Для HTML страниц перенаправляем на логин
    if (req.accepts('html')) {
      return res.redirect('/login.html');
    }
    // Для API возвращаем 401
    return res.status(401).json({ error: 'Требуется авторизация' });
  }

  const verification = verifyToken(token);

  if (!verification.valid) {
    if (req.accepts('html')) {
      return res.redirect('/login.html');
    }
    return res.status(401).json({ error: 'Недействительный токен' });
  }

  // Добавляем информацию о пользователе в запрос
  req.user = { username: verification.username };
  next();
}

/**
 * Endpoint для логина
 */
export function loginHandler(req, res) {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      error: 'Необходимо указать логин и пароль'
    });
  }

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
 * Endpoint для проверки токена
 */
export function verifyHandler(req, res) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.json({ valid: false });
  }

  const token = authHeader.substring(7);
  const verification = verifyToken(token);

  res.json(verification);
}

/**
 * Endpoint для выхода
 */
export function logoutHandler(req, res) {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    revokeToken(token);
  }

  res.json({ success: true });
}
