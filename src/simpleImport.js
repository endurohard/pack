import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import WarehouseDatabase from './warehouseDatabase.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const warehouseDb = new WarehouseDatabase();

/**
 * Упрощенный скрипт импорта товаров из JSON
 * Поддерживает простой формат с фотографиями
 */

function importSimpleJSON(jsonFilePath) {
  console.log('🚀 Начало импорта товаров\n');
  console.log(`📂 Файл: ${jsonFilePath}\n`);

  if (!fs.existsSync(jsonFilePath)) {
    throw new Error(`Файл не найден: ${jsonFilePath}`);
  }

  const data = JSON.parse(fs.readFileSync(jsonFilePath, 'utf-8'));
  const products = Array.isArray(data) ? data : (data.products || []);

  console.log(`✅ Загружено товаров из файла: ${products.length}\n`);

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const product of products) {
    try {
      // Проверяем обязательные поля
      if (!product.name) {
        console.log(`⏭️  Пропущен (нет названия)`);
        skipped++;
        continue;
      }

      // Проверяем дубликаты по названию
      const existing = warehouseDb.getAllProducts().find(p => p.name === product.name);
      if (existing) {
        console.log(`⏭️  Пропущен (уже существует): ${product.name}`);
        skipped++;
        continue;
      }

      // Подготавливаем данные товара
      const productData = {
        name: product.name,
        type: product.type || 'product',
        unit: product.unit || 'шт',
        costPrice: parseFloat(product.costPrice || product.buyPrice || 0),
        sellingPrice: parseFloat(product.sellingPrice || product.price || 0),
        quantity: parseInt(product.quantity || product.stock || 0),
        category: product.category || 'Разное',
        description: product.description || '',
        image: product.image || product.imageUrl || product.photo || null,
        article: product.article || product.sku || '',
        barcode: product.barcode || ''
      };

      warehouseDb.addProduct(productData);
      console.log(`✅ Импортирован: ${productData.name}`);
      imported++;
    } catch (error) {
      console.error(`❌ Ошибка импорта ${product.name || 'Unknown'}:`, error.message);
      errors++;
    }
  }

  console.log('\n📊 Результаты импорта:');
  console.log(`  ✅ Импортировано: ${imported}`);
  console.log(`  ⏭️  Пропущено: ${skipped}`);
  console.log(`  ❌ Ошибок: ${errors}`);

  if (imported > 0) {
    console.log('\n⚠️  ВАЖНО: Перезапустите сервер для отображения новых товаров:');
    console.log('   pkill -9 node && cd ~/pack && nohup npm start > server.log 2>&1 &');
    console.log('\n🌐 После перезапуска откройте: http://localhost:3000/warehouse');
  }
}

/**
 * Главная функция
 */
function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`
📦 Упрощенный импортер товаров

Использование:
  node src/simpleImport.js <путь_к_json_файлу>

Пример:
  node src/simpleImport.js products_to_import.json

Формат JSON файла:
[
  {
    "name": "Название товара",          // Обязательно
    "type": "product",                    // product или service
    "unit": "шт",                         // шт, кг, час, мес и т.д.
    "costPrice": 100,                     // Себестоимость
    "sellingPrice": 200,                  // Цена продажи
    "price": 200,                         // Альтернатива для sellingPrice
    "quantity": 10,                       // Количество
    "stock": 10,                          // Альтернатива для quantity
    "category": "Категория",              // Категория товара
    "description": "Описание",            // Описание
    "image": "https://...",               // URL изображения
    "article": "ART-001",                 // Артикул
    "barcode": "1234567890123"            // Штрихкод
  }
]

Или с вложенной структурой:
{
  "products": [...]
}
    `);
    process.exit(0);
  }

  const jsonFilePath = args[0];

  try {
    importSimpleJSON(jsonFilePath);
  } catch (error) {
    console.error('\n❌ Критическая ошибка:', error.message);
    process.exit(1);
  }
}

main();
