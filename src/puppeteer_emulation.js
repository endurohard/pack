/**
 * Модуль эмуляции пользовательских действий для Puppeteer
 *
 * Этот модуль содержит методы для симуляции естественных пользовательских
 * действий при работе с файловыми input-элементами в браузере.
 * Использует плавное перемещение мыши и задержки для имитации реального поведения.
 */

/**
 * Перемещает курсор мыши к элементу с естественной анимацией
 *
 * @param {import('puppeteer').Page} page - Страница Puppeteer
 * @param {import('puppeteer').ElementHandle} element - Элемент, к которому нужно переместить курсор
 * @param {Object} options - Опции
 * @param {number} [options.steps=10] - Количество шагов для плавного перемещения
 * @param {number} [options.delay=300] - Задержка после перемещения (мс)
 * @returns {Promise<{x: number, y: number}>} Координаты центра элемента
 */
async function moveToFileInput(page, element, options = {}) {
  const { steps = 10, delay = 300 } = options;

  // Получаем координаты центра элемента
  console.log('🖱️  Получение координат файлового input...');
  const boundingBox = await element.boundingBox();

  if (!boundingBox) {
    throw new Error('Не удалось получить координаты элемента - элемент не виден или имеет нулевой размер');
  }

  const targetX = boundingBox.x + boundingBox.width / 2;
  const targetY = boundingBox.y + boundingBox.height / 2;

  // Плавное перемещение курсора к элементу (имитация естественного движения)
  console.log(`🖱️  Перемещение курсора к файловому input (${Math.round(targetX)}, ${Math.round(targetY)})...`);
  await page.mouse.move(targetX, targetY, { steps });

  // Задержка после перемещения (имитация человеческого поведения)
  await new Promise(resolve => setTimeout(resolve, delay));
  console.log('✅ Курсор перемещен к элементу');

  return { x: targetX, y: targetY };
}

/**
 * Симулирует клик на файловом input элементе с естественным движением мыши
 *
 * Выполняет:
 * 1. Плавное перемещение курсора к элементу
 * 2. Короткую паузу
 * 3. Клик мышью
 * 4. Паузу после клика
 *
 * @param {import('puppeteer').Page} page - Страница Puppeteer
 * @param {import('puppeteer').ElementHandle} element - Файловый input элемент
 * @param {Object} options - Опции
 * @param {number} [options.steps=10] - Количество шагов для плавного перемещения
 * @param {number} [options.preClickDelay=200] - Задержка перед кликом (мс)
 * @param {number} [options.postClickDelay=300] - Задержка после клика (мс)
 * @returns {Promise<{x: number, y: number, clicked: boolean}>} Результат клика
 */
async function simulateFileInputClick(page, element, options = {}) {
  const {
    steps = 10,
    preClickDelay = 200,
    postClickDelay = 300
  } = options;

  console.log('🖱️  Симуляция клика на файловом input...');

  // Шаг 1: Перемещаем курсор к элементу
  const coords = await moveToFileInput(page, element, { steps, delay: preClickDelay });

  // Шаг 2: Выполняем клик
  console.log('🖱️  Выполнение клика...');
  await page.mouse.click(coords.x, coords.y);
  console.log('✅ Клик выполнен!');

  // Шаг 3: Задержка после клика
  await new Promise(resolve => setTimeout(resolve, postClickDelay));

  return {
    x: coords.x,
    y: coords.y,
    clicked: true
  };
}

/**
 * Симулирует наведение курсора на файловый input с задержкой (hover эффект)
 * Полезно для активации визуальных подсказок перед кликом
 *
 * @param {import('puppeteer').Page} page - Страница Puppeteer
 * @param {import('puppeteer').ElementHandle} element - Элемент для наведения
 * @param {number} [hoverDuration=500] - Длительность удержания курсора (мс)
 * @returns {Promise<void>}
 */
async function hoverFileInput(page, element, hoverDuration = 500) {
  console.log('🖱️  Наведение курсора на файловый input...');

  const coords = await moveToFileInput(page, element, { steps: 8, delay: 100 });

  // Удерживаем курсор на элементе
  await new Promise(resolve => setTimeout(resolve, hoverDuration));
  console.log('✅ Hover завершен');

  return coords;
}

