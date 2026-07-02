import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_PATH = path.join(__dirname, '../data/recurringPayments.json');

class RecurringPaymentsDatabase {
  constructor() {
    this.ensureDataDir();
    this.loadData();
  }

  ensureDataDir() {
    const dataDir = path.dirname(DATA_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  loadData() {
    if (fs.existsSync(DATA_PATH)) {
      const data = fs.readFileSync(DATA_PATH, 'utf-8');
      this.data = JSON.parse(data);
    } else {
      this.data = {
        payments: [],
        history: [],
        settings: {
          checkHour: 9,
          checkMinute: 0,
          remindDaysBefore: 3
        }
      };
      this.saveData();
    }
  }

  saveData() {
    fs.writeFileSync(DATA_PATH, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  getCurrentMonth() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }

  getAllPayments() {
    return this.data.payments;
  }

  getActivePayments() {
    return this.data.payments.filter(p => p.active);
  }

  getPaymentById(id) {
    return this.data.payments.find(p => p.id === id);
  }

  addPayment(paymentData) {
    if (!paymentData.name) {
      throw new Error('Название обязательно');
    }
    if (!paymentData.amount || paymentData.amount <= 0) {
      throw new Error('Сумма должна быть больше 0');
    }
    if (!paymentData.dayOfMonth || paymentData.dayOfMonth < 1 || paymentData.dayOfMonth > 31) {
      throw new Error('День месяца должен быть от 1 до 31');
    }

    const payment = {
      id: Date.now().toString(),
      name: paymentData.name.trim(),
      description: paymentData.description || '',
      amount: Number(paymentData.amount),
      dayOfMonth: Number(paymentData.dayOfMonth),
      active: paymentData.active !== false,
      createdAt: new Date().toISOString()
    };

    this.data.payments.push(payment);
    this.saveData();
    return payment;
  }

  updatePayment(id, updates) {
    const payment = this.getPaymentById(id);
    if (!payment) {
      throw new Error('Платеж не найден');
    }

    if (updates.amount !== undefined) updates.amount = Number(updates.amount);
    if (updates.dayOfMonth !== undefined) updates.dayOfMonth = Number(updates.dayOfMonth);
    if (updates.name !== undefined) updates.name = updates.name.trim();

    Object.assign(payment, updates);
    payment.updatedAt = new Date().toISOString();
    this.saveData();
    return payment;
  }

  deletePayment(id) {
    const index = this.data.payments.findIndex(p => p.id === id);
    if (index === -1) {
      throw new Error('Платеж не найден');
    }

    const deleted = this.data.payments.splice(index, 1)[0];
    // Удаляем историю этого платежа
    this.data.history = this.data.history.filter(h => h.paymentId !== id);
    this.saveData();
    return deleted;
  }

  getMonthStatus(month) {
    const targetMonth = month || this.getCurrentMonth();
    const monthHistory = this.data.history.filter(h => h.month === targetMonth);

    return this.data.payments.map(payment => {
      const historyEntry = monthHistory.find(h => h.paymentId === payment.id);
      return {
        ...payment,
        paid: !!historyEntry,
        paidAt: historyEntry ? historyEntry.paidAt : null,
        paidVia: historyEntry ? historyEntry.paidVia : null,
        month: targetMonth
      };
    });
  }

  isPaymentPaidThisMonth(paymentId) {
    const month = this.getCurrentMonth();
    return this.data.history.some(h => h.paymentId === paymentId && h.month === month);
  }

  markAsPaid(paymentId, via) {
    const payment = this.getPaymentById(paymentId);
    if (!payment) {
      throw new Error('Платеж не найден');
    }

    const month = this.getCurrentMonth();

    // Проверяем, не оплачен ли уже
    const existing = this.data.history.find(h => h.paymentId === paymentId && h.month === month);
    if (existing) {
      return existing;
    }

    const entry = {
      paymentId,
      month,
      paidAt: new Date().toISOString(),
      paidVia: via || 'web'
    };

    this.data.history.push(entry);
    this.saveData();
    return entry;
  }

  markAsUnpaid(paymentId) {
    const month = this.getCurrentMonth();
    const index = this.data.history.findIndex(h => h.paymentId === paymentId && h.month === month);
    if (index === -1) {
      return null;
    }

    const removed = this.data.history.splice(index, 1)[0];
    this.saveData();
    return removed;
  }

  getUpcomingPayments(daysBefore) {
    const now = new Date();
    const currentDay = now.getDate();
    const month = this.getCurrentMonth();
    const paidIds = new Set(
      this.data.history.filter(h => h.month === month).map(h => h.paymentId)
    );

    return this.data.payments.filter(p => {
      if (!p.active) return false;
      if (paidIds.has(p.id)) return false;

      const diff = p.dayOfMonth - currentDay;
      // Напоминаем: за daysBefore дней до дедлайна, в день дедлайна, и после (просрочка)
      return diff <= daysBefore;
    });
  }

  getSettings() {
    return this.data.settings;
  }

  updateSettings(updates) {
    Object.assign(this.data.settings, updates);
    this.saveData();
    return this.data.settings;
  }
}

export default RecurringPaymentsDatabase;
