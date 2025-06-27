import axios from 'axios';
import cors from 'cors';
import crypto from 'crypto';
import express, { Request, Response } from 'express';
import fs from 'fs';
import { AddressInfo } from 'net';
import path from 'path';
import { ElementHandle, firefox, Page } from 'playwright';
7894754476

let API_PORT = 3562;
const BACKUP_PORTS = [3563, 3564, 3565, 3566, 3567];

const imageCache = new Map<string, string>();
const MAX_IMAGE_CACHE = 5000;

const geoCache = new Map<string, { lat: number; lon: number; name: string; displayName: string; timestamp: number }>();

function generateStableFileName(title: string, price: string, location: string): string {
  const cleaned = `${title}_${price}_${location}`.replace(/[^a-zA-Z0-9А-Яа-я]/g, '_');
  const hash = crypto.createHash('md5').update(cleaned).digest('hex').substring(0, 8);
  return `${cleaned.substring(0, 30)}_${hash}.png`;
}

function isTextMatch(actualValue: string, expectedValue: string): boolean {
  // Прямое совпадение
  if (actualValue === expectedValue) return true;

  // Для чисел проверяем форматированные варианты Facebook
  if (/^\d+$/.test(expectedValue)) {
    const num = parseInt(expectedValue);

    // Форматирование с точками как разделителями тысяч
    const formatted = num.toLocaleString('de-DE'); // немецкий формат с точками
    if (actualValue === formatted) return true;

    // Форматирование с долларом
    if (actualValue === `$${formatted}`) return true;
    if (actualValue === `$${expectedValue}`) return true;

    // Форматирование с запятыми
    const commaFormatted = num.toLocaleString('en-US');
    if (actualValue === commaFormatted) return true;
    if (actualValue === `$${commaFormatted}`) return true;
  }

  return false;
}

async function findElement(page: Page, selectors: string[], description: string = 'элемент'): Promise<ElementHandle | null> {
  console.log(`🔍 Ищем ${description} среди ${selectors.length} селекторов`);

  for (let i = 0; i < selectors.length; i++) {
    const selector = selectors[i];
    try {
      console.log(`Попытка ${i + 1}/${selectors.length}: "${selector}"`);

      const element = await page.$(selector);
      if (element) {
        // Проверяем что элемент действительно видим и интерактивен
        const isVisible = await element.isVisible();
        const isConnected = await element.evaluate((el: HTMLElement) => el.isConnected);

        if (isVisible && isConnected) {
          console.log(`✅ ${description} найден и готов: селектор "${selector}"`);

          // Скроллим к элементу для надежности
          try {
            await element.scrollIntoViewIfNeeded();
            await page.waitForTimeout(100);
          } catch (scrollError) {
            console.log('Не удалось скроллить к элементу, но продолжаем');
          }

          return element;
        } else {
          console.log(`⚠️ ${description} найден но не готов: visible=${isVisible}, connected=${isConnected}`);
          continue;
        }
      }
    } catch (e) {
      console.log(`❌ Селектор "${selector}" не сработал: ${e}`);
      continue;
    }
  }

  console.log(`🔍 ${description} не найден по стандартным селекторам, пробую JS поиск`);
  return null;
}

async function waitForElement(page: Page, selectors: string[], timeout: number = 5000): Promise<ElementHandle | null> {
  console.log(`Ищем элемент с таймаутом ${timeout}ms среди ${selectors.length} селекторов`);

  for (let i = 0; i < selectors.length; i++) {
    const selector = selectors[i];
    try {
      console.log(`Попытка ${i + 1}/${selectors.length}: селектор "${selector}"`);

      const element = await page.waitForSelector(selector, {
        timeout,
        state: 'visible'
      });

      if (element) {
        // Дополнительная проверка что элемент действительно интерактивен
        const isVisible = await element.isVisible();
        const isEnabled = await element.isEnabled();

        if (isVisible && isEnabled) {
          console.log(`✅ Элемент найден и готов к взаимодействию: селектор "${selector}"`);
          return element;
        } else {
          console.log(`⚠️ Элемент найден но не готов: visible=${isVisible}, enabled=${isEnabled}`);
          continue;
        }
      }
    } catch (e) {
      console.log(`❌ Селектор не сработал: "${selector}" - ${e}`);
      continue;
    }
  }

  console.log('🔍 Не найден ни один элемент из списка селекторов');
  return null;
}

