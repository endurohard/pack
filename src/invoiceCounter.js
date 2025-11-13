import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class InvoiceCounter {
  constructor() {
    this.counterFile = path.join(__dirname, '../data/invoice-counter.json');
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
    counter.current += 1;
    this.saveCounter(counter);

    // Форматируем номер (например, 001, 002, ..., 999, 1000)
    return counter.current.toString().padStart(3, '0');
  }

  /**
   * Получить текущий номер (без инкремента)
   */
  getCurrentNumber() {
    const counter = this.loadCounter();
    return counter.current;
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
}

// Экспортируем единственный экземпляр
const invoiceCounter = new InvoiceCounter();
export default invoiceCounter;
