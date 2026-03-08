// Тест выбора файла по имени клиента
const fs = require('fs');
const path = require('path');

// Функция sanitizeFilename из server.js
function sanitizeFilename(name) {
  return name
    .replace(/"/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '_')
    .slice(0, 50);
}

const outputDir = path.join(__dirname, 'output');
const invoiceId = '149';

console.log('\n🧪 ТЕСТ: Выбор файла счета по имени клиента\n');
console.log('='  .repeat(60));

// Симулируем данные из БД
const invoiceFromDB = {
  client: '"Лайм"',
  invoiceNumber: '149'
};

console.log(`\n📋 Данные счета из БД:`);
console.log(`   Номер: ${invoiceFromDB.invoiceNumber}`);
console.log(`   Клиент: ${invoiceFromDB.client}`);

// Получаем все файлы
const files = fs.readdirSync(outputDir);

// Ищем все файлы с номером счета
const matchingFiles = files.filter(f => {
  if (!f.endsWith('.pdf')) return false;
  const match = f.match(/^Счет_(\d+)_/);
  return match && match[1] === String(invoiceId);
});

console.log(`\n📁 Найдено файлов для счета ${invoiceId}: ${matchingFiles.length}`);
matchingFiles.forEach(f => console.log(`   • ${f}`));

if (matchingFiles.length > 1) {
  console.log(`\n🔍 Поиск файла по имени клиента...`);

  const clientNameClean = sanitizeFilename(invoiceFromDB.client);
  console.log(`   Очищенное имя клиента: "${clientNameClean}"`);

  const fileWithClientName = matchingFiles.find(f => f.includes(clientNameClean));

  if (fileWithClientName) {
    console.log(`\n✅ Найден файл по имени клиента:`);
    console.log(`   ${fileWithClientName}`);

    // Проверяем дату модификации
    const filePath = path.join(outputDir, fileWithClientName);
    const stats = fs.statSync(filePath);
    console.log(`   Дата модификации: ${stats.mtime.toISOString()}`);
  } else {
    console.log(`\n❌ Файл с именем клиента "${clientNameClean}" НЕ найден`);
    console.log(`   Будет выбран самый свежий файл по дате`);

    // Показываем какой файл будет выбран
    const filesWithStats = matchingFiles.map(f => {
      const filePath = path.join(outputDir, f);
      const stats = fs.statSync(filePath);
      return { name: f, mtime: stats.mtime };
    });

    filesWithStats.sort((a, b) => b.mtime - a.mtime);
    console.log(`   Самый свежий: ${filesWithStats[0].name}`);
  }
}

console.log('\n' + '='.repeat(60));

// Теперь тест с клиентом Pancho
console.log('\n\n🧪 ТЕСТ 2: Что если запросим файл для клиента Pancho?\n');
console.log('='  .repeat(60));

const invoiceFromDB2 = {
  client: 'Pancho',
  invoiceNumber: '149'
};

console.log(`\n📋 Данные счета из БД:`);
console.log(`   Номер: ${invoiceFromDB2.invoiceNumber}`);
console.log(`   Клиент: ${invoiceFromDB2.client}`);

const clientNameClean2 = sanitizeFilename(invoiceFromDB2.client);
console.log(`   Очищенное имя: "${clientNameClean2}"`);

const fileWithClientName2 = matchingFiles.find(f => f.includes(clientNameClean2));

if (fileWithClientName2) {
  console.log(`\n✅ Найден файл по имени клиента:`);
  console.log(`   ${fileWithClientName2}`);

  const filePath = path.join(outputDir, fileWithClientName2);
  const stats = fs.statSync(filePath);
  console.log(`   Дата модификации: ${stats.mtime.toISOString()}`);
} else {
  console.log(`\n❌ Файл с именем клиента "${clientNameClean2}" НЕ найден`);
}

console.log('\n' + '='.repeat(60));
