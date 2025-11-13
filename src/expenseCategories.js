import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CATEGORIES_PATH = path.join(__dirname, '../data/expenseCategories.json');

/**
 * Управление категориями расходов
 */
class ExpenseCategories {
  constructor() {
    this.ensureDataDir();
    this.loadData();
  }

  ensureDataDir() {
    const dataDir = path.dirname(CATEGORIES_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  loadData() {
    if (fs.existsSync(CATEGORIES_PATH)) {
      const data = fs.readFileSync(CATEGORIES_PATH, 'utf-8');
      this.categories = JSON.parse(data);
    } else {
      // Инициализируем с базовыми категориями
      this.categories = [
        { id: '1', name: 'Материалы', description: 'Закупка материалов для работы', createdAt: new Date().toISOString() },
        { id: '2', name: 'Работа', description: 'Оплата труда работников', createdAt: new Date().toISOString() },
        { id: '3', name: 'Транспорт', description: 'Транспортные расходы', createdAt: new Date().toISOString() },
        { id: '4', name: 'Доставка', description: 'Доставка материалов/товаров', createdAt: new Date().toISOString() },
        { id: '5', name: 'Аренда', description: 'Аренда помещений/оборудования', createdAt: new Date().toISOString() },
        { id: '6', name: 'Комиссия', description: 'Комиссия банка/платежных систем', createdAt: new Date().toISOString() },
        { id: '7', name: 'Прочее', description: 'Другие расходы', createdAt: new Date().toISOString() }
      ];
      this.saveData();
    }
  }

  saveData() {
    fs.writeFileSync(CATEGORIES_PATH, JSON.stringify(this.categories, null, 2), 'utf-8');
  }

  /**
   * Получить все категории
   */
  getAllCategories() {
    return this.categories.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Получить категорию по ID
   */
  getCategoryById(id) {
    return this.categories.find(cat => cat.id === id);
  }

  /**
   * Добавить новую категорию
   */
  addCategory(categoryData) {
    if (!categoryData.name) {
      throw new Error('Название категории обязательно');
    }

    // Проверяем, не существует ли уже такая категория
    const existing = this.categories.find(
      cat => cat.name.toLowerCase() === categoryData.name.toLowerCase()
    );
    if (existing) {
      throw new Error('Категория с таким названием уже существует');
    }

    const category = {
      id: Date.now().toString(),
      name: categoryData.name.trim(),
      description: categoryData.description || '',
      createdAt: new Date().toISOString()
    };

    this.categories.push(category);
    this.saveData();
    return category;
  }

  /**
   * Обновить категорию
   */
  updateCategory(id, updates) {
    const category = this.getCategoryById(id);
    if (!category) {
      throw new Error('Категория не найдена');
    }

    // Проверяем уникальность имени при обновлении
    if (updates.name) {
      const existing = this.categories.find(
        cat => cat.id !== id && cat.name.toLowerCase() === updates.name.toLowerCase()
      );
      if (existing) {
        throw new Error('Категория с таким названием уже существует');
      }
    }

    Object.assign(category, updates);
    category.updatedAt = new Date().toISOString();
    this.saveData();
    return category;
  }

  /**
   * Удалить категорию
   */
  deleteCategory(id) {
    const index = this.categories.findIndex(cat => cat.id === id);
    if (index === -1) {
      throw new Error('Категория не найдена');
    }

    const deleted = this.categories.splice(index, 1)[0];
    this.saveData();
    return deleted;
  }
}

export default ExpenseCategories;
