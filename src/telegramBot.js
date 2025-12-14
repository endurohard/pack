import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class InvoiceTelegramBot {
    constructor(db, whatsappManager, pdfGenerator) {
        this.db = db;
        this.whatsappManager = whatsappManager;
        this.pdfGenerator = pdfGenerator;
        this.config = null;
        this.userSessions = new Map(); // Для хранения состояния диалогов
        this.lastUpdateId = 0;

        this.loadConfig();

        if (this.config && this.config.enabled) {
            this.initBot();
        }
    }

    loadConfig() {
        try {
            const configPath = path.join(__dirname, '..', 'telegram-config.json');
            if (fs.existsSync(configPath)) {
                this.config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                console.log('[TelegramBot] Конфигурация загружена');
            } else {
                console.log('[TelegramBot] Конфигурационный файл не найден');
            }
        } catch (error) {
            console.error('[TelegramBot] Ошибка загрузки конфигурации:', error);
        }
    }

    initBot() {
        try {
            this.apiUrl = `https://api.telegram.org/bot${this.config.botToken}`;
            this.startPolling();
            console.log('[TelegramBot] Бот успешно запущен');
        } catch (error) {
            console.error('[TelegramBot] Ошибка инициализации бота:', error);
        }
    }

    // Запуск long polling
    async startPolling() {
        while (this.config && this.config.enabled) {
            try {
                const updates = await this.getUpdates();

                for (const update of updates) {
                    this.lastUpdateId = update.update_id + 1;
                    this.handleUpdate(update);
                }

                // Небольшая задержка между запросами
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
                console.error('[TelegramBot] Ошибка polling:', error.message);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }

    // Получение обновлений
    async getUpdates() {
        try {
            const response = await axios.get(`${this.apiUrl}/getUpdates`, {
                params: {
                    offset: this.lastUpdateId,
                    timeout: 30
                }
            });

            if (response.data.ok) {
                return response.data.result;
            }
            return [];
        } catch (error) {
            console.error('[TelegramBot] Ошибка getUpdates:', error.message);
            return [];
        }
    }

    // Отправка сообщения
    async sendMessage(chatId, text, options = {}) {
        try {
            await axios.post(`${this.apiUrl}/sendMessage`, {
                chat_id: chatId,
                text: text,
                parse_mode: options.parse_mode || 'HTML',
                reply_markup: options.reply_markup
            });
        } catch (error) {
            console.error('[TelegramBot] Ошибка отправки сообщения:', error.message);
        }
    }

    // Редактирование сообщения
    async editMessageText(chatId, messageId, text, options = {}) {
        try {
            await axios.post(`${this.apiUrl}/editMessageText`, {
                chat_id: chatId,
                message_id: messageId,
                text: text,
                parse_mode: options.parse_mode || 'HTML',
                reply_markup: options.reply_markup
            });
        } catch (error) {
            console.error('[TelegramBot] Ошибка редактирования сообщения:', error.message);
        }
    }

    // Удаление сообщения
    async deleteMessage(chatId, messageId) {
        try {
            await axios.post(`${this.apiUrl}/deleteMessage`, {
                chat_id: chatId,
                message_id: messageId
            });
        } catch (error) {
            console.error('[TelegramBot] Ошибка удаления сообщения:', error.message);
        }
    }

    // Ответ на callback query
    async answerCallbackQuery(queryId, text = '') {
        try {
            await axios.post(`${this.apiUrl}/answerCallbackQuery`, {
                callback_query_id: queryId,
                text: text
            });
        } catch (error) {
            console.error('[TelegramBot] Ошибка ответа на callback:', error.message);
        }
    }

    // Проверка авторизации
    isAuthorized(userId) {
        return userId === this.config.allowedUserId;
    }

    // Обработка обновлений
    handleUpdate(update) {
        if (update.message) {
            const chatId = update.message.chat.id;
            const userId = update.message.from.id;

            if (!this.isAuthorized(userId)) {
                this.sendMessage(chatId, '❌ У вас нет доступа к этому боту.');
                return;
            }

            if (update.message.text) {
                if (update.message.text.startsWith('/')) {
                    this.handleCommand(update.message);
                } else {
                    this.handleTextMessage(chatId, userId, update.message);
                }
            }
        } else if (update.callback_query) {
            const chatId = update.callback_query.message.chat.id;
            const userId = update.callback_query.from.id;

            if (!this.isAuthorized(userId)) {
                this.answerCallbackQuery(update.callback_query.id, '❌ Нет доступа');
                return;
            }

            this.handleCallback(chatId, userId, update.callback_query);
        }
    }

    // Обработка команд
    handleCommand(message) {
        const chatId = message.chat.id;
        const command = message.text.split(' ')[0];

        if (command === '/start') {
            this.showMainMenu(chatId);
        }
    }

    // Главное меню
    showMainMenu(chatId) {
        const keyboard = {
            inline_keyboard: [
                [{ text: '➕ Создать счет', callback_data: 'create_invoice' }],
                [{ text: '📋 Список счетов', callback_data: 'list_invoices' }],
                [{ text: '💰 Неоплаченные счета', callback_data: 'unpaid_invoices' }],
                [{ text: '📊 Статистика', callback_data: 'statistics' }]
            ]
        };

        this.sendMessage(chatId,
            '🏢 <b>Система управления счетами</b>\n\n' +
            'Выберите действие:',
            { reply_markup: keyboard }
        );
    }

    // Обработка callback-запросов
    async handleCallback(chatId, userId, query) {
        const data = query.data;

        try {
            if (data === 'main_menu') {
                await this.deleteMessage(chatId, query.message.message_id);
                this.showMainMenu(chatId);
            } else if (data === 'create_invoice') {
                this.startInvoiceCreation(chatId, userId);
            } else if (data === 'list_invoices') {
                this.showInvoicesList(chatId, query.message.message_id);
            } else if (data === 'unpaid_invoices') {
                this.showUnpaidInvoices(chatId, query.message.message_id);
            } else if (data === 'statistics') {
                this.showStatistics(chatId, query.message.message_id);
            } else if (data.startsWith('select_client_')) {
                const clientId = data.replace('select_client_', '');
                this.selectClient(chatId, userId, clientId);
            } else if (data.startsWith('select_product_')) {
                const productId = data.replace('select_product_', '');
                this.addProductToInvoice(chatId, userId, productId);
            } else if (data === 'finish_invoice') {
                await this.finishInvoiceCreation(chatId, userId);
            } else if (data === 'cancel_invoice') {
                this.cancelInvoiceCreation(chatId, userId);
            } else if (data.startsWith('invoice_')) {
                const invoiceId = data.replace('invoice_', '');
                this.showInvoiceDetails(chatId, invoiceId, query.message.message_id);
            } else if (data.startsWith('pay_')) {
                const invoiceId = data.replace('pay_', '');
                await this.markInvoiceAsPaid(chatId, invoiceId);
            } else if (data.startsWith('send_')) {
                const invoiceId = data.replace('send_', '');
                await this.sendInvoiceToWhatsApp(chatId, invoiceId);
            } else if (data === 'back_to_list') {
                this.showInvoicesList(chatId, query.message.message_id);
            }

            this.answerCallbackQuery(query.id);
        } catch (error) {
            console.error('[TelegramBot] Ошибка обработки callback:', error);
            this.answerCallbackQuery(query.id, '❌ Произошла ошибка');
        }
    }

    // Обработка текстовых сообщений
    handleTextMessage(chatId, userId, message) {
        const session = this.userSessions.get(userId);

        if (!session) return;

        if (session.state === 'waiting_quantity') {
            const quantity = parseFloat(message.text);

            if (isNaN(quantity) || quantity <= 0) {
                this.sendMessage(chatId, '❌ Введите корректное количество (число больше 0)');
                return;
            }

            session.items[session.items.length - 1].quantity = quantity;
            session.state = 'adding_items';

            this.showProductSelection(chatId, userId);
        }
    }

    // Начало создания счета
    startInvoiceCreation(chatId, userId) {
        this.userSessions.set(userId, {
            state: 'selecting_client',
            client: null,
            items: []
        });

        this.showClientSelection(chatId);
    }

    // Показать список клиентов
    showClientSelection(chatId) {
        const clients = this.db.getClients();

        if (clients.length === 0) {
            this.sendMessage(chatId, '❌ Клиенты не найдены. Добавьте клиента через веб-интерфейс.');
            return;
        }

        const keyboard = {
            inline_keyboard: []
        };

        // Показываем первых 20 клиентов
        clients.slice(0, 20).forEach(client => {
            keyboard.inline_keyboard.push([{
                text: `${client.name} (${client.phone})`,
                callback_data: `select_client_${client.id}`
            }]);
        });

        keyboard.inline_keyboard.push([
            { text: '❌ Отмена', callback_data: 'cancel_invoice' }
        ]);

        this.sendMessage(chatId,
            '👤 <b>Выберите клиента:</b>',
            { reply_markup: keyboard }
        );
    }

    // Выбор клиента
    selectClient(chatId, userId, clientId) {
        const session = this.userSessions.get(userId);
        if (!session) return;

        const client = this.db.getClientById(clientId);
        if (!client) {
            this.sendMessage(chatId, '❌ Клиент не найден');
            return;
        }

        session.client = client;
        session.state = 'adding_items';

        this.sendMessage(chatId, `✅ Клиент: ${client.name}\n\nТеперь добавьте товары/услуги:`);
        this.showProductSelection(chatId, userId);
    }

    // Показать список товаров
    showProductSelection(chatId, userId) {
        const products = this.db.getAllProducts();
        const session = this.userSessions.get(userId);

        if (products.length === 0) {
            this.sendMessage(chatId, '❌ Товары не найдены. Добавьте товары через веб-интерфейс.');
            return;
        }

        const keyboard = {
            inline_keyboard: []
        };

        // Показываем первые 15 товаров
        products.slice(0, 15).forEach(product => {
            const price = product.sellingPrice || 0;
            keyboard.inline_keyboard.push([{
                text: `${product.name} - ${price.toLocaleString('ru-RU')} ₽`,
                callback_data: `select_product_${product.id}`
            }]);
        });

        if (session.items.length > 0) {
            keyboard.inline_keyboard.push([
                { text: '✅ Завершить создание счета', callback_data: 'finish_invoice' }
            ]);
        }

        keyboard.inline_keyboard.push([
            { text: '❌ Отмена', callback_data: 'cancel_invoice' }
        ]);

        let message = '📦 <b>Выберите товар/услугу:</b>';

        if (session.items.length > 0) {
            message += '\n\n<b>Добавлено:</b>\n';
            session.items.forEach((item, index) => {
                const total = item.price * item.quantity;
                message += `${index + 1}. ${item.name} - ${item.quantity} ${item.unit} × ${item.price} ₽ = ${total.toLocaleString('ru-RU')} ₽\n`;
            });
        }

        this.sendMessage(chatId, message, { reply_markup: keyboard });
    }

    // Добавление товара в счет
    addProductToInvoice(chatId, userId, productId) {
        const session = this.userSessions.get(userId);
        if (!session) return;

        const product = this.db.getProductById(productId);
        if (!product) {
            this.sendMessage(chatId, '❌ Товар не найден');
            return;
        }

        session.items.push({
            name: product.name,
            unit: product.unit || 'шт',
            price: product.sellingPrice || 0,
            quantity: 1 // По умолчанию
        });

        session.state = 'waiting_quantity';

        this.sendMessage(chatId,
            `➕ Добавлен: <b>${product.name}</b>\n\n` +
            `Введите количество (${product.unit || 'шт'}):`
        );
    }

    // Завершение создания счета
    async finishInvoiceCreation(chatId, userId) {
        const session = this.userSessions.get(userId);
        if (!session || !session.client || session.items.length === 0) {
            this.sendMessage(chatId, '❌ Недостаточно данных для создания счета');
            return;
        }

        try {
            const totalAmount = session.items.reduce((sum, item) =>
                sum + (item.price * item.quantity), 0
            );

            const invoice = this.db.createInvoice({
                client: session.client.name,
                clientPhone: session.client.phone,
                amount: totalAmount,
                items: session.items,
                autoSend: false,
                paid: false,
                paidAmount: 0
            });

            this.userSessions.delete(userId);

            const keyboard = {
                inline_keyboard: [
                    [{ text: '📤 Отправить в WhatsApp', callback_data: `send_${invoice.id}` }],
                    [{ text: '💰 Отметить как оплаченный', callback_data: `pay_${invoice.id}` }],
                    [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                ]
            };

            let message = `✅ <b>Счет №${invoice.invoiceNumber} создан!</b>\n\n`;
            message += `👤 Клиент: ${session.client.name}\n`;
            message += `📞 Телефон: ${session.client.phone}\n`;
            message += `💰 Сумма: ${totalAmount.toLocaleString('ru-RU')} ₽\n\n`;
            message += `<b>Позиции:</b>\n`;

            session.items.forEach((item, index) => {
                const total = item.price * item.quantity;
                message += `${index + 1}. ${item.name} - ${item.quantity} ${item.unit} × ${item.price} ₽ = ${total.toLocaleString('ru-RU')} ₽\n`;
            });

            this.sendMessage(chatId, message, { reply_markup: keyboard });

        } catch (error) {
            console.error('[TelegramBot] Ошибка создания счета:', error);
            this.sendMessage(chatId, '❌ Ошибка при создании счета');
        }
    }

    // Отмена создания счета
    cancelInvoiceCreation(chatId, userId) {
        this.userSessions.delete(userId);
        this.sendMessage(chatId, '❌ Создание счета отменено');
        this.showMainMenu(chatId);
    }

    // Показать список счетов
    showInvoicesList(chatId, messageId = null) {
        const invoices = this.db.getInvoices();

        if (invoices.length === 0) {
            const msg = '📋 Счета не найдены';
            if (messageId) {
                this.editMessageText(chatId, messageId, msg);
            } else {
                this.sendMessage(chatId, msg);
            }
            return;
        }

        const keyboard = {
            inline_keyboard: []
        };

        // Показываем последние 10 счетов
        invoices.slice(-10).reverse().forEach(invoice => {
            const status = invoice.paid ? '✅' : '❌';
            const paidAmount = invoice.paidAmount || 0;
            const isPartial = !invoice.paid && paidAmount > 0;
            const statusIcon = isPartial ? '⚠️' : status;

            keyboard.inline_keyboard.push([{
                text: `${statusIcon} №${invoice.invoiceNumber} - ${invoice.client} - ${invoice.amount.toLocaleString('ru-RU')} ₽`,
                callback_data: `invoice_${invoice.id}`
            }]);
        });

        keyboard.inline_keyboard.push([
            { text: '🏠 Главное меню', callback_data: 'main_menu' }
        ]);

        const msg = '📋 <b>Последние счета:</b>\n\n✅ - Оплачен\n⚠️ - Частично\n❌ - Не оплачен';

        if (messageId) {
            this.editMessageText(chatId, messageId, msg, { reply_markup: keyboard });
        } else {
            this.sendMessage(chatId, msg, { reply_markup: keyboard });
        }
    }

    // Показать неоплаченные счета
    showUnpaidInvoices(chatId, messageId = null) {
        const invoices = this.db.getInvoices();
        const unpaid = invoices.filter(inv => {
            const paidAmount = inv.paidAmount || 0;
            return !inv.paid && paidAmount === 0;
        });

        if (unpaid.length === 0) {
            const msg = '✅ Все счета оплачены!';
            if (messageId) {
                this.editMessageText(chatId, messageId, msg);
            } else {
                this.sendMessage(chatId, msg);
            }
            return;
        }

        const keyboard = {
            inline_keyboard: []
        };

        unpaid.slice(0, 10).forEach(invoice => {
            keyboard.inline_keyboard.push([{
                text: `№${invoice.invoiceNumber} - ${invoice.client} - ${invoice.amount.toLocaleString('ru-RU')} ₽`,
                callback_data: `invoice_${invoice.id}`
            }]);
        });

        keyboard.inline_keyboard.push([
            { text: '🏠 Главное меню', callback_data: 'main_menu' }
        ]);

        const msg = `💰 <b>Неоплаченные счета (${unpaid.length}):</b>`;

        if (messageId) {
            this.editMessageText(chatId, messageId, msg, { reply_markup: keyboard });
        } else {
            this.sendMessage(chatId, msg, { reply_markup: keyboard });
        }
    }

    // Показать детали счета
    showInvoiceDetails(chatId, invoiceId, messageId = null) {
        const invoice = this.db.getInvoiceById(invoiceId);

        if (!invoice) {
            this.sendMessage(chatId, '❌ Счет не найден');
            return;
        }

        const paidAmount = invoice.paidAmount || 0;
        const isFullyPaid = invoice.paid || (paidAmount >= invoice.amount);
        const isPartiallyPaid = !invoice.paid && paidAmount > 0 && paidAmount < invoice.amount;

        let message = `📄 <b>Счет №${invoice.invoiceNumber}</b>\n\n`;
        message += `👤 Клиент: ${invoice.client}\n`;
        message += `📞 Телефон: ${invoice.clientPhone}\n`;
        message += `💰 Сумма: ${invoice.amount.toLocaleString('ru-RU')} ₽\n`;

        if (isPartiallyPaid) {
            message += `💵 Оплачено: ${paidAmount.toLocaleString('ru-RU')} ₽\n`;
            message += `💸 Осталось: ${(invoice.amount - paidAmount).toLocaleString('ru-RU')} ₽\n`;
        }

        message += `📅 Дата: ${new Date(invoice.date).toLocaleDateString('ru-RU')}\n`;
        message += `📊 Статус: ${isFullyPaid ? '✅ Оплачен' : isPartiallyPaid ? '⚠️ Частично оплачен' : '❌ Не оплачен'}\n`;

        if (invoice.items && invoice.items.length > 0) {
            message += `\n<b>Позиции:</b>\n`;
            invoice.items.forEach((item, index) => {
                const total = item.price * item.quantity;
                message += `${index + 1}. ${item.name} - ${item.quantity} ${item.unit} × ${item.price} ₽ = ${total.toLocaleString('ru-RU')} ₽\n`;
            });
        }

        const keyboard = {
            inline_keyboard: []
        };

        if (!isFullyPaid) {
            keyboard.inline_keyboard.push([
                { text: '💰 Отметить как оплаченный', callback_data: `pay_${invoice.id}` }
            ]);
        }

        keyboard.inline_keyboard.push([
            { text: '📤 Отправить в WhatsApp', callback_data: `send_${invoice.id}` }
        ]);

        keyboard.inline_keyboard.push([
            { text: '◀️ Назад к списку', callback_data: 'back_to_list' },
            { text: '🏠 Главное меню', callback_data: 'main_menu' }
        ]);

        if (messageId) {
            this.editMessageText(chatId, messageId, message, { reply_markup: keyboard });
        } else {
            this.sendMessage(chatId, message, { reply_markup: keyboard });
        }
    }

    // Отметить счет как оплаченный
    async markInvoiceAsPaid(chatId, invoiceId) {
        try {
            const invoice = this.db.getInvoiceById(invoiceId);

            if (!invoice) {
                this.sendMessage(chatId, '❌ Счет не найден');
                return;
            }

            this.db.updateInvoice(invoiceId, {
                paid: true,
                paidAmount: invoice.amount
            });

            this.sendMessage(chatId,
                `✅ Счет №${invoice.invoiceNumber} отмечен как оплаченный!`
            );

            // Обновляем отображение деталей счета
            setTimeout(() => {
                this.showInvoiceDetails(chatId, invoiceId);
            }, 1000);

        } catch (error) {
            console.error('[TelegramBot] Ошибка отметки оплаты:', error);
            this.sendMessage(chatId, '❌ Ошибка при обновлении счета');
        }
    }

    // Отправить счет в WhatsApp
    async sendInvoiceToWhatsApp(chatId, invoiceId) {
        try {
            const invoice = this.db.getInvoiceById(invoiceId);

            if (!invoice) {
                this.sendMessage(chatId, '❌ Счет не найден');
                return;
            }

            this.sendMessage(chatId, '⏳ Генерирую PDF и отправляю в WhatsApp...');

            // Генерируем PDF
            const pdfPath = await this.pdfGenerator.generateInvoicePDF(invoice);

            // Отправляем через WhatsApp
            const settingsPath = path.join(__dirname, '..', 'data', 'whatsapp-settings.json');
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

            const message = settings.greeting
                .replace(/{номер}/g, invoice.invoiceNumber)
                .replace(/{клиент}/g, invoice.client)
                .replace(/{сумма}/g, invoice.amount.toLocaleString('ru-RU'))
                .replace(/{дата}/g, new Date(invoice.date).toLocaleDateString('ru-RU'));

            const result = await this.whatsappManager.sendMessageWithFile(
                invoice.clientPhone,
                message,
                pdfPath
            );

            if (result.success) {
                // Обновляем дату отправки
                this.db.updateInvoice(invoiceId, {
                    lastWhatsAppSent: new Date().toISOString()
                });

                this.sendMessage(chatId,
                    `✅ Счет №${invoice.invoiceNumber} успешно отправлен в WhatsApp!\n` +
                    `📞 Клиент: ${invoice.client} (${invoice.clientPhone})`
                );
            } else {
                this.sendMessage(chatId,
                    `❌ Ошибка отправки в WhatsApp:\n${result.error}`
                );
            }

        } catch (error) {
            console.error('[TelegramBot] Ошибка отправки в WhatsApp:', error);
            this.sendMessage(chatId, '❌ Ошибка при отправке счета');
        }
    }

    // Показать статистику
    showStatistics(chatId, messageId = null) {
        const invoices = this.db.getInvoices();

        const totalCount = invoices.length;
        const paidCount = invoices.filter(inv => {
            if (inv.paid) return true;
            const paidAmount = inv.paidAmount || 0;
            return paidAmount >= inv.amount;
        }).length;

        const partialCount = invoices.filter(inv => {
            if (inv.paid) return false;
            const paidAmount = inv.paidAmount || 0;
            return paidAmount > 0 && paidAmount < inv.amount;
        }).length;

        const unpaidCount = invoices.filter(inv => {
            if (inv.paid) return false;
            const paidAmount = inv.paidAmount || 0;
            return paidAmount === 0;
        }).length;

        const totalAmount = invoices.reduce((sum, inv) => sum + inv.amount, 0);
        const paidAmount = invoices.reduce((sum, inv) => {
            if (inv.paid) return sum + inv.amount;
            const paid = inv.paidAmount || 0;
            return sum + paid;
        }, 0);

        let message = '📊 <b>Статистика счетов:</b>\n\n';
        message += `📋 Всего счетов: ${totalCount}\n`;
        message += `✅ Оплачено: ${paidCount}\n`;
        message += `⚠️ Частично: ${partialCount}\n`;
        message += `❌ Не оплачено: ${unpaidCount}\n\n`;
        message += `💰 Общая сумма: ${totalAmount.toLocaleString('ru-RU')} ₽\n`;
        message += `💵 Оплачено: ${paidAmount.toLocaleString('ru-RU')} ₽\n`;
        message += `💸 Осталось: ${(totalAmount - paidAmount).toLocaleString('ru-RU')} ₽`;

        const keyboard = {
            inline_keyboard: [
                [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
            ]
        };

        if (messageId) {
            this.editMessageText(chatId, messageId, message, { reply_markup: keyboard });
        } else {
            this.sendMessage(chatId, message, { reply_markup: keyboard });
        }
    }
}

export default InvoiceTelegramBot;
