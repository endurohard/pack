// auth.js - Общая библиотека для работы с авторизацией

/**
 * Получить токен из localStorage
 */
function getAuthToken() {
    return localStorage.getItem('authToken');
}

/**
 * Сохранить токен в localStorage
 */
function setAuthToken(token) {
    localStorage.setItem('authToken', token);
}

/**
 * Удалить токен из localStorage
 */
function clearAuthToken() {
    localStorage.removeItem('authToken');
}

/**
 * Проверить наличие токена и редирект на логин если нет
 */
async function checkAuth() {
    const token = getAuthToken();

    if (!token) {
        window.location.href = '/login.html';
        return false;
    }

    try {
        const response = await fetch('/api/auth/verify', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        const data = await response.json();

        if (!data.valid) {
            clearAuthToken();
            window.location.href = '/login.html';
            return false;
        }

        return true;
    } catch (error) {
        console.error('Ошибка проверки авторизации:', error);
        return false;
    }
}

/**
 * Выполнить fetch запрос с автоматическим добавлением токена
 */
async function authFetch(url, options = {}) {
    const token = getAuthToken();

    if (!token) {
        window.location.href = '/login.html';
        throw new Error('Нет токена авторизации');
    }

    // Добавляем заголовок Authorization
    const headers = {
        ...options.headers,
        'Authorization': `Bearer ${token}`
    };

    const response = await fetch(url, {
        ...options,
        headers
    });

    // Если 401 - перенаправляем на логин
    if (response.status === 401) {
        clearAuthToken();
        window.location.href = '/login.html';
        throw new Error('Требуется авторизация');
    }

    return response;
}

/**
 * Выйти из системы
 */
async function logout() {
    const token = getAuthToken();

    if (token) {
        try {
            await fetch('/api/auth/logout', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
        } catch (error) {
            console.error('Ошибка выхода:', error);
        }
    }

    clearAuthToken();
    window.location.href = '/login.html';
}

// Проверяем авторизацию при загрузке страницы (кроме страницы логина)
if (window.location.pathname !== '/login.html' && window.location.pathname !== '/login') {
    checkAuth();
}
