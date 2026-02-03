import ClientsDatabase from './clientsDatabase.js';

/**
 * Сервис валидации и контроля номеров телефонов
 * Обеспечивает соответствие между клиентами и счетами
 */
class PhoneValidator {
  constructor() {
    this.clientsDb = new ClientsDatabase();
  }

  /**
   * Нормализовать имя клиента (убрать лишние кавычки)
   */
  normalizeClientName(name) {
    if (!name) return name;

    // Убираем кавычки в начале и в конце, если они двойные
    let normalized = name.trim();
    if (normalized.startsWith('"') && normalized.endsWith('"')) {
      normalized = normalized.slice(1, -1);
    }

    return normalized;
  }

  /**
   * Нормализовать номер телефона для сравнения
   */
  normalizePhone(phone) {
    if (!phone) return '';

    // Убираем все нецифровые символы
    let normalized = phone.replace(/[^0-9]/g, '');

    // Преобразуем 8 в начале на 7
    if (normalized.startsWith('8')) {
      normalized = '7' + normalized.substring(1);
    }

    // Добавляем 7 в начало если нет
    if (!normalized.startsWith('7') && normalized.length === 10) {
      normalized = '7' + normalized;
    }

    return normalized;
  }

  /**
   * Форматировать номер телефона в стандартный вид +7XXXXXXXXXX
   */
  formatPhone(phone) {
    const normalized = this.normalizePhone(phone);
    if (normalized.length === 11 && normalized.startsWith('7')) {
      return '+' + normalized;
    }
    return phone; // Возвращаем как есть, если не удалось нормализовать
  }

  /**
   * Найти клиента по имени с учетом кавычек
   */
  findClientByName(clientName) {
    const clients = this.clientsDb.getAllClients();

    // Нормализуем имя для поиска
    const normalizedSearchName = this.normalizeClientName(clientName);

    // Ищем точное совпадение с нормализованным именем
    const exactMatch = clients.find(c => {
      const clientNormalized = this.normalizeClientName(c.name);
      return clientNormalized === normalizedSearchName;
    });

    if (exactMatch) {
      return exactMatch;
    }

    // Ищем точное совпадение с оригинальным именем
    return clients.find(c => c.name === clientName);
  }

  /**
   * Получить правильный номер телефона клиента
   */
  getClientPhone(clientName) {
    const client = this.findClientByName(clientName);

    if (client && client.phone) {
      return this.formatPhone(client.phone);
    }

    return null;
  }

  /**
   * Проверить соответствие номера телефона клиенту
   * @returns {Object} { valid: boolean, expectedPhone: string, actualPhone: string, message: string }
   */
  validateInvoicePhone(clientName, invoicePhone) {
    const result = {
      valid: false,
      clientFound: false,
      expectedPhone: null,
      actualPhone: invoicePhone,
      message: ''
    };

    // Проверяем наличие номера в счете
    if (!invoicePhone) {
      result.message = 'В счете отсутствует номер телефона';
      return result;
    }

    // Ищем клиента
    const client = this.findClientByName(clientName);

    if (!client) {
      result.message = `Клиент "${clientName}" не найден в базе клиентов`;
      return result;
    }

    result.clientFound = true;

    // Проверяем наличие номера у клиента
    if (!client.phone) {
      result.message = `У клиента "${clientName}" не указан номер телефона в базе`;
      return result;
    }

    result.expectedPhone = this.formatPhone(client.phone);

    // Нормализуем номера для сравнения
    const normalizedExpected = this.normalizePhone(client.phone);
    const normalizedActual = this.normalizePhone(invoicePhone);

    // Сравниваем нормализованные номера
    if (normalizedExpected === normalizedActual) {
      result.valid = true;
      result.message = 'Номер телефона соответствует клиенту';
    } else {
      result.valid = false;
      result.message = `Номер в счете (${invoicePhone}) не соответствует номеру клиента (${result.expectedPhone})`;
    }

    return result;
  }

  /**
   * Исправить номер телефона в счете на правильный из базы клиентов
   */
  fixInvoicePhone(clientName, currentPhone) {
    const correctPhone = this.getClientPhone(clientName);

    if (!correctPhone) {
      return {
        success: false,
        message: `Не удалось найти клиента "${clientName}" или у него нет номера телефона`,
        correctPhone: null
      };
    }

    // Проверяем, нужно ли исправление
    const normalizedCurrent = this.normalizePhone(currentPhone);
    const normalizedCorrect = this.normalizePhone(correctPhone);

    if (normalizedCurrent === normalizedCorrect) {
      return {
        success: true,
        message: 'Номер телефона уже правильный',
        correctPhone: correctPhone,
        changed: false
      };
    }

    return {
      success: true,
      message: `Номер исправлен: ${currentPhone} → ${correctPhone}`,
      correctPhone: correctPhone,
      changed: true,
      oldPhone: currentPhone
    };
  }

  /**
   * Валидировать все счета и вернуть отчет
   */
  validateAllInvoices(invoices) {
    const report = {
      total: invoices.length,
      valid: 0,
      invalid: 0,
      missingClient: 0,
      missingPhone: 0,
      issues: []
    };

    invoices.forEach(invoice => {
      const validation = this.validateInvoicePhone(invoice.client, invoice.clientPhone);

      if (validation.valid) {
        report.valid++;
      } else {
        report.invalid++;

        if (!validation.clientFound) {
          report.missingClient++;
        } else if (!invoice.clientPhone) {
          report.missingPhone++;
        }

        report.issues.push({
          invoiceNumber: invoice.invoiceNumber,
          invoiceId: invoice.id,
          client: invoice.client,
          currentPhone: invoice.clientPhone,
          expectedPhone: validation.expectedPhone,
          message: validation.message,
          autoSendEnabled: invoice.autoSendEnabled || false
        });
      }
    });

    return report;
  }

  /**
   * Получить отчет по счетам с автоотправкой
   */
  validateAutoSendInvoices(invoices) {
    const autoSendInvoices = invoices.filter(inv => inv.autoSendEnabled);
    const report = this.validateAllInvoices(autoSendInvoices);
    report.autoSendCount = autoSendInvoices.length;
    return report;
  }
}

export default PhoneValidator;
