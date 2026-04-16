import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// HTTP прокси xray для доступа к Telegram API
const proxyAgent = new HttpsProxyAgent('http://127.0.0.1:1087');

// Создаём axios-инстанс с прокси для всех запросов к Telegram
const tgAxios = axios.create({
    httpsAgent: proxyAgent,
    httpAgent: proxyAgent,
    proxy: false // отключаем встроенный прокси axios, используем agent
});

class InvoiceTelegramBot {
    constructor(invoiceDb, clientsDb, warehouseDb, whatsappManager, invoiceService, paymentReminderService, recurringPaymentsDb) {
        this.invoiceDb = invoiceDb;
        this.clientsDb = clientsDb;
        this.warehouseDb = warehouseDb;
        this.whatsappManager = whatsappManager;
        this.invoiceService = invoiceService;
        this.paymentReminderService = paymentReminderService;
        this.recurringPaymentsDb = recurringPaymentsDb;
        this.config = null;
        this.userSessions = new Map();
        this.lastUpdateId = 0;

        this.loadConfig();

        if (this.config && this.config.enabled) {
            this.initBot();
            this.startPaymentReminderScheduler();
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

    // ==========================================
    // Планировщик напоминаний об оплате
    // ==========================================

    startPaymentReminderScheduler() {
        console.log('[TelegramBot] Планировщик напоминаний об оплате запущен');
        this.schedulePaymentCheck();
    }

    schedulePaymentCheck() {
        const now = new Date();
        const nextCheck = new Date();
        nextCheck.setHours(7, 0, 0, 0); // 7:00 UTC = 10:00 МСК

        if (now >= nextCheck) {
            nextCheck.setDate(nextCheck.getDate() + 1);
        }

        const delay = nextCheck - now;
        console.log(`[TelegramBot] Следующая проверка оплат: ${nextCheck.toLocaleString('ru-RU')}`);

        setTimeout(() => {
            this.checkPaymentDeadlines();
            this.schedulePaymentCheck();
        }, delay);
    }

    async checkPaymentDeadlines() {
        try {
            console.log('[TelegramBot] Проверка дедлайнов оплаты...');

            const invoices = this.invoiceDb.getAllInvoices();
            const today = new Date();
            const currentDay = today.getDate();
            const currentMonth = today.getMonth();
            const currentYear = today.getFullYear();

            // Фильтруем неоплаченные абонементские счета
            const unpaidRecurring = invoices.filter(inv => {
                if (inv.paid) return false;
                const paidAmount = inv.paidAmount || 0;
                if (paidAmount >= inv.amount) return false;
                if (!inv.isRecurring) return false;
                return true;
            });

            if (unpaidRecurring.length === 0) {
                console.log('[TelegramBot] Нет неоплаченных абонементских счетов');
                return;
            }

            const remindersToday = [];
            const reminders3days = [];

            for (const invoice of unpaidRecurring) {
                // Определяем дедлайн: из счёта или из клиента
                let deadlineDay = invoice.paymentDeadlineDay;

                if (!deadlineDay) {
                    // Ищем клиента по имени
                    const client = this.clientsDb.getClientByName(invoice.client);
                    if (client && client.paymentDay) {
                        deadlineDay = client.paymentDay;
                    }
                }

                if (!deadlineDay) continue; // Нет дедлайна — пропускаем

                // Вычисляем дату дедлайна в текущем месяце
                const deadlineDate = new Date(currentYear, currentMonth, deadlineDay);
                const diffDays = Math.ceil((deadlineDate - today) / (1000 * 60 * 60 * 24));

                const remainingAmount = invoice.amount - (invoice.paidAmount || 0);

                const info = {
                    invoiceNumber: invoice.invoiceNumber,
                    client: invoice.client,
                    amount: invoice.amount,
                    remainingAmount: remainingAmount,
                    deadlineDay: deadlineDay,
                    diffDays: diffDays
                };

                if (diffDays === 0) {
                    remindersToday.push(info);
                } else if (diffDays === 3) {
                    reminders3days.push(info);
                }
            }

            // Отправляем напоминания
            const chatId = this.config.allowedUserId;

            if (reminders3days.length > 0) {
                let msg = '🔔 <b>Напоминание: оплата через 3 дня</b>\n\n';
                let totalSum = 0;
                reminders3days.forEach(r => {
                    msg += `📄 №${r.invoiceNumber} — <b>${r.client}</b>\n`;
                    msg += `   💰 ${r.remainingAmount.toLocaleString('ru-RU')} ₽ (до ${r.deadlineDay}-го числа)\n\n`;
                    totalSum += r.remainingAmount;
                });
                msg += `💳 <b>Итого к оплате: ${totalSum.toLocaleString('ru-RU')} ₽</b>`;
                await this.sendMessage(chatId, msg);
                console.log(`[TelegramBot] Отправлено напоминание за 3 дня: ${reminders3days.length} счетов`);
            }

            if (remindersToday.length > 0) {
                let msg = '🚨 <b>СЕГОДНЯ дедлайн оплаты!</b>\n\n';
                let totalSum = 0;
                remindersToday.forEach(r => {
                    msg += `📄 №${r.invoiceNumber} — <b>${r.client}</b>\n`;
                    msg += `   💰 ${r.remainingAmount.toLocaleString('ru-RU')} ₽\n\n`;
                    totalSum += r.remainingAmount;
                });
                msg += `💳 <b>Итого к оплате: ${totalSum.toLocaleString('ru-RU')} ₽</b>`;
                await this.sendMessage(chatId, msg);
                console.log(`[TelegramBot] Отправлено напоминание на сегодня: ${remindersToday.length} счетов`);
            }

            if (reminders3days.length === 0 && remindersToday.length === 0) {
                console.log('[TelegramBot] Нет счетов с дедлайном сегодня или через 3 дня');
            }

        } catch (error) {
            console.error('[TelegramBot] Ошибка проверки дедлайнов:', error);
        }
    }

    // ==========================================
    // Telegram API методы (через прокси xray)
    // ==========================================

    async startPolling() {
        while (this.config && this.config.enabled) {
            try {
                const updates = await this.getUpdates();

                for (const update of updates) {
                    this.lastUpdateId = update.update_id + 1;
                    this.handleUpdate(update);
                }

                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
                console.error('[TelegramBot] Ошибка polling:', error.message);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }

    async getUpdates() {
        try {
            const response = await tgAxios.get(`${this.apiUrl}/getUpdates`, {
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

    async sendMessage(chatId, text, options = {}) {
        try {
            await tgAxios.post(`${this.apiUrl}/sendMessage`, {
                chat_id: chatId,
                text: text,
                parse_mode: options.parse_mode || 'HTML',
                reply_markup: options.reply_markup
            });
        } catch (error) {
            console.error('[TelegramBot] Ошибка отправки сообщения:', error.message);
        }
    }

    async editMessageText(chatId, messageId, text, options = {}) {
        try {
            await tgAxios.post(`${this.apiUrl}/editMessageText`, {
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

    async deleteMessage(chatId, messageId) {
        try {
            await tgAxios.post(`${this.apiUrl}/deleteMessage`, {
                chat_id: chatId,
                message_id: messageId
            });
        } catch (error) {
            console.error('[TelegramBot] Ошибка удаления сообщения:', error.message);
        }
    }

    async answerCallbackQuery(queryId, text = '') {
        try {
            await tgAxios.post(`${this.apiUrl}/answerCallbackQuery`, {
                callback_query_id: queryId,
                text: text
            });
        } catch (error) {
            console.error('[TelegramBot] Ошибка ответа на callback:', error.message);
        }
    }

    // ==========================================
    // Обработка обновлений и команд
    // ==========================================

    isAuthorized(userId) {
        return userId === this.config.allowedUserId;
    }

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

    handleCommand(message) {
        const chatId = message.chat.id;
        const command = message.text.split(' ')[0];

        if (command === '/start') {
            this.showMainMenu(chatId);
        } else if (command === '/payments') {
            this.checkPaymentDeadlines();
        } else if (command === '/bills') {
            this.showRecurringPaymentsStatus(chatId);
        }
    }

    showMainMenu(chatId) {
        const keyboard = {
            inline_keyboard: [
                [{ text: '🌐 Открыть веб-интерфейс', url: 'http://176.98.155.17:10801' }],
                [{ text: '➕ Создать счет', callback_data: 'create_invoice' }],
                [{ text: '📋 Список счетов', callback_data: 'list_invoices' }],
                [{ text: '💰 Неоплаченные счета', callback_data: 'unpaid_invoices' }],
                [{ text: '📊 Статистика', callback_data: 'statistics' }],
                [{ text: '🔔 Проверить дедлайны оплат', callback_data: 'check_deadlines' }],
                [{ text: '📅 Регулярные платежи', callback_data: 'recurring_payments' }]
            ]
        };

        this.sendMessage(chatId,
            '🏢 <b>Система управления счетами</b>\n\n' +
            'Выберите действие:',
            { reply_markup: keyboard }
        );
    }

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
            } else if (data === 'check_deadlines') {
                await this.answerCallbackQuery(query.id, 'Проверяю дедлайны...');
                await this.checkPaymentDeadlines();
                return;
            } else if (data === 'new_client') {
                this.startNewClientCreation(chatId, userId);
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
            } else if (data === 'recurring_payments') {
                this.showRecurringPaymentsStatus(chatId, query.message.message_id);
            } else if (data.startsWith('rp_pay_')) {
                const paymentId = data.replace('rp_pay_', '');
                await this.markRecurringPaymentPaid(chatId, paymentId, query.message.message_id);
            } else if (data.startsWith('rp_unpay_')) {
                const paymentId = data.replace('rp_unpay_', '');
                await this.markRecurringPaymentUnpaid(chatId, paymentId, query.message.message_id);
            } else if (data === 'rp_add') {
                this.startRecurringPaymentCreation(chatId, userId);
            } else if (data === 'rp_cancel_add') {
                this.userSessions.delete(userId);
                this.showRecurringPaymentsStatus(chatId, query.message.message_id);
            } else if (data === 'rp_back') {
                this.showRecurringPaymentsStatus(chatId, query.message.message_id);
            } else if (data === 'back_to_list') {
                this.showInvoicesList(chatId, query.message.message_id);
            }

            this.answerCallbackQuery(query.id);
        } catch (error) {
            console.error('[TelegramBot] Ошибка обработки callback:', error);
            this.answerCallbackQuery(query.id, '❌ Произошла ошибка');
        }
    }

    handleTextMessage(chatId, userId, message) {
        const session = this.userSessions.get(userId);

        if (!session) return;

        // Создание регулярного платежа
        if (session.state === 'rp_waiting_name') {
            session.rpData = { name: message.text.trim() };
            session.state = 'rp_waiting_description';
            this.sendMessage(chatId, `📝 Организация: <b>${session.rpData.name}</b>

Введите описание (что оплачиваем):
<i>Например: пополнить баланс +79096194444</i>

Или отправьте <b>-</b> чтобы пропустить`);
            return;
        }

        if (session.state === 'rp_waiting_description') {
            const desc = message.text.trim();
            session.rpData.description = desc === '-' ? '' : desc;
            session.state = 'rp_waiting_amount';
            this.sendMessage(chatId, `💰 Введите сумму платежа (в рублях):
<i>Например: 450</i>`);
            return;
        }

        if (session.state === 'rp_waiting_amount') {
            const amount = parseFloat(message.text.replace(/[^\d.,]/g, '').replace(',', '.'));
            if (isNaN(amount) || amount <= 0) {
                this.sendMessage(chatId, '❌ Введите корректную сумму (число больше 0)');
                return;
            }
            session.rpData.amount = amount;
            session.state = 'rp_waiting_day';
            this.sendMessage(chatId, `📅 Введите день месяца для оплаты (1-31):
<i>Например: 13</i>`);
            return;
        }

        if (session.state === 'rp_waiting_day') {
            const day = parseInt(message.text.trim());
            if (isNaN(day) || day < 1 || day > 31) {
                this.sendMessage(chatId, '❌ Введите число от 1 до 31');
                return;
            }
            session.rpData.dayOfMonth = day;

            // Сохраняем платеж
            try {
                const payment = this.recurringPaymentsDb.addPayment(session.rpData);
                this.userSessions.delete(userId);

                const desc = payment.description ? '\n📝 ' + payment.description : '';
                this.sendMessage(chatId, `✅ <b>Платеж добавлен!</b>

🏢 ${payment.name}${desc}
💰 ${payment.amount.toLocaleString('ru-RU')} ₽
📅 До ${payment.dayOfMonth}-го числа каждого месяца`, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '➕ Добавить ещё', callback_data: 'rp_add' }],
                            [{ text: '📅 Все платежи', callback_data: 'recurring_payments' }],
                            [{ text: '◀ Главное меню', callback_data: 'main_menu' }]
                        ]
                    }
                });
            } catch (e) {
                this.sendMessage(chatId, '❌ Ошибка: ' + e.message);
                this.userSessions.delete(userId);
            }
            return;
        }

        if (session.state === 'waiting_client_name') {
            session.newClient = { name: message.text.trim() };
            session.state = 'waiting_client_phone';
            this.sendMessage(chatId, `👤 Клиент: <b>${session.newClient.name}</b>

📱 Введите номер телефона (WhatsApp):`);
            return;
        }

        if (session.state === 'waiting_client_phone') {
            const phone = message.text.trim();
            const newClient = this.clientsDb.addClient({
                name: session.newClient.name,
                phone: phone
            });
            session.client = newClient;
            session.state = 'adding_items';
            delete session.newClient;

            this.sendMessage(chatId, `✅ Клиент <b>${newClient.name}</b> создан!
📱 Телефон: ${newClient.phone}

Теперь добавьте товары/услуги:`);
            this.showProductSelection(chatId, userId);
            return;
        }

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

    // ==========================================
    // Создание счёта
    // ==========================================

    startInvoiceCreation(chatId, userId) {
        this.userSessions.set(userId, {
            state: 'selecting_client',
            client: null,
            items: []
        });

        this.showClientSelection(chatId);
    }

    startNewClientCreation(chatId, userId) {
        const session = this.userSessions.get(userId);
        if (!session) {
            this.userSessions.set(userId, {
                state: 'waiting_client_name',
                client: null,
                items: []
            });
        } else {
            session.state = 'waiting_client_name';
        }

        this.sendMessage(chatId, '👤 Введите название компании или ФИО клиента:');
    }

    showClientSelection(chatId) {
        const clients = this.clientsDb.getAllClients();

        // Даже если клиентов нет, показываем кнопку создания нового

        const keyboard = {
            inline_keyboard: []
        };

        // Кнопка создания нового клиента — всегда сверху
        keyboard.inline_keyboard.push([
            { text: '➕ Создать нового клиента', callback_data: 'new_client' }
        ]);

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

    selectClient(chatId, userId, clientId) {
        const session = this.userSessions.get(userId);
        if (!session) return;

        const client = this.clientsDb.getClientById(clientId);
        if (!client) {
            this.sendMessage(chatId, '❌ Клиент не найден');
            return;
        }

        session.client = client;
        session.state = 'adding_items';

        this.sendMessage(chatId, `✅ Клиент: ${client.name}\n\nТеперь добавьте товары/услуги:`);
        this.showProductSelection(chatId, userId);
    }

    showProductSelection(chatId, userId) {
        const products = this.warehouseDb.getAllProducts();
        const session = this.userSessions.get(userId);

        if (products.length === 0) {
            this.sendMessage(chatId, '❌ Товары не найдены. Добавьте товары через веб-интерфейс.');
            return;
        }

        const keyboard = {
            inline_keyboard: []
        };

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

    addProductToInvoice(chatId, userId, productId) {
        const session = this.userSessions.get(userId);
        if (!session) return;

        const product = this.warehouseDb.getProductById(productId);
        if (!product) {
            this.sendMessage(chatId, '❌ Товар не найден');
            return;
        }

        session.items.push({
            name: product.name,
            unit: product.unit || 'шт',
            price: product.sellingPrice || 0,
            quantity: 1
        });

        session.state = 'waiting_quantity';

        this.sendMessage(chatId,
            `➕ Добавлен: <b>${product.name}</b>\n\n` +
            `Введите количество (${product.unit || 'шт'}):`
        );
    }

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

            const invoice = this.invoiceDb.createInvoice({
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

    cancelInvoiceCreation(chatId, userId) {
        this.userSessions.delete(userId);
        this.sendMessage(chatId, '❌ Создание счета отменено');
        this.showMainMenu(chatId);
    }

    // ==========================================
    // Просмотр счетов
    // ==========================================

    showInvoicesList(chatId, messageId = null) {
        const invoices = this.invoiceDb.getAllInvoices();

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

    showUnpaidInvoices(chatId, messageId = null) {
        const invoices = this.invoiceDb.getAllInvoices();
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

    showInvoiceDetails(chatId, invoiceId, messageId = null) {
        const invoice = this.invoiceDb.getInvoiceById(invoiceId);

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

        const invoiceDate = invoice.invoiceDate || invoice.createdAt;
        message += `📅 Дата: ${new Date(invoiceDate).toLocaleDateString('ru-RU')}\n`;
        message += `📊 Статус: ${isFullyPaid ? '✅ Оплачен' : isPartiallyPaid ? '⚠️ Частично оплачен' : '❌ Не оплачен'}\n`;

        if (invoice.paymentDeadlineDay) {
            message += `⏰ Дедлайн оплаты: до ${invoice.paymentDeadlineDay}-го числа\n`;
        }

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

    async markInvoiceAsPaid(chatId, invoiceId) {
        try {
            const invoice = this.invoiceDb.getInvoiceById(invoiceId);

            if (!invoice) {
                this.sendMessage(chatId, '❌ Счет не найден');
                return;
            }

            this.invoiceDb.updateInvoice(invoiceId, {
                paid: true,
                paidAmount: invoice.amount
            });

            this.sendMessage(chatId,
                `✅ Счет №${invoice.invoiceNumber} отмечен как оплаченный!`
            );

            setTimeout(() => {
                this.showInvoiceDetails(chatId, invoiceId);
            }, 1000);

        } catch (error) {
            console.error('[TelegramBot] Ошибка отметки оплаты:', error);
            this.sendMessage(chatId, '❌ Ошибка при обновлении счета');
        }
    }

    async sendInvoiceToWhatsApp(chatId, invoiceId) {
        try {
            const invoice = this.invoiceDb.getInvoiceById(invoiceId);

            if (!invoice) {
                this.sendMessage(chatId, '❌ Счет не найден');
                return;
            }

            this.sendMessage(chatId, '⏳ Генерирую PDF и отправляю в WhatsApp...');

            const pdfPath = await this.invoiceService.generateInvoicePDF(invoice);

            const settingsPath = path.join(__dirname, '..', 'data', 'whatsapp-settings.json');
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

            const message = settings.greeting
                .replace(/{номер}/g, invoice.invoiceNumber)
                .replace(/{клиент}/g, invoice.client)
                .replace(/{сумма}/g, invoice.amount.toLocaleString('ru-RU'))
                .replace(/{дата}/g, new Date(invoice.invoiceDate || invoice.createdAt).toLocaleDateString('ru-RU'));

            const result = await this.whatsappManager.sendMessageWithFile(
                invoice.clientPhone,
                message,
                pdfPath
            );

            if (result.success) {
                this.invoiceDb.updateInvoice(invoiceId, {
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

    showStatistics(chatId, messageId = null) {
        const invoices = this.invoiceDb.getAllInvoices();

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
    // ==========================================
    // Регулярные платежи
    // ==========================================

    startRecurringPaymentCreation(chatId, userId) {
        this.userSessions.set(userId, {
            state: 'rp_waiting_name',
            rpData: {}
        });

        this.sendMessage(chatId, `➕ <b>Добавление регулярного платежа</b>

Введите название организации:
<i>Например: МТС, Ростелеком, Аренда офиса</i>`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '❌ Отмена', callback_data: 'rp_cancel_add' }]
                ]
            }
        });
    }

    async showRecurringPaymentsStatus(chatId, messageId = null) {
        if (!this.recurringPaymentsDb) {
            this.sendMessage(chatId, '❌ Сервис регулярных платежей не инициализирован');
            return;
        }

        const status = this.recurringPaymentsDb.getMonthStatus();
        const monthNames = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
        const now = new Date();
        const monthLabel = monthNames[now.getMonth()] + ' ' + now.getFullYear();
        const today = now.getDate();

        if (status.length === 0) {
            const text = '📅 <b>Регулярные платежи</b>\n\nНет добавленных платежей. Добавьте через веб-интерфейс.';
            const kb = { inline_keyboard: [[{ text: '◀ Главное меню', callback_data: 'main_menu' }]] };
            if (messageId) {
                this.editMessageText(chatId, messageId, text, { reply_markup: kb });
            } else {
                this.sendMessage(chatId, text, { reply_markup: kb });
            }
            return;
        }

        const active = status.filter(p => p.active);
        const paid = active.filter(p => p.paid);
        const unpaid = active.filter(p => !p.paid);
        const totalDue = unpaid.reduce((s, p) => s + p.amount, 0);

        let text = '📅 <b>Регулярные платежи — ' + monthLabel + '</b>\n';
        text += '━━━━━━━━━━━━━━━━━━━━━\n';
        text += '✅ Оплачено: ' + paid.length + ' / ' + active.length + '\n';
        if (unpaid.length > 0) {
            text += '💰 К оплате: ' + totalDue.toLocaleString('ru-RU') + ' ₽\n';
        }
        text += '━━━━━━━━━━━━━━━━━━━━━\n\n';

        const buttons = [];

        for (const p of active) {
            const isOverdue = !p.paid && p.dayOfMonth < today;
            if (p.paid) {
                text += '✅ <s>' + p.name + '</s> — ' + p.amount.toLocaleString('ru-RU') + ' ₽\n';
                if (p.description) text += '   <i>' + p.description + '</i>\n';
                buttons.push([{ text: '↩ Отменить: ' + p.name, callback_data: 'rp_unpay_' + p.id }]);
            } else {
                const icon = isOverdue ? '🔴' : '🔵';
                text += icon + ' <b>' + p.name + '</b> — ' + p.amount.toLocaleString('ru-RU') + ' ₽ (до ' + p.dayOfMonth + '-го)\n';
                if (p.description) text += '   <i>' + p.description + '</i>\n';
                if (isOverdue) text += '   ⚠️ <b>Просрочено!</b>\n';
                buttons.push([{ text: '✅ Оплатил: ' + p.name, callback_data: 'rp_pay_' + p.id }]);
            }
            text += '\n';
        }

        buttons.push([{ text: '➕ Добавить платеж', callback_data: 'rp_add' }]);
        buttons.push([{ text: '◀ Главное меню', callback_data: 'main_menu' }]);
        const kb = { inline_keyboard: buttons };

        if (messageId) {
            this.editMessageText(chatId, messageId, text, { reply_markup: kb });
        } else {
            this.sendMessage(chatId, text, { reply_markup: kb });
        }
    }

    async markRecurringPaymentPaid(chatId, paymentId, messageId) {
        try {
            this.recurringPaymentsDb.markAsPaid(paymentId, 'telegram');
            await this.answerCallbackQuery(null, '✅ Отмечено как оплаченное');
        } catch (e) {
            console.error('[TelegramBot] Ошибка отметки оплаты:', e.message);
        }
        this.showRecurringPaymentsStatus(chatId, messageId);
    }

    async markRecurringPaymentUnpaid(chatId, paymentId, messageId) {
        try {
            this.recurringPaymentsDb.markAsUnpaid(paymentId);
        } catch (e) {
            console.error('[TelegramBot] Ошибка снятия оплаты:', e.message);
        }
        this.showRecurringPaymentsStatus(chatId, messageId);
    }

}

export default InvoiceTelegramBot;