async function safeClick(page: Page, element: ElementHandle): Promise<boolean> {
  const errors: string[] = [];

  try {
    // Скроллим к элементу
    await element.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);

    // Ждем что элемент станет видимым и интерактивным
    await element.waitForElementState('visible', { timeout: 3000 });
    await page.waitForTimeout(100);

    // Метод 1: Обычный клик
    await element.click({ timeout: 3000, force: false });
    console.log('Успешный клик методом 1 (обычный клик)');
    return true;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    errors.push(`Метод 1 (обычный клик): ${error}`);

    try {
      // Метод 2: Клик с force
      await element.click({ timeout: 3000, force: true });
      console.log('Успешный клик методом 2 (force клик)');
      return true;
    } catch (e2) {
      const error2 = e2 instanceof Error ? e2.message : String(e2);
      errors.push(`Метод 2 (force клик): ${error2}`);

      try {
        // Метод 3: JS клик
        await element.evaluate((el: HTMLElement) => el.click());
        console.log('Успешный клик методом 3 (JS клик)');
        return true;
      } catch (e3) {
        const error3 = e3 instanceof Error ? e3.message : String(e3);
        errors.push(`Метод 3 (JS клик): ${error3}`);

        try {
          // Метод 4: Клик по координатам
          const box = await element.boundingBox();
          if (box) {
            const x = box.x + box.width / 2;
            const y = box.y + box.height / 2;
            await page.mouse.click(x, y);
            console.log('Успешный клик методом 4 (координаты)');
            return true;
          } else {
            errors.push(`Метод 4 (координаты): Не удалось получить boundingBox`);
          }
        } catch (e4) {
          const error4 = e4 instanceof Error ? e4.message : String(e4);
          errors.push(`Метод 4 (координаты): ${error4}`);

          try {
            // Метод 5: Dispatch событий
            await element.evaluate((el: HTMLElement) => {
              el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
              el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
              el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            console.log('Успешный клик методом 5 (dispatch событий)');
            return true;
          } catch (e5) {
            const error5 = e5 instanceof Error ? e5.message : String(e5);
            errors.push(`Метод 5 (dispatch событий): ${error5}`);

            console.log('Не удалось кликнуть по элементу всеми методами');
            const errorMessage = `ОШИБКА КЛИКА: Не удалось выполнить клик всеми доступными методами:\n${errors.join('\n')}`;
            console.error(errorMessage);
            throw new Error(errorMessage);
          }
        }
      }
    }
  }

  const errorMessage = `ОШИБКА КЛИКА: Не удалось выполнить клик всеми доступными методами:\n${errors.join('\n')}`;
  console.error(errorMessage);
  throw new Error(errorMessage);
}

async function safeType(page: Page, element: ElementHandle, text: string): Promise<boolean> {
  const errors: string[] = [];

  try {
    // Скроллим к элементу и фокусируемся
    await element.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await element.waitForElementState('visible', { timeout: 3000 });

    // Метод 1: Очистка и ввод через element.fill
    await element.click({ clickCount: 3 });
    await page.waitForTimeout(100);
    await element.fill('');
    await page.waitForTimeout(100);
    await element.fill(text);

    // Проверяем что текст действительно введен
    const currentValue = await element.evaluate((el: HTMLInputElement) => el.value);
    if (isTextMatch(currentValue, text)) {
      console.log(`Успешный ввод методом 1 (element.fill): '${currentValue}'`);
      return true;
    } else {
      errors.push(`Метод 1: Текст не совпадает: '${currentValue}' !== '${text}'`);
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    errors.push(`Метод 1 (element.fill): ${error}`);
    console.log('Метод 1 не сработал, пробуем метод 2');
  }

  try {
    // Метод 2: Очистка через Ctrl+A + Delete и type
    await element.click();
    await page.waitForTimeout(100);
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(100);
    await element.type(text);

    // Проверяем результат
    const currentValue = await element.evaluate((el: HTMLInputElement) => el.value);
    if (isTextMatch(currentValue, text)) {
      console.log(`Успешный ввод методом 2 (Ctrl+A + type): '${currentValue}'`);
      return true;
    } else {
      errors.push(`Метод 2: Текст не совпадает: '${currentValue}' !== '${text}'`);
    }
  } catch (e2) {
    const error2 = e2 instanceof Error ? e2.message : String(e2);
    errors.push(`Метод 2 (Ctrl+A + type): ${error2}`);
    console.log('Метод 2 не сработал, пробуем метод 3');
  }

  try {
    // Метод 3: Прямой JS ввод с событиями
    await element.evaluate((el: HTMLInputElement, value: string) => {
      el.focus();
      el.value = '';
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }, text);

    // Проверяем результат
    const currentValue = await element.evaluate((el: HTMLInputElement) => el.value);
    if (isTextMatch(currentValue, text)) {
      console.log(`Успешный ввод методом 3 (JS с событиями): '${currentValue}'`);
      return true;
    } else {
      errors.push(`Метод 3: Текст не совпадает: '${currentValue}' !== '${text}'`);
    }
  } catch (e3) {
    const error3 = e3 instanceof Error ? e3.message : String(e3);
    errors.push(`Метод 3 (JS с событиями): ${error3}`);
    console.log('Метод 3 не сработал, пробуем метод 4');
  }

  try {
    // Метод 4: Симуляция посимвольного ввода
    await element.click();
    await page.waitForTimeout(100);
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');

    for (const char of text) {
      await page.keyboard.type(char);
      await page.waitForTimeout(50);
    }

    // Проверяем результат
    const currentValue = await element.evaluate((el: HTMLInputElement) => el.value);
    if (isTextMatch(currentValue, text)) {
      console.log(`Успешный ввод методом 4 (посимвольный ввод): '${currentValue}'`);
      return true;
    } else {
      errors.push(`Метод 4: Текст не совпадает: '${currentValue}' !== '${text}'`);
    }
  } catch (e4) {
    const error4 = e4 instanceof Error ? e4.message : String(e4);
    errors.push(`Метод 4 (посимвольный ввод): ${error4}`);
    console.log('Метод 4 не сработал');
  }

  const errorMessage = `ОШИБКА ВВОДА: Не удалось ввести текст '${text}' всеми доступными методами:\n${errors.join('\n')}`;
  console.error(errorMessage);
  throw new Error(errorMessage);
}

interface AppStatus {
  logined: boolean;
  stage: string;
  active: boolean;
  downloadedImages?: number;
  yearFilterNotFound?: boolean;
  minYear?: number;
  maxYear?: number;
  restarting_soon?: boolean;
}
interface CategoryData {
  name: string;
  id: string;
  selector: string;
}
interface SearchResult {
  success: boolean;
  message?: string;
  error?: string;
}
interface MarketplaceItem {
  title: string;
  price: string;
  location: string;
  imageUrl: string;
  itemUrl: string;
  savedImagePath?: string;
  ageMinutes?: number;
  modelName?: string;
}
interface ListingsResult {
  success: boolean;
  items?: MarketplaceItem[];
  error?: string;
  filteredCount?: number;
  duplicatesRemoved?: number;
}
interface PriceFilter {
  minPrice?: number;
  maxPrice?: number;
}
interface YearFilter {
  minYear?: number;
  maxYear?: number;
}
let appStatus: AppStatus = {
  logined: false,
  stage: 'initializing',
  active: false,
  downloadedImages: 0,
  yearFilterNotFound: false,
  restarting_soon: false
};
let globalPage: Page | null = null;
let globalBrowser: any = null;
let categories: CategoryData[] = [];
let apiServer: any = null;

interface AppState {
  selectedCategory?: string;
  searchQuery?: string;
  location?: string;
  radius?: number;
  minPrice?: number;
  maxPrice?: number;
  minYear?: number;
  maxYear?: number;
  maxAgeMinutes?: number;
}

let currentAppState: AppState = {};

function getRandomDelay(min: number = 100, max: number = 500): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getHumanTypingDelay(): number {
  return Math.floor(Math.random() * 80) + 20;
}

async function humanMouseMove(page: Page, fromX?: number, fromY?: number, toX?: number, toY?: number) {
  try {
    const viewport = page.viewportSize();
    if (!viewport) return;

    const startX = fromX || Math.random() * viewport.width;
    const startY = fromY || Math.random() * viewport.height;
    const endX = toX || Math.random() * viewport.width;
    const endY = toY || Math.random() * viewport.height;

    const steps = Math.floor(Math.random() * 10) + 5;

    for (let i = 0; i <= steps; i++) {
      const x = startX + (endX - startX) * (i / steps) + (Math.random() - 0.5) * 10;
      const y = startY + (endY - startY) * (i / steps) + (Math.random() - 0.5) * 10;

      await page.mouse.move(x, y);
      await page.waitForTimeout(getRandomDelay(10, 30));
    }
  } catch (error) {
    console.log('Ошибка движения мыши:', error);
  }
}

async function humanClick(page: Page, element: any, options: any = {}) {
  try {
    const box = await element.boundingBox();
    if (!box) {
      await element.click(options);
      return;
    }

    const x = box.x + box.width * (0.3 + Math.random() * 0.4);
    const y = box.y + box.height * (0.3 + Math.random() * 0.4);

    await humanMouseMove(page, undefined, undefined, x, y);
    await page.waitForTimeout(getRandomDelay(50, 150));

    await page.mouse.down();
    await page.waitForTimeout(getRandomDelay(20, 80));
    await page.mouse.up();

    await page.waitForTimeout(getRandomDelay(100, 300));
  } catch (error) {
    console.log('Ошибка человеческого клика, использую обычный:', error);
    try {
      await element.click(options);
    } catch (fallbackError) {
      const errorMsg = `ОШИБКА КЛИКА: Не удалось выполнить клик ни человеческим методом, ни обычным. Оригинальная ошибка: ${error}. Ошибка запасного метода: ${fallbackError}`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }
  }
}

async function humanType(page: Page, element: any, text: string) {
  try {
    await humanClick(page, element);
    await page.waitForTimeout(getRandomDelay(100, 200));

    for (const char of text) {
      await page.keyboard.type(char);
      await page.waitForTimeout(getHumanTypingDelay());
    }

    // Проверяем, что текст действительно был введен
    try {
      const currentValue = await element.evaluate((el: HTMLInputElement) => el.value || el.textContent);
      if (currentValue && !currentValue.includes(text)) {
        throw new Error(`Текст не был введен корректно. Ожидался '${text}', получено '${currentValue}'`);
      }
    } catch (checkError) {
      console.log('Невозможно проверить введенный текст:', checkError);
      // Продолжаем выполнение, так как не все элементы имеют свойство value
    }

    await page.waitForTimeout(getRandomDelay(200, 500));
  } catch (error) {
    console.log('Ошибка человеческого ввода, использую обычный:', error);
    try {
      await element.type(text);

      // Дополнительная проверка после обычного ввода
      try {
        const currentValue = await element.evaluate((el: HTMLInputElement) => el.value || el.textContent);
        if (currentValue && !currentValue.includes(text)) {
          throw new Error(`Текст не был введен корректно. Ожидался '${text}', получено '${currentValue}'`);
        }
      } catch (checkError) {
        // Проигнорируем ошибку проверки
      }
    } catch (fallbackError) {
      const errorMsg = `ОШИБКА ВВОДА: Не удалось ввести текст '${text}' ни человеческим методом, ни обычным. Оригинальная ошибка: ${error}. Ошибка запасного метода: ${fallbackError}`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }
  }
}

async function detectDeadBrowser(): Promise<boolean> {
  try {
    if (!globalPage) return true;

    await globalPage.evaluate(() => document.title);
    return false;
  } catch (error) {
    console.log('Обнаружен мертвый браузер:', error);
    return true;
  }
}

async function detectFacebookError(): Promise<boolean> {
  try {
    if (!globalPage) return false;

    // Проверка точного селектора ошибки
    const errorElement = await globalPage.$('span.x193iq5w.xeuugli.x13faqbe.x1vvkbs.x1xmvt09.x1lliihq.x1s928wv.xhkezso.x1gmr53x.x1cpjm7i.x1fgarty.x1943h6x.xtoi2st.x3x7a5m.x1603h9y.x1u7k74.x1xlr1w8.xi81zsa.x2b8uid[dir="auto"]');

    if (errorElement) {
      const text = await errorElement.textContent();
      if (text && text.includes('Произошла ошибка')) {
        console.log('🚨 Обнаружена ошибка Facebook по точному селектору');
        return true;
      }
    }

    // Запасная проверка по тексту
    const errorByText = await globalPage.locator('text=Произошла ошибка').first();
    if (await errorByText.count() > 0) {
      console.log('🚨 Обнаружена ошибка Facebook по тексту');
      return true;
    }

    return false;
  } catch (error) {
    console.log('Ошибка при проверке состояния Facebook:', error);
    return false;
  }
}

async function restartBrowser(): Promise<boolean> {
  try {
    console.log('🔄 Начинаю полный перезапуск браузера...');

    if (globalPage) {
      try {
        const browser = globalPage.context().browser();
        globalPage = null;
        if (browser) {
          await browser.close();
        }
      } catch (e) {
        console.log('Ошибка при закрытии старого браузера:', e);
      }
    }

    if (globalBrowser) {
      try {
        await globalBrowser.close();
      } catch (e) {
        console.log('Ошибка при закрытии глобального браузера:', e);
      }
      globalBrowser = null;
    }

    await cleanupSingletonLock();
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Используем абсолютный путь для директории сессии
    const userDataDir = path.resolve(__dirname, '../../backend/sessions/fb-browser-session');

    try {
      globalBrowser = await firefox.launchPersistentContext(userDataDir, {
        headless: false,
        viewport: { width: 1366, height: 768 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
        args: [
          '--disable-extensions',
          '--disable-notifications',
          '--disable-popup-blocking'
        ],
        acceptDownloads: true,
        bypassCSP: true,
        ignoreHTTPSErrors: true,
        javaScriptEnabled: true,
        offline: false,
        permissions: ['notifications', 'geolocation']
      });

      const page = await globalBrowser.newPage();
      globalPage = page;

      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined,
          configurable: true
        });

        Object.defineProperty(navigator, 'plugins', {
          get: () => ({
            length: 3,
            0: { name: 'Chrome PDF Plugin', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
            1: { name: 'Chrome PDF Viewer', description: '', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
            2: { name: 'Native Client', description: '', filename: 'internal-nacl-plugin' }
          }),
          configurable: true
        });

        Object.defineProperty(navigator, 'languages', {
          get: () => ['ru-RU', 'ru', 'en-US', 'en'],
          configurable: true
        });
      });

      await page.goto('https://www.facebook.com/marketplace', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });

      await page.waitForTimeout(getRandomDelay(2000, 4000));
      await humanMouseMove(page);

      await handleCheckpoints(page);

      console.log('✅ Браузер успешно перезапущен');
      updateStatus({ active: true, stage: 'browser_restarted' });

      return true;
    } catch (error) {
      console.error('❌ Ошибка при перезапуске браузера:', error);
      return false;
    }
  } catch (error) {
    console.error('❌ Критическая ошибка перезапуска:', error);
    return false;
  }
}

async function autoRecover(): Promise<boolean> {
  try {
    console.log('🔄 Начинаю автовосстановление после ошибки Facebook...');

    // Сохраняем текущее состояние фильтров
    const savedState = { ...currentAppState };

    // Полный перезапуск браузера
    const restarted = await restartBrowser();
    if (!restarted) {
      console.log('❌ Не удалось перезапустить браузер при автовосстановлении');
      return false;
    }

    // Восстанавливаем состояние
    currentAppState = savedState;
    await restoreState();

    // Восстанавливаем фильтры если они есть
    if (currentAppState.location && currentAppState.radius) {
      try {
        console.log('🔧 Восстанавливаю фильтр местоположения...');
        await new Promise(resolve => setTimeout(resolve, 2000));

        const mockReq = { body: { city: currentAppState.location, radius: currentAppState.radius } } as any;
        const mockRes = {
          status: () => ({ json: () => { } }),
          json: () => { },
          send: () => { }
        } as any;

        await handleSetLocation(mockReq, mockRes);
        console.log('✅ Фильтр местоположения восстановлен');
      } catch (e) {
        console.log('⚠️ Ошибка восстановления местоположения:', e);
      }
    }

    if (currentAppState.minPrice !== undefined || currentAppState.maxPrice !== undefined) {
      try {
        console.log('🔧 Восстанавливаю фильтр цены...');
        await new Promise(resolve => setTimeout(resolve, 1000));

        const mockReq = { body: { minPrice: currentAppState.minPrice, maxPrice: currentAppState.maxPrice } } as any;
        const mockRes = {
          status: () => ({ json: () => { } }),
          json: () => { },
          send: () => { }
        } as any;

        await handleSetPriceFilter(mockReq, mockRes);
        console.log('✅ Фильтр цены восстановлен');
      } catch (e) {
        console.log('⚠️ Ошибка восстановления цены:', e);
      }
    }

    if (currentAppState.minYear !== undefined || currentAppState.maxYear !== undefined) {
      try {
        console.log('🔧 Восстанавливаю фильтр года...');
        await new Promise(resolve => setTimeout(resolve, 1000));

        const mockReq = { body: { minYear: currentAppState.minYear, maxYear: currentAppState.maxYear } } as any;
        const mockRes = {
          status: () => ({ json: () => { } }),
          json: () => { },
          send: () => { }
        } as any;

        await handleSetYearFilter(mockReq, mockRes);
        console.log('✅ Фильтр года восстановлен');
      } catch (e) {
        console.log('⚠️ Ошибка восстановления года:', e);
      }
    }

    console.log('✅ Автовосстановление завершено успешно');
    return true;
  } catch (error) {
    console.error('❌ Ошибка автовосстановления:', error);
    return false;
  }
}

async function handleCriticalError(errorContext: string, error: any): Promise<boolean> {
  console.log(`🚨 Критическая ошибка в ${errorContext}: ${error}`);

  // Попытка автовосстановления
  const recovered = await autoRecover();
  if (recovered) {
    console.log(`✅ Автовосстановление после ошибки в ${errorContext} успешно`);
    return true;
  }

  console.log(`❌ Автовосстановление после ошибки в ${errorContext} не удалось`);
  return false;
}

async function handleRestartBrowser(req: Request, res: Response): Promise<Response> {
  try {
    console.log('🔄 Принудительный перезапуск браузера через API...');

    const restarted = await restartBrowser();
    if (restarted) {
      await restoreState();
      return res.json({
        success: true,
        message: "Браузер успешно перезапущен и настроен",
        status: "restarted"
      });
    } else {
      return res.status(500).json({
        success: false,
        error: "Не удалось перезапустить браузер",
        status: "restart_failed"
      });
    }
  } catch (error) {
    console.error('❌ Ошибка принудительного перезапуска:', error);
    return res.status(500).json({
      success: false,
      error: `Ошибка перезапуска браузера: ${error}`,
      status: "error"
    });
  }
}

