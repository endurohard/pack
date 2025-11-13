import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PRODUCTS_DB_PATH = path.join(__dirname, '../data/products.json');
const MOVEMENTS_DB_PATH = path.join(__dirname, '../data/movements.json');

/**
 * База данных для управления складом
 */
class WarehouseDatabase {
  constructor() {
    this.ensureDataDir();
    this.loadData();
  }

  ensureDataDir() {
    const dataDir = path.dirname(PRODUCTS_DB_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  loadData() {
    // Загружаем товары
    if (fs.existsSync(PRODUCTS_DB_PATH)) {
      const data = fs.readFileSync(PRODUCTS_DB_PATH, 'utf-8');
      this.products = JSON.parse(data);
    } else {
      this.products = [];
      this.saveProducts();
    }

    // Загружаем движения
    if (fs.existsSync(MOVEMENTS_DB_PATH)) {
      const data = fs.readFileSync(MOVEMENTS_DB_PATH, 'utf-8');
      this.movements = JSON.parse(data);
    } else {
      this.movements = [];
      this.saveMovements();
    }
  }

  saveProducts() {
    fs.writeFileSync(PRODUCTS_DB_PATH, JSON.stringify(this.products, null, 2), 'utf-8');
  }

  saveMovements() {
    fs.writeFileSync(MOVEMENTS_DB_PATH, JSON.stringify(this.movements, null, 2), 'utf-8');
  }

  /**
   * Добавить новый товар/услугу
   */
  addProduct(productData) {
    const product = {
      id: Date.now().toString(),
      name: productData.name,
      type: productData.type, // 'product' или 'service'
      unit: productData.unit, // шт, кг, час, мес и т.д.
      costPrice: productData.costPrice || 0, // Себестоимость
      sellingPrice: productData.sellingPrice || 0, // Цена продажи
      quantity: 0, // Текущий остаток
      category: productData.category || 'Разное',
      description: productData.description || '',
      createdAt: new Date().toISOString()
    };

    this.products.push(product);
    this.saveProducts();
    return product;
  }

  /**
   * Получить все товары
   */
  getAllProducts() {
    return this.products.sort((a, b) =>
      new Date(b.createdAt) - new Date(a.createdAt)
    );
  }

  /**
   * Получить товар по ID
   */
  getProductById(id) {
    return this.products.find(p => p.id === id);
  }

  /**
   * Обновить товар
   */
  updateProduct(id, updates) {
    const product = this.getProductById(id);
    if (product) {
      Object.assign(product, updates);
      this.saveProducts();
      return product;
    }
    return null;
  }

  /**
   * Удалить товар
   */
  deleteProduct(id) {
    const index = this.products.findIndex(p => p.id === id);
    if (index !== -1) {
      const deleted = this.products.splice(index, 1)[0];
      this.saveProducts();
      return deleted;
    }
    return null;
  }

  /**
   * Добавить движение товара (приход/расход)
   */
  addMovement(movementData) {
    const product = this.getProductById(movementData.productId);
    if (!product) {
      throw new Error('Товар не найден');
    }

    const movement = {
      id: Date.now().toString(),
      productId: movementData.productId,
      type: movementData.type, // 'in' (приход) или 'out' (расход)
      quantity: movementData.quantity,
      costPrice: movementData.costPrice || product.costPrice,
      sellingPrice: movementData.sellingPrice || product.sellingPrice,
      invoiceId: movementData.invoiceId || null, // Связь со счетом
      note: movementData.note || '',
      createdAt: new Date().toISOString()
    };

    // Обновляем остаток товара
    if (movement.type === 'in') {
      product.quantity += movement.quantity;
      // Обновляем среднюю себестоимость при приходе
      if (movementData.costPrice) {
        product.costPrice = movementData.costPrice;
      }
    } else if (movement.type === 'out') {
      if (product.type === 'product' && product.quantity < movement.quantity) {
        throw new Error('Недостаточно товара на складе');
      }
      product.quantity -= movement.quantity;
    }

    this.movements.push(movement);
    this.saveProducts();
    this.saveMovements();
    return movement;
  }

  /**
   * Получить все движения
   */
  getAllMovements() {
    return this.movements.sort((a, b) =>
      new Date(b.createdAt) - new Date(a.createdAt)
    );
  }

  /**
   * Получить движения по товару
   */
  getMovementsByProduct(productId) {
    return this.movements
      .filter(m => m.productId === productId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  /**
   * Получить движения по счету
   */
  getMovementsByInvoice(invoiceId) {
    return this.movements.filter(m => m.invoiceId === invoiceId);
  }

  /**
   * Анализ доходности
   */
  getProfitabilityAnalysis(startDate = null, endDate = null) {
    let movements = this.movements;

    // Фильтрация по датам
    if (startDate) {
      movements = movements.filter(m => new Date(m.createdAt) >= new Date(startDate));
    }
    if (endDate) {
      movements = movements.filter(m => new Date(m.createdAt) <= new Date(endDate));
    }

    // Расходы (траты на товары)
    const expenses = movements
      .filter(m => m.type === 'in')
      .reduce((sum, m) => sum + (m.costPrice * m.quantity), 0);

    // Доходы (продажи)
    const revenue = movements
      .filter(m => m.type === 'out')
      .reduce((sum, m) => sum + (m.sellingPrice * m.quantity), 0);

    // Себестоимость проданных товаров
    const cogs = movements
      .filter(m => m.type === 'out')
      .reduce((sum, m) => sum + (m.costPrice * m.quantity), 0);

    // Прибыль
    const profit = revenue - cogs;

    // Маржа
    const margin = revenue > 0 ? ((profit / revenue) * 100).toFixed(2) : 0;

    // Анализ по товарам
    const productAnalysis = {};
    movements.forEach(m => {
      if (!productAnalysis[m.productId]) {
        const product = this.getProductById(m.productId);
        productAnalysis[m.productId] = {
          productName: product ? product.name : 'Неизвестно',
          revenue: 0,
          cost: 0,
          profit: 0,
          soldQuantity: 0
        };
      }

      if (m.type === 'out') {
        productAnalysis[m.productId].revenue += m.sellingPrice * m.quantity;
        productAnalysis[m.productId].cost += m.costPrice * m.quantity;
        productAnalysis[m.productId].soldQuantity += m.quantity;
        productAnalysis[m.productId].profit =
          productAnalysis[m.productId].revenue - productAnalysis[m.productId].cost;
      }
    });

    return {
      expenses,
      revenue,
      cogs,
      profit,
      margin: parseFloat(margin),
      productAnalysis: Object.values(productAnalysis)
        .sort((a, b) => b.profit - a.profit)
    };
  }

  /**
   * Получить товары с низким остатком
   */
  getLowStockProducts(threshold = 5) {
    return this.products
      .filter(p => p.type === 'product' && p.quantity <= threshold)
      .sort((a, b) => a.quantity - b.quantity);
  }

  /**
   * Получить статистику склада
   */
  getWarehouseStatistics() {
    const totalProducts = this.products.length;
    const productsCount = this.products.filter(p => p.type === 'product').length;
    const servicesCount = this.products.filter(p => p.type === 'service').length;

    const totalValue = this.products.reduce((sum, p) =>
      sum + (p.quantity * p.costPrice), 0
    );

    const lowStock = this.getLowStockProducts().length;

    return {
      totalProducts,
      productsCount,
      servicesCount,
      totalValue,
      lowStock
    };
  }
}

export default WarehouseDatabase;
