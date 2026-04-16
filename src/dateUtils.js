/**
 * Утилиты для работы с датами счетов
 * Централизованная логика расчета дат для избежания дублирования кода
 */

/**
 * Получить дату для расчета просрочки счета
 *
 * Логика приоритетов:
 * 1. lastWhatsAppSent (дата фактической отправки через WhatsApp)
 * 2. sentToClient (отмечен как отправленный клиенту вручную)
 *
 * ВАЖНО: Просрочка начинается ТОЛЬКО после фактической отправки счета клиенту.
 * Если счет не отправлен — возвращает null (просрочки нет).
 *
 * @param {Object} invoice - Объект счета
 * @returns {Date|null} Дата отправки клиенту или null если не отправлен
 */
function getInvoiceSentDate(invoice) {
  // Просрочка считается ТОЛЬКО от даты фактической отправки клиенту.
  // Если счет не отправлен — просрочки нет (возвращаем null).

  // Приоритет 1: Дата отправки через WhatsApp (факт отправки клиенту)
  if (invoice.lastWhatsAppSent) {
    return new Date(invoice.lastWhatsAppSent);
  }

  // Приоритет 2: Отмечен как отправленный клиенту вручную
  if (invoice.sentToClient) {
    return new Date(invoice.sentToClient);
  }

  // Счет не отправлен клиенту — просрочки нет
  return null;
}

/**
 * Вычесть один месяц от даты (правильный способ без потери дней)
 *
 * Проблема с setMonth():
 * - new Date('2024-03-31').setMonth(2) => '2024-03-03' (потеряли 28 дней!)
 *
 * Правильный способ:
 * - Получить год, месяц, день
 * - Вычесть 1 из месяца
 * - Создать новую дату с корректными значениями
 *
 * @param {Date} date - Исходная дата
 * @returns {Date} Дата минус 1 месяц
 */
function subtractMonth(date) {
  const year = date.getFullYear();
  const month = date.getMonth(); // 0-11
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = date.getSeconds();
  const milliseconds = date.getMilliseconds();

  // Вычитаем месяц
  let newMonth = month - 1;
  let newYear = year;

  // Если месяц стал отрицательным, переходим на предыдущий год
  if (newMonth < 0) {
    newMonth = 11;
    newYear = year - 1;
  }

  // Проверяем, что день существует в новом месяце
  // Например, 31 марта -> 28/29 февраля
  const lastDayOfMonth = new Date(newYear, newMonth + 1, 0).getDate();
  const newDay = Math.min(day, lastDayOfMonth);

  return new Date(newYear, newMonth, newDay, hours, minutes, seconds, milliseconds);
}

/**
 * Добавить один месяц к дате (правильный способ)
 *
 * @param {Date} date - Исходная дата
 * @returns {Date} Дата плюс 1 месяц
 */
function addMonth(date) {
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = date.getSeconds();
  const milliseconds = date.getMilliseconds();

  let newMonth = month + 1;
  let newYear = year;

  if (newMonth > 11) {
    newMonth = 0;
    newYear = year + 1;
  }

  const lastDayOfMonth = new Date(newYear, newMonth + 1, 0).getDate();
  const newDay = Math.min(day, lastDayOfMonth);

  return new Date(newYear, newMonth, newDay, hours, minutes, seconds, milliseconds);
}

/**
 * Рассчитать количество дней между двумя датами
 *
 * @param {Date} date1 - Первая дата
 * @param {Date} date2 - Вторая дата
 * @returns {number} Количество дней (может быть отрицательным)
 */
function daysBetween(date1, date2) {
  const diffMs = date2 - date1;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Проверить, является ли дата сегодняшней
 *
 * @param {Date|string} date - Дата для проверки
 * @returns {boolean} true если дата сегодняшняя
 */
function isToday(date) {
  const checkDate = new Date(date);
  const today = new Date();

  return (
    checkDate.getFullYear() === today.getFullYear() &&
    checkDate.getMonth() === today.getMonth() &&
    checkDate.getDate() === today.getDate()
  );
}

/**
 * Получить правильное склонение слова "день"
 *
 * @param {number} days - Количество дней
 * @returns {string} "день", "дня" или "дней"
 */
function getDaysWord(days) {
  const lastDigit = Math.abs(days) % 10;
  const lastTwoDigits = Math.abs(days) % 100;

  if (lastTwoDigits >= 11 && lastTwoDigits <= 19) {
    return 'дней';
  }

  if (lastDigit === 1) {
    return 'день';
  }

  if (lastDigit >= 2 && lastDigit <= 4) {
    return 'дня';
  }

  return 'дней';
}

/**
 * Получить текущий час по московскому времени (UTC+3)
 * @returns {number} Час 0-23 по МСК
 */
function getMoscowHour() {
  const now = new Date();
  const moscowOffset = 3 * 60; // UTC+3 в минутах
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const moscowMinutes = utcMinutes + moscowOffset;
  return Math.floor(((moscowMinutes % 1440) + 1440) % 1440 / 60);
}

/**
 * Проверить, попадает ли текущее время в рабочие часы по МСК (10:00-20:00)
 * @returns {boolean} true если сейчас рабочее время по МСК
 */
function isMoscowWorkingHours() {
  const hour = getMoscowHour();
  return hour >= 10 && hour < 20;
}

export {
  getMoscowHour,
  isMoscowWorkingHours,
  getInvoiceSentDate,
  subtractMonth,
  addMonth,
  daysBetween,
  isToday,
  getDaysWord
};
