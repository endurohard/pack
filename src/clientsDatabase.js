import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, '../data/clients.json');

/**
 * База данных для хранения информации о клиентах
 */
class ClientsDatabase {
  constructor() {
    this.ensureDataDir();
    this.loadData();
  }

  ensureDataDir() {
    const dataDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  loadData() {
    if (fs.existsSync(DB_PATH)) {
      const data = fs.readFileSync(DB_PATH, 'utf-8');
      this.clients = JSON.parse(data);
    } else {
      this.clients = [];
      this.saveData();
    }
  }

  saveData() {
    fs.writeFileSync(DB_PATH, JSON.stringify(this.clients, null, 2), 'utf-8');
  }

  /**
   * Добавить нового клиента
   */
  addClient(clientData) {
    const client = {
      id: Date.now().toString(),
      name: clientData.name,
      phone: clientData.phone || '',
      email: clientData.email || '',
      address: clientData.address || '',
      notes: clientData.notes || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.clients.push(client);
    this.saveData();
    return client;
  }

  /**
   * Получить всех клиентов
   */
  getAllClients() {
    return this.clients.sort((a, b) =>
      a.name.localeCompare(b.name, 'ru')
    );
  }

  /**
   * Получить клиента по ID
   */
  getClientById(id) {
    return this.clients.find(client => client.id === id);
  }

  /**
   * Получить клиента по имени
   */
  getClientByName(name) {
    return this.clients.find(client =>
      client.name.toLowerCase() === name.toLowerCase()
    );
  }

  /**
   * Обновить клиента
   */
  updateClient(id, updates) {
    const client = this.getClientById(id);
    if (client) {
      Object.assign(client, updates);
      client.updatedAt = new Date().toISOString();
      this.saveData();
      return client;
    }
    return null;
  }

  /**
   * Удалить клиента
   */
  deleteClient(id) {
    const index = this.clients.findIndex(client => client.id === id);
    if (index !== -1) {
      const deleted = this.clients.splice(index, 1)[0];
      this.saveData();
      return deleted;
    }
    return null;
  }

  /**
   * Поиск клиентов
   */
  searchClients(query) {
    const searchQuery = query.toLowerCase();
    return this.clients.filter(client =>
      client.name.toLowerCase().includes(searchQuery) ||
      client.phone.includes(searchQuery) ||
      (client.email && client.email.toLowerCase().includes(searchQuery))
    );
  }
}

export default ClientsDatabase;
