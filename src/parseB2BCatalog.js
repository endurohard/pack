import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Скрипт для парсинга B2B каталога МойСклад
 * Извлекает товары с фотографиями из публичного каталога
 */

async function parseB2BCatalog(catalogUrl) {
  console.log('🚀 Запуск парсера B2B каталога МойСклад...\n');
  console.log(`📂 URL: ${catalogUrl}\n`);

  let browser;
  try {
    // Запускаем браузер
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();

    // Увеличиваем таймаут
    page.setDefaultTimeout(60000);

    console.log('🌐 Загрузка страницы...');
    await page.goto(catalogUrl, { waitUntil: 'networkidle0' });

    // Ждем загрузки товаров
    console.log('⏳ Ожидание загрузки каталога...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Извлекаем данные товаров
    console.log('📊 Извлечение данных товаров...\n');

    const products = await page.evaluate(() => {
      const items = [];

      // Ищем карточки товаров (структура может отличаться)
      const productCards = document.querySelectorAll('[class*="product"], [class*="item"], [class*="card"]');

      productCards.forEach((card, index) => {
        try {
          // Извлекаем название
          const nameEl = card.querySelector('[class*="name"], [class*="title"], h2, h3, h4');
          const name = nameEl ? nameEl.textContent.trim() : `Товар ${index + 1}`;

          // Извлекаем изображение
          const imgEl = card.querySelector('img');
          const image = imgEl ? imgEl.src : null;

          // Извлекаем цену
          const priceEl = card.querySelector('[class*="price"]');
          let price = 0;
          if (priceEl) {
            const priceText = priceEl.textContent.replace(/[^\d.,]/g, '').replace(',', '.');
            price = parseFloat(priceText) || 0;
          }

          // Извлекаем описание
          const descEl = card.querySelector('[class*="description"], [class*="desc"], p');
          const description = descEl ? descEl.textContent.trim() : '';

          // Извлекаем артикул
          const articleEl = card.querySelector('[class*="article"], [class*="code"], [class*="sku"]');
          const article = articleEl ? articleEl.textContent.trim() : '';

          items.push({
            name,
            image,
            price,
            description,
            article
          });
        } catch (error) {
          console.error('Ошибка обработки карточки:', error);
        }
      });

      return items;
    });

    console.log(`✅ Найдено товаров: ${products.length}\n`);

    if (products.length === 0) {
      console.log('⚠️  Товары не найдены. Попробуем альтернативный способ...\n');

      // Пробуем найти данные в JavaScript объектах на странице
      const alternativeData = await page.evaluate(() => {
        // Ищем данные в window объекте
        if (window.__INITIAL_STATE__) {
          return window.__INITIAL_STATE__;
        }
        if (window.__DATA__) {
          return window.__DATA__;
        }

        // Ищем в script тегах
        const scripts = Array.from(document.querySelectorAll('script'));
        for (const script of scripts) {
          const text = script.textContent;
          if (text.includes('products') || text.includes('items')) {
            try {
              const match = text.match(/(?:products|items)\s*[:=]\s*(\[[\s\S]*?\])/);
              if (match) {
                return JSON.parse(match[1]);
              }
            } catch (e) {
              // Игнорируем ошибки парсинга
            }
          }
        }

        return null;
      });

      if (alternativeData) {
        console.log('✅ Данные извлечены альтернативным способом');
        products.push(...(Array.isArray(alternativeData) ? alternativeData : []));
      }
    }

    // Сохраняем результат
    const outputPath = path.join(__dirname, '../moysklad_parsed.json');
    fs.writeFileSync(outputPath, JSON.stringify(products, null, 2));

    console.log(`💾 Данные сохранены в: ${outputPath}\n`);

    // Выводим пример данных
    if (products.length > 0) {
      console.log('📋 Пример первого товара:');
      console.log(JSON.stringify(products[0], null, 2));
    }

    await browser.close();

    return products;
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    if (browser) {
      await browser.close();
    }
    throw error;
  }
}

/**
 * Скачать изображение
 */
async function downloadImage(imageUrl, productIndex) {
  if (!imageUrl || (!imageUrl.startsWith('http'))) {
    return null;
  }

  try {
    const imagesDir = path.join(__dirname, '../uploads/products');
    if (!fs.existsSync(imagesDir)) {
      fs.mkdirSync(imagesDir, { recursive: true });
    }

    const ext = path.extname(new URL(imageUrl).pathname) || '.jpg';
    const filename = `b2b_product_${productIndex}_${Date.now()}${ext}`;
    const filepath = path.join(imagesDir, filename);

    console.log(`  📥 Загрузка изображения ${productIndex + 1}: ${filename}`);

    return new Promise((resolve, reject) => {
      const protocol = imageUrl.startsWith('https') ? https : http;

      protocol.get(imageUrl, (response) => {
        if (response.statusCode !== 200) {
          console.log(`    ⚠️  HTTP ${response.statusCode}`);
          resolve(imageUrl); // Возвращаем URL если не удалось скачать
          return;
        }

        const fileStream = fs.createWriteStream(filepath);
        response.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close();
          console.log(`    ✅ Сохранено`);
          resolve(`/uploads/products/${filename}`);
        });

        fileStream.on('error', (err) => {
          fs.unlink(filepath, () => {});
          console.log(`    ❌ Ошибка: ${err.message}`);
          resolve(imageUrl); // Возвращаем URL если не удалось скачать
        });
      }).on('error', (err) => {
        console.log(`    ❌ Ошибка: ${err.message}`);
        resolve(imageUrl); // Возвращаем URL если не удалось скачать
      });
    });
  } catch (error) {
    console.error(`  ❌ Ошибка загрузки изображения: ${error.message}`);
    return imageUrl;
  }
}