async function applyLast24HoursFilter(): Promise<boolean> {
  if (!globalPage) return false;

  try {
    console.log('🕐 Применяю фильтр "Последние 24 часа"...');

    // Подход 1: Приоритетный - через URL-параметры (надежнее)
    try {
      console.log('🔥 Применение фильтров через URL...');
      const currentUrl = globalPage.url();
      let newUrl = currentUrl;

      // Добавляем параметр сортировки по дате создания
      if (!newUrl.includes('sortBy=')) {
        newUrl += (newUrl.includes('?') ? '&' : '?') + 'sortBy=creation_time_descend';
      } else {
        newUrl = newUrl.replace(/sortBy=[^&]+/, 'sortBy=creation_time_descend');
      }

      // Добавляем параметр фильтра времени (24 часа)
      if (!newUrl.includes('daysSinceListed=')) {
        newUrl += '&daysSinceListed=1';
      } else {
        newUrl = newUrl.replace(/daysSinceListed=[^&]+/, 'daysSinceListed=1');
      }

      if (newUrl !== currentUrl) {
        console.log(`🚀 Переход на URL с фильтрами: ${newUrl}`);
        await globalPage.goto(newUrl, { timeout: 30000 });
        await globalPage.waitForTimeout(3000);

        // Проверяем, что фильтры действительно применились
        const urlAfterNavigation = globalPage.url();
        if (urlAfterNavigation.includes('sortBy=creation_time_descend') && urlAfterNavigation.includes('daysSinceListed=1')) {
          console.log('✅ УСПЕХ! Фильтры применены через URL - "Последние 24 часа" + сортировка по дате');
          return true;
        } else {
          console.log('⚠️ Фильтры в URL не обнаружены после навигации, переходим к кликам...');
        }
      } else {
        console.log('⚠️ URL не изменился, переходим к кликам...');
      }
    } catch (urlError) {
      console.log(`⚠️ Ошибка при попытке применить фильтры через URL: ${urlError}`);
    }

    // Подход 2: Резервный - через клики (если URL не сработал)
    console.log('🔥 Применяю фильтры через последовательность кликов...');

    // Шаг 1: Поиск и клик на кнопку сортировки
    console.log('🔍 Шаг 1: Клик на "Сортировка:"');
    const sortButtonSelectors = [
      'text=Сортировка:',
      '*:has-text("Сортировка:")',
      'span:has-text("Сортировка:")',
      'div[role="button"]:has-text("Сортировка:")'
    ];

    let sortButtonClicked = false;

    // Попытка через обычные селекторы
    for (const selector of sortButtonSelectors) {
      try {
        console.log(`Попытка клика по селектору: ${selector}`);
        const element = globalPage.locator(selector).first();
        if (await element.count() > 0 && await element.isVisible()) {
          await element.click({ timeout: 5000 });
          console.log(`✅ text селектор сработал: ${selector}`);
          sortButtonClicked = true;
          break;
        }
      } catch (e) {
        console.log(`❌ text селектор не сработал: ${e}`);
      }
    }

    // Если обычные селекторы не сработали, пробуем JavaScript
    if (!sortButtonClicked) {
      try {
        console.log('🔧 Пробую найти кнопку сортировки через JavaScript...');
        const jsResult = await globalPage.evaluate(() => {
          // Ищем по тексту "Сортировка:"
          const elements = Array.from(document.querySelectorAll('*'));
          for (const el of elements) {
            if (el.textContent && el.textContent.includes('Сортировка:') &&
              (el.tagName === 'SPAN' || el.tagName === 'DIV') &&
              el.getAttribute('role') === 'button') {
              (el as HTMLElement).click();
              return true;
            }
          }
          return false;
        });

        if (jsResult) {
          console.log('✅ JavaScript поиск кнопки сортировки успешен');
          sortButtonClicked = true;
        }
      } catch (jsError) {
        console.log(`❌ JavaScript поиск не удался: ${jsError}`);
      }
    }

    if (!sortButtonClicked) {
      console.log('⚠️ Не удалось кликнуть на "Сортировка:", но продолжаем работу');
      return false;
    }

    await globalPage.waitForTimeout(1500);

    // Шаг 2: Выбор "Дата публикации: сначала новые"
    console.log('🔍 Шаг 2: Выбор "Дата публикации: сначала новые"...');
    let datePublicationClicked = false;

    try {
      const datePublicationElement = await globalPage.locator('span', {
        hasText: 'Дата публикации: сначала новые'
      }).first();

      if (await datePublicationElement.count() > 0) {
        await datePublicationElement.click();
        datePublicationClicked = true;
        await globalPage.waitForTimeout(1500);
      }
    } catch (error) {
      console.log(`Не удалось кликнуть на "Дата публикации: сначала новые" через локатор: ${error}`);
    }

    if (!datePublicationClicked) {
      try {
        const jsResult = await globalPage.evaluate(() => {
          const spans = Array.from(document.querySelectorAll('span[id^="_R_"], span'));
          for (const span of spans) {
            if (span.textContent && span.textContent.includes('Дата публикации: сначала')) {
              (span as HTMLElement).click();
              return true;
            }
          }
          return false;
        });

        if (jsResult) {
          datePublicationClicked = true;
          await globalPage.waitForTimeout(1500);
        }
      } catch (jsError) {
        console.log(`Ошибка при попытке клика через JavaScript: ${jsError}`);
      }
    }

    if (!datePublicationClicked) {
      console.log('⚠️ Не удалось выбрать "Дата публикации: сначала новые"');
      return false;
    }

    // Шаг 3: Клик на фильтр "Дата размещения"
    console.log('🔍 Шаг 3: Клик на фильтр "Дата размещения"...');
    let timeFilterClicked = false;

    try {
      const timeFilterElement = await globalPage.locator('span', {
        hasText: 'Дата размещения'
      }).first();

      if (await timeFilterElement.count() > 0) {
        await timeFilterElement.click();
        timeFilterClicked = true;
        await globalPage.waitForTimeout(1000);
      }
    } catch (error) {
      console.log(`Не удалось кликнуть на "Дата размещения" через локатор: ${error}`);
    }

    if (!timeFilterClicked) {
      try {
        const jsResult = await globalPage.evaluate(() => {
          const elements = Array.from(document.querySelectorAll('span, div'));
          for (const el of elements) {
            if (el.textContent && el.textContent.includes('Дата размещения')) {
              (el as HTMLElement).click();
              return true;
            }
          }
          return false;
        });

        if (jsResult) {
          timeFilterClicked = true;
          await globalPage.waitForTimeout(1000);
        }
      } catch (jsError) {
        console.log(`Ошибка при попытке клика через JavaScript: ${jsError}`);
      }
    }

    if (!timeFilterClicked) {
      console.log('⚠️ Не удалось кликнуть на фильтр "Дата размещения"');
      return false;
    }

    // Шаг 4: Выбор "Последние 24 часа"
    console.log('🔍 Шаг 4: Выбор "Последние 24 часа"...');
    let last24HoursClicked = false;

    try {
      const last24HoursElement = await globalPage.locator('span', {
        hasText: 'Последние 24 часа'
      }).first();

      if (await last24HoursElement.count() > 0) {
        await last24HoursElement.click();
        last24HoursClicked = true;
        await globalPage.waitForTimeout(1500);
      }
    } catch (error) {
      console.log(`Не удалось кликнуть на "Последние 24 часа" через локатор: ${error}`);
    }

    if (!last24HoursClicked) {
      try {
        const jsResult = await globalPage.evaluate(() => {
          const spans = Array.from(document.querySelectorAll('span[id^="_R_"], span'));
          for (const span of spans) {
            if (span.textContent && span.textContent.includes('Последние 24 часа')) {
              (span as HTMLElement).click();
              return true;
            }
          }
          return false;
        });

        if (jsResult) {
          last24HoursClicked = true;
          await globalPage.waitForTimeout(1500);
        }
      } catch (jsError) {
        console.log(`Ошибка при попытке клика через JavaScript: ${jsError}`);
      }
    }

    if (last24HoursClicked) {
      console.log('✅ Успешно выбрана опция "Последние 24 часа"');
      return true;
    } else {
      console.log('⚠️ Не удалось выбрать опцию "Последние 24 часа"');
      return false;
    }

  } catch (error) {
    console.error('❌ Ошибка при применении фильтра "Последние 24 часа":', error);
    return false;
  }
}

