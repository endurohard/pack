#!/bin/bash

# Скрипт мониторинга и автоматического восстановления WhatsApp
# Проверяет состояние WhatsApp и перезапускает при необходимости

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$SCRIPT_DIR/whatsapp-monitor.log"
MAX_LOG_SIZE=10485760  # 10MB

# Функция логирования
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# Ротация логов
rotate_logs() {
    if [ -f "$LOG_FILE" ]; then
        local size=$(stat -f%z "$LOG_FILE" 2>/dev/null || stat -c%s "$LOG_FILE" 2>/dev/null)
        if [ "$size" -gt "$MAX_LOG_SIZE" ]; then
            mv "$LOG_FILE" "$LOG_FILE.old"
            log "Лог ротирован"
        fi
    fi
}

# Проверка статуса WhatsApp через API
check_whatsapp_status() {
    local response=$(curl -s http://localhost:3000/api/whatsapp/status 2>/dev/null)

    if [ -z "$response" ]; then
        log "⚠️  Сервер не отвечает"
        return 1
    fi

    local is_ready=$(echo "$response" | grep -o '"isReady":[^,}]*' | cut -d':' -f2)
    local browser_active=$(echo "$response" | grep -o '"browserActive":[^,}]*' | cut -d':' -f2)

    if [ "$is_ready" = "true" ] && [ "$browser_active" = "true" ]; then
        log "✅ WhatsApp работает нормально"
        return 0
    else
        log "❌ WhatsApp не готов (isReady: $is_ready, browserActive: $browser_active)"
        return 1
    fi
}

# Проверка зависших процессов Chrome
check_hanging_chrome() {
    if [ -f "$SCRIPT_DIR/data/whatsapp-session/SingletonLock" ]; then
        log "⚠️  Обнаружен файл SingletonLock - возможно Chrome завис"
        return 1
    fi
    return 0
}

# Очистка зависших процессов
cleanup_processes() {
    log "🧹 Очистка зависших процессов..."

    # Завершаем Chrome
    pkill -9 chrome 2>/dev/null || true
    pkill -9 chromium 2>/dev/null || true

    # Удаляем Singleton файлы
    rm -f "$SCRIPT_DIR/data/whatsapp-session/SingletonLock" 2>/dev/null || true
    rm -f "$SCRIPT_DIR/data/whatsapp-session/SingletonCookie" 2>/dev/null || true
    rm -f "$SCRIPT_DIR/data/whatsapp-session/SingletonSocket" 2>/dev/null || true

    sleep 3
    log "✅ Очистка завершена"
}

# Перезапуск сервера
restart_server() {
    log "🔄 Перезапуск сервера..."

    # Останавливаем сервер
    pkill -9 -f "node src/server.js" 2>/dev/null || true
    sleep 3

    # Очищаем процессы
    cleanup_processes

    # Запускаем сервер
    cd "$SCRIPT_DIR"
    export DISPLAY=:99
    nohup node src/server.js > server.log 2>&1 &

    log "⏳ Ожидание запуска сервера (30 секунд)..."
    sleep 30

    # Проверяем результат
    if check_whatsapp_status; then
        log "✅ Сервер успешно перезапущен"
        return 0
    else
        log "❌ Сервер не запустился корректно"
        return 1
    fi
}

# Главная функция мониторинга
monitor() {
    rotate_logs
    log "=========================================="
    log "🔍 Начало проверки WhatsApp"

    # Проверка 1: Статус через API
    if ! check_whatsapp_status; then
        log "⚠️  WhatsApp не работает, попытка перезапуска..."

        if restart_server; then
            log "✅ Проблема решена"
            return 0
        else
            log "❌ Не удалось восстановить WhatsApp"
            return 1
        fi
    fi

    # Проверка 2: Зависшие процессы Chrome
    if ! check_hanging_chrome; then
        log "⚠️  Обнаружены зависшие процессы, очистка..."
        cleanup_processes
    fi

    log "✅ Проверка завершена, все в порядке"
}

# Режим работы
case "${1:-}" in
    start)
        log "🚀 Запуск мониторинга WhatsApp"
        while true; do
            monitor
            sleep 300  # Проверка каждые 5 минут
        done
        ;;
    check)
        monitor
        ;;
    cleanup)
        cleanup_processes
        ;;
    restart)
        restart_server
        ;;
    *)
        echo "Использование: $0 {start|check|cleanup|restart}"
        echo ""
        echo "  start   - Запустить постоянный мониторинг (каждые 5 минут)"
        echo "  check   - Выполнить одну проверку"
        echo "  cleanup - Очистить зависшие процессы"
        echo "  restart - Перезапустить сервер WhatsApp"
        exit 1
        ;;
esac
