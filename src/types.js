/**
 * @typedef {Object} InvoiceItem
 * @property {string} name - Наименование товара/услуги
 * @property {string} unit - Единица измерения
 * @property {number} quantity - Количество
 * @property {number} price - Цена за единицу
 * @property {number} amount - Сумма (price * quantity)
 */

/**
 * @typedef {Object} Discount
 * @property {number} value - Размер скидки (процент или сумма)
 * @property {string} type - Тип скидки: 'percent' (процент) или 'fixed' (фиксированная сумма)
 * @property {string} [description] - Описание скидки (опционально)
 */

/**
 * @typedef {Object} PaymentInfo
 * @property {string} cardNumber - Номер карты для оплаты
 * @property {string} sbpPhone - Телефон для СБП
 * @property {string} sbpBank - Название банка для СБП
 */

/**
 * @typedef {Object} InvoiceData
 * @property {number} invoiceNumber - Номер счета
 * @property {InvoiceItem[]} items - Список товаров/услуг
 * @property {Discount} [discount] - Скидка на весь счет (опционально)
 * @property {PaymentInfo} payment - Платежная информация
 */

export {};
