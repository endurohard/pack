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
        this.listFilters = new Map(); // chatId -> { status, monthIdx, page }
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
        } else if (command === '/cancel') {
            this.userSessions.delete(message.from.id);
            this.sendMessage(chatId, '❌ Действие отменено.');
        }
    }

    showMainMenu(chatId) {
        const keyboard = {
            inline_keyboard: [
                [{ text: '🌐 Открыть веб-интерфейс', url: 'http://176.98.155.17:10801' }],
                [{ text: '➕ Создать счет', callback_data: 'create_invoice' }],
                [{ text: '📋 Все счета', callback_data: 'list_invoices' }, { text: '❌ Неоплаченные', callback_data: 'inv_fs_unpaid' }],
                [{ text: '📊 Статистика', callback_data: 'statistics' }],
                [{ text: '🔔 Проверить дедлайны оплат', callback_data: 'check_deadlines' }],
                [{ text: '📅 Регулярные платежи', callback_data: 'recurring_payments' }],
                [{ text: '👥 Клиенты', callback_data: 'clients_menu' }]
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
                const f = { status: 'unpaid', monthKey: 'all', page: 0 };
                this.showInvoicesList(chatId, query.message.message_id, f);
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
            } else if (data.startsWith('inv_fs_')) {
                const status = data.replace('inv_fs_', '');
                const f = this.listFilters.get(chatId) || { status: 'all', monthKey: 'all', page: 0 };
                f.status = status; f.page = 0;
                this.showInvoicesList(chatId, query.message.message_id, f);
            } else if (data.startsWith('inv_fm_')) {
                const monthKey = data.replace('inv_fm_', '');
                const f = this.listFilters.get(chatId) || { status: 'all', monthKey: 'all', page: 0 };
                f.monthKey = monthKey; f.page = 0;
                this.showInvoicesList(chatId, query.message.message_id, f);
            } else if (data.startsWith('inv_p_')) {
                const page = parseInt(data.replace('inv_p_', ''));
                const f = this.listFilters.get(chatId) || { status: 'all', monthKey: 'all', page: 0 };
                f.page = page;
                this.showInvoicesList(chatId, query.message.message_id, f);
            } else if (data.startsWith('partial_')) {
                const invoiceId = data.replace('partial_', '');
                this.askPartialPayment(chatId, userId, invoiceId, query.message.message_id);
            } else if (data.startsWith('unpay_')) {
                const invoiceId = data.replace('unpay_', '');
                await this.cancelInvoicePayment(chatId, invoiceId, query.message.message_id);
            } else if (data.startsWith('remind_')) {
                const invoiceId = data.replace('remind_', '');
                await this.sendReminderFromBot(chatId, invoiceId);
            } else if (data === 'clients_menu') {
                this.showClientsMenu(chatId, query.message.message_id);
            } else if (data === 'cl_noop') {
                // индикатор страницы, ничего не делаем
            } else if (data.startsWith('cl_page_')) {
                this.showClientsMenu(chatId, query.message.message_id, parseInt(data.replace('cl_page_', '')));
            } else if (data === 'cl_new') {
                this.startClientCreate(chatId, userId);
            } else if (data === 'cl_search') {
                this.startClientSearch(chatId, userId);
            } else if (data.startsWith('cl_ename_')) {
                this.startClientEdit(chatId, userId, data.replace('cl_ename_', ''), 'name');
            } else if (data.startsWith('cl_ephone_')) {
                this.startClientEdit(chatId, userId, data.replace('cl_ephone_', ''), 'phone');
            } else if (data.startsWith('cl_delyes_')) {
                this.doClientDelete(chatId, data.replace('cl_delyes_', ''), query.message.message_id);
            } else if (data.startsWith('cl_del_')) {
                this.confirmClientDelete(chatId, data.replace('cl_del_', ''), query.message.message_id);
            } else if (data.startsWith('cl_')) {
                this.showClientDetails(chatId, data.replace('cl_', ''), query.message.message_id);
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

        // --- Управление клиентами ---
        if (session.state === 'cl_new_name') {
            const name = message.text.trim();
            if (!name) { this.sendMessage(chatId, '❌ Имя не может быть пустым'); return; }
            session.clNew = { name };
            session.state = 'cl_new_phone';
            this.sendMessage(chatId, `👤 Клиент: <b>${name}</b>\n\n📱 Введите номер телефона (WhatsApp) или <b>-</b> чтобы пропустить:`);
            return;
        }
        if (session.state === 'cl_new_phone') {
            const phone = message.text.trim() === '-' ? '' : message.text.trim();
            const client = this.clientsDb.addClient({ name: session.clNew.name, phone });
            this.userSessions.delete(userId);
            this.sendMessage(chatId, `✅ Клиент <b>${client.name}</b> создан.`, { reply_markup: { inline_keyboard: [[{ text: '👤 Открыть карточку', callback_data: `cl_${client.id}` }], [{ text: '👥 К клиентам', callback_data: 'clients_menu' }]] } });
            return;
        }
        if (session.state === 'cl_edit_name') {
            const name = message.text.trim();
            if (!name) { this.sendMessage(chatId, '❌ Имя не может быть пустым'); return; }
            const client = this.clientsDb.updateClient(session.clientId, { name });
            this.userSessions.delete(userId);
            if (client) this.sendMessage(chatId, `✅ Имя обновлено: <b>${client.name}</b>`, { reply_markup: { inline_keyboard: [[{ text: '👤 Карточка', callback_data: `cl_${client.id}` }]] } });
            else this.sendMessage(chatId, '❌ Клиент не найден');
            return;
        }
        if (session.state === 'cl_edit_phone') {
            const newPhone = message.text.trim();
            const client = this.clientsDb.getClientById(session.clientId);
            if (!client) { this.userSessions.delete(userId); this.sendMessage(chatId, '❌ Клиент не найден'); return; }
            const oldPhone = client.phone;
            const updated = this.clientsDb.updateClient(session.clientId, { phone: newPhone });
            this.userSessions.delete(userId);
            let synced = [];
            if (oldPhone && updated.phone && oldPhone !== updated.phone) {
                synced = this.invoiceDb.syncClientPhone(oldPhone, updated.phone, updated.name) || [];
            }
            let msg = `✅ Телефон обновлён: <b>${updated.phone || '—'}</b>`;
            if (synced.length > 0) msg += `\n🔄 Номер проброшен в активные счета: ${synced.map(s => '#' + s.invoiceNumber).join(', ')}`;
            this.sendMessage(chatId, msg, { reply_markup: { inline_keyboard: [[{ text: '👤 Карточка', callback_data: `cl_${updated.id}` }]] } });
            return;
        }
        if (session.state === 'cl_search') {
            const q = message.text.trim();
            this.userSessions.delete(userId);
            this.showClientSearchResults(chatId, q);
            return;
        }

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

        if (session.state === 'awaiting_partial_amount') {
            const raw = message.text.trim().replace(/[^\d.,]/g, '').replace(',', '.');
            const amount = parseFloat(raw);
            if (isNaN(amount) || amount <= 0) {
                this.sendMessage(chatId, '❌ Введите корректную сумму (число)');
                return;
            }
            const inv = this.invoiceDb.getInvoiceById(session.invoiceId);
            if (!inv) { this.userSessions.delete(userId); return; }
            const newPaid = (inv.paidAmount || 0) + amount;
            const isNowFull = newPaid >= inv.amount;
            this.invoiceDb.updateInvoice(session.invoiceId, {
                paidAmount: newPaid,
                paid: isNowFull
            });
            this.userSessions.delete(userId);
            const remaining = inv.amount - newPaid;
            let msg = isNowFull
                ? `✅ Счет №${inv.invoiceNumber} полностью оплачен!`
                : `💵 Оплачено: <b>${newPaid.toLocaleString('ru-RU')} ₽</b>\nОстаток: ${remaining.toLocaleString('ru-RU')} ₽`;
            this.sendMessage(chatId, msg);
            setTimeout(() => this.showInvoiceDetails(chatId, session.invoiceId, session.messageId), 800);
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

    getAvailableMonths(invoices) {
        const months = new Map();
        invoices.forEach(inv => {
            const d = new Date(inv.invoiceDate || inv.createdAt);
            const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
            const label = d.toLocaleDateString('ru-RU', { year: 'numeric', month: 'long' });
            months.set(key, label.charAt(0).toUpperCase() + label.slice(1));
        });
        return Array.from(months.entries()).sort((a,b) => b[0].localeCompare(a[0]));
    }

    showInvoicesList(chatId, messageId = null, overrideFilters = null) {
        const f = overrideFilters || this.listFilters.get(chatId) || { status: 'all', monthKey: 'all', page: 0 };
        this.listFilters.set(chatId, f);

        const allInvoices = this.invoiceDb.getAllInvoices();
        const availMonths = this.getAvailableMonths(allInvoices);

        // Apply filters
        let filtered = allInvoices.filter(inv => {
            const paidAmt = inv.paidAmount || 0;
            const isFullyPaid = inv.paid || paidAmt >= inv.amount;
            const isPartial = !inv.paid && paidAmt > 0 && paidAmt < inv.amount;
            if (f.status === 'paid' && !isFullyPaid) return false;
            if (f.status === 'unpaid' && (isFullyPaid || isPartial)) return false;
            if (f.status === 'partial' && !isPartial) return false;
            if (f.monthKey && f.monthKey !== 'all') {
                const d = new Date(inv.invoiceDate || inv.createdAt);
                const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
                if (key !== f.monthKey) return false;
            }
            return true;
        }).sort((a,b) => {
            const da = new Date(a.invoiceDate || a.createdAt);
            const db = new Date(b.invoiceDate || b.createdAt);
            return db - da;
        });

        const PAGE_SIZE = 8;
        const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
        const page = Math.min(f.page, totalPages - 1);
        const pageInvoices = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

        const keyboard = { inline_keyboard: [] };

        // Status filter row
        const statuses = [
            { label: f.status==='all' ? '▶ Все' : 'Все', val: 'all' },
            { label: f.status==='unpaid' ? '▶ ❌ Не опл.' : '❌ Не опл.', val: 'unpaid' },
            { label: f.status==='partial' ? '▶ ⚠️ Частичн.' : '⚠️ Частичн.', val: 'partial' },
            { label: f.status==='paid' ? '▶ ✅ Опл.' : '✅ Опл.', val: 'paid' }
        ];
        keyboard.inline_keyboard.push(statuses.map(s => ({ text: s.label, callback_data: `inv_fs_${s.val}` })));

        // Month filter row (show current month + up to 3 recent)
        if (availMonths.length > 0) {
            const monthBtns = [{ text: f.monthKey==='all' ? '▶ Все мес.' : 'Все мес.', callback_data: 'inv_fm_all' }];
            availMonths.slice(0, 3).forEach(([key, label]) => {
                const shortLabel = label.replace(/\s+\d{4}$/, '').substring(0,8);
                monthBtns.push({ text: f.monthKey===key ? `▶ ${shortLabel}` : shortLabel, callback_data: `inv_fm_${key}` });
            });
            keyboard.inline_keyboard.push(monthBtns);
        }

        if (filtered.length === 0) {
            keyboard.inline_keyboard.push([{ text: '🏠 Главное меню', callback_data: 'main_menu' }]);
            const msg = `📋 <b>Счета</b>\n\nПо выбранным фильтрам счета не найдены.`;
            if (messageId) this.editMessageText(chatId, messageId, msg, { reply_markup: keyboard });
            else this.sendMessage(chatId, msg, { reply_markup: keyboard });
            return;
        }

        // Invoice rows
        pageInvoices.forEach(invoice => {
            const paidAmt = invoice.paidAmount || 0;
            const isFullyPaid = invoice.paid || paidAmt >= invoice.amount;
            const isPartial = !invoice.paid && paidAmt > 0;
            const icon = isFullyPaid ? '✅' : isPartial ? '⚠️' : '❌';
            const d = new Date(invoice.invoiceDate || invoice.createdAt);
            const dateStr = d.toLocaleDateString('ru-RU', { day:'2-digit', month:'2-digit' });
            keyboard.inline_keyboard.push([{
                text: `${icon} №${invoice.invoiceNumber} ${dateStr} ${invoice.client} — ${invoice.amount.toLocaleString('ru-RU')}₽`,
                callback_data: `invoice_${invoice.id}`
            }]);
        });

        // Pagination
        if (totalPages > 1) {
            const paginationRow = [];
            if (page > 0) paginationRow.push({ text: `◀ ${page}/${totalPages}`, callback_data: `inv_p_${page-1}` });
            paginationRow.push({ text: `${page+1}/${totalPages}`, callback_data: `inv_p_${page}` });
            if (page < totalPages - 1) paginationRow.push({ text: `${page+2}/${totalPages} ▶`, callback_data: `inv_p_${page+1}` });
            keyboard.inline_keyboard.push(paginationRow);
        }

        keyboard.inline_keyboard.push([{ text: '🏠 Главное меню', callback_data: 'main_menu' }]);

        const statusLabels = { all: 'Все', paid: '✅ Оплаченные', unpaid: '❌ Неоплаченные', partial: '⚠️ Частично' };
        const monthLabel = f.monthKey && f.monthKey !== 'all' ? (availMonths.find(([k]) => k===f.monthKey)||['',''])[1] : 'все месяцы';
        const msg = `📋 <b>Счета</b> — ${statusLabels[f.status]||'Все'}, ${monthLabel}\nПоказано: ${pageInvoices.length} из ${filtered.length}\n\n✅ Оплачен | ⚠️ Частично | ❌ Не оплачен`;

        if (messageId) this.editMessageText(chatId, messageId, msg, { reply_markup: keyboard });
        else this.sendMessage(chatId, msg, { reply_markup: keyboard });
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
                { text: '✅ Оплачен полностью', callback_data: `pay_${invoice.id}` },
                { text: '💵 Частичная оплата', callback_data: `partial_${invoice.id}` }
            ]);
        } else {
            keyboard.inline_keyboard.push([
                { text: '↩ Отменить оплату', callback_data: `unpay_${invoice.id}` }
            ]);
        }

        keyboard.inline_keyboard.push([
            { text: '📤 Отправить счет (WA)', callback_data: `send_${invoice.id}` },
            { text: '🔔 Напоминание (WA)', callback_data: `remind_${invoice.id}` }
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

    askPartialPayment(chatId, userId, invoiceId, messageId = null) {
        const inv = this.invoiceDb.getInvoiceById(invoiceId);
        if (!inv) { this.sendMessage(chatId, '❌ Счет не найден'); return; }
        const paidAmt = inv.paidAmount || 0;
        const remaining = inv.amount - paidAmt;
        this.userSessions.set(userId, { state: 'awaiting_partial_amount', invoiceId, messageId });
        let msg = `💵 <b>Частичная оплата</b>\n\nСчет №${inv.invoiceNumber} — ${inv.client}\nСумма: ${inv.amount.toLocaleString('ru-RU')} ₽`;
        if (paidAmt > 0) msg += `\nУже оплачено: ${paidAmt.toLocaleString('ru-RU')} ₽\nОстаток: ${remaining.toLocaleString('ru-RU')} ₽`;
        msg += `\n\nВведите сумму оплаты:`;
        this.sendMessage(chatId, msg, {
            reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: `invoice_${invoiceId}` }]] }
        });
    }

    async cancelInvoicePayment(chatId, invoiceId, messageId = null) {
        const inv = this.invoiceDb.getInvoiceById(invoiceId);
        if (!inv) { this.sendMessage(chatId, '❌ Счет не найден'); return; }
        this.invoiceDb.updateInvoice(invoiceId, { paid: false, paidAmount: 0 });
        this.sendMessage(chatId, `↩ Оплата счета №${inv.invoiceNumber} отменена`);
        setTimeout(() => this.showInvoiceDetails(chatId, invoiceId, messageId), 600);
    }

    async sendReminderFromBot(chatId, invoiceId) {
        try {
            const inv = this.invoiceDb.getInvoiceById(invoiceId);
            if (!inv) { this.sendMessage(chatId, '❌ Счет не найден'); return; }
            if (!inv.clientPhone) { this.sendMessage(chatId, '❌ У клиента не указан телефон'); return; }
            const paidAmt = inv.paidAmount || 0;
            const isFullyPaid = inv.paid || paidAmt >= inv.amount;
            if (isFullyPaid) { this.sendMessage(chatId, '✅ Счет уже оплачен, напоминание не нужно'); return; }
            this.sendMessage(chatId, `⏳ Отправляю напоминание клиенту ${inv.client}...`);
            if (this.paymentReminderService) {
                await this.paymentReminderService.sendReminder(inv);
                this.invoiceDb.updateInvoice(invoiceId, {
                    lastReminderSentAt: new Date().toISOString(),
                    reminderCount: (inv.reminderCount || 0) + 1
                });
                this.sendMessage(chatId, `✅ Напоминание отправлено!\n📞 ${inv.client} (${inv.clientPhone})\n💰 Счет №${inv.invoiceNumber} на ${inv.amount.toLocaleString('ru-RU')} ₽`);
            } else {
                this.sendMessage(chatId, '❌ Сервис напоминаний не инициализирован');
            }
        } catch (error) {
            console.error('[TelegramBot] Ошибка отправки напоминания:', error);
            this.sendMessage(chatId, '❌ Ошибка отправки: ' + error.message);
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

    // ==========================================
    // Управление клиентами (CRUD + поиск)
    // ==========================================

    showClientsMenu(chatId, messageId = null, page = 0) {
        const clients = this.clientsDb.getAllClients();
        const perPage = 10;
        const totalPages = Math.max(1, Math.ceil(clients.length / perPage));
        if (page < 0) page = 0;
        if (page >= totalPages) page = totalPages - 1;
        const slice = clients.slice(page * perPage, page * perPage + perPage);

        const keyboard = { inline_keyboard: [] };
        keyboard.inline_keyboard.push([
            { text: '➕ Новый клиент', callback_data: 'cl_new' },
            { text: '🔍 Поиск', callback_data: 'cl_search' }
        ]);
        slice.forEach(c => {
            keyboard.inline_keyboard.push([{
                text: `${c.name}${c.phone ? ' (' + c.phone + ')' : ''}`,
                callback_data: `cl_${c.id}`
            }]);
        });
        if (totalPages > 1) {
            const nav = [];
            if (page > 0) nav.push({ text: '◀', callback_data: `cl_page_${page - 1}` });
            nav.push({ text: `${page + 1}/${totalPages}`, callback_data: 'cl_noop' });
            if (page < totalPages - 1) nav.push({ text: '▶', callback_data: `cl_page_${page + 1}` });
            keyboard.inline_keyboard.push(nav);
        }
        keyboard.inline_keyboard.push([{ text: '🏠 Главное меню', callback_data: 'main_menu' }]);

        const text = `👥 <b>Клиенты</b> (всего: ${clients.length})\n\nВыберите клиента или действие:`;
        if (messageId) this.editMessageText(chatId, messageId, text, { reply_markup: keyboard });
        else this.sendMessage(chatId, text, { reply_markup: keyboard });
    }

    showClientDetails(chatId, clientId, messageId = null) {
        const client = this.clientsDb.getClientById(clientId);
        if (!client) { this.sendMessage(chatId, '❌ Клиент не найден'); return; }

        const allInvoices = this.invoiceDb.getAllInvoices();
        const tail = (client.phone || '').replace(/\D/g, '').slice(-10);
        const linked = allInvoices.filter(inv =>
            inv.client === client.name ||
            (tail && inv.clientPhone && inv.clientPhone.replace(/\D/g, '').slice(-10) === tail)
        );
        const unpaid = linked.filter(inv => !inv.paid);

        let text = `👤 <b>${client.name}</b>\n\n`;
        text += `📱 Телефон: ${client.phone || '—'}\n`;
        if (client.email) text += `✉️ Email: ${client.email}\n`;
        if (client.address) text += `🏠 Адрес: ${client.address}\n`;
        if (client.notes) text += `📝 Заметки: ${client.notes}\n`;
        text += `\n📄 Счетов: ${linked.length} (неоплачено: ${unpaid.length})`;

        const keyboard = { inline_keyboard: [
            [{ text: '✏️ Имя', callback_data: `cl_ename_${client.id}` },
             { text: '📱 Телефон', callback_data: `cl_ephone_${client.id}` }],
            [{ text: '🗑 Удалить', callback_data: `cl_del_${client.id}` }],
            [{ text: '◀️ К списку', callback_data: 'clients_menu' },
             { text: '🏠 Меню', callback_data: 'main_menu' }]
        ] };

        if (messageId) this.editMessageText(chatId, messageId, text, { reply_markup: keyboard });
        else this.sendMessage(chatId, text, { reply_markup: keyboard });
    }

    startClientCreate(chatId, userId) {
        this.userSessions.set(userId, { state: 'cl_new_name' });
        this.sendMessage(chatId, '👤 Введите имя или название нового клиента:\n\n<i>/cancel — отмена</i>');
    }

    startClientEdit(chatId, userId, clientId, field) {
        const client = this.clientsDb.getClientById(clientId);
        if (!client) { this.sendMessage(chatId, '❌ Клиент не найден'); return; }
        if (field === 'name') {
            this.userSessions.set(userId, { state: 'cl_edit_name', clientId });
            this.sendMessage(chatId, `Текущее имя: <b>${client.name}</b>\n\nВведите новое имя:\n\n<i>/cancel — отмена</i>`);
        } else {
            this.userSessions.set(userId, { state: 'cl_edit_phone', clientId });
            this.sendMessage(chatId, `Текущий телефон: <b>${client.phone || '—'}</b>\n\nВведите новый номер (WhatsApp).\nПри смене номер автоматически обновится во всех активных счетах клиента.\n\n<i>/cancel — отмена</i>`);
        }
    }

    confirmClientDelete(chatId, clientId, messageId) {
        const client = this.clientsDb.getClientById(clientId);
        if (!client) { this.sendMessage(chatId, '❌ Клиент не найден'); return; }
        const keyboard = { inline_keyboard: [
            [{ text: '🗑 Да, удалить', callback_data: `cl_delyes_${client.id}` }],
            [{ text: '◀️ Отмена', callback_data: `cl_${client.id}` }]
        ] };
        this.editMessageText(chatId, messageId, `⚠️ Удалить клиента <b>${client.name}</b>?\n\nСами счета останутся, удалится только карточка клиента.`, { reply_markup: keyboard });
    }

    doClientDelete(chatId, clientId, messageId) {
        const deleted = this.clientsDb.deleteClient(clientId);
        this.showClientsMenu(chatId, messageId);
        if (deleted) this.sendMessage(chatId, `🗑 Клиент <b>${deleted.name}</b> удалён.`);
    }

    startClientSearch(chatId, userId) {
        this.userSessions.set(userId, { state: 'cl_search' });
        this.sendMessage(chatId, '🔍 Введите имя, телефон или email для поиска:\n\n<i>/cancel — отмена</i>');
    }

    showClientSearchResults(chatId, query) {
        const results = this.clientsDb.searchClients(query);
        if (results.length === 0) {
            this.sendMessage(chatId, `🔍 По запросу «${query}» ничего не найдено.`, { reply_markup: { inline_keyboard: [[{ text: '👥 К клиентам', callback_data: 'clients_menu' }]] } });
            return;
        }
        const keyboard = { inline_keyboard: [] };
        results.slice(0, 20).forEach(c => keyboard.inline_keyboard.push([{
            text: `${c.name}${c.phone ? ' (' + c.phone + ')' : ''}`,
            callback_data: `cl_${c.id}`
        }]));
        keyboard.inline_keyboard.push([{ text: '👥 К клиентам', callback_data: 'clients_menu' }]);
        this.sendMessage(chatId, `🔍 Найдено: ${results.length}`, { reply_markup: keyboard });
    }

}

export default InvoiceTelegramBot;
