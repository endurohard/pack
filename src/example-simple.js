import SimpleInvoiceService from './simpleInvoiceService.js';

// Создаем сервис - он автоматически загрузит настройки из .env
const service = new SimpleInvoiceService();

// Пример 1: Простой счет без скидки
async function createSimpleInvoice() {
  console.log('\n=== Пример 1: Простой счет ===\n');

  const invoice = {
    invoiceNumber: 1001,
    items: [
      service.createItem('Аренда АТС', 'мес', 1, 5700.00)
    ],
    payment: {
      cardNumber: '5280-4137-5406-3845',
      sbpPhone: '9633707007',
      sbpBank: 'ТИНЬКОФФ'
    }
  };

  // Создаем счет - он автоматически загрузится на Яндекс.Диск (если настроен)
  await service.createInvoice(invoice);
}

// Пример 2: Счет со скидкой
async function createInvoiceWithDiscount() {
  console.log('\n=== Пример 2: Счет со скидкой 10% ===\n');

  const invoice = {
    invoiceNumber: 1002,
    items: [
      service.createItem('Консультация', 'час', 3, 2000.00),
      service.createItem('Разработка', 'час', 10, 3500.00),
      service.createItem('Тестирование', 'час', 5, 2500.00)
    ],
    discount: service.createPercentDiscount(10, 'Скидка постоянного клиента'),
    payment: {
      cardNumber: '5280-4137-5406-3845',
      sbpPhone: '9633707007',
      sbpBank: 'ТИНЬКОФФ'
    }
  };

  await service.createInvoice(invoice, 'invoice_1002_with_discount.pdf');
}

// Пример 3: Много позиций с фиксированной скидкой
async function createDetailedInvoice() {
  console.log('\n=== Пример 3: Детальный счет с фиксированной скидкой ===\n');

  const invoice = {
    invoiceNumber: 1003,
    items: [
      service.createItem('Веб-разработка', 'час', 40, 3000.00),
      service.createItem('Дизайн интерфейса', 'час', 20, 2500.00),
      service.createItem('Настройка сервера', 'шт', 1, 15000.00),
      service.createItem('SSL сертификат', 'год', 1, 3000.00),
      service.createItem('Техподдержка', 'мес', 3, 5000.00)
    ],
    discount: service.createFixedDiscount(20000, 'Специальное предложение'),
    payment: {
      cardNumber: '5280-4137-5406-3845',
      sbpPhone: '9633707007',
      sbpBank: 'ТИНЬКОФФ'
    }
  };

  await service.createInvoice(invoice);
}

// Пример 4: Проверка настройки и получение информации о диске
async function checkYandexDiskStatus() {
  console.log('\n=== Информация о Яндекс.Диске ===\n');

  if (service.isYandexDiskConfigured()) {
    try {
      const info = await service.getDiskInfo();
      const usedGB = (info.used_space / 1024 / 1024 / 1024).toFixed(2);
      const totalGB = (info.total_space / 1024 / 1024 / 1024).toFixed(2);
      const freeGB = ((info.total_space - info.used_space) / 1024 / 1024 / 1024).toFixed(2);

      console.log(`📊 Статус диска:`);
      console.log(`   Всего: ${totalGB} GB`);
      console.log(`   Использовано: ${usedGB} GB`);
      console.log(`   Свободно: ${freeGB} GB`);

      console.log('\n📋 Список счетов на диске:');
      const invoices = await service.listInvoices();
      if (invoices.length === 0) {
        console.log('   Пока нет счетов');
      } else {
        invoices.forEach((file, index) => {
          const sizeKB = (file.size / 1024).toFixed(2);
          const date = new Date(file.created).toLocaleString('ru-RU');
          console.log(`   ${index + 1}. ${file.name} (${sizeKB} KB, создан ${date})`);
        });
      }
    } catch (error) {
      console.error(`❌ Ошибка: ${error.message}`);
    }
  } else {
    console.log('❌ Яндекс.Диск не настроен');
    console.log('   Запустите: node src/setupYandexDisk.js');
  }
}

// Запускаем все примеры
async function main() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║   Простой сервис генерации счетов                     ║');
  console.log('╚════════════════════════════════════════════════════════╝');

  // Проверяем настройку
  await checkYandexDiskStatus();

  // Создаем счета
  await createSimpleInvoice();
  await createInvoiceWithDiscount();
  await createDetailedInvoice();

  console.log('\n✨ Готово! Все счета созданы.\n');
}

main().catch(console.error);