async function restoreState(): Promise<void> {
  try {
    if (!globalPage) return;

    console.log('🔧 Восстанавливаю состояние приложения...');

    if (currentAppState.selectedCategory) {
      console.log(`Восстанавливаю категорию: ${currentAppState.selectedCategory}`);
      const targetCategory = categories.find(c => c.name === currentAppState.selectedCategory);
      if (targetCategory) {
        try {
          const found = await globalPage.evaluate((categoryName) => {
            const spans = Array.from(document.querySelectorAll('span.x193iq5w'));
            for (const span of spans) {
              if (span.textContent?.trim() === categoryName) {
                span.dispatchEvent(new MouseEvent('click', {
                  view: window,
                  bubbles: true,
                  cancelable: true,
                  buttons: 1
                }));
                return true;
              }
            }
            return false;
          }, currentAppState.selectedCategory);

          if (found) {
            await globalPage.waitForTimeout(getRandomDelay(1000, 2000));
          }
        } catch (e) {
          console.log('Ошибка восстановления категории:', e);
        }
      }
    }

    if (currentAppState.searchQuery) {
      console.log(`Восстанавливаю поиск: ${currentAppState.searchQuery}`);
      try {
        const searchInput = await globalPage.$('input[type="search"][placeholder="Поиск в Marketplace"]');
        if (searchInput) {
          await humanType(globalPage, searchInput, currentAppState.searchQuery);
          await globalPage.keyboard.press('Enter');
          await globalPage.waitForTimeout(getRandomDelay(2000, 3000));
        }
      } catch (e) {
        console.log('Ошибка восстановления поиска:', e);
      }
    }

    // Восстанавливаем геолокацию и применяем фильтр "Последние 24 часа"
    if (currentAppState.location && (currentAppState.radius !== undefined)) {
      console.log(`Восстанавливаю геолокацию: ${currentAppState.location}, радиус: ${currentAppState.radius} миль`);
      try {
        // Применяем фильтр "Последние 24 часа" при восстановлении состояния
        const filterApplied = await applyLast24HoursFilter();
        if (filterApplied) {
          console.log('✅ Фильтр "Последние 24 часа" успешно применен при восстановлении состояния');
        } else {
          console.log('⚠️ Не удалось применить фильтр "Последние 24 часа" при восстановлении состояния');
        }
      } catch (e) {
        console.log('Ошибка восстановления фильтра "Последние 24 часа":', e);
      }
    }

    console.log('✅ Состояние восстановлено');
  } catch (error) {
    console.error('❌ Ошибка восстановления состояния:', error);
  }
}
try {
  const categoriesPath = path.join(process.cwd(), 'fb-mk.json');
  if (fs.existsSync(categoriesPath)) {
    const rawData = fs.readFileSync(categoriesPath, 'utf8');
    const jsonData = JSON.parse(rawData);
    categories = jsonData.categories || [];
  }
} catch (error) {
  console.error('Ошибка загрузки категорий:', error);
}
function updateStatus(updates: Partial<AppStatus>) {
  appStatus = { ...appStatus, ...updates };
  console.log(`<status>${JSON.stringify(appStatus)}</status>`);
}
function setupApiServer() {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.get('/status', (req, res) => {
    res.json({
      ...appStatus,
      categoriesCount: categories.length
    });
  });
  app.get('/categories', (req, res) => {
    res.json(categories);
  });
  app.get('/port', (req, res) => {
    res.json({
      port: API_PORT
    });
  });
  app.post('/search', (req, res) => {
    handleSearch(req, res).catch(error => {
      res.status(500).json({
        success: false,
        error: String(error)
      });
    });
  });
  app.post('/set-price-filter', (req, res) => {
    handleSetPriceFilter(req, res).catch(error => {
      res.status(500).json({
        success: false,
        error: String(error)
      });
    });
  });
  app.post('/set-year-filter', (req, res) => {
    handleSetYearFilter(req, res).catch(error => {
      res.status(500).json({
        success: false,
        error: String(error)
      });
    });
  });
  app.post('/set-location', (req, res) => {
    handleSetLocation(req, res).catch(error => {
      res.status(500).json({
        success: false,
        error: String(error)
      });
    });
  });
  app.get('/listings', (req, res) => {
    const count = req.query.count ? parseInt(req.query.count as string) : 5;
    handleGetListings(req, res, count).catch(error => {
      res.status(500).json({
        success: false,
        error: String(error)
      });
    });
  });
  app.post('/refresh-page', (req, res) => {
    handleRefreshPage(req, res).catch(error => {
      res.status(500).json({
        success: false,
        error: String(error)
      });
    });
  });
  app.post('/navigate-to-marketplace', (req, res) => {
    handleNavigateToMarketplace(req, res).catch(error => {
      res.status(500).json({
        success: false,
        error: String(error)
      });
    });
  });
  app.post('/restart-browser', (req, res) => {
    handleRestartBrowser(req, res).catch(error => {
      res.status(500).json({
        success: false,
        error: String(error)
      });
    });
  });
  app.post('/set-age-filter', (req, res) => {
    handleSetAgeFilter(req, res).catch(error => {
      res.status(500).json({
        success: false,
        error: String(error)
      });
    });
  });
  app.post('/clear-image-cache', (req, res) => {
    handleClearImageCache(req, res).catch(error => {
      res.status(500).json({ success: false, error: String(error) });
    });
  });
  app.post('/geocode-city', (req, res) => {
    handleGeocodeCity(req, res).catch((error: any) => {
      res.status(500).json({ success: false, error: String(error) });
    });
  });
  return new Promise<number>((resolve, reject) => {
    function tryListen(port: number, backupIndex: number = 0) {
      apiServer = app.listen(port, () => {
        const actualPort = (apiServer.address() as AddressInfo).port;
        console.log(`API сервер запущен на порту ${actualPort}`);
        console.log(`Статус: http://localhost:${actualPort}/status`);
        console.log(`Информация о порте: http://localhost:${actualPort}/port`);
        console.log(`Категории: http://localhost:${actualPort}/categories`);
        console.log(`Выбор категории: POST http://localhost:${actualPort}/select-category с JSON {"category":"Имя категории"}`);
        console.log(`Установка фильтра цены: POST http://localhost:${actualPort}/set-price-filter с JSON {"minPrice":1000, "maxPrice":5000}`);
        console.log(`Поиск: POST http://localhost:${actualPort}/search с JSON {"query":"Ключевые слова для поиска"}`);
        console.log(`Получить товары: GET http://localhost:${actualPort}/listings?count=5`);
        console.log(`Навигация на базовую страницу: POST http://localhost:${actualPort}/navigate-to-marketplace`);
        API_PORT = actualPort;
        try {
          const portFilePath = path.join(process.cwd(), 'api_port.txt');
          fs.writeFileSync(portFilePath, actualPort.toString(), 'utf8');
          console.log(`Текущий порт API (${actualPort}) сохранен в файл: ${portFilePath}`);
        } catch (err) {
          console.error(`Ошибка при сохранении порта в файл: ${err}`);
        }
        resolve(actualPort);
      }).on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          console.log(`Порт ${port} занят, пробую следующий...`);
          if (backupIndex < BACKUP_PORTS.length) {
            tryListen(BACKUP_PORTS[backupIndex], backupIndex + 1);
          } else {
            tryListen(0);
          }
        } else {
          console.error(`Ошибка запуска API сервера: ${err}`);
          reject(err);
        }
      });
    }
    tryListen(API_PORT);
  });
}
async function handleSetPriceFilter(req: Request, res: Response): Promise<Response> {
  if (!globalPage) {
    return res.status(400).json({
      success: false,
      error: "Браузер не инициализирован"
    });
  }
  const { minPrice, maxPrice } = req.body;
  if ((minPrice === undefined || minPrice === null) && (maxPrice === undefined || maxPrice === null)) {
    return res.status(400).json({
      success: false,
      error: "Необходимо указать хотя бы один параметр: minPrice или maxPrice"
    });
  }
  try {
    console.log(`Устанавливаю фильтр цены: минимум ${minPrice || '-'}, максимум ${maxPrice || '-'}`);

    const minPriceSelectors = [
      'input[placeholder="Мин."][aria-label="Минимум"]',
      'input[placeholder="Мин."]',
      'input.x1i10hfl.xggy1nq.xtpw4lu.x1tutvks.x1s3xk63.x1s07b3s.x1kdt53j.x1a2a7pz.xmjcpbm.x8cjs6t.x3sou0m.x80vd3b.x12u81az.xhk9q7s.x1otrzb0.x1i1ezom.x1o6z2jb.x13fuv20.x18b5jzi.x1q0q8m5.x1t7ytsu.x178xt8z.x1lun4ml.xso031l.xpilrb4.x9f619.xzsf02u.x1qlqyl8.xk50ysn.x6ikm8r.x1y1aw1k.xwib8y2.x1g0dm76.xpdmqnj.xh8yej3.xha3pab.xyc4ar7.x1b3pals.x10bruuh.x108a08w.x1fiakjg.xacio93.xr7akr5.x1yc453h.xc9qbxq[placeholder="Мин."][aria-label="Минимум"]'
    ];

    const maxPriceSelectors = [
      'input[placeholder="Макс."][aria-label="Максимум"]',
      'input[placeholder="Макс."]',
      'label.xzsf02u.x6prxxf input.x1i10hfl.xggy1nq.xtpw4lu.x1tutvks.x1s3xk63.x1s07b3s.x1kdt53j.x1a2a7pz.xmjcpbm.x8cjs6t.x3sou0m.x80vd3b.x12u81az.xhk9q7s.x1otrzb0.x1i1ezom.x1o6z2jb.x13fuv20.x18b5jzi.x1q0q8m5.x1t7ytsu.x178xt8z.x1lun4ml.xso031l.xpilrb4.x9f619.xzsf02u.x1qlqyl8.xk50ysn.x6ikm8r.x1y1aw1k.xwib8y2.x1g0dm76.xpdmqnj.xh8yej3.xha3pab.xyc4ar7.x1b3pals.x10bruuh.x108a08w.x1fiakjg.xacio93.xr7akr5.x1yc453h.xc9qbxq[placeholder="Макс."][aria-label="Максимум"]'
    ];

    if (minPrice !== undefined && minPrice !== null) {
      const minPriceInput = await findElement(globalPage, minPriceSelectors, 'поле минимальной цены');
      if (minPriceInput) {
        await safeType(globalPage, minPriceInput, minPrice.toString());
        console.log(`Установлено значение минимальной цены: ${minPrice}`);
      }
    }

    if (maxPrice !== undefined && maxPrice !== null) {
      const maxPriceInput = await findElement(globalPage, maxPriceSelectors, 'поле максимальной цены');
      if (maxPriceInput) {
        await safeType(globalPage, maxPriceInput, maxPrice.toString());
        console.log(`Установлено значение максимальной цены: ${maxPrice}`);
      }
    }

    await globalPage.waitForTimeout(1000);

    // Сохраняем фильтры цены в состояние для автовосстановления
    currentAppState.minPrice = minPrice !== undefined && minPrice !== null ? minPrice : undefined;
    currentAppState.maxPrice = maxPrice !== undefined && maxPrice !== null ? maxPrice : undefined;

    return res.json({
      success: true,
      message: `Фильтр цены установлен: мин=${minPrice || '-'}, макс=${maxPrice || '-'}`,
      status: "completed"
    });
  } catch (error) {
    console.error(`Ошибка при установке фильтра цены: ${error}`);
    return res.status(500).json({
      success: false,
      error: `Не удалось установить фильтр цены: ${error}`,
      status: "failed"
    });
  }
}
async function handleSearch(req: Request, res: Response): Promise<Response> {
  if (!globalPage) {
    return res.status(400).json({
      success: false,
      error: "Браузер не инициализирован"
    });
  }
  const { query } = req.body;
  if (!query || typeof query !== 'string') {
    return res.status(400).json({
      success: false,
      error: "Необходимо указать параметр query с текстом для поиска"
    });
  }
  try {
    await handleCheckpoints(globalPage);
    console.log(`Выполняю поиск по запросу: "${query}"`);

    // Селекторы, проверенные на работоспособность в последних версиях Facebook Marketplace
    const searchSelectors = [
      '.x9f619:nth-child(2) > div:nth-child(1) > .xjp7ctv:nth-child(1) [placeholder="Поиск в Marketplace"]',
      'input[type="search"][placeholder="Поиск в Marketplace"]',
      'input[aria-label="Поиск в Marketplace"]',
      'input[type="search"]',
      '.x18bame2 > [placeholder="Поиск в Marketplace"]'
    ];

    // Ищем поле поиска
    let searchInput = null;

    for (const selector of searchSelectors) {
      try {
        searchInput = await globalPage.$(selector);
        if (searchInput) {
          console.log(`Найдено поле поиска по селектору: ${selector}`);
          break;
        }
      } catch (e) {
        console.log(`Селектор не работает: ${selector}`);
      }
    }

    if (!searchInput) {
      return res.status(404).json({
        success: false,
        error: "Не удалось найти поле поиска на странице"
      });
    }

    // Очистка поля поиска
    try {
      await globalPage.fill(searchSelectors[0], '');
      console.log('Поле поиска очищено');
    } catch (clearError) {
      try {
        await searchInput.click({ clickCount: 3 });
        await globalPage.keyboard.press('Backspace');
        console.log('Поле поиска очищено через clickCount и Backspace');
      } catch (e) {
        console.log('Ошибка при очистке поля поиска:', e);
      }
    }

    await globalPage.waitForTimeout(300);

    // Ввод текста в поле поиска
    try {
      await globalPage.fill(searchSelectors[0], query);
      console.log('Текст введен через fill');
    } catch (fillError) {
      try {
        await searchInput.type(query);
        console.log('Текст введен через type');
      } catch (typeError) {
        try {
          // Используем функцию для вставки текста через JavaScript
          const fillByJs = async (text: string): Promise<boolean> => {
            if (!globalPage) return false;
            return await globalPage.evaluate(text => {
              const selectors = [
                '.x9f619:nth-child(2) > div:nth-child(1) > .xjp7ctv:nth-child(1) [placeholder="Поиск в Marketplace"]',
                'input[type="search"][placeholder="Поиск в Marketplace"]',
                'input[aria-label="Поиск в Marketplace"]',
                'input[type="search"]',
                '.x18bame2 > [placeholder="Поиск в Marketplace"]'
              ];

              for (const selector of selectors) {
                try {
                  const input = document.querySelector(selector) as HTMLInputElement;
                  if (input) {
                    input.value = text;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    return true;
                  }
                } catch (e) { }
              }
              return false;
            }, query);
          };

          await fillByJs(query);
          console.log('Текст введен через JavaScript');
        } catch (jsError) {
          return res.status(500).json({
            success: false,
            error: "Не удалось ввести текст в поле поиска всеми доступными методами"
          });
        }
      }
    }

    // Нажатие Enter для выполнения поиска
    try {
      await globalPage.keyboard.press('Enter');
      await globalPage.waitForTimeout(3000);
      console.log('Выполнен поиск нажатием Enter');
    } catch (enterError) {
      try {
        await globalPage.evaluate(() => {
          const form = document.querySelector('form');
          if (form) form.submit();
        });
        await globalPage.waitForTimeout(3000);
        console.log('Выполнен поиск через submit формы');
      } catch (submitError) {
        return res.status(500).json({
          success: false,
          error: "Не удалось выполнить поиск"
        });
      }
    }

    // Проверка успешности поиска
    const currentUrl = globalPage.url();
    if (currentUrl.includes('/search') || currentUrl.includes('q=')) {
      console.log(`Поиск выполнен успешно`);
      currentAppState.searchQuery = query;
      return res.json({
        success: true,
        message: `Поиск по запросу "${query}" выполнен успешно`,
        status: "completed",
        searchQuery: query
      });
    } else {
      return res.json({
        success: false,
        error: "Поиск не был выполнен",
        status: "failed"
      });
    }
  } catch (error) {
    console.error(`Ошибка при выполнении поиска: ${error}`);
    return res.status(500).json({
      success: false,
      error: `Не удалось выполнить поиск: ${error}`,
      status: "failed"
    });
  }
}


