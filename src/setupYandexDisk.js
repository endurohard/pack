#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envPath = path.join(__dirname, '../.env');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function setup() {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║   Настройка интеграции с Яндекс.Диском                        ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  // Проверяем, есть ли уже токен
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    if (envContent.includes('YANDEX_DISK_TOKEN=') && !envContent.includes('your_oauth_token_here')) {
      console.log('✅ Токен уже настроен!\n');
      const answer = await question('Хотите перенастроить? (y/n): ');
      if (answer.toLowerCase() !== 'y') {
        console.log('\nНастройка отменена.');
        rl.close();
        return;
      }
    }
  }

  console.log('Для работы с Яндекс.Диском нужен OAuth токен.\n');
  console.log('Пожалуйста, выполните следующие шаги:\n');
  console.log('1. Откройте браузер и перейдите по ссылке:');
  console.log('   \x1b[36mhttps://yandex.ru/dev/disk/poligon/\x1b[0m\n');
  console.log('2. Нажмите кнопку "Получить OAuth-токен"');
  console.log('3. Разрешите доступ к вашему Яндекс.Диску');
  console.log('4. Скопируйте полученный токен\n');

  const token = await question('Вставьте токен сюда: ');

  if (!token || token.trim().length < 10) {
    console.log('\n❌ Ошибка: токен не может быть пустым или слишком коротким');
    rl.close();
    return;
  }

  console.log('\n');
  const folder = await question('В какую папку сохранять счета? (по умолчанию: /Счета): ');
  const folderPath = folder.trim() || '/Счета';

  // Создаем .env файл
  const envContent = `# Яндекс.Диск OAuth токен
YANDEX_DISK_TOKEN=${token.trim()}

# Путь к папке на Яндекс.Диске для сохранения счетов
YANDEX_DISK_FOLDER=${folderPath}
`;

  fs.writeFileSync(envPath, envContent, 'utf-8');

  console.log('\n✅ Конфигурация сохранена!');
  console.log(`📁 Файлы будут сохраняться в папку: ${folderPath}`);
  console.log('\nТеперь вы можете использовать:');
  console.log('  node src/example-yandex-disk.js\n');
  console.log('Токен сохранен в файле .env и больше не потребуется.\n');

  rl.close();
}

setup().catch(console.error);
