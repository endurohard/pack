import fs from 'fs';

const invoices = JSON.parse(fs.readFileSync('./data/invoices.json', 'utf-8'));
const clients = JSON.parse(fs.readFileSync('./data/clients.json', 'utf-8'));

// Создаем карту клиентов: имя -> телефон
const clientMap = {};
clients.forEach(c => {
    clientMap[c.name] = c.phone;
});

console.log('\n=== ПРОВЕРКА СООТВЕТСТВИЯ НОМЕРОВ ТЕЛЕФОНОВ ===\n');
console.log(`Всего счетов: ${invoices.length}`);
console.log(`Всего клиентов: ${clients.length}\n`);

// Проверяем несовпадения
const mismatches = [];
const missing = [];
const correct = [];

invoices.forEach(inv => {
    const expectedPhone = clientMap[inv.client];

    if (!expectedPhone) {
        if (inv.client) {
            missing.push({
                invoiceNumber: inv.invoiceNumber,
                client: inv.client,
                invoicePhone: inv.clientPhone
            });
        }
    } else if (!inv.clientPhone) {
        missing.push({
            invoiceNumber: inv.invoiceNumber,
            client: inv.client,
            invoicePhone: 'НЕТ НОМЕРА',
            expectedPhone: expectedPhone
        });
    } else if (expectedPhone !== inv.clientPhone) {
        mismatches.push({
            invoiceNumber: inv.invoiceNumber,
            client: inv.client,
            invoicePhone: inv.clientPhone,
            expectedPhone: expectedPhone
        });
    } else {
        correct.push({
            invoiceNumber: inv.invoiceNumber,
            client: inv.client,
            phone: inv.clientPhone
        });
    }
});

console.log(`✅ Счетов с правильными номерами: ${correct.length}`);
console.log(`❌ Счетов с несовпадающими номерами: ${mismatches.length}`);
console.log(`⚠️  Счетов с отсутствующими данными: ${missing.length}\n`);

if (mismatches.length > 0) {
    console.log('=== НЕСОВПАДЕНИЯ НОМЕРОВ ===\n');
    mismatches.slice(0, 15).forEach(m => {
        console.log(`Счет №${m.invoiceNumber} - ${m.client}`);
        console.log(`  В счете:    ${m.invoicePhone}`);
        console.log(`  У клиента:  ${m.expectedPhone}`);
        console.log('');
    });

    if (mismatches.length > 15) {
        console.log(`... и еще ${mismatches.length - 15} несовпадений\n`);
    }
}

if (missing.length > 0) {
    console.log('\n=== ОТСУТСТВУЮЩИЕ ДАННЫЕ ===\n');
    missing.slice(0, 10).forEach(m => {
        console.log(`Счет №${m.invoiceNumber} - ${m.client}`);
        console.log(`  В счете: ${m.invoicePhone || 'НЕТ'}`);
        console.log(`  У клиента: ${m.expectedPhone || 'Клиент не найден в базе'}`);
        console.log('');
    });
}

// Проверяем счета с автоотправкой
console.log('\n=== СЧЕТА С АВТООТПРАВКОЙ ===\n');
const autoSendInvoices = invoices.filter(inv => inv.autoSendEnabled || inv.autoSend);
console.log(`Счетов с автоотправкой: ${autoSendInvoices.length}`);

if (autoSendInvoices.length > 0) {
    autoSendInvoices.forEach(inv => {
        const expectedPhone = clientMap[inv.client];
        const match = expectedPhone === inv.clientPhone ? '✅' : '❌';
        console.log(`${match} Счет №${inv.invoiceNumber} - ${inv.client}`);
        console.log(`   Телефон в счете: ${inv.clientPhone}`);
        if (expectedPhone !== inv.clientPhone) {
            console.log(`   Телефон клиента: ${expectedPhone}`);
        }
        console.log(`   След. отправка: ${inv.nextSendDate || 'не установлена'}`);
        console.log('');
    });
}