/**
 * Скачать все изображения товаров
 */
async function downloadAllImages(products) {
  console.log(`\n📥 Загрузка изображений (всего: ${products.length})...\n`);

  for (let i = 0; i < products.length; i++) {
    const product = products[i];

    if (product.image) {
      const localPath = await downloadImage(product.image, i);
      if (localPath && localPath.startsWith('/uploads')) {
        product.image = localPath;
      }
    }
  }

  console.log('\n✅ Загрузка изображений завершена\n');
  return products;
}

/**
 * Преобразовать распарсенные данные в формат для импорта
 */
function convertToImportFormat(parsedProducts) {
  return parsedProducts.map((product, index) => {
    return {
      name: product.name || product.title || `Товар ${index + 1}`,
      type: 'product',
      unit: product.unit || 'шт',
      costPrice: 0,
      sellingPrice: product.price || 0,
      quantity: 0,
      category: product.category || 'Импорт из B2B каталога',
      description: product.description || '',
      image: product.image || null,
      article: product.article || product.code || product.sku || '',
      barcode: product.barcode || ''
    };
  });
}

/**
 * Главная функция
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`
📦 Парсер B2B каталога МойСклад

Использование:
  node src/parseB2BCatalog.js <URL_каталога> [--download-images]

Пример:
  node src/parseB2BCatalog.js https://b2b.moysklad.ru/4r4hy5a2n7KA

Опции:
  --download-images  Скачивать изображения товаров на сервер (по умолчанию только URL)

После парсинга файл b2b_catalog_ready.json можно импортировать:
  node src/simpleImport.js b2b_catalog_ready.json
    `);
    process.exit(0);
  }

  const catalogUrl = args[0];
  const downloadImages = args.includes('--download-images');

  console.log(`\n📋 Настройки парсинга:`);
  console.log(`  URL: ${catalogUrl}`);
  console.log(`  Скачивание изображений: ${downloadImages ? 'Да' : 'Нет (только URL)'}\n`);

  try {
    let products = await parseB2BCatalog(catalogUrl);

    if (products.length > 0) {
      // Скачиваем изображения если указан флаг
      if (downloadImages) {
        products = await downloadAllImages(products);
      }

      // Преобразуем в формат для импорта
      const importData = convertToImportFormat(products);
      const importPath = path.join(__dirname, '../b2b_catalog_ready.json');
      fs.writeFileSync(importPath, JSON.stringify(importData, null, 2));

      console.log(`\n✅ Готово к импорту: ${importPath}`);
      console.log(`   Товаров: ${importData.length}`);
      console.log(`   С изображениями: ${importData.filter(p => p.image).length}`);
      console.log(`\n💡 Для импорта в базу данных выполните:`);
      console.log(`   node src/simpleImport.js b2b_catalog_ready.json`);
    }
  } catch (error) {
    console.error('\n❌ Критическая ошибка:', error.message);
    console.error('\n💡 Попробуйте:');
    console.error('1. Убедитесь, что URL корректный');
    console.error('2. Проверьте, что каталог публичный (не требует авторизации)');
    console.error('3. Установите зависимости: npm install puppeteer');
    process.exit(1);
  }
}

// Запуск
main();
