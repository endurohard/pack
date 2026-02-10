import InvoiceDatabase from './src/invoiceDatabase.js';
import PhoneValidator from './src/phoneValidator.js';

const db = new InvoiceDatabase();
const validator = new PhoneValidator();

// Найдем счет №114
const invoices = db.getAllInvoices();
const invoice114 = invoices.find(inv => inv.invoiceNumber === '114' || inv.invoiceNumber === 114);

if (!invoice114) {
  console.log('❌ Счет №114 не найден');
  process.exit(1);
}

console.log('\n📄 СЧЕТ №114 - ДО ИСПРАВЛЕНИЯ:');
console.log(`   Клиент: ${invoice114.client}`);
console.log(`   Текущий номер: ${invoice114.clientPhone}`);

// Проверяем и исправляем
const validation = validator.validateInvoicePhone(invoice114.client, invoice114.clientPhone);
console.log(`\n🔍 Результат валидации:`);
console.log(`   Корректный: ${validation.valid ? 'Да' : 'Нет'}`);
console.log(`   Ожидаемый номер: ${validation.expectedPhone || 'НЕТ'}`);
console.log(`   Сообщение: ${validation.message}`);

if (!validation.valid && validation.expectedPhone) {
  console.log(`\n🔧 Исправляем номер телефона...`);

  db.updateInvoice(invoice114.id, {
    clientPhone: validation.expectedPhone
  });

  console.log(`✅ Номер телефона исправлен!`);

  // Проверяем результат
  const updatedInvoice = db.getInvoiceById(invoice114.id);
  console.log(`\n📄 СЧЕТ №114 - ПОСЛЕ ИСПРАВЛЕНИЯ:`);
  console.log(`   Клиент: ${updatedInvoice.client}`);
  console.log(`   Новый номер: ${updatedInvoice.clientPhone}`);
} else {
  console.log(`\n✅ Номер уже правильный или исправление невозможно`);
}
