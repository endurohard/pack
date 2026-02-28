import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, '../data/invoices.json');

/**
 * Простая база данных для хранения информации о счетах
 * Использует async операции для предотвращения блокировки event loop
 */
class InvoiceDatabase {
  constructor() {
    this.invoices = [];
    this.saveQueue = Promise.resolve(); // Очередь для последовательных записей
    this.initialized = false;
    this.initPromise = this.initialize();
  }

  async initialize() {
    await this.ensureDataDir();
    await this.loadData();
    this.initialized = true;
  }

  async ensureDataDir() {
    const dataDir = path.dirname(DB_PATH);
    try {
      await fsPromises.access(dataDir);
    } catch {
      await fsPromises.mkdir(dataDir, { recursive: true });
    }
  }

  async loadData() {
    try {
      await fsPromises.access(DB_PATH);
      const data = await fsPromises.readFile(DB_PATH, 'utf-8');
      this.invoices = JSON.parse(data);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Файл не существует - создаем пустой массив
        this.invoices = [];
        await this.saveData();
      } else {
        throw error;
      }
    }
  }

  async saveData() {
    // Используем очередь для избежания race conditions при параллельных записях
    this.saveQueue = this.saveQueue.then(async () => {
      try {
        await fsPromises.writeFile(
          DB_PATH,
          JSON.stringify(this.invoices, null, 2),
          'utf-8'
        );
      } catch (error) {
        console.error('❌ Ошибка сохранения invoices.json:', error.message);
        throw error;
      }
    });
    return this.saveQueue;
  }

  // Синхронная версия для обратной совместимости (использует кэш)
  saveDataSync() {
    try {
      fs.writeFileSync(DB_PATH, JSON.stringify(this.invoices, null, 2), 'utf-8');
    } catch (error) {
      console.error('❌ Ошибка синхронного сохранения:', error.message);
    }
  }

  /**
   * Добавить новый счет
   * Синхронный метод - обновляет кэш в памяти и асинхронно сохраняет на диск
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
      invoiceDate: invoiceData.invoiceDate || new Date().toISOString(), // Дата, на которую выставлен счёт
      paid: false,
      paidAt: null,
      yandexPath: invoiceData.yandexPath || null,
      publicUrl: invoiceData.publicUrl || null,
      // Поля для автоматической рассылки
      nextSendDate: invoiceData.nextSendDate || null, // Дата следующей автоматической отправки
      autoSendEnabled: invoiceData.autoSendEnabled || false, // Включена ли автоматическая рассылка
      lastSentAt: null, // Дата последней автоматической отправки
      // Поля для отслеживания отправки через WhatsApp
      lastWhatsAppSent: invoiceData.lastWhatsAppSent || null, // Дата последней отправки через WhatsApp (ручной или автоматической)
      whatsAppSentCount: invoiceData.whatsAppSentCount || 0, // Количество отправок через WhatsApp
      // Поля для напоминаний об оплате
      reminderEnabled: invoiceData.reminderEnabled || false, // Включены ли напоминания
      lastReminderSentAt: invoiceData.lastReminderSentAt || null, // Дата последнего напоминания
      // Расходы по счету
      expenses: invoiceData.expenses || [] // Массив расходов: [{id, date, amount, description, category}]
    };

    this.invoices.push(invoice);
    // Асинхронное сохранение (не блокирует)
    this.saveData().catch(err => console.error('Ошибка сохранения счета:', err));
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
    // Поддерживаем поиск по строке и числу
    return this.invoices.find(inv =>
      inv.invoiceNumber === invoiceNumber ||
      inv.invoiceNumber === String(invoiceNumber) ||
      inv.invoiceNumber === parseInt(invoiceNumber)
    );
  }

  /**
   * Отметить счет как оплаченный
   */
  markAsPaid(id) {
    const invoice = this.getInvoiceById(id);
    if (invoice) {
      const oldStatus = invoice.paid;
      invoice.paid = true;
      invoice.paidAt = new Date().toISOString();
      this.saveData().catch(err => console.error('Ошибка сохранения:', err));

      // Логирование изменения статуса
      console.log(`[InvoiceDB] ✅ Счет №${invoice.invoiceNumber} помечен как ОПЛАЧЕННЫЙ`);
      console.log(`[InvoiceDB] Клиент: ${invoice.client}`);
      console.log(`[InvoiceDB] Сумма: ${invoice.amount} ₽`);
      console.log(`[InvoiceDB] Предыдущий статус: ${oldStatus ? 'оплачен' : 'не оплачен'}`);
      console.log(`[InvoiceDB] Дата оплаты: ${invoice.paidAt}`);

      return invoice;
    }
    console.error(`[InvoiceDB] ❌ Ошибка: счет с ID ${id} не найден при попытке отметить как оплаченный`);
    return null;
  }

  /**
   * Отметить счет как неоплаченный
   */
  markAsUnpaid(id) {
    const invoice = this.getInvoiceById(id);
    if (invoice) {
      const oldStatus = invoice.paid;
      const oldPaidAt = invoice.paidAt;
      invoice.paid = false;
      invoice.paidAt = null;
      this.saveData().catch(err => console.error('Ошибка сохранения:', err));

      // Логирование изменения статуса
      console.log(`[InvoiceDB] ⚠️  Счет №${invoice.invoiceNumber} помечен как НЕОПЛАЧЕННЫЙ`);
      console.log(`[InvoiceDB] Клиент: ${invoice.client}`);
      console.log(`[InvoiceDB] Сумма: ${invoice.amount} ₽`);
      console.log(`[InvoiceDB] Предыдущий статус: ${oldStatus ? 'оплачен' : 'не оплачен'}`);
      if (oldPaidAt) {
        console.log(`[InvoiceDB] Предыдущая дата оплаты: ${oldPaidAt}`);
      }

      return invoice;
    }
    console.error(`[InvoiceDB] ❌ Ошибка: счет с ID ${id} не найден при попытке отметить как неоплаченный`);
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
      this.saveData().catch(err => console.error('Ошибка сохранения:', err));
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
      this.saveData().catch(err => console.error('Ошибка сохранения:', err));
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
   * - счет не оплачен полностью
   */
  getInvoicesForAutoSend() {
    const now = new Date();
    return this.invoices.filter(inv => {
      if (!inv.autoSendEnabled || !inv.nextSendDate) return false;

      // Проверяем, не оплачен ли счет полностью
      if (inv.paid) return false;
      const paidAmount = inv.paidAmount || 0;
      if (paidAmount >= inv.amount) return false;

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
      this.saveData().catch(err => console.error('Ошибка сохранения:', err));
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
      this.saveData().catch(err => console.error('Ошибка сохранения:', err));
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
      this.saveData().catch(err => console.error('Ошибка сохранения:', err));
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
        this.saveData().catch(err => console.error('Ошибка сохранения:', err));
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
