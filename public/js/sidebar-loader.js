// Загрузка бокового меню
document.addEventListener('DOMContentLoaded', async () => {
    try {
        const response = await fetch('/components/sidebar.html');
        const sidebarHTML = await response.text();
        
        // Вставляем sidebar в начало body
        document.body.insertAdjacentHTML('afterbegin', sidebarHTML);
        
        console.log('✅ Боковое меню загружено');
    } catch (error) {
        console.error('❌ Ошибка загрузки бокового меню:', error);
    }
});
