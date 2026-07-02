/**
 * Модуль валидации входных данных
 *
 * Защита от:
 * - SQL инъекций (хотя используем JSON, но на будущее)
 * - XSS атак через HTML в полях
 * - Некорректных данных (отрицательные суммы, пустые обязательные поля)
 * - Невалидных email и телефонов
 */

// Встроенная базовая валидация (fallback если Joi не установлен)
export class ValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

/**
 * Экранирование HTML для предотвращения XSS
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return str;

  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Очистка строки от потенциально опасных символов
 */
function sanitizeString(str, allowHtml = false) {
  if (typeof str !== 'string') return str;

  // Удаляем null bytes
  str = str.replace(/\0/g, '');

  // Если HTML не разрешен, экранируем
  if (!allowHtml) {
    str = escapeHtml(str);
  }

  return str.trim();
}

/**
 * Валидация телефона (российский формат)
 */
function validatePhone(phone) {
  if (!phone) return { valid: false, error: 'Телефон обязателен' };

  const cleaned = phone.replace(/[^0-9]/g, '');

  // Допускаем форматы: 7XXXXXXXXXX, 8XXXXXXXXXX, XXXXXXXXXX (10 цифр)
  if (cleaned.length === 11) {
    if (cleaned.startsWith('8')) {
      // Меняем 8 на 7
      return { valid: true, value: '7' + cleaned.substring(1) };
    }
    if (cleaned.startsWith('7')) {
      return { valid: true, value: cleaned };
    }
  }

  if (cleaned.length === 10) {
    return { valid: true, value: '7' + cleaned };
  }

  return { valid: false, error: 'Неверный формат телефона (ожидается 10-11 цифр)' };
}

/**
 * Валидация email
 */
function validateEmail(email) {
  if (!email) return { valid: true, value: null }; // Email опциональный

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!emailRegex.test(email)) {
    return { valid: false, error: 'Неверный формат email' };
  }

  return { valid: true, value: email.toLowerCase().trim() };
}

/**
 * Валидация числа (с диапазоном)
 */
function validateNumber(value, { min = -Infinity, max = Infinity, required = true } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) {
      return { valid: false, error: 'Значение обязательно' };
    }
    return { valid: true, value: null };
  }

  const num = Number(value);

  if (isNaN(num)) {
    return { valid: false, error: 'Должно быть числом' };
  }

  if (num < min) {
    return { valid: false, error: `Минимальное значение: ${min}` };
  }

  if (num > max) {
    return { valid: false, error: `Максимальное значение: ${max}` };
  }

  return { valid: true, value: num };
}

/**
 * Валидация строки
 */
function validateString(value, { minLength = 0, maxLength = Infinity, required = true, allowHtml = false } = {}) {
  if (!value || value.trim() === '') {
    if (required) {
      return { valid: false, error: 'Поле обязательно для заполнения' };
    }
    return { valid: true, value: '' };
  }

  const cleaned = sanitizeString(value, allowHtml);

  if (cleaned.length < minLength) {
    return { valid: false, error: `Минимальная длина: ${minLength} символов` };
  }

  if (cleaned.length > maxLength) {
    return { valid: false, error: `Максимальная длина: ${maxLength} символов` };
  }

  return { valid: true, value: cleaned };
}

/**
 * Валидация даты
 */
function validateDate(value, { required = true } = {}) {
  if (!value) {
    if (required) {
      return { valid: false, error: 'Дата обязательна' };
    }
    return { valid: true, value: null };
  }

  const date = new Date(value);

  if (isNaN(date.getTime())) {
    return { valid: false, error: 'Неверный формат даты' };
  }

  return { valid: true, value: value };
}

/**
 * Валидация счета (Invoice)
 */
