import axios from 'axios';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';
import WarehouseDatabase from './warehouseDatabase.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const warehouseDb = new WarehouseDatabase();

/**
 * Скрипт импорта товаров из МойСклад
 *
 * Поддерживает два режима:
 * 1. Импорт через API МойСклад (требуется токен)
 * 2. Импорт из JSON файла (экспортированного вручную)
 */

// Конфигурация МойСклад API
const MOYSKLAD_CONFIG = {
  // Получите токен в настройках МойСклад:
  // Настройки -> Пользователи и права -> Создать токен
  token: process.env.MOYSKLAD_TOKEN || '',

  // ID вашей организации (можно найти в URL при работе с МойСклад)
  accountId: process.env.MOYSKLAD_ACCOUNT_ID || ''
};

/**
 * Получить товары из МойСклад через API
 */
async function fetchProductsFromAPI() {
  if (!MOYSKLAD_CONFIG.token || !MOYSKLAD_CONFIG.accountId) {
    throw new Error('Не указаны MOYSKLAD_TOKEN и MOYSKLAD_ACCOUNT_ID в переменных окружения');
  }

  console.log('📡 Получение товаров из МойСклад API...');

  try {
    const response = await axios.get(
      `https://api.moysklad.ru/api/remap/1.2/entity/product`,
      {
        headers: {
          'Authorization': `Bearer ${MOYSKLAD_CONFIG.token}`,
          'Accept-Encoding': 'gzip'
        },
        params: {
          limit: 1000 // Максимальное количество за один запрос
        }
      }
    );

    return response.data.rows || [];
  } catch (error) {
    if (error.response) {
      console.error('❌ Ошибка API МойСклад:', error.response.status, error.response.data);
    } else {
      console.error('❌ Ошибка:', error.message);
    }
    throw error;
  }
}

/**
 * Скачать изображение товара
 */
async function downloadImage(imageUrl, productId) {
  if (!imageUrl) return null;

  try {
    const imagesDir = path.join(__dirname, '../uploads/products');
    if (!fs.existsSync(imagesDir)) {
      fs.mkdirSync(imagesDir, { recursive: true });
    }

    const ext = path.extname(new URL(imageUrl).pathname) || '.jpg';
    const filename = `product_${productId}${ext}`;
    const filepath = path.join(imagesDir, filename);

    console.log(`  📥 Скачивание изображения: ${filename}`);

    const response = await axios({
      method: 'get',
      url: imageUrl,
      responseType: 'stream',
      headers: MOYSKLAD_CONFIG.token ? {
        'Authorization': `Bearer ${MOYSKLAD_CONFIG.token}`
      } : {}
    });

    const writer = fs.createWriteStream(filepath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    return `/uploads/products/${filename}`;
  } catch (error) {
    console.error(`  ❌ Ошибка загрузки изображения: ${error.message}`);
    return null;
  }
}

/**
 * Преобразовать товар из формата МойСклад в наш формат
 */
async function convertMoySkladProduct(msProduct, downloadImages = false) {
  // Получаем первое изображение товара
  let imageUrl = null;
  if (msProduct.images && msProduct.images.meta && msProduct.images.meta.href) {
    try {
      if (MOYSKLAD_CONFIG.token) {
        const imagesResponse = await axios.get(msProduct.images.meta.href, {
          headers: {
            'Authorization': `Bearer ${MOYSKLAD_CONFIG.token}`
          }
        });

        if (imagesResponse.data.rows && imagesResponse.data.rows.length > 0) {
          imageUrl = imagesResponse.data.rows[0].miniature?.href ||
                     imagesResponse.data.rows[0].tiny?.href;

          if (downloadImages && imageUrl) {
            imageUrl = await downloadImage(imageUrl, msProduct.id);
          }
        }
      }
    } catch (error) {
      console.error(`  ⚠️  Не удалось получить изображение для ${msProduct.name}`);
    }
  }

  // Получаем цены
  const costPrice = msProduct.buyPrice?.value ? msProduct.buyPrice.value / 100 : 0;
  const sellingPrice = msProduct.salePrices?.[0]?.value ? msProduct.salePrices[0].value / 100 : 0;

  return {
    id: `ms_${msProduct.id}`,
    name: msProduct.name,
    type: msProduct.productType === 'SERVICE' ? 'service' : 'product',
    unit: msProduct.uom?.name || 'шт',
    costPrice: costPrice,
    sellingPrice: sellingPrice,
    quantity: msProduct.stock || 0,
    category: msProduct.pathName || 'Разное',
    description: msProduct.description || '',
    image: imageUrl,
    article: msProduct.article || '',
    barcode: msProduct.barcodes?.[0]?.value || '',
    createdAt: msProduct.created || new Date().toISOString()
  };
}

/**
 * Импорт товаров из МойСклад API
 */
async function importFromAPI(downloadImages = false) {
  console.log('🚀 Начало импорта из МойСклад API\n');

  const products = await fetchProductsFromAPI();
  console.log(`✅ Получено товаров: ${products.length}\n`);

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const msProduct of products) {
    try {
      // Проверяем, не импортирован ли уже этот товар
      const existingProduct = warehouseDb.getProductById(`ms_${msProduct.id}`);
      if (existingProduct) {
        console.log(`⏭️  Пропущен (уже существует): ${msProduct.name}`);
        skipped++;
        continue;
      }

      const product = await convertMoySkladProduct(msProduct, downloadImages);
      warehouseDb.addProduct(product);

      console.log(`✅ Импортирован: ${product.name}`);
      imported++;
    } catch (error) {
      console.error(`❌ Ошибка импорта ${msProduct.name}:`, error.message);
      errors++;
    }
  }

  console.log('\n📊 Результаты импорта:');
  console.log(`  ✅ Импортировано: ${imported}`);
  console.log(`  ⏭️  Пропущено: ${skipped}`);
  console.log(`  ❌ Ошибок: ${errors}`);
}

