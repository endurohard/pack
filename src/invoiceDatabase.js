import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, '../data/invoices.json');

/**
 * Простая база данных для хранения информации о счетах
 */
class InvoiceDatabase {
  constructor() {
    this.ensureDataDir();
    this.loadData();
  }

  ensureDataDir() {
    const dataDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  loadData() {
    if (fs.existsSync(DB_PATH)) {
      const data = fs.readFileSync(DB_PATH, 'utf-8');
      this.invoices = JSON.parse(data);
    } else {
      this.invoices = [];
      this.saveData();
    }
  }

  saveData() {
    fs.writeFileSync(DB_PATH, JSON.stringify(this.invoices, null, 2), 'utf-8');
  }

  /**
   * Добавить новый счет
   */
  addInvoice(invoiceData) {
    const invoice = {
      id: Date.now().toString(),
      invoiceNumber: invoiceData.invoiceNumber,
      filename: invoiceData.filename,
      amount: invoiceData.amount,
      items: invoiceData.items || [],
      discount: invoiceData.discount || null,
      client: invoiceData.client || null,
      clientPhone: invoiceData.clientPhone || '',
      isRecurring: invoiceData.isRecurring || false,
      payment: invoiceData.payment || null,
      createdAt: invoiceData.createdAt || new Date().toISOString(),
      paid: false,
      paidAt: null,
      yandexPath: invoiceData.yandexPath || null,
      publicUrl: invoiceData.publicUrl || null,
      // Поля для автоматической рассылки
      nextSendDate: invoiceData.nextSendDate || null, // Дата следующей автоматической отправки
      autoSendEnabled: invoiceData.autoSendEnabled || false, // Включена ли автоматическая рассылка
      lastSentAt: null, // Дата последней автоматической отправки
      // Расходы по счету
      expenses: invoiceData.expenses || [] // Массив расходов: [{id, date, amount, description, category}]
    };

    this.invoices.push(invoice);
    this.saveData();
    return invoice;
  }

  /**
   * Получить все счета
   */
  getAllInvoices() {
    return this.invoices.sort((a, b) =>
      new Date(b.createdAt) - new Date(a.createdAt)
    );
  }

  /**
   * Получить счет по ID
   */
  getInvoiceById(id) {
    return this.invoices.find(inv => inv.id === id);
  }

  /**
   * Получить счет по номеру
   */
  getInvoiceByNumber(invoiceNumber) {
    return this.invoices.find(inv => inv.invoiceNumber === parseInt(invoiceNumber));
  }

  /**
   * Отметить счет как оплаченный
   */
  markAsPaid(id) {
    const invoice = this.getInvoiceById(id);
    if (invoice) {
      invoice.paid = true;
      invoice.paidAt = new Date().toISOString();
      this.saveData();
      return invoice;
    }
    return null;
  }

  /**
   * Отметить счет как неоплаченный
   */
  markAsUnpaid(id) {
    const invoice = this.getInvoiceById(id);
    if (invoice) {
      invoice.paid = false;
      invoice.paidAt = null;
      this.saveData();
      return invoice;
    }
    return null;
  }

  /**
   * Обновить статус оплаты
   */
  updatePaymentStatus(id, paid) {
    return paid ? this.markAsPaid(id) : this.markAsUnpaid(id);
  }

  /**
   * Обновить счет
   */
  updateInvoice(id, updates) {
    const invoice = this.getInvoiceById(id);
    if (invoice) {
      Object.assign(invoice, updates);
      invoice.updatedAt = new Date().toISOString();
      this.saveData();
      return invoice;
    }
    return null;
  }

  /**
   * Удалить счет
   */
  deleteInvoice(id) {
    const index = this.invoices.findIndex(inv => inv.id === id);
    if (index !== -1) {
      const deleted = this.invoices.splice(index, 1)[0];
      this.saveData();
      return deleted;
    }
    return null;
  }

  /**
   * Получить статистику
   */
  getStatistics() {
    const total = this.invoices.length;
    const paid = this.invoices.filter(inv => inv.paid).length;
    const unpaid = total - paid;

    const totalAmount = this.invoices.reduce((sum, inv) => sum + (inv.amount || 0), 0);
    const paidAmount = this.invoices.filter(inv => inv.paid).reduce((sum, inv) => sum + (inv.amount || 0), 0);
    const unpaidAmount = totalAmount - paidAmount;

    return {
      total,
      paid,
      unpaid,
      totalAmount,
      paidAmount,
      unpaidAmount
    };
  }

  /**
   * Получить счета для автоматической отправки
   * Возвращает счета у которых:
   * - autoSendEnabled = true
   * - nextSendDate <= текущая дата
   */
  getInvoicesForAutoSend() {
    const now = new Date();
    return this.invoices.filter(inv => {
      if (!inv.autoSendEnabled || !inv.nextSendDate) return false;
      const sendDate = new Date(inv.nextSendDate);
      return sendDate <= now;
    });
  }

  /**
   * Обновить дату следующей отправки счета (сдвинуть на месяц вперед)
   */
  updateNextSendDate(id) {
    const invoice = this.getInvoiceById(id);
    if (invoice && invoice.nextSendDate) {
      const currentDate = new Date(invoice.nextSendDate);
      // Сдвигаем дату на месяц вперед
      currentDate.setMonth(currentDate.getMonth() + 1);
      invoice.nextSendDate = currentDate.toISOString();
      invoice.lastSentAt = new Date().toISOString();
      this.saveData();
      return invoice;
    }
    return null;
  }

  /**
   * Включить/выключить автоматическую рассылку для счета
   */
  setAutoSend(id, enabled, nextSendDate = null) {
    const invoice = this.getInvoiceById(id);
    if (invoice) {
      invoice.autoSendEnabled = enabled;
      if (nextSendDate) {
        invoice.nextSendDate = nextSendDate;
      }
      this.saveData();
      return invoice;
    }
    return null;
  }

  /**
   * Добавить расход к счету
   */
  addExpense(invoiceId, expenseData) {
    const invoice = this.getInvoiceById(invoiceId);
    if (invoice) {
      if (!invoice.expenses) {
        invoice.expenses = [];
      }

      const expense = {
        id: Date.now().toString(),
        date: expenseData.date || new Date().toISOString(),
        amount: expenseData.amount,
        description: expenseData.description || '',
        category: expenseData.category || 'Прочее',
        createdAt: new Date().toISOString()
      };

      invoice.expenses.push(expense);
      this.saveData();
      return expense;
    }
    return null;
  }

  /**
   * Удалить расход из счета
   */
  deleteExpense(invoiceId, expenseId) {
    const invoice = this.getInvoiceById(invoiceId);
    if (invoice && invoice.expenses) {
      const index = invoice.expenses.findIndex(exp => exp.id === expenseId);
      if (index !== -1) {
        const deleted = invoice.expenses.splice(index, 1)[0];
        this.saveData();
        return deleted;
      }
    }
    return null;
  }

  /**
   * Получить все расходы по счету
   */
  getExpenses(invoiceId) {
    const invoice = this.getInvoiceById(invoiceId);
    if (invoice) {
      return invoice.expenses || [];
    }
    return [];
  }

  /**
   * Получить общую сумму расходов по счету
   */
  getTotalExpenses(invoiceId) {
    const expenses = this.getExpenses(invoiceId);
    return expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);
  }
}

export default InvoiceDatabase;