export function validateInvoice(invoice) {
  const errors = [];

  // Проверка обязательных полей
  const clientName = validateString(invoice.clientName, { required: true, maxLength: 200 });
  if (!clientName.valid) errors.push({ field: 'clientName', message: clientName.error });

  const amount = validateNumber(invoice.amount, { min: 0, max: 999999999, required: true });
  if (!amount.valid) errors.push({ field: 'amount', message: amount.error });

  const date = validateDate(invoice.date, { required: true });
  if (!date.valid) errors.push({ field: 'date', message: date.error });

  // Опциональные поля
  if (invoice.phone) {
    const phone = validatePhone(invoice.phone);
    if (!phone.valid) errors.push({ field: 'phone', message: phone.error });
  }

  if (invoice.description) {
    const desc = validateString(invoice.description, { required: false, maxLength: 5000 });
    if (!desc.valid) errors.push({ field: 'description', message: desc.error });
  }

  // Валидация товаров
  if (invoice.items && Array.isArray(invoice.items)) {
    invoice.items.forEach((item, index) => {
      const itemName = validateString(item.name, { required: true, maxLength: 200 });
      if (!itemName.valid) errors.push({ field: `items[${index}].name`, message: itemName.error });

      const quantity = validateNumber(item.quantity, { min: 0.001, max: 999999, required: true });
      if (!quantity.valid) errors.push({ field: `items[${index}].quantity`, message: quantity.error });

      const price = validateNumber(item.price, { min: 0, max: 999999999, required: true });
      if (!price.valid) errors.push({ field: `items[${index}].price`, message: price.error });
    });
  }

  if (errors.length > 0) {
    throw new ValidationError('Ошибка валидации счета', errors);
  }

  // Возвращаем очищенные данные
  return {
    ...invoice,
    clientName: clientName.value,
    amount: amount.value,
    date: date.value
  };
}

/**
 * Валидация клиента
 */
export function validateClient(client) {
  const errors = [];

  const name = validateString(client.name, { required: true, maxLength: 200 });
  if (!name.valid) errors.push({ field: 'name', message: name.error });

  const phone = validatePhone(client.phone);
  if (!phone.valid) errors.push({ field: 'phone', message: phone.error });

  if (client.email) {
    const email = validateEmail(client.email);
    if (!email.valid) errors.push({ field: 'email', message: email.error });
  }

  if (client.address) {
    const address = validateString(client.address, { required: false, maxLength: 500 });
    if (!address.valid) errors.push({ field: 'address', message: address.error });
  }

  if (errors.length > 0) {
    throw new ValidationError('Ошибка валидации клиента', errors);
  }

  return {
    ...client,
    name: name.value,
    phone: phone.value
  };
}

/**
 * Валидация товара
 */
export function validateProduct(product) {
  const errors = [];

  const name = validateString(product.name, { required: true, maxLength: 200 });
  if (!name.valid) errors.push({ field: 'name', message: name.error });

  const price = validateNumber(product.price, { min: 0, max: 999999999, required: true });
  if (!price.valid) errors.push({ field: 'price', message: price.error });

  const quantity = validateNumber(product.quantity, { min: 0, max: 999999, required: true });
  if (!quantity.valid) errors.push({ field: 'quantity', message: quantity.error });

  if (product.description) {
    const desc = validateString(product.description, { required: false, maxLength: 2000 });
    if (!desc.valid) errors.push({ field: 'description', message: desc.error });
  }

  if (errors.length > 0) {
    throw new ValidationError('Ошибка валидации товара', errors);
  }

  return {
    ...product,
    name: name.value,
    price: price.value,
    quantity: quantity.value
  };
}

/**
 * Валидация учетных данных
 */
export function validateCredentials(username, password) {
  const errors = [];

  const usernameResult = validateString(username, {
    required: true,
    minLength: 3,
    maxLength: 50
  });
  if (!usernameResult.valid) errors.push({ field: 'username', message: usernameResult.error });

  const passwordResult = validateString(password, {
    required: true,
    minLength: 6,
    maxLength: 100
  });
  if (!passwordResult.valid) errors.push({ field: 'password', message: passwordResult.error });

  if (errors.length > 0) {
    throw new ValidationError('Ошибка валидации учетных данных', errors);
  }

  return {
    username: usernameResult.value,
    password: password // Пароль не санитизируем - может содержать спецсимволы
  };
}

/**
 * Middleware для Express - валидация тела запроса
 */
export function validate(validatorFn) {
  return (req, res, next) => {
    try {
      req.body = validatorFn(req.body);
      next();
    } catch (error) {
      if (error instanceof ValidationError) {
        return res.status(400).json({
          success: false,
          error: error.message,
          details: error.details
        });
      }
      next(error);
    }
  };
}

export default {
  validateInvoice,
  validateClient,
  validateProduct,
  validateCredentials,
  validate,
  ValidationError
};
