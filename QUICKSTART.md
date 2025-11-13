# Быстрый старт

## 1. Установка

```bash
npm install
```

## 2. Базовое использование (без Яндекс.Диска)

```bash
npm test
```

Это создаст пример счета в папке `output/`.

## 3. Использование с Яндекс.Диском

### Шаг 1: Получите OAuth токен

1. Откройте https://yandex.ru/dev/disk/poligon/
2. Нажмите "Получить OAuth-токен"
3. Разрешите доступ к Яндекс.Диску
4. Скопируйте токен

### Шаг 2: Настройте конфигурацию

```bash
cp .env.example .env
```

Откройте `.env` и вставьте ваш токен:

```
YANDEX_DISK_TOKEN=ваш_токен_здесь
YANDEX_DISK_FOLDER=/Счета
```

### Шаг 3: Запустите пример

```bash
node src/example-yandex-disk.js
```

## 4. Создание своего счета

Создайте файл `my-invoice.js`:

```javascript
import InvoiceGenerator from './src/invoiceGenerator.js';

const generator = new InvoiceGenerator();

const invoice = {
  invoiceNumber: 1,
  items: [
    generator.createItem('Услуга 1', 'шт', 2, 1000.00),
    generator.createItem('Услуга 2', 'час', 5, 500.00)
  ],
  discount: generator.createPercentDiscount(10),
  payment: {
    cardNumber: '1111-2222-3333-4444',
    sbpPhone: '9001112233',
    sbpBank: 'Банк'
  }
};

// Только локальный файл
await generator.generateInvoice(invoice, './output/my-invoice.pdf');

// Или с загрузкой на Яндекс.Диск
await generator.generateAndUploadToYandexDisk(
  invoice,
  './output/my-invoice.pdf',
  process.env.YANDEX_DISK_TOKEN,
  '/Счета/my-invoice.pdf',
  { publish: true }
);
```

Запустите:

```bash
node my-invoice.js
```

## 5. Возможности

- ✅ Создание позиций: `generator.createItem(name, unit, qty, price)`
- ✅ Процентные скидки: `generator.createPercentDiscount(10, 'описание')`
- ✅ Фиксированные скидки: `generator.createFixedDiscount(1000, 'описание')`
- ✅ Автоматическая загрузка на Яндекс.Диск
- ✅ Публичные ссылки на счета
- ✅ QR-коды для оплаты

Готово! 🎉
