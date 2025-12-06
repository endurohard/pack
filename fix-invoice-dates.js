import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const invoicesPath = path.join(__dirname, 'data', 'invoices.json');

// Читаем файл счетов
const invoices = JSON.parse(fs.readFileSync(invoicesPath, 'utf-8'));

console.log('Проверка и исправление дат счетов...\n');

let fixed = 0;
const now = new Date();

invoices.forEach(invoice => {
  // Пропускаем счета с autoSendEnabled = false
  if (!invoice.autoSendEnabled) {
    return;
  }

  const nextSendDate = new Date(invoice.nextSendDate);

  // Если дата отправки в прошлом или слишком близко (раньше чем через неделю)
  const weekFromNow = new Date(now);
  weekFromNow.setDate(weekFromNow.getDate() + 7);

  if (nextSendDate < weekFromNow) {
    console.log(`Счет №${invoice.invoiceNumber} (${invoice.client}):`);
    console.log(`  Старая дата: ${nextSendDate.toISOString()}`);

    // Сохраняем день месяца из оригинальной даты
    const dayOfMonth = nextSendDate.getDate();

    // Устанавливаем дату на тот же день следующего месяца
    const newDate = new Date(now);
    newDate.setMonth(newDate.getMonth() + 1);
    newDate.setDate(dayOfMonth);
    newDate.setHours(0, 0, 0, 0);

    invoice.nextSendDate = newDate.toISOString();
    console.log(`  Новая дата: ${newDate.toISOString()}`);
    console.log(`  (${dayOfMonth}-е число следующего месяца)\n`);

    fixed++;
  }
});

if (fixed > 0) {
  // Сохраняем изменения
  fs.writeFileSync(invoicesPath, JSON.stringify(invoices, null, 2), 'utf-8');
  console.log(`✅ Исправлено счетов: ${fixed}`);
} else {
  console.log('✅ Все даты корректны, исправлений не требуется');
}
