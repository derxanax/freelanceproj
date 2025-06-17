import { firefox, Page, ElementHandle } from 'playwright';
import path from 'path';
import os from 'os';
import fs from 'fs';
import express from 'express';
import cors from 'cors';
import { Request, Response } from 'express';
import { AddressInfo } from 'net';
import crypto from 'crypto';
import axios from 'axios';

let API_PORT = 3562;
const BACKUP_PORTS = [3563, 3564, 3565, 3566, 3567];

const imageCache = new Map<string, string>();
const MAX_IMAGE_CACHE = 5000;

const geoCache = new Map<string, { lat: number; lon: number; name: string; timestamp: number }>();

function generateStableFileName(title: string, price: string, location: string): string {
  const contentKey = `${title}_${price}_${location}`;
  const contentHash = crypto.createHash('md5').update(contentKey).digest('hex').substring(0, 8);
  const titleClean = title.replace(/[^a-zA-Zа-яА-Я0-9]/g, '_').substring(0, 20);
  const locationClean = location.replace(/[^a-zA-Zа-яА-Я0-9]/g, '_').substring(0, 15);
  return `${titleClean}_${locationClean}_${contentHash}.png`;
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
    if (currentValue === text) {
      console.log('Успешный ввод методом 1 (element.fill)');
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
    if (currentValue === text) {
      console.log('Успешный ввод методом 2 (Ctrl+A + type)');
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
    if (currentValue === text) {
      console.log('Успешный ввод методом 3 (JS с событиями)');
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
    if (currentValue === text) {
      console.log('Успешный ввод методом 4 (посимвольный ввод)');
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
          status: () => ({ json: () => {} }),
          json: () => {},
          send: () => {}
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
          status: () => ({ json: () => {} }),
          json: () => {},
          send: () => {}
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
          status: () => ({ json: () => {} }),
          json: () => {},
          send: () => {}
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
                } catch (e) {}
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
      try { await page.close(); } catch {}
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
    const sortButton = await globalPage.$('div[role="button"].x1i10hfl.x1qjc9v5.xjbqb8w.xjqpnuy.xa49m3k.xqeqjp1.x2hbi6w.x13fuv20.xu3j5b3.x1q0q8m5.x26u7qi.x972fbf.xcfux6l.x1qhh985.xm0m39n.x9f619.x1ypdohk.xdl72j9.x2lah0s.xe8uvvx.xat24cr.x1mh8g0r.x2lwn1j.xeuugli.xexx8yu.x4uap5.x18d9i69.xkhd6sd.x1n2onr6.x16tdsg8.x1hl2dhg.xggy1nq.x1ja2u2z.x1t137rt.x1o1ewxj.x3x9cwd.x1e5q0jg.x13rtm0m.x1q0g3np.x87ps6o.x1lku1pv.x78zum5.x1a2a7pz.xqvfhly.x1emribx.xdj266r');
    if (sortButton) {
      try {
        await sortButton.click({ timeout: 3000 });
        await globalPage.waitForTimeout(500);
      } catch {
        try {
          await sortButton.evaluate((el) => (el as HTMLElement).click());
          await globalPage.waitForTimeout(500);
        } catch {
          const child = await sortButton.$('div,span');
          if (child) {
            await child.click({ timeout: 3000 });
            await globalPage.waitForTimeout(500);
          }
        }
      }
      console.log('Ищу опцию "Дата публикации: сначала новые"...');
      try {
        const newPublicationOption = await globalPage.locator('span', { 
          hasText: 'Дата публикации: сначала новые' 
        }).first();
        if (await newPublicationOption.count() > 0) {
          console.log('Опция найдена через локатор по тексту, кликаю...');
          await newPublicationOption.click();
          await globalPage.waitForTimeout(1000);
        } else {
          const optionById = await globalPage.$('span[id="«r3j»"]');
          if (optionById) {
            console.log('Опция найдена через id="«r3j»", кликаю...');
            await optionById.click();
            await globalPage.waitForTimeout(1000);
          } else {
            const sortMenuItem = await globalPage.waitForSelector('span.x193iq5w.xeuugli.x13faqbe.x1vvkbs.x1xmvt09.x1lliihq.x1s928wv.xhkezso.x1gmr53x.x1cpjm7i.x1fgarty.x1943h6x.xudqn12.x3x7a5m.x6prxxf.xvq8zen.xk50ysn.xzsf02u.x1yc453h', { timeout: 3000 });
            if (sortMenuItem) {
              const text = await sortMenuItem.textContent();
              if (text && text.includes('Дата публикации: сначала новые')) {
                console.log('Опция найдена через CSS селектор, кликаю...');
                await sortMenuItem.click();
                await globalPage.waitForTimeout(1000);
              }
            } else {
              console.log('Пытаюсь найти опцию через JavaScript...');
              await globalPage.evaluate(() => {
                const allSpans = Array.from(document.querySelectorAll('span'));
                for (const span of allSpans) {
                  if (span.textContent && span.textContent.includes('Дата публикации: сначала новые')) {
                    (span as HTMLElement).click();
                    return true;
                  }
                }
                const radioItems = Array.from(document.querySelectorAll('div[aria-checked="false"][role="radio"]'));
                for (const radio of radioItems) {
                  const textSpan = radio.querySelector('span');
                  if (textSpan && textSpan.textContent && textSpan.textContent.includes('Дата публикации: сначала новые')) {
                    (radio as HTMLElement).click();
                    return true;
                  }
                }
                const exactRadioSelector = 'div[aria-checked="false"][role="radio"].x1i10hfl.x1qjc9v5.xjbqb8w.xjqpnuy.xa49m3k.xqeqjp1.x2hbi6w.x13fuv20.xu3j5b3.x1q0q8m5.x26u7qi.x972fbf.xcfux6l.x1qhh985.xm0m39n.x9f619.x1ypdohk.xdl72j9.x2lah0s.xe8uvvx.xdj266r.x11i5rnm.xat24cr.x1mh8g0r.x2lwn1j.xeuugli.xexx8yu.x4uap5.x18d9i69.x1sxyh0.xurb0ha.xexx8yu.x1n2onr6.x1ja2u2z.x1gg8mnh';
                const exactRadioButtons = document.querySelectorAll(exactRadioSelector);
                for (const radio of Array.from(exactRadioButtons)) {
                  const inner = radio.querySelector('div.x6s0dn4.x1q0q8m5.x1qhh985.xu3j5b3.xcfux6l.x26u7qi.xm0m39n.x13fuv20.x972fbf.x9f619.x78zum5.x1q0g3np.x1iyjqo2.xs83m0k.x1qughib.xat24cr.x11i5rnm.x1mh8g0r.xdj266r.xeuugli.x18d9i69.x1sxyh0.xurb0ha.xexx8yu.x1n2onr6.x1ja2u2z.x1gg8mnh');
                  if (inner) {
                    const textDiv = inner.querySelector('div.xod5an3.x16n37ib.x14vqqas.x1n2onr6.xqcrz7y');
                    if (textDiv) {
                      const targetSpan = radio.querySelector('span.x193iq5w.xeuugli.x13faqbe.x1vvkbs.x10flsy6.x1lliihq.x1s928wv.xhkezso.x1gmr53x.x1cpjm7i.x1fgarty.x1943h6x.x4zkp8e.x41vudc.x6prxxf.xvq8zen.x1s688f.xzsf02u');
                      if (targetSpan && targetSpan.textContent && targetSpan.textContent.includes('Дата публикации: сначала новые')) {
                        console.log('Найден точный элемент по HTML структуре');
                        (radio as HTMLElement).click();
                        return true;
                      }
                    }
                  }
                }
                return false;
              });
              await globalPage.waitForTimeout(1000);
            }
          }
        }
      } catch (error) {
        console.error(`Ошибка при клике на "Дата публикации: сначала новые": ${error}`);
      }
      
      // Клик на "Дата размещения"
      try {
        console.log('Ищу элемент "Дата размещения"...');
        const datePostingElement = await globalPage.locator('span', { hasText: 'Дата размещения' }).first();
        if (await datePostingElement.count() > 0) {
          console.log('Элемент "Дата размещения" найден, кликаю...');
          await datePostingElement.click();
          await globalPage.waitForTimeout(1000);
        } else {
          // Попытка через селектор класса
          const datePostingByClass = await globalPage.$('span.x193iq5w.xeuugli.x13faqbe.x1vvkbs.x10flsy6.x1lliihq.x1s928wv.xhkezso.x1gmr53x.x1cpjm7i.x1fgarty.x1943h6x.x4zkp8e.x41vudc.x6prxxf.xvq8zen.x1s688f.xzsf02u');
          if (datePostingByClass) {
            console.log('Элемент "Дата размещения" найден по классу, кликаю...');
            await datePostingByClass.click();
            await globalPage.waitForTimeout(1000);
          }
        }
      } catch (error) {
        console.error(`Ошибка при клике на "Дата размещения": ${error}`);
      }
      
      // Клик на "Последние 24 часа"
      try {
        console.log('Ищу элемент "Последние 24 часа"...');
        const last24HoursElement = await globalPage.locator('span', { hasText: 'Последние 24 часа' }).first();
        if (await last24HoursElement.count() > 0) {
          console.log('Элемент "Последние 24 часа" найден, кликаю...');
          await last24HoursElement.click();
          await globalPage.waitForTimeout(1000);
        } else {
          // Попытка через селектор класса
          const last24HoursByClass = await globalPage.$('span.x193iq5w.xeuugli.x13faqbe.x1vvkbs.x10flsy6.x1lliihq.x1s928wv.xhkezso.x1gmr53x.x1cpjm7i.x1fgarty.x1943h6x.x4zkp8e.x41vudc.x6prxxf.xvq8zen.xk50ysn.xzsf02u.x1yc453h');
          if (last24HoursByClass) {
            console.log('Элемент "Последние 24 часа" найден по классу, кликаю...');
            await last24HoursByClass.click();
            await globalPage.waitForTimeout(1000);
          }
        }
      } catch (error) {
        console.error(`Ошибка при клике на "Последние 24 часа": ${error}`);
      }
    }
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
        } catch {}

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
  console.log(`[set-location] Получен запрос на установку местоположения: город "${city}", радиус ${radius ? radius + ' miles' : 'не указан'}`);
  if (!city || typeof city !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Необходимо указать город (city)'
    });
  }
  try {
    console.log('[set-location] start', { city, radius });
    if (latitude === undefined || longitude === undefined || isNaN(Number(latitude)) || isNaN(Number(longitude))) {
      return res.status(400).json({ success: false, error: 'latitude_longitude_required' });
    }

    // quick geolocation path executed below

    try {
      const ctx = globalPage.context();
      await ctx.grantPermissions(['geolocation']);
      await ctx.setGeolocation({ latitude: Number(latitude), longitude: Number(longitude), accuracy: 50 });
      console.log(`[set-location] Geolocation applied lat=${latitude} lon=${longitude}`);

      // attempt to click compass with multiple strategies
      let compassClicked = false;
      try {
        const compassCss = 'div[aria-label^="Выбор геолокации"][role="button"]';
        const compass = await globalPage.$(compassCss);
        if (compass) {
          await safeClick(globalPage, compass);
          compassClicked = true;
        }
      } catch {}
      if (!compassClicked) {
        console.log('[set-location] Compass not found directly, opening location menu…');
        try {
          const menuBtn = await findElement(globalPage, [
            '#seo_filters div[role="button"]',
            'div[aria-label*="геолокации"][role="button"]',
            '.x1i10hfl.xjbqb8w[role="button"]'
          ], 'кнопка меню местоположения');
          if (menuBtn) {
            await safeClick(globalPage, menuBtn);
            await globalPage.waitForTimeout(800);
            const compass2 = await findElement(globalPage, [
              'i.xep6ejk',
              'div[role="button"] i[data-visualcompletion="css-img"]'
            ], 'кнопка компаса');
            if (compass2) {
              await safeClick(globalPage, compass2);
              compassClicked = true;
            }
          }
        } catch (fallbackErr) {
          console.error('[set-location] compass fallback error', fallbackErr);
        }
      }
      console.log(`[set-location] compassClicked_final=${compassClicked}`);

      // сохраняем в state
      currentAppState.location = city;
      currentAppState.radius = radius;

      console.log(`[set-location] params received: city=${city}, radius=${radius}, lat=${latitude}, lon=${longitude}`);

      return res.json({ success: true, message: 'Геолокация установлена', status: 'completed' });
    } catch (geoErr) {
      console.error('[set-location] geolocation flow error', geoErr);
      // fallthrough to manual flow
    }

    let cityBlock = await globalPage.$('#seo_filters div[role="button"]');
    let cityBlockSelector = '#seo_filters div[role="button"]';
    if (!cityBlock) {
      cityBlock = await globalPage.$('div.x1i10hfl.x1qjc9v5.xjbqb8w.xjqpnuy[role="button"]');
      cityBlockSelector = 'div.x1i10hfl.x1qjc9v5.xjbqb8w.xjqpnuy[role="button"]';
    }
    
    // Альтернативный селектор из примера Playwright
    if (!cityBlock) {
      cityBlock = await globalPage.$('.x1iyjqo2 > .x13faqbe');
      cityBlockSelector = '.x1iyjqo2 > .x13faqbe';
    }

    if (cityBlock) {
      console.log(`[set-location] cityBlock найден по селектору: ${cityBlockSelector}, кликаю`);
      try {
        await humanClick(globalPage, cityBlock, {timeout: 3000});
        await globalPage.waitForTimeout(getRandomDelay(800, 1500));
        console.log('[set-location] человеческий click сработал');
      } catch (e) {
        console.log('[set-location] обычный click НЕ сработал, пробую через evaluate');
        try {
          await cityBlock.evaluate((el: HTMLElement) => el.click());
          await globalPage.waitForTimeout(1000);
          console.log('[set-location] js click через evaluate сработал');
        } catch (e2) {
          console.log('[set-location] js click НЕ сработал, пробую дочерний div/span');
          const child = await cityBlock.$('div,span');
          if (child) {
            try {
              await child.click({timeout: 3000});
              await globalPage.waitForTimeout(1000);
              console.log('[set-location] click по дочернему div/span сработал');
            } catch (e3) {
              console.log('[set-location] click по дочернему div/span НЕ сработал, пробую boundingBox');
              const box = await cityBlock.boundingBox();
              if (box) {
                await globalPage.mouse.click(box.x + box.width/2, box.y + box.height/2);
                await globalPage.waitForTimeout(1000);
                console.log('[set-location] click по координатам boundingBox сработал');
              } else {
                console.log('[set-location] boundingBox не найден, все способы клика не сработали');
              }
            }
          } else {
            console.log('[set-location] дочерний div/span не найден, все способы клика не сработали');
          }
        }
      }
      console.log('[set-location] жду появления поля ввода местоположения...');
      const locationInput = await globalPage.waitForSelector(
        'input[aria-label="Почтовый индекс или город"], input[placeholder*="Почтовый индекс"], input[type="text"][aria-autocomplete="list"], #_r_1s_', 
        { timeout: 5000 }
      ).catch(() => null);
      if (!locationInput) {
        console.log('[set-location] поле ввода местоположения не найдено по селекторам, пробую js-поиск...');
        const jsLocationInput = await globalPage.evaluateHandle(() => {
          const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
          const exactInput = inputs.find(input => 
            input.getAttribute('aria-label') === 'Почтовый индекс или город'
          );
          if (exactInput) return exactInput;
          const partialInput = inputs.find(input => {
            const label = input.getAttribute('aria-label') || '';
            return label.toLowerCase().includes('город') || 
                   label.toLowerCase().includes('индекс') || 
                   label.toLowerCase().includes('местоположени');
          });
          if (partialInput) return partialInput;
          return inputs.find(input => input.getAttribute('aria-autocomplete') === 'list') || null;
        });
        if (jsLocationInput && jsLocationInput.asElement()) {
          console.log('[set-location] поле ввода найдено через JS-поиск');
          const locationInputElement = jsLocationInput.asElement()!;
          await humanClick(globalPage, locationInputElement, { clickCount: 3 });
          await globalPage.keyboard.press('Backspace');
          await humanType(globalPage, locationInputElement, city);
        } else {
          console.log('[set-location] поле ввода местоположения не появилось после открытия меню!');
          return res.status(404).json({
            success: false,
            error: 'Поле ввода местоположения не появилось после открытия меню'
          });
        }
      } else {
        console.log('[set-location] locationInput найден, ввожу город');
        await humanClick(globalPage, locationInput, { clickCount: 3 });
        await globalPage.keyboard.press('Backspace');
        await humanType(globalPage, locationInput, city);
      }
      await globalPage.waitForTimeout(1500);
      const firstAutocomplete = await globalPage.$('ul[role="listbox"] li, div[role="option"]');
      if (firstAutocomplete) {
        console.log('[set-location] автокомплит найден, кликаю');
        await humanClick(globalPage, firstAutocomplete);
        await globalPage.waitForTimeout(getRandomDelay(600, 1200));
      } else {
        console.log('[set-location] автокомплит НЕ найден');
      }
      if (radius) {
        console.log(`[set-location] начинаю установку радиуса: ${radius} miles`);
        const allCombos = await globalPage.$$('label[role="combobox"]');
        let radiusCombo = null;
        for (const combo of allCombos) {
          const text = await combo.textContent();
          if (text && text.includes('Радиус')) {
            radiusCombo = combo;
            break;
          }
        }
        if (!radiusCombo) {
          const possibleCombos = await globalPage.$$('[role="button"]');
          for (const combo of possibleCombos) {
            const text = await combo.textContent();
            if (text && (text.includes('миль') || text.includes('рад'))) {
              radiusCombo = combo;
              break;
            }
          }
        }
        if (radiusCombo) {
          console.log('[set-location] radiusCombo найден, кликаю');
          try {
            await radiusCombo.evaluate((el: HTMLElement) => el.click());
            await globalPage.waitForTimeout(1000);
            console.log('[set-location] клик по radiusCombo выполнен через JS');
            const selectRadiusResult = await globalPage.evaluate((targetRadius) => {
              const listboxes = Array.from(document.querySelectorAll('[role="listbox"]'));
              if (!listboxes.length) return { success: false, reason: 'Не найден listbox' };
              const targetText = `${targetRadius} миль`;
              for (const listbox of listboxes) {
                const options = Array.from(listbox.querySelectorAll('[role="option"]'));
                for (const option of options) {
                  const spans = Array.from(option.querySelectorAll('span'));
                  for (const span of spans) {
                    if (span.textContent && span.textContent.trim() === targetText) {
                      (option as HTMLElement).click();
                      return { success: true, id: option.id, text: targetText };
                    }
                  }
                }
              }
              const allOptions = Array.from(document.querySelectorAll('div[role="option"]'));
              for (const option of allOptions) {
                const spans = Array.from(option.querySelectorAll('span'));
                for (const span of spans) {
                  if (span.textContent && span.textContent.trim() === targetText) {
                    try {
                      (option as HTMLElement).click();
                      return { success: true, id: option.id, text: targetText, method: 'global-search' };
                    } catch (e) {
                      return { success: false, reason: 'Ошибка клика', error: String(e) };
                    }
                  }
                }
              }
              const allRadiusOptions = Array.from(document.querySelectorAll('span'))
                .filter(span => {
                  const text = span.textContent;
                  return text && /\d+ миль$/.test(text.trim());
                })
                .map(span => {
                  const text = span.textContent?.trim() || '';
                  const value = parseInt(text);
                  return {
                    element: span,
                    text,
                    value: isNaN(value) ? 0 : value,
                    diff: Math.abs((isNaN(value) ? 0 : value) - parseInt(targetRadius))
                  };
                })
                .sort((a, b) => a.diff - b.diff);
              if (allRadiusOptions.length > 0) {
                const closest = allRadiusOptions[0];
                let parent = closest.element.parentElement;
                while (parent && parent.getAttribute('role') !== 'option') {
                  parent = parent.parentElement;
                }
                if (parent) {
                  try {
                    (parent as HTMLElement).click();
                    return { 
                      success: true, 
                      id: parent.id, 
                      text: closest.text, 
                      method: 'closest-match', 
                      value: closest.value 
                    };
                  } catch (e) {
                    return { success: false, reason: 'Ошибка клика на ближайшем значении', error: String(e) };
                  }
                }
                try {
                  const parentAny = closest.element.parentElement;
                  if (parentAny) {
                    (parentAny as HTMLElement).click();
                    return { success: true, text: closest.text, method: 'parent-span-click', value: closest.value };
                  } else {
                    (closest.element as HTMLElement).click();
                    return { success: true, text: closest.text, method: 'direct-span-click', value: closest.value };
                  }
                } catch (e) {
                  return { success: false, reason: 'Ошибка прямого клика на тексте', error: String(e) };
                }
              }
              return { success: false, reason: 'Не найден радиус', options: allRadiusOptions.length };
            }, radius.toString());
            console.log('[set-location] Результат выбора радиуса через JS:', selectRadiusResult);
            if (selectRadiusResult.success) {
              console.log(`[set-location] Радиус успешно выбран: ${selectRadiusResult.text || radius + ' miles'}`);
              await globalPage.waitForTimeout(1000);
            } else {
              console.log(`[set-location] Не удалось выбрать радиус через JS: ${JSON.stringify(selectRadiusResult)}`);
              console.log('[set-location] ищу выпадающий список с вариантами радиуса');
              const listbox = await globalPage.waitForSelector('[role="listbox"]', { timeout: 3000 }).catch(() => null);
              if (listbox) {
                console.log('[set-location] listbox найден, ищу нужное значение');
                const radiusOption = await globalPage.waitForSelector(`[role="option"] span:text("${radius} миль")`, { timeout: 3000 }).catch(() => null);
                if (radiusOption) {
                  try {
                    await radiusOption.click({ timeout: 3000 });
                    console.log(`[set-location] Успешно кликнул на опцию "${radius} miles"`);
                    await globalPage.waitForTimeout(1000);
                  } catch (clickError) {
                    console.log(`[set-location] Ошибка при клике на опцию: ${clickError}`);
                    const MAX_RETRY = 3;
                    let retry = 0;
                    while (retry < MAX_RETRY) {
                      retry++;
                      console.log(`[set-location] Попытка ${retry} выбора радиуса через JavaScript`);
                      try {
                        const jsResult = await globalPage.evaluate((targetRadius) => {
                          const radiusStr = `${targetRadius} миль`;
                          const options = Array.from(document.querySelectorAll('[role="option"]'));
                          for (const opt of options) {
                            if (opt.textContent && opt.textContent.includes(radiusStr)) {
                              (opt as HTMLElement).click();
                              return { success: true, text: radiusStr };
                            }
                          }
                          return { success: false };
                        }, radius);
                        if (jsResult.success) {
                          console.log(`[set-location] Успешно выбран радиус через JS на попытке ${retry}`);
                          break;
                        }
                      } catch (e) {
                        console.log(`[set-location] Ошибка в попытке ${retry}: ${e}`);
                      }
                      await globalPage.waitForTimeout(500);
                    }
                  }
                } else {
                  console.log(`[set-location] Опция "${radius} miles" не найдена по тексту`);
                }
              }
            }
          } catch (clickError) {
            console.log(`[set-location] ошибка при клике на combobox: ${clickError}`);
          }
        } else {
          console.log('[set-location] radiusCombo НЕ найден');
        }
        
        // Если не удалось выбрать радиус миль, пробуем с километрами
        console.log('[set-location] Пробуем выбрать радиус в километрах (запасной вариант)');
        try {
          // Пробуем найти селектор для показа списка радиусов
          const radiusSelector = await globalPage.$('.x1a8lsjc:nth-child(1)');
          if (radiusSelector && globalPage) {
            await radiusSelector.click().catch(async () => {
              const box = await radiusSelector.boundingBox();
              if (box) {
                await globalPage!.mouse.click(box.x + box.width/2, box.y + box.height/2);
              } else {
                await radiusSelector.evaluate((el: HTMLElement) => el.click());
              }
            });
            
            await globalPage.waitForTimeout(1000);
            
            // Определяем какой километровый радиус выбрать
            let kmRadiusSelector = '';
            let kmValue = '';
            
            // Преобразуем мили в ближайшее значение километров
            const milesValue = parseInt(radius.toString());
            if (milesValue <= 1) {
              kmRadiusSelector = '#_r_20___0 > .html-div';
              kmValue = '1 км';
            } else if (milesValue <= 3) {
              kmRadiusSelector = '#_r_20___1 > .html-div';
              kmValue = '2 км';
            } else if (milesValue <= 7) {
              kmRadiusSelector = '#_r_20___2';
              kmValue = '5 км';
            } else if (milesValue <= 15) {
              kmRadiusSelector = '#_r_20___3 > .html-div';
              kmValue = '10 км';
            } else if (milesValue <= 30) {
              kmRadiusSelector = '#_r_20___4 > .html-div';
              kmValue = '20 км';
            } else if (milesValue <= 50) {
              kmRadiusSelector = 'text=40 км';
              kmValue = '40 км';
            } else if (milesValue <= 70) {
              kmRadiusSelector = '#_r_20___6';
              kmValue = '60 км';
            } else if (milesValue <= 90) {
              kmRadiusSelector = 'text=80 км';
              kmValue = '80 км';
            } else if (milesValue <= 175) {
              kmRadiusSelector = 'text=100 км';
              kmValue = '100 км';
            } else if (milesValue <= 350) {
              kmRadiusSelector = '#_r_20___9 > .html-div';
              kmValue = '250 км';
            } else {
              kmRadiusSelector = '#_r_20___10';
              kmValue = '500 км';
            }
            
            console.log(`[set-location] Пробую выбрать радиус ${kmValue} с селектором ${kmRadiusSelector}`);
            
            // Пробуем сначала по селектору
            const kmRadiusElement = await globalPage.$(kmRadiusSelector);
            if (kmRadiusElement) {
              await kmRadiusElement.click().catch(async () => {
                // Если не удалось кликнуть напрямую, пробуем через текст
                if (globalPage) {
                  const textSelector = await globalPage.locator(`text=${kmValue}`).first();
                  if (await textSelector.count() > 0) {
                    await textSelector.click();
                    console.log(`[set-location] Радиус выбран через текстовый селектор ${kmValue}`);
                  } else {
                    // Последняя попытка через JavaScript
                    await globalPage.evaluate((value) => {
                      const allElements = document.querySelectorAll('div[role="option"], span');
                      for (const el of Array.from(allElements)) {
                        if (el.textContent && el.textContent.trim() === value) {
                          (el as HTMLElement).click();
                          return true;
                        }
                      }
                      return false;
                    }, kmValue);
                    console.log(`[set-location] Радиус выбран через JavaScript поиск ${kmValue}`);
                  }
                }
              });
              console.log(`[set-location] Радиус в км успешно выбран: ${kmValue}`);
              await globalPage.waitForTimeout(1000);
            } else {
              console.log(`[set-location] Не найден элемент радиуса в км по селектору ${kmRadiusSelector}`);
              
              // Пробуем по тексту
              if (globalPage) {
                const textSelector = await globalPage.locator(`text=${kmValue}`).first();
                if (await textSelector.count() > 0) {
                  await textSelector.click();
                  console.log(`[set-location] Радиус выбран через текстовый селектор ${kmValue}`);
                }
              }
            }
          }
        } catch (kmError) {
          console.log(`[set-location] Ошибка при выборе радиуса в км: ${kmError}`);
        }
      }
      
      // Ищем кнопку "Применить" с использованием нескольких селекторов
      let applyButton = await globalPage.$('div[role="button"]:has-text("Применить"), button:has-text("Применить")');
      
      // Если не нашли по предыдущим селекторам, пробуем селектор из Playwright примера
      if (!applyButton) {
        applyButton = await globalPage.$('.xjp7ctv .x1i10hfl > .x1ja2u2z');
        if (applyButton) {
          console.log('[set-location] applyButton найден через селектор из Playwright примера');
        }
      }
      
      if (applyButton) {
        console.log('[set-location] applyButton найден, кликаю');
        try {
          await applyButton.evaluate((el: HTMLElement) => el.click());
          await globalPage.waitForTimeout(1200);
          console.log('[set-location] клик на кнопку Применить выполнен через JS');
        } catch (e) {
          try {
            await applyButton.click();
            await globalPage.waitForTimeout(1200);
            console.log('[set-location] клик на кнопку Применить выполнен через обычный клик');
          } catch (clickError) {
            console.log(`[set-location] ошибка при клике на кнопку Применить: ${clickError}`);
            
            // Критическая ошибка - пытаемся автовосстановление
            const recovered = await handleCriticalError('set-location-apply-button', clickError);
            if (!recovered) {
              return res.status(500).json({
                success: false,
                error: `Критическая ошибка при установке местоположения: ${clickError}`,
                status: "browser_restart_failed"
              });
            }
          }
        }
      } else {
        console.log('[set-location] applyButton НЕ найден');
      }
      console.log('[set-location] done');
      
      // Сохраняем местоположение в состояние для автовосстановления
      currentAppState.location = city;
      currentAppState.radius = radius;
      
      return res.json({
        success: true,
        message: `Местоположение установлено: ${city}${radius ? ', радиус ' + radius + ' miles' : ''}`,
        status: "completed",
        applied: {
          city: city,
          radius: radius || null
        }
      });
    } else {
      console.log('[set-location] cityBlock НЕ найден');
      return res.status(404).json({
        success: false,
        error: 'Кнопка открытия меню местоположения не найдена',
        status: "not_found"
      });
    }
  } catch (error) {
    console.log('[set-location] ERROR', error);
    return res.status(500).json({
      success: false,
      error: `Не удалось установить местоположение: ${error}`,
      status: "failed"
    });
  }
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
      } catch {}
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

async function geocodeCity(query: string): Promise<{ success: boolean; lat?: number; lon?: number; name?: string; error?: string }> {
  try {
    if (!query || typeof query !== 'string') {
      return { success: false, error: 'invalid_query' };
    }

    const lower = query.toLowerCase();
    const cached = geoCache.get(lower);
    if (cached && Date.now() - cached.timestamp < 24 * 60 * 60 * 1000) {
      return { success: true, lat: cached.lat, lon: cached.lon, name: cached.name };
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
    const name = loc.display_name || query;
    geoCache.set(lower, { lat, lon, name, timestamp: Date.now() });
    if (geoCache.size > 1000) {
      const keys = Array.from(geoCache.keys()).slice(0, geoCache.size - 1000);
      keys.forEach(k => geoCache.delete(k));
    }
    return { success: true, lat, lon, name };
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
    return res.json({ success: true, lat: result.lat, lon: result.lon, name: result.name });
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