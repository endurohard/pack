import InvoiceGenerator from './invoiceGenerator.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Создаем экземпляр генератора
const generator = new InvoiceGenerator();

// Пример 1: Счет с процентной скидкой
const invoiceData1 = {
  invoiceNumber: 673,
  items: [
    generator.createItem('Аренда АТС\\Обслуживание', 'мес', 1, 5700.00),
    generator.createItem('IP-телефония', 'мес', 1, 2500.00),
    generator.createItem('Настройка оборудования', 'шт', 1, 3000.00)
  ],
  discount: generator.createPercentDiscount(10, 'Скидка постоянного клиента'),
  payment: {
    cardNumber: '5280-4137-5406-3845',
    sbpPhone: '9633707007',
    sbpBank: 'ТИНЬКОФФ'
  }
};

// Пример 2: Счет с фиксированной скидкой
const invoiceData2 = {
  invoiceNumber: 674,
  items: [
    generator.createItem('Разработка сайта', 'шт', 1, 50000.00),
    generator.createItem('Техническая поддержка', 'мес', 3, 5000.00)
  ],
  discount: generator.createFixedDiscount(5000, 'Специальное предложение'),
  payment: {
    cardNumber: '5280-4137-5406-3845',
    sbpPhone: '9633707007',
    sbpBank: 'ТИНЬКОФФ'
  }
};

// Пример 3: Счет без скидки (много позиций)
const invoiceData3 = {
  invoiceNumber: 675,
  items: [
    generator.createItem('Хостинг веб-сайта', 'мес', 12, 500.00),
    generator.createItem('SSL сертификат', 'год', 1, 2000.00),
    generator.createItem('Доменное имя .ru', 'год', 1, 700.00),
    generator.createItem('Резервное копирование', 'мес', 12, 300.00)
  ],
  payment: {
    cardNumber: '5280-4137-5406-3845',
    sbpPhone: '9633707007',
    sbpBank: 'ТИНЬКОФФ'
  }
};

// Генерируем все три счета
const examples = [
  { data: invoiceData1, filename: 'invoice_673_with_percent_discount.pdf' },
  { data: invoiceData2, filename: 'invoice_674_with_fixed_discount.pdf' },
  { data: invoiceData3, filename: 'invoice_675_multiple_items.pdf' }
];

console.log('Генерация примеров счетов...\n');

for (const example of examples) {
  const outputPath = path.join(__dirname, '../output', example.filename);

  try {
    await generator.generateInvoice(example.data, outputPath);
    console.log(`✓ Создан: ${example.filename}`);
  } catch (error) {
    console.error(`✗ Ошибка при создании ${example.filename}:`, error.message);
  }
}

console.log('\nВсе счета созданы в папке output/');