/**
 * Симулирует клик с удержанием (mousedown/mouseup)
 * Некоторые элементы требуют явного нажатия и отпускания кнопки мыши
 *
 * @param {import('puppeteer').Page} page - Страница Puppeteer
 * @param {import('puppeteer').ElementHandle} element - Элемент для клика
 * @param {Object} options - Опции
 * @param {number} [options.holdDuration=100] - Длительность удержания кнопки (мс)
 * @returns {Promise<{x: number, y: number}>} Координаты клика
 */
async function simulateFileInputPressRelease(page, element, options = {}) {
  const { holdDuration = 100 } = options;

  console.log('🖱️  Симуляция нажатия и отпускания на файловом input...');

  // Перемещаем курсор
  const coords = await moveToFileInput(page, element, { steps: 10, delay: 150 });

  // Нажимаем кнопку мыши
  console.log('🖱️  Нажатие кнопки мыши...');
  await page.mouse.down();

  // Удерживаем
  await new Promise(resolve => setTimeout(resolve, holdDuration));

  // Отпускаем кнопку мыши
  console.log('🖱️  Отпускание кнопки мыши...');
  await page.mouse.up();

  await new Promise(resolve => setTimeout(resolve, 200));
  console.log('✅ Нажатие/отпускание выполнено');

  return coords;
}

/**
 * Триггерит DOM события для файлового input после установки файлов
 * Используется для симуляции реального пользовательского взаимодействия
 * после программной установки файлов через DataTransfer API
 *
 * Выполняет:
 * 1. Событие 'input' (ввод данных)
 * 2. Событие 'change' (изменение значения)
 * 3. Опционально фокус/blur для полной эмуляции
 *
 * @param {import('puppeteer').Page} page - Страница Puppeteer
 * @param {import('puppeteer').ElementHandle} element - Файловый input элемент
 * @param {Object} options - Опции
 * @param {boolean} [options.triggerFocus=false] - Триггерить события focus/blur
 * @param {number} [options.eventDelay=50] - Задержка между событиями (мс)
 * @returns {Promise<{eventsTriggered: string[], success: boolean}>} Результат триггера событий
 */
async function triggerFileInputEvents(page, element, options = {}) {
  const { triggerFocus = false, eventDelay = 50 } = options;

  console.log('📤 Триггер DOM событий для файлового input...');

  const eventsTriggered = [];

  try {
    // Триггерим события внутри контекста браузера
    const result = await element.evaluate((input, opts) => {
      const triggered = [];

      // Опционально: фокус на элементе
      if (opts.triggerFocus) {
        const focusEvent = new FocusEvent('focus', { bubbles: true });
        input.dispatchEvent(focusEvent);
        triggered.push('focus');
      }

      // Событие input (происходит при вводе данных)
      const inputEvent = new Event('input', { bubbles: true, cancelable: true });
      input.dispatchEvent(inputEvent);
      triggered.push('input');

      // Событие change (происходит при изменении значения и потере фокуса)
      const changeEvent = new Event('change', { bubbles: true, cancelable: true });
      input.dispatchEvent(changeEvent);
      triggered.push('change');

      // Опционально: потеря фокуса
      if (opts.triggerFocus) {
        const blurEvent = new FocusEvent('blur', { bubbles: true });
        input.dispatchEvent(blurEvent);
        triggered.push('blur');
      }

      return triggered;
    }, { triggerFocus });

    eventsTriggered.push(...result);

    // Задержка для обработки событий
    await new Promise(resolve => setTimeout(resolve, eventDelay));

    console.log(`✅ DOM события триггерены: ${eventsTriggered.join(', ')}`);

    return {
      eventsTriggered,
      success: true
    };
  } catch (error) {
    console.log(`❌ Ошибка триггера DOM событий: ${error.message}`);
    return {
      eventsTriggered,
      success: false
    };
  }
}

export {
  moveToFileInput,
  simulateFileInputClick,
  hoverFileInput,
  simulateFileInputPressRelease,
  triggerFileInputEvents
};