function extractYearFromTitle(title: string): number | null {
  const yearMatch = title.match(/\b(19|20)\d{2}\b/);
  if (yearMatch && yearMatch[0]) {
    return parseInt(yearMatch[0], 10);
  }
  return null;
}

function extractModelNameFromTitle(title: string): string {
  try {
    // Находим год в заголовке
    const yearMatch = title.match(/^\s*(\b(19|20)\d{2}\b)\s*/);

    if (yearMatch && yearMatch[0]) {
      // Удаляем год и лишние пробелы из начала строки
      const modelName = title.replace(yearMatch[0], '').trim();
      return modelName || title; // Возвращаем оригинальный заголовок, если после удаления года ничего не осталось
    }

    // Если год не найден в начале, возвращаем оригинальный заголовок
    return title;
  } catch (error) {
    console.log('Ошибка при извлечении названия модели:', error);
    return title;
  }
}

// Парсинг строки "17 ч. назад", "неделю назад" → минуты
function parseAgeToMinutes(raw: string): number | null {
  try {
    raw = raw.toLowerCase().trim();
    // Удаляем лишние символы
    raw = raw.replace(/\s+/g, ' ');
    // Минуты
    if (/^(\d{1,2}) ?мин(\.|ут|уты|уту|утами)?/.test(raw)) {
      const m = raw.match(/(\d{1,2}) ?мин/);
      if (!m) return null;
      const val = parseInt(m[1], 10);
      if (val >= 1 && val <= 59) return val;
      return null;
    }
    // Часы
    if (/^(\d{1,2}) ?ч(\.|ас|аса|асов|асами)?/.test(raw) || /^(\d{1,2}) ?час(а|ов|ами)?/.test(raw)) {
      const m = raw.match(/(\d{1,2}) ?ч/);
      if (!m) return null;
      const val = parseInt(m[1], 10);
      if (val >= 1 && val <= 23) return val * 60;
      return null;
    }
    // Дни
    if (/^(\d{1,2}) ?д(н\.|ень|ня|ней|нями)?/.test(raw) || /^(\d{1,2}) ?день/.test(raw)) {
      const m = raw.match(/(\d{1,2}) ?д/);
      if (!m) return null;
      const val = parseInt(m[1], 10);
      if (val >= 1 && val <= 6) return val * 1440;
      return null;
    }
    // "день назад"
    if (/^день/.test(raw)) return 1440;
    // Неделя
    if (/^недел/.test(raw)) return 10080;
    if (/^(\d{1,2}) ?недел/.test(raw)) {
      const m = raw.match(/(\d{1,2}) ?недел/);
      if (!m) return null;
      const val = parseInt(m[1], 10);
      if (val >= 1 && val <= 4) return val * 10080;
      return null;
    }
    // "день", "дня", "дн." без числа
    if (/^д(ень|ня|н\.)/.test(raw)) return 1440;
    // "неделю", "нед.", "нед назад"
    if (/^нед(елю|\.|\b)/.test(raw)) return 10080;
    return null;
  } catch {
    return null;
  }
}

// Открываем карточку объявления и возвращаем возраст в минутах
async function getListingAgeMinutes(url: string): Promise<number | null> {
  if (!globalBrowser) return null;
  let page: Page | null = null;
  try {
    page = await globalBrowser.newPage();
    if (!page) return null;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(getRandomDelay(500, 1000));
    const abbr = await page.$('abbr[aria-label]');
    if (!abbr) return null;
    const label = await abbr.getAttribute('aria-label');
    if (!label) return null;
    const minutes = parseAgeToMinutes(label);
    return minutes;
  } catch (e) {
    console.log('Ошибка getListingAgeMinutes:', e);
    return null;
  } finally {
    if (page) {
      try { await page.close(); } catch { }
    }
  }
}

