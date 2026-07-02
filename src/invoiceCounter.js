import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class InvoiceCounter {
  constructor() {
    this.counterFile = path.join(__dirname, '../data/invoice-counter.json');
    this.db = null; // база счетов для проверки на коллизии номеров
    this.ensureCounterFile();
  }

  /**
   * Создать файл счетчика если его нет
   */
  ensureCounterFile() {
    const dataDir = path.join(__dirname, '../data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    if (!fs.existsSync(this.counterFile)) {
      this.saveCounter({ current: 0, lastReset: new Date().toISOString() });
    }
  }

  /**
   * Загрузить текущий счетчик
   */
  loadCounter() {
    try {
      const data = fs.readFileSync(this.counterFile, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error('Ошибка чтения счетчика:', error);
      return { current: 0, lastReset: new Date().toISOString() };
    }
  }

  /**
   * Сохранить счетчик
   */
  saveCounter(counterData) {
    try {
      fs.writeFileSync(
        this.counterFile,
        JSON.stringify(counterData, null, 2),
        'utf8'
      );
    } catch (error) {
      console.error('Ошибка сохранения счетчика:', error);
    }
  }

  /**
   * Получить следующий номер счета
   */
  getNextInvoiceNumber() {
    const counter = this.loadCounter();
    const maxInDb = this.getMaxInvoiceNumberInDb();
    // Берём максимум из файла-счётчика и базы, чтобы НИКОГДА не выдать уже занятый номер
    const next = Math.max(counter.current, maxInDb) + 1;
    counter.current = next;
    this.saveCounter(counter);

    // Возвращаем число, а не строку, чтобы избежать дублирования
    return next;
  }

  /**
   * Получить текущий номер (без инкремента)
   */
  getCurrentNumber() {
    const counter = this.loadCounter();
    return counter.current;
  }

  /**
   * Зарегистрировать базу счетов для проверки на коллизии номеров
   */
  setDatabase(db) {
    this.db = db;
  }

  /**
   * Максимальный номер счета в базе (0, если базы/счетов нет)
   */
  getMaxInvoiceNumberInDb() {
    try {
      if (!this.db || typeof this.db.getAllInvoices !== 'function') return 0;
      const all = this.db.getAllInvoices();
      if (!all || all.length === 0) return 0;
      return all.reduce((max, inv) => {
        const num = parseInt(inv.invoiceNumber) || 0;
        return num > max ? num : max;
      }, 0);
    } catch (error) {
      console.error('Ошибка чтения максимального номера из базы:', error);
      return 0;
    }
  }

  /**
   * Следующий свободный номер БЕЗ резервирования (для предпросмотра в форме)
   */
  peekNextNumber() {
    const counter = this.loadCounter();
    const maxInDb = this.getMaxInvoiceNumberInDb();
    return Math.max(counter.current, maxInDb) + 1;
  }

  /**
   * Сбросить счетчик
   */
  resetCounter() {
    this.saveCounter({
      current: 0,
      lastReset: new Date().toISOString()
    });
  }

  /**
   * Установить конкретное значение счетчика
   */
  setCounter(value) {
    const counter = this.loadCounter();
    counter.current = parseInt(value) || 0;
    this.saveCounter(counter);
  }

  /**
   * Синхронизировать счетчик с базой данных счетов
   * Устанавливает счетчик на максимальный номер из базы + 1
   */
  syncWithDatabase(invoiceDatabase) {
    try {
      const allInvoices = invoiceDatabase.getAllInvoices();

      if (!allInvoices || allInvoices.length === 0) {
        console.log('📊 База счетов пуста, счетчик остается без изменений');
        return;
      }

      // Находим максимальный номер счета
      const maxInvoiceNumber = allInvoices.reduce((max, invoice) => {
        const num = parseInt(invoice.invoiceNumber) || 0;
        return num > max ? num : max;
      }, 0);

      const currentCounter = this.getCurrentNumber();

      if (maxInvoiceNumber > currentCounter) {
        // Поднимаем "пол" счётчика до максимума в базе (следующий номер = +1 при выдаче)
        this.setCounter(maxInvoiceNumber);
        console.log(`🔄 Синхронизация счетчика: ${currentCounter} → ${maxInvoiceNumber} (максимальный номер в базе)`);
      } else {
        console.log(`✅ Счетчик синхронизирован (текущий: ${currentCounter}, максимальный в базе: ${maxInvoiceNumber})`);
      }
    } catch (error) {
      console.error('❌ Ошибка синхронизации счетчика:', error);
    }
  }
}

// Экспортируем единственный экземпляр
const invoiceCounter = new InvoiceCounter();
export default invoiceCounter;
