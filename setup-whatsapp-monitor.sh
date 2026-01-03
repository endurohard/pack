#!/bin/bash

# Скрипт установки мониторинга WhatsApp

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=========================================="
echo "Установка мониторинга WhatsApp"
echo "=========================================="
echo ""

# Проверка прав
if [ "$EUID" -eq 0 ]; then
    echo "❌ Не запускайте этот скрипт с sudo!"
    echo "   Запустите как обычный пользователь: ./setup-whatsapp-monitor.sh"
    exit 1
fi

echo "Выберите метод мониторинга:"
echo ""
echo "1) Cron (рекомендуется) - проверка каждые 5 минут через crontab"
echo "2) Systemd - постоянный сервис в фоне"
echo "3) Только настроить автоматическую очистку в коде"
echo ""
read -p "Ваш выбор (1-3): " choice

case $choice in
    1)
        echo ""
        echo "📅 Настройка Cron..."

        # Создаем запись для crontab
        CRON_JOB="*/5 * * * * cd $SCRIPT_DIR && ./whatsapp-monitor.sh check >> whatsapp-monitor.log 2>&1"

        # Проверяем, есть ли уже такая запись
        if crontab -l 2>/dev/null | grep -q "whatsapp-monitor.sh"; then
            echo "⚠️  Запись в crontab уже существует"
            read -p "Обновить? (y/n): " update
            if [ "$update" = "y" ]; then
                # Удаляем старую запись
                crontab -l 2>/dev/null | grep -v "whatsapp-monitor.sh" | crontab -
                # Добавляем новую
                (crontab -l 2>/dev/null; echo "$CRON_JOB") | crontab -
                echo "✅ Запись обновлена"
            fi
        else
            # Добавляем новую запись
            (crontab -l 2>/dev/null; echo "$CRON_JOB") | crontab -
            echo "✅ Запись добавлена в crontab"
        fi

        echo ""
        echo "✅ Настройка завершена!"
        echo ""
        echo "Мониторинг будет запускаться каждые 5 минут"
        echo "Логи: $SCRIPT_DIR/whatsapp-monitor.log"
        echo ""
        echo "Полезные команды:"
        echo "  Просмотр логов:       tail -f $SCRIPT_DIR/whatsapp-monitor.log"
        echo "  Ручная проверка:      ./whatsapp-monitor.sh check"
        echo "  Ручной перезапуск:    ./whatsapp-monitor.sh restart"
        echo "  Удалить из cron:      crontab -e (удалите строку с whatsapp-monitor.sh)"
        ;;

    2)
        echo ""
        echo "🔧 Настройка Systemd..."

        SERVICE_FILE="/etc/systemd/system/whatsapp-monitor.service"

        echo "Для установки systemd сервиса нужны права root"
        read -p "Продолжить? (y/n): " continue

        if [ "$continue" = "y" ]; then
            sudo cp "$SCRIPT_DIR/whatsapp-monitor.service" "$SERVICE_FILE"
            sudo systemctl daemon-reload
            sudo systemctl enable whatsapp-monitor.service
            sudo systemctl start whatsapp-monitor.service

            echo ""
            echo "✅ Systemd сервис установлен и запущен!"
            echo ""
            echo "Полезные команды:"
            echo "  Статус:              sudo systemctl status whatsapp-monitor"
            echo "  Остановить:          sudo systemctl stop whatsapp-monitor"
            echo "  Запустить:           sudo systemctl start whatsapp-monitor"
            echo "  Перезапустить:       sudo systemctl restart whatsapp-monitor"
            echo "  Просмотр логов:      sudo journalctl -u whatsapp-monitor -f"
            echo "  Отключить:           sudo systemctl disable whatsapp-monitor"
        fi
        ;;

    3)
        echo ""
        echo "✅ Автоматическая очистка уже настроена в коде!"
        echo ""
        echo "При каждом запуске сервера будет:"
        echo "  - Проверка зависших процессов Chrome"
        echo "  - Автоматическая очистка Singleton файлов"
        echo "  - Завершение старых процессов браузера"
        echo ""
        echo "Для ручных операций используйте:"
        echo "  Проверка:      ./whatsapp-monitor.sh check"
        echo "  Очистка:       ./whatsapp-monitor.sh cleanup"
        echo "  Перезапуск:    ./whatsapp-monitor.sh restart"
        ;;

    *)
        echo "❌ Неверный выбор"
        exit 1
        ;;
esac

echo ""
echo "=========================================="
echo "Установка завершена!"
echo "=========================================="
