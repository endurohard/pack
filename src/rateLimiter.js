/**
 * Простой in-memory rate limiter для защиты от брутфорса
 * Альтернатива express-rate-limit если его не удалось установить
 */

const loginAttempts = new Map(); // IP -> { count, resetTime }

const WINDOW_MS = 15 * 60 * 1000; // 15 минут
const MAX_ATTEMPTS = 5; // Максимум 5 попыток

/**
 * Проверить, не превышен ли лимит попыток для данного IP
 */
export function checkRateLimit(ip) {
  const now = Date.now();
  const attempt = loginAttempts.get(ip);

  if (!attempt) {
    // Первая попытка с этого IP
    loginAttempts.set(ip, {
      count: 1,
      resetTime: now + WINDOW_MS
    });
    return { allowed: true, remaining: MAX_ATTEMPTS - 1 };
  }

  // Проверяем, не истёк ли временной окно
  if (now > attempt.resetTime) {
    // Окно истекло, сбрасываем счётчик
    loginAttempts.set(ip, {
      count: 1,
      resetTime: now + WINDOW_MS
    });
    return { allowed: true, remaining: MAX_ATTEMPTS - 1 };
  }

  // Увеличиваем счётчик
  attempt.count++;

  if (attempt.count > MAX_ATTEMPTS) {
    const retryAfter = Math.ceil((attempt.resetTime - now) / 1000);
    return {
      allowed: false,
      retryAfter,
      message: `Слишком много попыток входа. Попробуйте через ${Math.ceil(retryAfter / 60)} минут.`
    };
  }

  return {
    allowed: true,
    remaining: MAX_ATTEMPTS - attempt.count
  };
}

/**
 * Сбросить счётчик для IP (при успешной авторизации)
 */
export function resetRateLimit(ip) {
  loginAttempts.delete(ip);
}

/**
 * Очистка старых записей (запускать периодически)
 */
export function cleanupOldAttempts() {
  const now = Date.now();
  for (const [ip, attempt] of loginAttempts.entries()) {
    if (now > attempt.resetTime) {
      loginAttempts.delete(ip);
    }
  }
}

// Автоматическая очистка каждые 30 минут
setInterval(cleanupOldAttempts, 30 * 60 * 1000);

/**
 * Middleware для Express
 */
export function rateLimitMiddleware(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const result = checkRateLimit(ip);

  if (!result.allowed) {
    return res.status(429).json({
      success: false,
      error: result.message,
      retryAfter: result.retryAfter
    });
  }

  // Добавляем информацию о лимите в ответ
  res.setHeader('X-RateLimit-Remaining', result.remaining);
  next();
}