async function handleNavigateToMarketplace(req: Request, res: Response): Promise<Response> {
  if (!globalPage) {
    return res.status(400).json({
      success: false,
      error: "Браузер не инициализирован"
    });
  }

  try {
    await handleCheckpoints(globalPage);
    console.log('Навигация на базовую страницу Facebook Marketplace...');
    await globalPage.goto('https://www.facebook.com/marketplace', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    await globalPage.waitForTimeout(2000);

    try {
      console.log('Проверяю наличие всплывающего окна...');
      const closeButton = await globalPage.waitForSelector('div[aria-label="Закрыть"][role="button"]', { timeout: 3000 }).catch(() => null);
      if (closeButton) {
        console.log('Найдена кнопка закрытия всплывающего окна, кликаю...');
        await closeButton.click().catch(err => console.log('Ошибка при клике на кнопку закрытия:', err));
        await globalPage.waitForTimeout(1000);
        console.log('Всплывающее окно закрыто');
      }
    } catch (err) {
      console.log('Ошибка при обработке всплывающего окна:', err);
    }

    console.log('Навигация на базовую страницу Marketplace завершена успешно');

    return res.json({
      success: true,
      message: "Успешная навигация на базовую страницу Facebook Marketplace",
      status: "completed"
    });
  } catch (error) {
    console.error(`Ошибка при навигации на Marketplace: ${error}`);
    return res.status(500).json({
      success: false,
      error: `Не удалось перейти на страницу Marketplace: ${error}`,
      status: "failed"
    });
  }
}
async function handleRefreshPage(req: Request, res: Response): Promise<Response> {
  if (!globalPage) {
    return res.status(400).json({
      success: false,
      error: "Браузер не инициализирован"
    });
  }

  try {
    console.log('Обновляю страницу Marketplace...');

    const isDead = await detectDeadBrowser();
    if (isDead) {
      console.log('🔄 Браузер мертв, выполняю полный перезапуск...');
      const restarted = await restartBrowser();
      if (restarted) {
        await restoreState();
        return res.json({
          success: true,
          message: "Браузер перезапущен и состояние восстановлено",
          status: "restarted"
        });
      } else {
        return res.status(500).json({
          success: false,
          error: "Не удалось перезапустить браузер",
          status: "restart_failed"
        });
      }
    }

    await globalPage.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('Страница обновлена успешно');

    return res.json({
      success: true,
      message: "Страница успешно обновлена",
      status: "completed"
    });
  } catch (error) {
    console.log('Ошибка при обновлении страницы:', error);

    // Если ошибка таймаута или критическая - перезапускаем браузер
    if (String(error).includes('Timeout') ||
      String(error).includes('NS_BINDING_ABORTED') ||
      String(error).includes('detached')) {

      console.log('🔄 Обнаружена критическая ошибка браузера, выполняю перезапуск...');
      const recovered = await handleCriticalError('refresh-page', error);

      return res.json({
        success: recovered,
        message: recovered ? 'Страница обновлена после перезапуска браузера' : 'Ошибка перезапуска браузера',
        status: recovered ? "restarted" : "failed"
      });
    }

    return res.status(500).json({
      success: false,
      error: `Не удалось обновить страницу: ${error}`,
      status: "failed"
    });
  }
}
async function handleGetListings(req: Request, res: Response, count: number = 5): Promise<Response> {
  const maxRetries = 3;
  let retryCount = 0;

  while (retryCount < maxRetries) {
    if (!globalPage) {
      return res.status(400).json({
        success: false,
        error: "Браузер не инициализирован"
      });
    }

    try {
      const isDead = await detectDeadBrowser();
      if (isDead) {
        console.log('🔄 Браузер мертв, выполняю перезапуск...');
        const restarted = await restartBrowser();
        if (restarted) {
          await restoreState();
        } else {
          retryCount++;
          if (retryCount >= maxRetries) {
            return res.status(500).json({
              success: false,
              error: "Не удалось перезапустить браузер после нескольких попыток"
            });
          }
          await new Promise(resolve => setTimeout(resolve, 5000 * retryCount));
          continue;
        }
      }

      await handleCheckpoints(globalPage);

      // Проверка ошибки Facebook перед парсингом товаров
      const hasFacebookError = await detectFacebookError();
      if (hasFacebookError) {
        console.log('🔄 Обнаружена ошибка Facebook, запускаю автовосстановление...');
        const recovered = await autoRecover();
        if (recovered) {
          console.log('✅ Автовосстановление завершено, повторяю попытку...');
          retryCount++;
          if (retryCount >= maxRetries) {
            return res.status(500).json({
              success: false,
              error: "Превышено максимальное количество попыток автовосстановления"
            });
          }
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        } else {
          return res.status(500).json({
            success: false,
            error: "Не удалось восстановиться после ошибки Facebook"
          });
        }
      }

      console.log(`Получаю список ${count} товаров с Marketplace... (попытка ${retryCount + 1}/${maxRetries})`);
      const imgDir = path.join(process.cwd(), 'src', 'img');
      if (!fs.existsSync(imgDir)) {
        fs.mkdirSync(imgDir, { recursive: true });
        console.log(`Создана директория для изображений: ${imgDir}`);
      }
      console.log('Ожидаем загрузки товаров...');
      await globalPage.waitForTimeout(3000);
      console.log('Извлекаем данные о товарах...');

      // ГАРАНТИРОВАННОЕ применение фильтров с задержкой 5 секунд между кликами
      console.log('🔥 ГАРАНТИРОВАННЫЙ поиск и применение фильтров с задержкой 5 секунд...');

      // Шаг 1: Клик на "Сортировка:"
      console.log('🔍 Шаг 1: Клик на "Сортировка:"');
      let sortClicked = false;

      try {
        await globalPage.click('text=Сортировка:');
        sortClicked = true;
        console.log('✅ Кликнул на "Сортировка:" через text селектор');
      } catch (error) {
        console.log(`❌ text селектор не сработал: ${error}`);

        try {
          const jsSort = await globalPage.evaluate(() => {
            const spans = Array.from(document.querySelectorAll('span'));
            for (const span of spans) {
              if (span.textContent && span.textContent.includes('Сортировка:')) {
                (span as HTMLElement).click();
                return true;
              }
            }
            return false;
          });

          if (jsSort) {
            sortClicked = true;
            console.log('✅ Кликнул на "Сортировка:" через JavaScript');
          }
        } catch (jsError) {
          console.log(`❌ JavaScript клик не сработал: ${jsError}`);
        }
      }

      if (sortClicked) {
        console.log('⏰ Задержка 5 секунд после клика на "Сортировка:"...');
        await globalPage.waitForTimeout(5000);

        // Шаг 2: Клик на "Дата публикации: сначала новые"
        console.log('🔍 Шаг 2: Клик на "Дата публикации: сначала новые"');
        let datePublicationClicked = false;

        try {
          await globalPage.click('#_r_34_');
          datePublicationClicked = true;
          console.log('✅ Кликнул на "Дата публикации: сначала новые" через ID селектор');
        } catch (error) {
          console.log(`❌ ID селектор не сработал: ${error}`);

          try {
            await globalPage.click('.x153efwv > .xb57i2i div:nth-child(3) > .x1i10hfl .x1qjc9v5');
            datePublicationClicked = true;
            console.log('✅ Кликнул на "Дата публикации: сначала новые" через CSS селектор');
          } catch (cssError) {
            console.log(`❌ CSS селектор не сработал: ${cssError}`);

            try {
              const jsDatePub = await globalPage.evaluate(() => {
                const spans = Array.from(document.querySelectorAll('span'));
                for (const span of spans) {
                  if (span.textContent && span.textContent.includes('Дата публикации: сначала')) {
                    (span as HTMLElement).click();
                    return true;
                  }
                }
                return false;
              });

              if (jsDatePub) {
                datePublicationClicked = true;
                console.log('✅ Кликнул на "Дата публикации: сначала новые" через JavaScript');
              }
            } catch (jsError) {
              console.log(`❌ JavaScript клик не сработал: ${jsError}`);
            }
          }
        }

        if (datePublicationClicked) {
          console.log('⏰ Задержка 5 секунд после клика на "Дата публикации"...');
          await globalPage.waitForTimeout(5000);

          // Шаг 3: Клик на "Дата размещения"
          console.log('🔍 Шаг 3: Клик на "Дата размещения"');
          let datePostingClicked = false;

          try {
            await globalPage.click('text=Дата размещения');
            datePostingClicked = true;
            console.log('✅ Кликнул на "Дата размещения" через text селектор');
          } catch (error) {
            console.log(`❌ text селектор не сработал: ${error}`);

            try {
              const jsDatePost = await globalPage.evaluate(() => {
                const spans = Array.from(document.querySelectorAll('span'));
                for (const span of spans) {
                  if (span.textContent && span.textContent.includes('Дата размещения')) {
                    (span as HTMLElement).click();
                    return true;
                  }
                }
                return false;
              });

              if (jsDatePost) {
                datePostingClicked = true;
                console.log('✅ Кликнул на "Дата размещения" через JavaScript');
              }
            } catch (jsError) {
              console.log(`❌ JavaScript клик не сработал: ${jsError}`);
            }
          }

          if (datePostingClicked) {
            console.log('⏰ Задержка 5 секунд после клика на "Дата размещения"...');
            await globalPage.waitForTimeout(5000);

            // Шаг 4: Клик на "Последние 24 часа"
            console.log('🔍 Шаг 4: Клик на "Последние 24 часа"');
            let last24HoursClicked = false;

            try {
              await globalPage.click('#_r_3c_');
              last24HoursClicked = true;
              console.log('✅ Кликнул на "Последние 24 часа" через ID селектор');
            } catch (error) {
              console.log(`❌ ID селектор не сработал: ${error}`);

              try {
                await globalPage.click('.x153efwv:nth-child(7) div:nth-child(2) > .x1i10hfl:nth-child(1) .x1qjc9v5:nth-child(1) .x78zum5:nth-child(1)');
                last24HoursClicked = true;
                console.log('✅ Кликнул на "Последние 24 часа" через CSS селектор');
              } catch (cssError) {
                console.log(`❌ CSS селектор не сработал: ${cssError}`);

                try {
                  const js24Hours = await globalPage.evaluate(() => {
                    const spans = Array.from(document.querySelectorAll('span'));
                    for (const span of spans) {
                      if (span.textContent && span.textContent.includes('Последние 24 часа')) {
                        (span as HTMLElement).click();
                        return true;
                      }
                    }
                    return false;
                  });

                  if (js24Hours) {
                    last24HoursClicked = true;
                    console.log('✅ Кликнул на "Последние 24 часа" через JavaScript');
                  }
                } catch (jsError) {
                  console.log(`❌ JavaScript клик не сработал: ${jsError}`);
                }
              }
            }

            if (last24HoursClicked) {
              console.log('🎉 ВСЕ ФИЛЬТРЫ УСПЕШНО ПРИМЕНЕНЫ С ЗАДЕРЖКАМИ!');
              console.log('⏰ Финальная задержка 5 секунд для загрузки результатов...');
              await globalPage.waitForTimeout(5000);
            } else {
              console.log('⚠️ Не удалось кликнуть на "Последние 24 часа"');
            }
          } else {
            console.log('⚠️ Не удалось кликнуть на "Дата размещения"');
          }
        } else {
          console.log('⚠️ Не удалось кликнуть на "Дата публикации: сначала новые"');
        }
      } else {
        console.log('⚠️ Не удалось кликнуть на "Сортировка:"');
      }

      console.log('🔄 Ждем применения фильтров и загрузки результатов...');
      await globalPage.waitForTimeout(2000);

      let items = await globalPage.evaluate((maxCount: number) => {
        const results: MarketplaceItem[] = [];
        const containers = document.querySelectorAll('div.x9f619.x78zum5.xdt5ytf.x1qughib.x1rdy4ex.xz9dl7a.xsag5q8.xh8yej3.xp0eagm.x1nrcals, div[aria-hidden="false"] h1, div.xyamay9.xv54qhq.x18d9i69.xf7dkkf, div.x9f619.x1ja2u2z.x78zum5.x2lah0s.xyamay9');
        const productCards: Element[] = [];
        containers.forEach(container => {
          let parent = container.parentElement;
          while (parent && parent.tagName !== 'A') {
            parent = parent.parentElement;
          }
          if (parent && parent.tagName === 'A' && parent.getAttribute('role') === 'link') {
            productCards.push(parent);
          }
        });
        if (productCards.length === 0) {
          console.log('Используем запасные селекторы для карточек товаров');
          const alternativeCards = Array.from(document.querySelectorAll('a[role="link"]'))
            .filter(el => {
              const hasPrice = el.querySelector('span.x193iq5w[dir="auto"]');
              const hasImage = el.querySelector('img.x168nmei.x13lgxp2');
              return hasPrice && hasImage;
            });
          if (alternativeCards.length > 0) {
            productCards.push(...alternativeCards);
          }
        }
        for (let i = 0; i < Math.min(maxCount, productCards.length); i++) {
          const card = productCards[i] as HTMLAnchorElement;
          let price = "Цена не указана";
          let title = "Без названия";
          let location = "";
          let imageUrl = "";
          let itemUrl = "";
          const priceElement = card.querySelector('span.x193iq5w[dir="auto"]');
          if (priceElement) {
            price = priceElement.textContent || "Цена не указана";
          } else {
            const priceAlt = card.querySelector('div.x1xmf6yo span');
            if (priceAlt) price = priceAlt.textContent || price;
          }
          const titleElement = card.querySelector('span.x1lliihq.x6ikm8r.x10wlt62.x1n2onr6[style*="-webkit-box-orient"]');
          if (titleElement) {
            title = titleElement.textContent || "Без названия";
          } else {
            const tAlt = card.querySelector('h1 span');
            if (tAlt) title = tAlt.textContent || title;
          }
          const locationElement = card.querySelector('span.x1lliihq.x6ikm8r.x10wlt62.x1n2onr6.xlyipyv.xuxw1ft');
          if (locationElement) {
            location = locationElement.textContent || "";
          } else {
            const locAlt = card.querySelector('a[href*="/marketplace/"] span');
            if (locAlt) location = locAlt.textContent || '';
          }
          const imageElement = card.querySelector('img.x168nmei.x13lgxp2');
          if (imageElement) {
            imageUrl = imageElement.getAttribute('src') || "";
          } else {
            const altImageElement = card.querySelector('img');
            if (altImageElement) {
              imageUrl = altImageElement.getAttribute('src') || "";
            }
          }
          const href = card.getAttribute('href');
          if (href) {
            itemUrl = (href.startsWith('http') ? href : `https://www.facebook.com${href}`).split('?')[0];
          } else {
            itemUrl = "";
          }
          // попытка вытащить возраст объявления
          let ageMinutes: number | null = null;
          try {
            const abbr = card.querySelector('abbr[aria-label]');
            if (abbr) {
              const raw = abbr.getAttribute('aria-label') || '';
              const txt = raw.toLowerCase().trim();
              const m = txt.match(/(\d+)/);
              const val = m ? parseInt(m[1], 10) : 0;
              if (/мин/.test(txt)) ageMinutes = val;
              else if (/ч/.test(txt) || /час/.test(txt)) ageMinutes = val * 60;
              else if (/дн/.test(txt) || /день/.test(txt)) ageMinutes = val * 1440;
              else if (/нед/.test(txt)) ageMinutes = val ? val * 10080 : 10080;
            }
          } catch { }

          results.push({
            price: price.trim(),
            title: title.trim(),
            location: location.trim(),
            imageUrl,
            itemUrl,
            ageMinutes: ageMinutes === null ? undefined : ageMinutes
          });
        }
        return results;
      }, count);
      console.log(`Найдено товаров: ${items.length}`);

      // Добавляем названия моделей на серверной стороне
      items = items.map(item => ({
        ...item,
        modelName: extractModelNameFromTitle(item.title)
      }));

      let filteredCount = 0;
      if (appStatus.yearFilterNotFound) {
        console.log('Фильтр года не найден, выполняем сортировку и фильтрацию по году из заголовка...');
        if (appStatus.minYear !== undefined || appStatus.maxYear !== undefined) {
          console.log(`Применяем фильтр года: от ${appStatus.minYear || '-'} до ${appStatus.maxYear || '-'}`);
          const filteredItems = items.filter(item => {
            const year = extractYearFromTitle(item.title);
            if (year === null) return true;
            if (appStatus.minYear !== undefined && year < appStatus.minYear) {
              console.log(`Отфильтровано объявление с годом ${year} < ${appStatus.minYear}: ${item.title}`);
              return false;
            }
            if (appStatus.maxYear !== undefined && year > appStatus.maxYear) {
              console.log(`Отфильтровано объявление с годом ${year} > ${appStatus.maxYear}: ${item.title}`);
              return false;
            }

            return true;
          });

          filteredCount = items.length - filteredItems.length;
          console.log(`Отфильтровано объявлений: ${filteredCount} из ${items.length}`);
          items = filteredItems;
        }
        items.sort((a, b) => {
          const yearA = extractYearFromTitle(a.title);
          const yearB = extractYearFromTitle(b.title);
          if (yearA !== null && yearB !== null) {
            return yearB - yearA;
          }
          if (yearA !== null) return -1;
          if (yearB !== null) return 1;
          return 0;
        });

        console.log('Сортировка по году из заголовка завершена');
      }
      const uniqueUrls = new Set<string>();
      const uniqueTitles = new Set<string>();
      const originalItemsCount = items.length;
      items = items.filter(item => {
        if (!item.itemUrl) {
          console.log(`Обнаружено объявление без URL: ${item.title}`);
          return false;
        }
        if (uniqueUrls.has(item.itemUrl)) {
          console.log(`Обнаружен дубликат по URL: ${item.title} (${item.itemUrl})`);
          return false;
        }
        const itemSignature = `${item.title}_${item.price}_${item.location}`;
        if (uniqueTitles.has(itemSignature)) {
          console.log(`Обнаружен дубликат по содержимому: ${itemSignature}`);
          return false;
        }
        uniqueUrls.add(item.itemUrl);
        uniqueTitles.add(itemSignature);
        return true;
      });

      // Фильтр по давности объявления
      if (currentAppState.maxAgeMinutes && currentAppState.maxAgeMinutes > 0) {
        console.log(`Применяем фильтр по возрасту: не старше ${currentAppState.maxAgeMinutes} минут`);
        const ageFiltered: MarketplaceItem[] = [];
        for (const itm of items) {
          let ageVal: number | null = itm.ageMinutes !== undefined ? itm.ageMinutes : null;
          if (ageVal === null) {
            ageVal = await getListingAgeMinutes(itm.itemUrl);
          }
          if (ageVal === null) {
            console.log(`⚠️ Не удалось определить возраст: ${itm.itemUrl}`);
            continue; // пропускаем при ошибке
          }
          if (ageVal <= currentAppState.maxAgeMinutes) {
            ageFiltered.push(itm);
          } else {
            console.log(`Отфильтровано по возрасту (${ageVal} мин > ${currentAppState.maxAgeMinutes}): ${itm.title}`);
          }
        }
        items = ageFiltered;
      }

      const duplicatesRemoved = originalItemsCount - items.length;
      console.log(`Удалено дубликатов: ${duplicatesRemoved}`);

      let imageStats = {
        downloaded: 0,
        reused: 0,
        cached: 0
      };

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.imageUrl && globalPage) {
          try {
            const contentKey = `${item.title}_${item.price}_${item.location}`;

            if (imageCache.has(contentKey)) {
              const cachedPath = imageCache.get(contentKey)!;
              if (fs.existsSync(path.join(imgDir, cachedPath))) {
                console.log(`Используется кэшированное изображение: ${item.title} -> ${cachedPath}`);
                item.savedImagePath = `src/img/${cachedPath}`;
                imageStats.cached++;
                continue;
              } else {
                imageCache.delete(contentKey);
              }
            }

            console.log(`Скачивание изображения для товара: ${item.title}`);
            const fileName = generateStableFileName(item.title, item.price, item.location);
            const filePath = path.join(imgDir, fileName);

            if (fs.existsSync(filePath)) {
              console.log(`Файл уже существует, переиспользуется: ${fileName}`);
              item.savedImagePath = `src/img/${fileName}`;
              imageCache.set(contentKey, fileName);
              imageStats.reused++;
              continue;
            }

            try {
              await downloadImage(item.imageUrl, filePath);
              console.log(`Изображение сохранено: ${filePath}`);
              item.savedImagePath = `src/img/${fileName}`;
              imageCache.set(contentKey, fileName);
              pruneImageCache();
              imageStats.downloaded++;
            } catch (imgErr) {
              console.error(`Ошибка downloadImage: ${imgErr}`);
            }
          } catch (error) {
            console.error(`Ошибка при скачивании изображения: ${error}`);
          }
        }
      }

      console.log(`Статистика изображений: скачано ${imageStats.downloaded}, переиспользовано ${imageStats.reused}, из кэша ${imageStats.cached}`);

      // 🔥 ФИНАЛЬНАЯ ПРОВЕРКА URL И ПРИНУДИТЕЛЬНОЕ ПРИМЕНЕНИЕ ФИЛЬТРОВ
      console.log('🔍 Проверяем финальный URL после всех кликов...');
      const currentUrl = globalPage.url();
      console.log(`Текущий URL: ${currentUrl}`);

      const hasDateFilter = currentUrl.includes('daysSinceListed=1');
      const hasSortFilter = currentUrl.includes('sortBy=creation_time_descend');

      if (!hasDateFilter || !hasSortFilter) {
        console.log('⚠️ ФИЛЬТРЫ НЕ ПРИМЕНИЛИСЬ! Принудительно меняем URL...');

        try {
          // Парсим текущий URL и добавляем недостающие параметры
          const url = new URL(currentUrl);
          const params = new URLSearchParams(url.search);

          // Добавляем недостающие фильтры
          if (!hasDateFilter) {
            params.set('daysSinceListed', '1');
            console.log('✅ Добавлен параметр daysSinceListed=1');
          }

          if (!hasSortFilter) {
            params.set('sortBy', 'creation_time_descend');
            console.log('✅ Добавлен параметр sortBy=creation_time_descend');
          }

          // Формируем новый URL
          const newUrl = `${url.origin}${url.pathname}?${params.toString()}`;
          console.log(`🔄 Переходим на новый URL: ${newUrl}`);

          // Переходим на новый URL
          await globalPage.goto(newUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await globalPage.waitForTimeout(3000);

          console.log('🎉 ФИЛЬТРЫ УСПЕШНО ПРИМЕНЕНЫ ЧЕРЕЗ ПРИНУДИТЕЛЬНОЕ ИЗМЕНЕНИЕ URL!');

        } catch (urlError) {
          console.error(`❌ Ошибка при принудительном изменении URL: ${urlError}`);
        }
      } else {
        console.log('✅ Все фильтры уже применены в URL');
      }

      return res.json({
        success: true,
        items,
        filteredCount,
        duplicatesRemoved,
        imageStats
      });
    } catch (error) {
      console.error(`Ошибка при получении списка товаров (попытка ${retryCount + 1}): ${error}`);

      if (String(error).includes('NS_BINDING_ABORTED') || String(error).includes('frame was detached')) {
        console.log('🔄 Обнаружена критическая ошибка, перезапускаю браузер...');
        retryCount++;
        if (retryCount < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 3000 * retryCount));
          continue;
        }
      }

      retryCount++;
      if (retryCount < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 2000 * retryCount));
        continue;
      }

      return res.status(500).json({
        success: false,
        error: `${error}`,
        retries: retryCount
      });
    }
  }

  return res.status(500).json({
    success: false,
    error: "Превышено максимальное количество попыток получения товаров",
    retries: maxRetries
  });
}
async function cleanupSingletonLock() {
  // Используем абсолютный путь для директории сессии
  const userDataDir = path.resolve(__dirname, '../../backend/sessions/fb-browser-session');
  const lockFiles = [
    path.join(userDataDir, 'SingletonLock'),
    path.join(userDataDir, 'SingletonCookie'),
    path.join(userDataDir, 'parent.lock'),
    path.join(userDataDir, '.parentlock')
  ];

  for (const lockPath of lockFiles) {
    if (fs.existsSync(lockPath)) {
      try {
        fs.unlinkSync(lockPath);
        console.log(`Удален блокирующий файл: ${lockPath}`);
      } catch (error) {
        console.error(`Ошибка при удалении файла ${lockPath}:`, error);
      }
    }
  }
}
function cleanupPortFile() {
  try {
    const portFilePath = path.join(process.cwd(), 'api_port.txt');
    if (fs.existsSync(portFilePath)) {
      fs.unlinkSync(portFilePath);
      console.log('Удален файл с портом API');
    }
  } catch (error) {
    console.error('Ошибка при удалении файла порта:', error);
  }
}

