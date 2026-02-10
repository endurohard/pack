import PhoneValidator from './src/phoneValidator.js';
import InvoiceDatabase from './src/invoiceDatabase.js';

const validator = new PhoneValidator();
const db = new InvoiceDatabase();

const invoices = db.getAllInvoices();
const report = validator.validateAllInvoices(invoices);

console.log('\n❌ ПРОБЛЕМНЫЕ СЧЕТА:\n');
report.issues.forEach((issue, index) => {
  console.log(`${index + 1}. Счет №${issue.invoiceNumber} - ${issue.client}`);
  console.log(`   ID: ${issue.invoiceId}`);
  console.log(`   Текущий номер: ${issue.currentPhone || 'НЕТ'}`);
  console.log(`   Ожидаемый номер: ${issue.expectedPhone || 'КЛИЕНТ НЕ НАЙДЕН'}`);
  console.log(`   Проблема: ${issue.message}`);
  console.log(`   Автоотправка: ${issue.autoSendEnabled ? 'ДА' : 'Нет'}`);
  console.log('');
});
