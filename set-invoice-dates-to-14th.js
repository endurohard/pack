import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const invoicesPath = path.join(__dirname, 'data', 'invoices.json');

// Читаем файл счетов
const invoices = JSON.parse(fs.readFileSync(invoicesPath, 'utf-8'));

console.log('Установка дат рассылки на 14-е число...\n');

let updated = 0;

invoices.forEach(invoice => {
  // Обрабатываем только счета с включенной авторассылкой
  if (!invoice.autoSendEnabled) {
    return;
  }

  const currentDate = invoice.nextSendDate ? new Date(invoice.nextSendDate) : new Date();

  console.log(`Счет №${invoice.invoiceNumber} (${invoice.client}):`);
  console.log(`  Текущая дата: ${currentDate.toISOString()}`);

  // Устанавливаем 14-е число следующего месяца (январь 2026)
  const newDate = new Date();
  newDate.setFullYear(2026);
  newDate.setMonth(0); // Январь
  newDate.setDate(14);
  newDate.setHours(0, 0, 0, 0);

  invoice.nextSendDate = newDate.toISOString();
  console.log(`  Новая дата: ${newDate.toISOString()}`);
  console.log(`  (14 января 2026)\n`);

  updated++;
});

if (updated > 0) {
  // Сохраняем изменения
  fs.writeFileSync(invoicesPath, JSON.stringify(invoices, null, 2), 'utf-8');
  console.log(`✅ Обновлено счетов: ${updated}`);
} else {
  console.log('✅ Нет счетов с включенной авторассылкой');
}
