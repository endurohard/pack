# 🚀 Быстрое решение проблемы с инициализацией WhatsApp

## Проблема
```
❌ Ошибка инициализации WhatsApp: The browser is already running
```

## ✅ Решение (автоматическое)

### Уже работает!
При каждом запуске сервера автоматически:
- Проверяются зависшие процессы Chrome
- Удаляются блокирующие файлы
- WhatsApp запускается без ошибок

### Просто перезапустите сервер:
```bash
pkill -9 -f "node src/server.js"
sleep 3
export DISPLAY=:99
nohup node src/server.js > server.log 2>&1 &
```

## 🔧 Ручное решение (если нужно)

### Вариант 1: Через скрипт (быстро)
```bash
./whatsapp-monitor.sh restart
```

### Вариант 2: Только очистка
```bash
./whatsapp-monitor.sh cleanup
```

### Вариант 3: Полностью вручную
```bash
# 1. Остановить процессы
pkill -9 chrome && pkill -9 chromium && pkill -9 -f "node src/server.js"

# 2. Удалить блокировки
rm -f data/whatsapp-session/Singleton*

# 3. Подождать
sleep 3

# 4. Запустить сервер
export DISPLAY=:99
nohup node src/server.js > server.log 2>&1 &
```

## 🤖 Автоматический мониторинг (опционально)

### Установка (один раз):
```bash
./setup-whatsapp-monitor.sh
# Выберите вариант 1 (Cron)
```

После этого система будет сама проверять и восстанавливать WhatsApp каждые 5 минут.

## 📊 Проверка работы

```bash
# Статус WhatsApp
curl http://localhost:3000/api/whatsapp/status | jq

# Логи сервера
tail -20 server.log

# Логи мониторинга (если установлен)
tail -20 whatsapp-monitor.log
```

## 📝 Что в логах означает успех

```
🔍 Проверка зависших процессов Chrome...
⚠️  Найден файл блокировки: SingletonSocket
🧹 Очистка зависших процессов Chrome...
✅ Процессы Chrome завершены
🗑️  Удален SingletonSocket
✅ Очистка завершена
✅ WhatsApp Web готов к использованию!
```

## 💡 Самое простое решение

Просто перезапустите сервер - все сделается автоматически!

```bash
pkill -9 -f "node src/server.js" && sleep 3 && export DISPLAY=:99 && nohup node src/server.js > server.log 2>&1 &
```

Подождите 30 секунд и проверьте:
```bash
curl -s http://localhost:3000/api/whatsapp/status | jq
```

Должно быть:
```json
{
  "isReady": true,
  "browserActive": true,
  "sessionExists": true
}
```