async function openFacebookMarketplace() {
  console.log('Запуск браузера...');
  updateStatus({ stage: 'browser_starting' });
  try {
    await setupApiServer();
    // Используем абсолютный путь для директории сессии
    const userDataDir = path.resolve(__dirname, '../../backend/sessions/fb-browser-session');
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
      console.log(`Создана директория для профиля Firefox: ${userDataDir}`);
    }
    await cleanupSingletonLock();
    await new Promise(resolve => setTimeout(resolve, 2000));

    try {
      globalBrowser = await firefox.launchPersistentContext(userDataDir, {
        headless: false,
        viewport: { width: 1366, height: 768 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
        args: [
          '--disable-extensions',
          '--disable-notifications',
          '--disable-popup-blocking'
        ],
        acceptDownloads: true,
        bypassCSP: true,
        ignoreHTTPSErrors: true,
        javaScriptEnabled: true,
        offline: false,
        permissions: ['notifications', 'geolocation']
      });

      const page = await globalBrowser.newPage();
      globalPage = page;

      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined,
          configurable: true
        });

        Object.defineProperty(navigator, 'plugins', {
          get: () => ({
            length: 3,
            0: { name: 'Chrome PDF Plugin', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
            1: { name: 'Chrome PDF Viewer', description: '', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
            2: { name: 'Native Client', description: '', filename: 'internal-nacl-plugin' }
          }),
          configurable: true
        });

        Object.defineProperty(navigator, 'languages', {
          get: () => ['ru-RU', 'ru', 'en-US', 'en'],
          configurable: true
        });
      });

      await page.goto('https://www.facebook.com/marketplace', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });

      await page.waitForTimeout(getRandomDelay(2000, 4000));
      await humanMouseMove(page);

      await handleCheckpoints(page);

      console.log('✅ Браузер успешно перезапущен');
      updateStatus({ active: true, stage: 'browser_restarted' });

      schedulePeriodicRestart(45);

      return true;
    } catch (error) {
      console.error('❌ Ошибка при перезапуске браузера:', error);
      return false;
    }
  } catch (error) {
    console.error('❌ Критическая ошибка перезапуска:', error);
    return false;
  }
}

async function schedulePeriodicRestart(intervalMinutes: number) {
  console.log(`Планировщик перезапуска активирован с интервалом ${intervalMinutes} минут.`);
  setInterval(async () => {
    try {
      console.log('🔄 Начинаю плановый перезапуск браузера для предотвращения утечек памяти...');
      updateStatus({ restarting_soon: true, stage: 'scheduled_restart_pending' });

      console.log('Пауза на 15 секунд для уведомления бэкенда...');
      await new Promise(resolve => setTimeout(resolve, 15000));

      await restartBrowser();
      await restoreState();

      updateStatus({ restarting_soon: false });
      console.log('✅ Плановый перезапуск успешно завершен.');
    } catch (error) {
      console.error('❌ Ошибка во время планового перезапуска:', error);
      updateStatus({ restarting_soon: false, stage: 'scheduled_restart_failed' });
    }
  }, intervalMinutes * 60 * 1000);
}

