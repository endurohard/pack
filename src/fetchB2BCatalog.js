import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Скрипт для получения товаров из B2B каталога МойСклад через API
 * B2B каталоги имеют публичный API endpoint для получения списка товаров
 */

async function fetchB2BCatalog(catalogUrl) {
  console.log('🚀 Получение товаров из B2B каталога МойСклад...\n');
  console.log(`📂 URL: ${catalogUrl}\n`);

  // Извлекаем ID каталога из URL
  const catalogMatch = catalogUrl.match(/b2b\.moysklad\.ru\/([^\/]+)/);
  if (!catalogMatch) {
    throw new Error('Не удалось извлечь ID каталога из URL');
  }

  const catalogId = catalogMatch[1];
  console.log(`🔑 ID каталога: ${catalogId}\n`);

  // B2B каталоги обычно имеют API endpoint
  const apiUrl = `https://b2b.moysklad.ru/api/v1/public/catalog/${catalogId}/products`;

  console.log('📡 Попытка получить данные через API с пагинацией...\n');

  try {
    let allProducts = [];
    let offset = 0;
    const limit = 100; // МойСклад обычно ограничивает до 100 товаров за запрос
    let hasMore = true;

    while (hasMore) {
      console.log(`📥 Загрузка партии товаров (offset: ${offset}, limit: ${limit})...`);

      const response = await axios.get(apiUrl, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        params: {
          limit: limit,
          offset: offset
        }
      });

      const products = response.data.rows || response.data.products || response.data;

      if (Array.isArray(products) && products.length > 0) {
        allProducts = allProducts.concat(products);
        console.log(`✅ Загружено: ${products.length} товаров (всего: ${allProducts.length})\n`);

        // Если получили меньше, чем limit, значит это последняя страница
        if (products.length < limit) {
          hasMore = false;
        } else {
          offset += limit;
          // Небольшая задержка, чтобы не перегружать API
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } else {
        hasMore = false;
      }
    }

    if (allProducts.length > 0) {
      console.log(`\n✅ Всего получено товаров: ${allProducts.length}\n`);
      return allProducts;
    } else {
      console.log('⚠️  API вернул неожиданный формат данных\n');
      console.log('Попробуем альтернативный метод...\n');
      throw new Error('Неожиданный формат API');
    }
  } catch (error) {
    console.log(`⚠️  Прямой API не сработал: ${error.message}\n`);
    console.log('Попробуем получить данные из HTML страницы...\n');

    // Пробуем получить HTML и найти данные в скриптах
    try {
      const htmlResponse = await axios.get(catalogUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      const html = htmlResponse.data;

      // Ищем JSON данные в HTML (обычно в window.__INITIAL_STATE__ или подобном)
      const patterns = [
        /"products"\s*:\s*(\[[\s\S]*?\])/,
        /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?/,
        /window\.__DATA__\s*=\s*(\{[\s\S]*?\});?/,
        /"rows"\s*:\s*(\[[\s\S]*?\])/
      ];

      for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match) {
          try {
            const data = JSON.parse(match[1]);
            if (Array.isArray(data) && data.length > 0) {
              console.log(`✅ Найдено товаров в HTML: ${data.length}\n`);
              return data;
            } else if (data.products || data.rows) {
              const products = data.products || data.rows;
              console.log(`✅ Найдено товаров в HTML: ${products.length}\n`);
              return products;
            }
          } catch (e) {
            continue;
          }
        }
      }

      throw new Error('Не удалось извлечь данные из HTML');
    } catch (htmlError) {
      console.error('❌ Не удалось получить данные из HTML:', htmlError.message);
      throw htmlError;
    }
  }
}

/**
 * Преобразовать данные в наш формат
 */
