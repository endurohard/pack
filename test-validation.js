import PhoneValidator from './src/phoneValidator.js';
import InvoiceDatabase from './src/invoiceDatabase.js';

console.log('\n========================================');
console.log('   ТЕСТИРОВАНИЕ ВАЛИДАЦИИ НОМЕРОВ');
console.log('========================================\n');

const validator = new PhoneValidator();
const db = new InvoiceDatabase();

// Получаем все счета
const invoices = db.getAllInvoices();

console.log(`📊 Всего счетов в базе: ${invoices.length}\n`);

// Валидируем все счета
console.log('🔍 ПРОВЕРКА ВСЕХ СЧЕТОВ:\n');
const report = validator.validateAllInvoices(invoices);

console.log(`✅ Правильных номеров: ${report.valid}`);
console.log(`❌ Неправильных номеров: ${report.invalid}`);
console.log(`👤 Клиентов не найдено: ${report.missingClient}`);
console.log(`📞 Номеров не указано: ${report.missingPhone}\n`);

// Валидируем счета с автоотправкой
console.log('🔍 ПРОВЕРКА СЧЕТОВ С АВТООТПРАВКОЙ:\n');
const autoSendReport = validator.validateAutoSendInvoices(invoices);

console.log(`📋 Счетов с автоотправкой: ${autoSendReport.autoSendCount}`);
console.log(`✅ Правильных номеров: ${autoSendReport.valid}`);
console.log(`❌ Неправильных номеров: ${autoSendReport.invalid}\n`);

// Показываем проблемные счета с автоотправкой
if (autoSendReport.issues.length > 0) {
  console.log('⚠️  ПРОБЛЕМНЫЕ СЧЕТА С АВТООТПРАВКОЙ:\n');
  autoSendReport.issues.forEach((issue, index) => {
    console.log(`${index + 1}. Счет №${issue.invoiceNumber} - ${issue.client}`);
    console.log(`   Текущий номер: ${issue.currentPhone || 'НЕТ'}`);
    console.log(`   Правильный номер: ${issue.expectedPhone || 'КЛИЕНТ НЕ НАЙДЕН'}`);
    console.log(`   Проблема: ${issue.message}`);
    console.log('');
  });
}

// Тестируем функцию исправления
console.log('\n🔧 ТЕСТ ИСПРАВЛЕНИЯ НОМЕРОВ:\n');

// Найдем первый проблемный счет с автоотправкой
const problematicInvoice = invoices.find(inv => {
  const validation = validator.validateInvoicePhone(inv.client, inv.clientPhone);
  return !validation.valid && validation.clientFound && inv.autoSendEnabled;
});

if (problematicInvoice) {
  console.log(`Тестируем на счете №${problematicInvoice.invoiceNumber}`);
  console.log(`Клиент: ${problematicInvoice.client}`);
  console.log(`Текущий номер: ${problematicInvoice.clientPhone}\n`);

  const fixResult = validator.fixInvoicePhone(problematicInvoice.client, problematicInvoice.clientPhone);

  if (fixResult.success) {
    console.log(`✅ ${fixResult.message}`);
    if (fixResult.changed) {
      console.log(`   Старый: ${fixResult.oldPhone}`);
      console.log(`   Новый:  ${fixResult.correctPhone}`);
    }
  } else {
    console.log(`❌ ${fixResult.message}`);
  }
} else {
  console.log('Проблемных счетов для теста не найдено');
}

console.log('\n========================================');
console.log('   ТЕСТИРОВАНИЕ ЗАВЕРШЕНО');
console.log('========================================\n');