async function handleSetLocation(req: Request, res: Response): Promise<Response> {
  if (!globalPage) {
    return res.status(400).json({
      success: false,
      error: 'Браузер не инициализирован'
    });
  }
  const { city, radius, latitude, longitude } = req.body;

  if (latitude === undefined || longitude === undefined) {
    return res.status(400).json({ success: false, error: 'latitude и longitude обязательны' });
  }

  try {
    await handleCheckpoints(globalPage);

    const newLat = Number(latitude);
    const newLon = Number(longitude);

    if (isNaN(newLat) || isNaN(newLon)) {
      return res.status(400).json({ success: false, error: 'Неверный формат latitude или longitude' });
    }

    const context = globalPage.context();

    console.log(`📍 Шаг 1: Устанавливаю геолокацию браузера: Широта=${newLat}, Долгота=${newLon}`);
    await context.setGeolocation({ latitude: newLat, longitude: newLon });

    console.log('📍 Шаг 2: Открываю меню смены локации на Facebook...');
    const locationClicked = await tryClick(globalPage,
      ['#seo_filters > .x1i10hfl > .x78zum5', 'div[aria-label*="геолокации"]'],
      'кнопка меню локации',
      10000
    );
    if (!locationClicked) {
      return res.status(500).json({ success: false, error: "Не удалось открыть меню смены локации." });
    }
    await globalPage.waitForTimeout(1500);

    console.log('📍 Шаг 3: Нажимаю на "компас", чтобы применить новые координаты...');
    let compassClicked = await tryClick(globalPage, ['.x14hiurz'], '"компас" (первый селектор)');
    if (compassClicked) {
      await globalPage.waitForTimeout(500);
      compassClicked = await tryClick(globalPage, ['.x193iq5w > .xep6ejk'], '"компас" (второй селектор)');
    }
    if (!compassClicked) {
      console.log('  ...Новые селекторы компаса не сработали, пробую старый (по aria-label)...');
      compassClicked = await tryClick(globalPage, ['div[aria-label="Использовать текущее местоположение"][role="button"]'], '"компас" (запасной вариант)');
    }

    if (!compassClicked) {
      return res.status(500).json({ success: false, error: "Не удалось нажать на 'компас'." });
    }
    await globalPage.waitForTimeout(1500);

    console.log('📍 Шаг 4: Нажимаю "Применить"...');
    const applied = await tryClick(globalPage, ['div[aria-label="Применить"][role="button"]'], 'кнопка "Применить"');
    if (!applied) {
      console.log('  ...Кнопка "Применить" не найдена или не понадобилась.');
    }
    await globalPage.waitForTimeout(2000);

    // После успешной установки геолокации применяем фильтр "Последние 24 часа"
    console.log('📍 Шаг 5: Применяю фильтр "Последние 24 часа"...');

    const filterApplied = await applyLast24HoursFilter();
    if (filterApplied) {
      currentAppState.location = city;
      currentAppState.radius = radius;

      console.log(`✅ Геолокация успешно установлена на ${city || `(${newLat}, ${newLon})`}`);
      return res.json({ success: true, message: 'Геолокация и фильтры "Последние 24 часа" успешно установлены.' });
    } else {
      console.log('⚠️ Не удалось применить фильтр "Последние 24 часа", но геолокация установлена');
    }

    currentAppState.location = city;
    currentAppState.radius = radius;

    console.log(`✅ Геолокация успешно установлена на ${city || `(${newLat}, ${newLon})`}`);
    return res.json({ success: true, message: 'Геолокация успешно установлена.' });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`❌ Критическая ошибка в handleSetLocation: ${errorMessage}`);
    return res.status(500).json({
      success: false,
      error: `Не удалось установить местоположение: ${errorMessage}`
    });
  }
}

async function tryClick(page: Page, selectors: string[], description: string, timeout: number = 5000): Promise<boolean> {
  console.log(`🖱️ Пытаюсь кликнуть: ${description}`);
  for (const selector of selectors) {
    try {
      const element = await page.waitForSelector(selector, { timeout, state: 'visible' });
      await element.click({ timeout: 2000 });
      console.log(`  ✅ Успешный клик по селектору: ${selector}`);
      return true;
    } catch (e) {
      console.log(`  ...Селектор не сработал: ${selector}`);
    }
  }
  console.log(`❌ Не удалось кликнуть: ${description}`);
  return false;
}

async function handleSetYearFilter(req: Request, res: Response): Promise<Response> {
  const { minYear, maxYear } = req.body;
  if ((minYear === undefined || minYear === null) && (maxYear === undefined || maxYear === null)) {
    return res.status(400).json({
      success: false,
      error: "Необходимо указать хотя бы один параметр: minYear или maxYear"
    });
  }

  console.log(`Фильтр года: минимум ${minYear || '-'}, максимум ${maxYear || '-'} (применяется на клиенте)`);

  updateStatus({
    yearFilterNotFound: true,
    minYear: minYear !== undefined && minYear > 0 ? minYear : undefined,
    maxYear: maxYear !== undefined && maxYear > 0 ? maxYear : undefined
  });

  // Сохраняем фильтры года в состояние для автовосстановления
  currentAppState.minYear = minYear !== undefined && minYear > 0 ? minYear : undefined;
  currentAppState.maxYear = maxYear !== undefined && maxYear > 0 ? maxYear : undefined;

  return res.json({
    success: true,
    message: `Фильтр года сохранен для клиентской фильтрации: мин=${minYear || '-'}, макс=${maxYear || '-'}`,
    status: "completed",
    applied: {
      minYear: minYear !== undefined && minYear > 0 ? minYear : null,
      maxYear: maxYear !== undefined && maxYear > 0 ? maxYear : null
    }
  });
}

async function handleSetAgeFilter(req: Request, res: Response): Promise<Response> {
  const { maxAgeMinutes } = req.body;
  if (maxAgeMinutes === undefined || maxAgeMinutes === null || isNaN(Number(maxAgeMinutes)) || Number(maxAgeMinutes) <= 0) {
    return res.status(400).json({ success: false, error: 'Необходимо положительное число maxAgeMinutes' });
  }
  currentAppState.maxAgeMinutes = Number(maxAgeMinutes);
  return res.json({ success: true, applied: { maxAgeMinutes: currentAppState.maxAgeMinutes } });
}

function pruneImageCache() {
  if (imageCache.size > MAX_IMAGE_CACHE) {
    const excess = imageCache.size - MAX_IMAGE_CACHE;
    const keys = Array.from(imageCache.keys()).slice(0, excess);
    for (const k of keys) imageCache.delete(k);
    console.log(`pruneImageCache trimmed to ${imageCache.size}`);
  }
}

async function clearImages(): Promise<void> {
  try {
    const imgDir = path.join(process.cwd(), 'api', 'src', 'img');
    if (!fs.existsSync(imgDir)) return;
    const files = fs.readdirSync(imgDir);
    const threshold = Date.now() - 30 * 60 * 1000;
    for (const f of files) {
      const filePath = path.join(imgDir, f);
      try {
        const st = fs.statSync(filePath);
        if (st.mtime.getTime() < threshold) fs.unlinkSync(filePath);
      } catch { }
    }
  } catch (e) {
    console.error('clearImages error', e);
  }
}

async function handleClearImageCache(req: Request, res: Response): Promise<Response> {
  try {
    imageCache.clear();
    await clearImages();
    return res.json({ success: true, cleared: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: String(error) });
  }
}

async function geocodeCity(query: string): Promise<{ success: boolean; lat?: number; lon?: number; name?: string; displayName?: string; error?: string }> {
  try {
    if (!query || typeof query !== 'string') {
      return { success: false, error: 'invalid_query' };
    }

    const lower = query.toLowerCase();
    const cached = geoCache.get(lower);
    if (cached && Date.now() - cached.timestamp < 24 * 60 * 60 * 1000) {
      return { success: true, lat: cached.lat, lon: cached.lon, name: cached.name, displayName: cached.displayName };
    }

    const url = 'https://nominatim.openstreetmap.org/search';
    const resp = await axios.get(url, {
      params: { q: query, format: 'json', limit: 1 },
      headers: { 'User-Agent': 'FreelanceProj/1.0' },
      timeout: 8000
    });

    const arr = Array.isArray(resp.data) ? resp.data : [];
    if (!arr.length) {
      return { success: false, error: 'not_found' };
    }

    const loc = arr[0];
    const lat = parseFloat(loc.lat);
    const lon = parseFloat(loc.lon);
    const name = loc.name || query;
    const displayName = loc.display_name || query;
    geoCache.set(lower, { lat, lon, name, displayName, timestamp: Date.now() });
    if (geoCache.size > 1000) {
      const keys = Array.from(geoCache.keys()).slice(0, geoCache.size - 1000);
      keys.forEach(k => geoCache.delete(k));
    }
    return { success: true, lat, lon, name, displayName };
  } catch (err) {
    console.error('[geocodeCity]', err);
    return { success: false, error: 'network' };
  }
}

async function handleGeocodeCity(req: Request, res: Response): Promise<Response> {
  const { city } = req.body;
  if (!city || typeof city !== 'string') {
    return res.status(400).json({ success: false, error: 'city_required' });
  }
  const result = await geocodeCity(city);
  if (result.success) {
    return res.json({ success: true, lat: result.lat, lon: result.lon, name: result.name, displayName: result.displayName });
  }
  return res.json({ success: false, error: result.error || 'unknown' });
}

async function downloadImage(url: string, filePath: string): Promise<void> {
  const response = await axios.get(url, { responseType: 'stream', timeout: 15000 });
  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);
    let finished = false;
    const finish = (err?: any) => {
      if (finished) return;
      finished = true;
      if (err) reject(err);
      else resolve();
    };
    writer.on('finish', () => finish());
    writer.on('error', (err: any) => finish(err));
    response.data.on('error', (err: any) => finish(err));
  });
}

openFacebookMarketplace().catch(error => {
  console.error('Критическая ошибочка:', error);
  updateStatus({ active: false, stage: 'critical_error' });
  process.exit(1);
});

async function handleCheckpoints(page: Page): Promise<boolean> {
  console.log(`[CHECKPOINT] Начинаю проверку на странице: ${page.url()}`);

  try {
    const isCheckpointUrl = page.url().includes('/checkpoint/');
    const hasCheckpointText = await page.locator('*:has-text("автоматизированное поведение"), *:has-text("temporarily restricted")').count() > 0;

    console.log(`[CHECKPOINT] Результаты проверки: URL содержит /checkpoint/ -> ${isCheckpointUrl}, найден специфичный текст -> ${hasCheckpointText}`);

    if (!isCheckpointUrl && !hasCheckpointText) {
      console.log("[CHECKPOINT] Чекпоинт не обнаружен. Пропускаю.");
      return true;
    }

    console.log('ℹ️ Обнаружена страница чекпоинта (по URL или тексту). Проверяю наличие блокирующих элементов...');

    const declineButtonLocator = page.locator('*:has-text("Отклонить")').last();

    if (!(await declineButtonLocator.count() > 0 && await declineButtonLocator.isVisible())) {
      console.log('[CHECKPOINT] Элемент с текстом "Отклонить" не найден или не виден.');
      return true;
    }

    console.log('🔍 Обнаружен видимый элемент "Отклонить". Начинаю процедуру закрытия...');

    await humanMouseMove(page); // "Осматриваемся"

    const maxRetries = 3;
    for (let i = 0; i < maxRetries; i++) {
      console.log(`[Попытка ${i + 1}/${maxRetries}] Навожу курсор на кнопку...`);
      try {
        await declineButtonLocator.hover({ timeout: 3000 });
        await page.waitForTimeout(getRandomDelay(300, 700));

        console.log(`[Попытка ${i + 1}/${maxRetries}] Пытаюсь кликнуть по-человечески...`);
        await humanClick(page, declineButtonLocator);

        console.log(`[Попытка ${i + 1}/${maxRetries}] Клик выполнен. Ожидание 3-4 сек и проверка...`);
        await page.waitForTimeout(getRandomDelay(3000, 4000));

        if (!(await declineButtonLocator.isVisible())) {
          console.log('✅ УСПЕХ! Элемент "Отклонить" больше не виден.');
          return true;
        } else {
          console.warn(`[Попытка ${i + 1}/${maxRetries}] ⚠️ НЕУДАЧА: Элемент "Отклонить" все еще виден после клика.`);
          try {
            const screenshotPath = path.resolve(__dirname, '../src/img/checkpoint_failure.png');
            await page.screenshot({ path: screenshotPath, fullPage: true });
            console.log(`📸 Скриншот сохранен в: ${screenshotPath}`);
          } catch (screenshotError) {
            console.error('🔴 Не удалось сделать скриншот:', screenshotError);
          }
        }
      } catch (e) {
        console.error(`[Попытка ${i + 1}/${maxRetries}] 🔴 КРИТИЧЕСКАЯ ОШИБКА во время клика:`, e);
      }

      if (i < maxRetries - 1) {
        await page.waitForTimeout(getRandomDelay(1000, 2000));
      }
    }

    console.error('🔴 ФИНАЛЬНЫЙ ПРОВАЛ: Не удалось закрыть чекпоинт "Отклонить" после нескольких попыток.');
    return false;

  } catch (error) {
    console.log('ℹ️ КРИТИЧЕСКАЯ ОШИБКА во время проверки на всплывающие окна (handleCheckpoints):', error);
    return false;
  }
}