import InvoiceGenerator from './invoiceGenerator.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Пример данных счета
const invoiceData = {
  invoiceNumber: 672,
  items: [
    {
      name: 'Аренда АТС\\Обслуживание',
      unit: 'мес',
      quantity: 1,
      price: 5700.00,
      amount: 5700.00
    }
  ],
  payment: {
    cardNumber: '5280-4137-5406-3845',
    sbpPhone: '9633707007',
    sbpBank: 'ТИНЬКОФФ'
  }
};

// Создаем экземпляр генератора
const generator = new InvoiceGenerator();

// Генерируем счет
const outputPath = path.join(__dirname, '../output/invoice_672.pdf');

console.log('Генерация счета...');
generator.generateInvoice(invoiceData, outputPath)
  .then((filePath) => {
    console.log(`Счет успешно создан: ${filePath}`);
  })
  .catch((error) => {
    console.error('Ошибка при создании счета:', error);
  });
