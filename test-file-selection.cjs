// Тест выбора самого свежего файла
const fs = require('fs');
const path = require('path');

const outputDir = path.join(__dirname, 'output');
const invoiceId = '149';

// Получаем все файлы
const files = fs.readdirSync(outputDir);

// Ищем все файлы, которые содержат номер счета
const matchingFiles = files.filter(f => {
  if (!f.endsWith('.pdf')) return false;

  // Проверяем новый формат: Счет_NUMBER_...
  const newFormatMatch = f.match(/^Счет_(\d+)_/);
  if (newFormatMatch && newFormatMatch[1] === String(invoiceId)) {
    return true;
  }

  // Проверяем старый формат: invoice_NUMBER_...
  const oldFormatMatch = f.match(/^invoice_(\d+)_/);
  if (oldFormatMatch && oldFormatMatch[1] === String(invoiceId)) {
    return true;
  }

  return false;
});

console.log(`\n🔍 Найдено файлов для счета ${invoiceId}: ${matchingFiles.length}`);
matchingFiles.forEach(f => console.log(`   - ${f}`));

if (matchingFiles.length > 1) {
  console.warn(`\n⚠️  Найдено ${matchingFiles.length} файлов для счета ${invoiceId}`);

  // Сортируем по времени модификации (самый новый первый)
  const filesWithStats = matchingFiles.map(f => {
    const filePath = path.join(outputDir, f);
    const stats = fs.statSync(filePath);
    return { name: f, mtime: stats.mtime, mtimeStr: stats.mtime.toISOString() };
  });

  console.log('\n📅 Файлы с датами модификации:');
  filesWithStats.forEach(f => {
    console.log(`   ${f.mtimeStr} - ${f.name}`);
  });

  filesWithStats.sort((a, b) => b.mtime - a.mtime);
  const selectedFile = filesWithStats[0].name;

  console.log(`\n✅ Выбран самый свежий файл: ${selectedFile}`);
  console.log(`   Изменен: ${filesWithStats[0].mtimeStr}`);
} else if (matchingFiles.length === 1) {
  console.log(`\n✅ Выбран единственный файл: ${matchingFiles[0]}`);
} else {
  console.log('\n❌ Файлы не найдены');
}
