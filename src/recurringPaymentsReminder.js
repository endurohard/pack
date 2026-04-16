import { getMoscowHour, isMoscowWorkingHours } from './dateUtils.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class RecurringPaymentsReminder {
  constructor(db, telegramBot) {
    this.db = db;
    this.telegramBot = telegramBot;
    this.intervalId = null;
  }

  start() {
    console.log('[RecurringReminder] Сервис напоминаний о регулярных платежах запущен');
    this.scheduleNextCheck();
  }

  stop() {
    if (this.intervalId) {
      clearTimeout(this.intervalId);
      this.intervalId = null;
      console.log('[RecurringReminder] Сервис остановлен');
    }
  }

  scheduleNextCheck() {
    const settings = this.db.getSettings();
    const now = new Date();
    const nextCheck = new Date();
    nextCheck.setHours(settings.checkHour, settings.checkMinute || 0, 0, 0);

    if (now >= nextCheck) {
      nextCheck.setDate(nextCheck.getDate() + 1);
    }

    const delay = nextCheck - now;
    console.log(`[RecurringReminder] Следующая проверка: ${nextCheck.toLocaleString('ru-RU')}`);

    this.intervalId = setTimeout(() => {
      this.checkAndNotify();
      this.scheduleNextCheck();
    }, delay);
  }

  async checkAndNotify() {
    try {
      console.log('[RecurringReminder] Проверка регулярных платежей...');

      // Проверяем рабочие часы по МСК (10:00-20:00)
      if (!isMoscowWorkingHours()) {
        console.log('[RecurringReminder] Сейчас нерабочее время по МСК (допустимо 10:00-20:00), пропускаем');
        return;
      }

      const settings = this.db.getSettings();
      const upcoming = this.db.getUpcomingPayments(settings.remindDaysBefore);

      if (upcoming.length === 0) {
        console.log('[RecurringReminder] Нет платежей, требующих напоминания');
        return;
      }

      console.log(`[RecurringReminder] Найдено платежей для напоминания: ${upcoming.length}`);
      await this.sendTelegramReminder(upcoming);

    } catch (error) {
      console.error('[RecurringReminder] Ошибка:', error);
    }
  }

  async sendTelegramReminder(payments) {
    if (!this.telegramBot || !this.telegramBot.config) {
      console.error('[RecurringReminder] Telegram бот не инициализирован');
      return;
    }

    const chatId = this.telegramBot.config.allowedUserId;
    const today = new Date().getDate();
    const totalDue = payments.reduce((s, p) => s + p.amount, 0);

    let text = '📅 <b>Напоминание о регулярных платежах</b>\n';
    text += '━━━━━━━━━━━━━━━━━━━━━\n\n';

    const buttons = [];

    for (const p of payments) {
      const diff = p.dayOfMonth - today;
      let urgency;
      if (diff < 0) {
        urgency = '🔴 ПРОСРОЧЕНО';
      } else if (diff === 0) {
        urgency = '🟠 СЕГОДНЯ';
      } else {
        urgency = `🟡 через ${diff} дн.`;
      }

      text += `${urgency}\n`;
      text += `<b>${p.name}</b> — ${p.amount.toLocaleString('ru-RU')} ₽\n`;
      if (p.description) text += `<i>${p.description}</i>\n`;
      text += `📅 Срок: до ${p.dayOfMonth}-го числа\n\n`;

      buttons.push([{ text: `✅ Оплатил: ${p.name}`, callback_data: `rp_pay_${p.id}` }]);
    }

    text += `━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `💰 <b>Итого к оплате: ${totalDue.toLocaleString('ru-RU')} ₽</b>`;

    buttons.push([{ text: '📅 Все платежи', callback_data: 'recurring_payments' }]);

    try {
      await this.telegramBot.sendMessage(chatId, text, {
        reply_markup: { inline_keyboard: buttons }
      });
      console.log(`[RecurringReminder] Напоминание отправлено в Telegram (${payments.length} платежей)`);
    } catch (error) {
      console.error('[RecurringReminder] Ошибка отправки в Telegram:', error.message);
    }
  }

  // Ручная отправка напоминания (для тестирования)
  async sendTestReminder() {
    const active = this.db.getActivePayments();
    const month = this.db.getCurrentMonth();
    const paidIds = new Set(
      this.db.data.history.filter(h => h.month === month).map(h => h.paymentId)
    );
    const unpaid = active.filter(p => !paidIds.has(p.id));

    if (unpaid.length === 0) {
      console.log('[RecurringReminder] Нет неоплаченных платежей для тестового напоминания');
      return { sent: false, reason: 'no unpaid payments' };
    }

    await this.sendTelegramReminder(unpaid);
    return { sent: true, count: unpaid.length };
  }
}

export default RecurringPaymentsReminder;
