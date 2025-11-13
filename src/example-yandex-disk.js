import InvoiceGenerator from './invoiceGenerator.js';
import YandexDiskService from './yandexDiskService.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Загружаем переменные окружения из .env
dotenv.config();

const YANDEX_TOKEN = process.env.YANDEX_DISK_TOKEN;
const YANDEX_FOLDER = process.env.YANDEX_DISK_FOLDER || '/Счета';

if (!YANDEX_TOKEN) {
  console.error('❌ Ошибка: не найден YANDEX_DISK_TOKEN в .env файле');
  console.log('\nДля работы с Яндекс.Диском:');
  console.log('1. Скопируйте .env.example в .env');
  console.log('2. Получите OAuth токен на https://yandex.ru/dev/disk/poligon/');
  console.log('3. Добавьте токен в файл .env');
  process.exit(1);
}

const generator = new InvoiceGenerator();

// Пример 1: Простая загрузка на Яндекс.Диск
async function example1() {
  console.log('\n=== Пример 1: Генерация и загрузка счета на Яндекс.Диск ===\n');

  const invoiceData = {
    invoiceNumber: 676,
    items: [
      generator.createItem('Аренда АТС\\Обслуживание', 'мес', 1, 5700.00),
      generator.createItem('IP-телефония', 'мес', 1, 2500.00)
    ],
    discount: generator.createPercentDiscount(5, 'Скидка для первого клиента'),
    payment: {
      cardNumber: '5280-4137-5406-3845',
      sbpPhone: '9633707007',
      sbpBank: 'ТИНЬКОФФ'
    }
  };

  const localPath = path.join(__dirname, '../output/invoice_676.pdf');
  const remotePath = `${YANDEX_FOLDER}/invoice_676.pdf`;

  try {
    console.log('📄 Генерация счета...');
    const result = await generator.generateAndUploadToYandexDisk(
      invoiceData,
      localPath,
      YANDEX_TOKEN,
      remotePath,
      {
        createFolder: true,
        publish: false,
        deleteLocal: false
      }
    );

    console.log('✅ Успешно!');
    console.log(`   Локальный файл: ${result.localPath}`);
    console.log(`   На Яндекс.Диске: ${result.remotePath}`);
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
  }
}

// Пример 2: Загрузка с публичной ссылкой
async function example2() {
  console.log('\n=== Пример 2: Загрузка с получением публичной ссылки ===\n');

  const invoiceData = {
    invoiceNumber: 677,
    items: [
      generator.createItem('Консультация', 'час', 5, 3000.00),
      generator.createItem('Разработка', 'час', 10, 5000.00)
    ],
    discount: generator.createFixedDiscount(5000, 'Специальное предложение'),
    payment: {
      cardNumber: '5280-4137-5406-3845',
      sbpPhone: '9633707007',
      sbpBank: 'ТИНЬКОФФ'
    }
  };

  const localPath = path.join(__dirname, '../output/invoice_677.pdf');
  const remotePath = `${YANDEX_FOLDER}/invoice_677.pdf`;

  try {
    console.log('📄 Генерация счета и получение публичной ссылки...');
    const result = await generator.generateAndUploadToYandexDisk(
      invoiceData,
      localPath,
      YANDEX_TOKEN,
      remotePath,
      {
        createFolder: true,
        publish: true,  // Получаем публичную ссылку
        deleteLocal: false
      }
    );

    console.log('✅ Успешно!');
    console.log(`   Локальный файл: ${result.localPath}`);
    console.log(`   На Яндекс.Диске: ${result.remotePath}`);
    console.log(`   Публичная ссылка: ${result.publicUrl}`);
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
  }
}

// Пример 3: Работа напрямую с YandexDiskService
async function example3() {
  console.log('\n=== Пример 3: Прямая работа с Яндекс.Диском ===\n');

  try {
    const yandexDisk = new YandexDiskService(YANDEX_TOKEN);

    // Получаем информацию о диске
    console.log('📊 Получение информации о диске...');
    const diskInfo = await yandexDisk.getDiskInfo();
    const usedGB = (diskInfo.used_space / 1024 / 1024 / 1024).toFixed(2);
    const totalGB = (diskInfo.total_space / 1024 / 1024 / 1024).toFixed(2);
    console.log(`   Использовано: ${usedGB} GB из ${totalGB} GB`);

    // Создаем папку для счетов
    console.log('\n📁 Создание папки для счетов...');
    await yandexDisk.createFolder(YANDEX_FOLDER);
    console.log(`   Папка создана: ${YANDEX_FOLDER}`);

    // Получаем список файлов в папке
    console.log('\n📋 Список файлов в папке:');
    try {
      const files = await yandexDisk.listFiles(YANDEX_FOLDER);
      if (files.length === 0) {
        console.log('   Папка пуста');
      } else {
        files.forEach((file, index) => {
          const sizeKB = (file.size / 1024).toFixed(2);
          console.log(`   ${index + 1}. ${file.name} (${sizeKB} KB)`);
        });
      }
    } catch (error) {
      console.log('   Папка пуста или не существует');
    }

  } catch (error) {
    console.error('❌ Ошибка:', error.message);
  }
}

// Запускаем все примеры
async function runAll() {
  console.log('🚀 Запуск примеров работы с Яндекс.Диском');
  console.log('=========================================');

  await example1();
  await example2();
  await example3();

  console.log('\n✨ Все примеры выполнены!\n');
}

runAll().catch(console.error);