/**
 * Импорт из JSON файла
 */
async function importFromJSON(jsonFilePath, downloadImages = false) {
  console.log('🚀 Начало импорта из JSON файла\n');
  console.log(`📂 Файл: ${jsonFilePath}\n`);

  if (!fs.existsSync(jsonFilePath)) {
    throw new Error(`Файл не найден: ${jsonFilePath}`);
  }

  const data = JSON.parse(fs.readFileSync(jsonFilePath, 'utf-8'));
  const products = Array.isArray(data) ? data : (data.rows || []);

  console.log(`✅ Загружено товаров из файла: ${products.length}\n`);

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const msProduct of products) {
    try {
      const productId = msProduct.id || `import_${Date.now()}_${Math.random()}`;
      const existingProduct = warehouseDb.getProductById(`ms_${productId}`);

      if (existingProduct) {
        console.log(`⏭️  Пропущен (уже существует): ${msProduct.name}`);
        skipped++;
        continue;
      }

      const product = await convertMoySkladProduct(msProduct, downloadImages);
      warehouseDb.addProduct(product);

      console.log(`✅ Импортирован: ${product.name}`);
      imported++;
    } catch (error) {
      console.error(`❌ Ошибка импорта ${msProduct.name || 'Unknown'}:`, error.message);
      errors++;
    }
  }

  console.log('\n📊 Результаты импорта:');
  console.log(`  ✅ Импортировано: ${imported}`);
  console.log(`  ⏭️  Пропущено: ${skipped}`);
  console.log(`  ❌ Ошибок: ${errors}`);
}

/**
 * Главная функция
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`
📦 Скрипт импорта товаров из МойСклад

Использование:

1. Импорт через API МойСклад:
   node src/importFromMoySklad.js --api [--download-images]

   Требуется установить переменные окружения:
   - MOYSKLAD_TOKEN - токен доступа к API
   - MOYSKLAD_ACCOUNT_ID - ID вашей организации

   Пример:
   MOYSKLAD_TOKEN="your_token" MOYSKLAD_ACCOUNT_ID="your_id" node src/importFromMoySklad.js --api

2. Импорт из JSON файла:
   node src/importFromMoySklad.js --json <путь_к_файлу> [--download-images]

   Пример:
   node src/importFromMoySklad.js --json ./moysklad_products.json

Опции:
  --download-images  Скачивать изображения товаров (по умолчанию только URL)

Как получить JSON файл из МойСклад:
1. Зайдите в МойСклад -> Товары и услуги
2. Выберите нужные товары (или все)
3. Нажмите "Экспорт" -> "Экспортировать в JSON"
4. Сохраните файл и укажите путь к нему
    `);
    process.exit(0);
  }

  const downloadImages = args.includes('--download-images');

  try {
    if (args[0] === '--api') {
      await importFromAPI(downloadImages);
    } else if (args[0] === '--json' && args[1]) {
      await importFromJSON(args[1], downloadImages);
    } else {
      console.error('❌ Неверные параметры. Используйте --help для справки');
      process.exit(1);
    }
  } catch (error) {
    console.error('\n❌ Критическая ошибка:', error.message);
    process.exit(1);
  }
}

// Запуск скрипта
main();