function convertToOurFormat(products) {
  console.log('🔄 Преобразование данных в формат для импорта...\n');

  return products.map((product, index) => {
    // Извлекаем данные из разных возможных форматов
    const name = product.name || product.title || product.productName || `Товар ${index + 1}`;
    const price = product.price || product.salePrice || product.sellingPrice ||
                  (product.salePrices && product.salePrices[0]?.value) || 0;

    // Если цена в копейках (МойСклад), преобразуем в рубли
    const sellingPrice = price > 10000 ? price / 100 : price;

    const image = product.image || product.imageUrl || product.photo ||
                  (product.images && product.images[0]) ||
                  (product.images && product.images.miniature?.href) || null;

    // Формируем ссылку на товар в каталоге поставщика
    const productUrl = product.url || product.link ||
                       (product.id ? `https://b2b.moysklad.ru/4r4hy5a2n7KA/catalog/${product.id}` : null);

    return {
      name: name,
      type: product.type === 'SERVICE' || product.productType === 'SERVICE' ? 'service' : 'product',
      unit: product.unit || product.uom?.name || 'шт',
      sellingPrice: sellingPrice,
      costPrice: 0, // Обычно не доступна в B2B каталоге
      category: product.category || product.pathName || 'Импорт из МойСклад',
      description: product.description || '',
      image: image,
      article: product.article || product.sku || product.code || '',
      barcode: product.barcode || (product.barcodes && product.barcodes[0]?.value) || '',
      quantity: 0,
      supplierUrl: productUrl // Ссылка на товар в каталоге поставщика
    };
  });
}

/**
 * Сохранить данные в файл
 */
function saveToFile(products, filename = 'b2b_catalog_products.json') {
  const filepath = path.join(__dirname, '..', filename);
  fs.writeFileSync(filepath, JSON.stringify(products, null, 2));
  console.log(`💾 Данные сохранены в: ${filepath}\n`);
  return filepath;
}

/**
 * Главная функция
 */
async function main() {
  const catalogUrl = process.argv[2] || 'https://b2b.moysklad.ru/4r4hy5a2n7KA/catalog';

  try {
    // Получаем товары
    const rawProducts = await fetchB2BCatalog(catalogUrl);

    if (!rawProducts || rawProducts.length === 0) {
      console.error('❌ Товары не найдены');
      console.log('\n💡 Попробуйте следующий способ:');
      console.log('1. Откройте каталог в браузере: ' + catalogUrl);
      console.log('2. Нажмите F12 (Developer Tools)');
      console.log('3. Перейдите на вкладку Network');
      console.log('4. Найдите запрос к API с products');
      console.log('5. Скопируйте Response и сохраните в файл products.json');
      console.log('6. Запустите: node src/simpleImport.js products.json');
      process.exit(1);
    }

    // Показываем пример первого товара
    console.log('📋 Пример первого товара (сырые данные):');
    console.log(JSON.stringify(rawProducts[0], null, 2).substring(0, 500) + '...\n');

    // Преобразуем в наш формат
    const convertedProducts = convertToOurFormat(rawProducts);

    // Сохраняем в файл
    const filepath = saveToFile(convertedProducts);

    // Показываем пример преобразованного товара
    console.log('📋 Пример преобразованного товара:');
    console.log(JSON.stringify(convertedProducts[0], null, 2) + '\n');

    console.log('✅ Готово!\n');
    console.log('Для импорта выполните:');
    console.log(`node src/simpleImport.js ${path.basename(filepath)}`);
    console.log('\n⚠️  После импорта не забудьте перезапустить сервер!');

  } catch (error) {
    console.error('\n❌ Ошибка:', error.message);
    console.log('\n💡 Альтернативный способ - ручное извлечение:');
    console.log('\n1. Откройте в браузере: ' + catalogUrl);
    console.log('2. Нажмите F12 (открыть консоль)');
    console.log('3. Вставьте этот код в консоль:');
    console.log(`
// Скрипт для извлечения товаров
const products = [];

// Попробуем найти данные в разных местах
if (window.__INITIAL_STATE__ && window.__INITIAL_STATE__.products) {
  products.push(...window.__INITIAL_STATE__.products);
} else if (window.__DATA__ && window.__DATA__.products) {
  products.push(...window.__DATA__.products);
} else {
  // Собираем товары со страницы
  document.querySelectorAll('[data-product], [class*="product"]').forEach(el => {
    const name = el.querySelector('h2, h3, [class*="name"]')?.textContent?.trim();
    const price = el.querySelector('[class*="price"]')?.textContent?.replace(/[^\\d]/g, '');
    const img = el.querySelector('img')?.src;
    if (name) {
      products.push({ name, price: Number(price), image: img });
    }
  });
}

// Скачиваем JSON
const blob = new Blob([JSON.stringify(products, null, 2)], {type: 'application/json'});
const a = document.createElement('a');
a.href = URL.createObjectURL(blob);
a.download = 'products.json';
a.click();
console.log('Товаров найдено:', products.length);
    `);
    console.log('\n4. Файл products.json будет скачан');
    console.log('5. Импортируйте: node src/simpleImport.js products.json');

    process.exit(1);
  }
}

main();
