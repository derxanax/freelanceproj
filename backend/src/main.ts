import { Bot, Context, session, Keyboard, InlineKeyboard } from 'grammy'
import { FileAdapter } from '@grammyjs/storage-file'
import axios from 'axios'
import * as dotenv from 'dotenv'
import * as path from 'path'
import Database from 'better-sqlite3'
import fs from 'fs'
 
async function checkApiStatus(apiUrl: string): Promise<boolean> {
  try {
    console.log(`Проверка доступности API по адресу ${apiUrl}/status...`)
    const response = await axios.get(`${apiUrl}/status`)
    return response.status === 200 && response.data && response.data.stage
  } catch (error) {
    console.error(`API недоступен: ${error}`)
    return false
  }
}

async function tryRestartApiServer(): Promise<boolean> {
  console.log('Попытка перезапуска API сервера...');
  try {
    const possibleApiPaths = [
      path.resolve(__dirname, '../../api/dist/main.js'),
      path.resolve(__dirname, '../api/dist/main.js'),
      path.resolve(__dirname, '../../api/src/main.js'),
      path.join(process.cwd(), 'api/dist/main.js'),
      path.join(process.cwd(), 'api/src/main.js')
    ];
    
    let apiPath = '';
    for (const p of possibleApiPaths) {
      if (fs.existsSync(p)) {
        apiPath = p;
        console.log(`Найден путь к API серверу: ${apiPath}`);
        break;
      }
    }
    
    if (!apiPath) {
      console.error('Не удалось найти путь к API серверу для перезапуска');
      return false;
    }
    
    try {
      const checkProcess = require('child_process')
        .execSync('ps aux | grep "[n]ode.*api.*main.js"', { encoding: 'utf8' });
      
      if (checkProcess && checkProcess.length > 0) {
        console.log('API сервер уже запущен, пытаемся остановить его...');
        require('child_process')
          .execSync('pkill -f "node.*api.*main.js"', { encoding: 'utf8' });
        console.log('API сервер остановлен');
      }
    } catch (e) {
    }
    
    console.log(`Запускаем API сервер: ${apiPath}`);
    const nodeProcess = require('child_process').spawn(
      'node', 
      ['--expose-gc', apiPath],
      { 
        detached: true, 
        stdio: 'ignore',
        cwd: path.dirname(apiPath)
      }
    );
    
    nodeProcess.unref();
    
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    const apiUrl = `http://localhost:3562`;
    const available = await checkApiStatus(apiUrl);
    if (available) {
      console.log(`API успешно запущен на порту 3562`);
      return true;
    }
    
    console.error('API сервер не удалось перезапустить или он не отвечает');
    return false;
  } catch (error) {
    console.error('Ошибка при попытке перезапустить API сервер:', error);
    return false;
  }
}

async function withRetry<T>(
  fn: () => Promise<T>, 
  retries: number = 2, 
  delay: number = 1000
): Promise<T> {
  try {
    return await fn()
  } catch (error: any) {
    if (retries <= 0) {
      throw error
    }
    
    console.log(
      `Ошибка при выполнении запроса: ${error.message || error}. ` + 
      `Повторная попытка (${retries} осталось)...`
    );
    
    await new Promise(resolve => setTimeout(resolve, delay));
    return withRetry(fn, retries - 1, delay * 1.5);
  }
}

dotenv.config({ path: path.resolve(__dirname, '../../config/.env') })

const BOT_TOKEN = process.env.TG_BOT_TOKEN || ''

function getApiPort(): number {
  const defaultPort = 3562;
  const portFilePath = path.join(process.cwd(), 'api_port.txt');
  
  try {
    if (fs.existsSync(portFilePath)) {
      const content = fs.readFileSync(portFilePath, 'utf8').trim();
      const port = parseInt(content);
      if (!isNaN(port) && port > 0) {
        console.log(`Найден порт API в файле: ${port}`);
        return port;
      }
    }
  } catch (err) {
    console.error(`Ошибка при чтении файла порта:`, err);
  }

  console.log(`Используем порт по умолчанию: ${defaultPort}`);
  return defaultPort;
}

const API_PORT = getApiPort();
const API_URL = `http://localhost:${API_PORT}`;
console.log(`Используем API URL: ${API_URL}`);

interface FilterState {
  step: null | 'query' | 'city' | 'city_confirmation' | 'radius' | 'minPrice' | 'maxPrice' | 'minYear' | 'maxYear' | 'ageLimit'
  query?: string
  city?: string
  radius?: number
  minPrice?: number
  maxPrice?: number
  minYear?: number
  maxYear?: number
  maxAgeMinutes?: number
  lon?: number
  lat?: number
  tmpCityData?: {
    city: string;
    lat: number;
    lon: number;
    name: string;
    displayName: string;
  }
}

interface SessionData {
  filters: FilterState
  monitoring: boolean
  sent: Set<string>
  lastLogMessageId?: number
  consecutiveEmptyScans?: number
  lastStatusMessageId?: number
}

function initialSession(): SessionData {
  return {
    filters: { step: null },
    monitoring: false,
    sent: new Set(),
    lastLogMessageId: undefined,
    consecutiveEmptyScans: 0,
    lastStatusMessageId: undefined
  }
}

type MyContext = Context & { session: SessionData }

const bot = new Bot<MyContext>(BOT_TOKEN)
bot.use(session({ initial: initialSession, storage: new FileAdapter({ dirName: './sessions' }) }))

bot.use(async (ctx: MyContext, next: () => Promise<void>) => {
  if (!ctx.session.filters || typeof ctx.session.filters !== 'object') ctx.session.filters = { step: null }
  if (typeof ctx.session.monitoring !== 'boolean') ctx.session.monitoring = false
  if (!ctx.session.sent || !(ctx.session.sent instanceof Set)) ctx.session.sent = new Set()
  if (typeof ctx.session.lastLogMessageId !== 'number') ctx.session.lastLogMessageId = undefined
  if (typeof ctx.session.consecutiveEmptyScans !== 'number') ctx.session.consecutiveEmptyScans = 0
  if (typeof ctx.session.filters.maxAgeMinutes !== 'number') ctx.session.filters.maxAgeMinutes = undefined
  if (typeof ctx.session.lastStatusMessageId !== 'number') ctx.session.lastStatusMessageId = undefined
  await next()
})

const mainMenu = new Keyboard()
  .text('🛠 Настроить фильтры').text('🔎 Запустить мониторинг').row()
  .text('⏹ Остановить').text('📋 Мои фильтры').row()
  .text('ℹ️ Справка').text('🔄 Пере-настройка').row()
  .resized()

const db = new Database(path.resolve(__dirname, '../../sent_items.db'))

const ALL_KNOWN_URLS = new Set<string>();

try {
  const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sent_items'").get()
  
  if (!tableExists) {
    console.log('Создаю таблицу sent_items')
    db.exec(`CREATE TABLE sent_items (itemUrl TEXT PRIMARY KEY, timestamp INTEGER)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sent_items_url ON sent_items(itemUrl)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sent_items_timestamp ON sent_items(timestamp)`)
  } else {
    try {
      const testCol = db.prepare('SELECT itemUrl FROM sent_items LIMIT 1')
      testCol.get()
      
      try {
        const testTimestamp = db.prepare('SELECT timestamp FROM sent_items LIMIT 1')
        testTimestamp.get()
        console.log('Таблица sent_items уже существует с колонками itemUrl и timestamp')
      } catch (e) {
        console.log('Добавляю колонку timestamp в таблицу sent_items')
        db.exec(`ALTER TABLE sent_items ADD COLUMN timestamp INTEGER DEFAULT 0`)
        db.exec(`CREATE INDEX IF NOT EXISTS idx_sent_items_timestamp ON sent_items(timestamp)`)
      }
      
      console.log('Таблица sent_items уже существует с колонкой itemUrl')
    } catch (e) {
      console.log('Добавляю колонку itemUrl в таблицу sent_items')
      db.exec(`ALTER TABLE sent_items ADD COLUMN itemUrl TEXT`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sent_items_url ON sent_items(itemUrl)`)
      
      console.log('Добавляю колонку timestamp в таблицу sent_items')
      db.exec(`ALTER TABLE sent_items ADD COLUMN timestamp INTEGER DEFAULT 0`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sent_items_timestamp ON sent_items(timestamp)`)
    }
  }
  
  function cleanupOldRecords() {
    try {
      const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
      const deletedCount = db.prepare('DELETE FROM sent_items WHERE timestamp > 0 AND timestamp < ?').run(oneDayAgo);
      console.log(`Удалено ${deletedCount?.changes || 0} старых записей из таблицы sent_items`);
      
      const deletedLegacyCount = db.prepare('DELETE FROM sent_items WHERE timestamp IS NULL OR timestamp = 0 LIMIT 1000').run();
      if (deletedLegacyCount?.changes && deletedLegacyCount.changes > 0) {
        console.log(`Удалено ${deletedLegacyCount.changes} устаревших записей без timestamp`);
      }
      
      if ((deletedCount?.changes || 0) > 1000) {
        console.log('Выполняется вакуум БД для оптимизации размера файла...');
        db.exec('VACUUM');
        console.log('Вакуум БД завершен');
      }
    } catch (error) {
      console.error('Ошибка при очистке старых записей:', error);
    }
  }

  function loadAllUrlsToCache() {
    try {
      console.log('Загрузка всех URL из базы данных в глобальный кэш...');
      const allUrls = db.prepare('SELECT itemUrl FROM sent_items WHERE itemUrl IS NOT NULL').all();
      let count = 0;
      for (const row of allUrls as any[]) {
        if (row && row.itemUrl) {
          const normalizedUrl = row.itemUrl.split('?')[0];
          ALL_KNOWN_URLS.add(normalizedUrl);
          count++;
        }
      }
      console.log(`Загружено ${count} URL в глобальный кэш`);
    } catch (error) {
      console.error('Ошибка при загрузке URL в кэш:', error);
    }
  }

  loadAllUrlsToCache();

  cleanupOldRecords();
  
  const CLEANUP_INTERVAL = 60 * 60 * 1000; 
  setInterval(cleanupOldRecords, CLEANUP_INTERVAL);
  
} catch (e) {
  console.error('Ошибка при инициализации БД:', e)
}

const MAX_GLOBAL_URLS = 50_000;
const MAX_SESSION_URLS = 5_000;
const FLUSH_INTERVAL = 30 * 60 * 1000;

function flushGlobalUrlsToDB(retain: number = 1000) {
  try {
    if (ALL_KNOWN_URLS.size === 0) return;
    let savedCount = 0;
    const timestamp = Date.now();
    const insertStmt = db.prepare('INSERT OR IGNORE INTO sent_items (itemUrl, timestamp) VALUES (?, ?)');

    const transaction = db.transaction(() => {
      ALL_KNOWN_URLS.forEach(url => {
        if (url.startsWith('http')) {
          const result = insertStmt.run(url, timestamp);
          if (result.changes > 0) savedCount++;
        }
      });
    });

    transaction();
    if (savedCount > 0) {
      console.log(`[flushGlobalUrlsToDB] Saved ${savedCount} URLs to DB`);
    }
    if (ALL_KNOWN_URLS.size > retain) {
      const arr = Array.from(ALL_KNOWN_URLS);
      ALL_KNOWN_URLS.clear();
      for (let i = Math.max(0, arr.length - retain); i < arr.length; i++) {
        ALL_KNOWN_URLS.add(arr[i]);
      }
      console.log(`[flushGlobalUrlsToDB] Trimmed global cache to ${ALL_KNOWN_URLS.size}`);
    }
  } catch (error) {
    console.error('[flushGlobalUrlsToDB] Error:', error);
  }
}

function pruneSessionCache(ctx: MyContext) {
  try {
    if (ctx.session.sent.size > MAX_SESSION_URLS) {
      const excess = ctx.session.sent.size - MAX_SESSION_URLS;
      const arr = Array.from(ctx.session.sent);
      for (let i = 0; i < excess; i++) {
        ctx.session.sent.delete(arr[i]);
      }
      console.log(`[pruneSessionCache] Trimmed session cache to ${ctx.session.sent.size}`);
    }
  } catch (error) {
    console.error('[pruneSessionCache] Error:', error);
  }
}

async function startFilterWizard(ctx: MyContext) {
  ctx.session.filters = { step: 'query' }
  
  const apiAvailable = await checkApiStatus(API_URL);
  if (!apiAvailable) {
    await ctx.reply('❌ КРИТИЧЕСКАЯ ОШИБКА: API сервер недоступен. Мониторинг невозможен.', { reply_markup: mainMenu });
    return;
  }
  
  try {
    console.log('[startFilterWizard] Навигация на базовую страницу Marketplace...');
    const navigateResult = await withRetry(() => axios.post(`${API_URL}/navigate-to-marketplace`, {}), 3, 2000);
    if (navigateResult.data && navigateResult.data.success) {
      console.log('[startFilterWizard] Успешная навигация на базовую страницу');
    } else {
      console.log('[startFilterWizard] Навигация вернула ошибку:', navigateResult.data?.error || 'неизвестная ошибка');
    }
  } catch (navError) {
    console.error('[startFilterWizard] Ошибка при навигации на базовую страницу:', navError);
  }
  
  await ctx.reply('Введи ключевые слова для поиска:');
}

bot.command('start', async (ctx: MyContext) => {
  await ctx.reply(
    '👋 Привет!\n\n' +
    '🤖 bot by @DerxKiwi\n\n' +
    '🔥 ENTERPRISE-УРОВЕНЬ:\n' +
    '• TypeScript + Firefox Playwright\n' +
    '• Парсеры написаны с нуля\n' +
    '• Анализ кода FB Marketplace\n' +
    '• 5000₽+ на антикапчи\n' +
    '• Solo разработка\n\n' +
    'Мониторинг Facebook Marketplace объявлений по твоим фильтрам.\n\n' +
    'Выбери действие:', 
    { reply_markup: mainMenu }
  )
})

async function performFullClear(ctx: MyContext) {
  const oldCacheSize = ALL_KNOWN_URLS.size;
  const sentSize = ctx.session.sent.size;
  
  ALL_KNOWN_URLS.clear();
  ctx.session.sent = new Set();
  ctx.session.consecutiveEmptyScans = 0;
  ctx.session.lastStatusMessageId = undefined;
  
  console.log(`[Кэш] Полная очистка: глобальный кэш (было ${oldCacheSize} записей), сессия пользователя (было ${sentSize} записей)`);
  
  try {
    console.log('Загрузка всех URL из базы данных в кэш...');
    const allUrls = db.prepare('SELECT itemUrl FROM sent_items WHERE itemUrl IS NOT NULL').all();
    let count = 0;
    for (const row of allUrls as any[]) {
      if (row && row.itemUrl) {
        ALL_KNOWN_URLS.add(row.itemUrl);
        count++;
      }
    }
    console.log(`Загружено ${count} URL в глобальный кэш`);
    await ctx.reply(`✓`, { reply_markup: mainMenu });
  } catch (error) {
    console.error('Ошибка при загрузке URL в кэш:', error);
    await ctx.reply(`❌ ФАТАЛЬНАЯ ОШИБКА: Не удалось перезагрузить базу данных.`, { reply_markup: mainMenu });
  }
}

const cancelKeyboard = new InlineKeyboard().text('❌ Отмена', 'cancel_setup');

bot.command('clear', async (ctx: MyContext) => {
  const ikb = new InlineKeyboard()
    .text('✅ Да, очистить', 'clear_cache:yes')
    .text('❌ Нет, отмена', 'clear_cache:no');
  await ctx.reply('🔐 Вы уверены, что хотите полностью очистить кэш и базу данных отправленных объявлений? Это действие необратимо.', { reply_markup: ikb });
})

bot.hears('🛠 Настроить фильтры', startFilterWizard)
bot.hears('🔄 Пере-настройка', startFilterWizard)

bot.on('message:text', async (ctx: MyContext, next: () => Promise<void>) => {
  if (!ctx.message?.text) return next();
  
  const { step } = ctx.session.filters
  if (step === 'query') {
    ctx.session.filters.query = ctx.message.text
    ctx.session.filters.step = 'city'
    await axios.post(`${API_URL}/search`, { query: ctx.session.filters.query })
    await ctx.reply('Введи город поиска:', { reply_markup: cancelKeyboard })
    return
  }
  if (step === 'city') {
    const cityInput = ctx.message.text.trim();
    try {
      const geoRes = await axios.post(`${API_URL}/geocode-city`, { city: cityInput });
      console.log('Ответ геокодера:', geoRes.data);

      if (geoRes.data && geoRes.data.success) {
        
        const displayNameFull = geoRes.data.displayName || '';
        const displayNameShort = displayNameFull.split(',').slice(0, 5).join(',').trim();

        ctx.session.filters.tmpCityData = {
          city: cityInput,
          lat: geoRes.data.lat,
          lon: geoRes.data.lon,
          name: geoRes.data.name,
          displayName: displayNameFull, // Сохраняем полный для возможного использования
        };
        ctx.session.filters.step = 'city_confirmation';

        const ikb = new InlineKeyboard()
          .text('Да', 'city_confirm:yes')
          .text('Нет', 'city_confirm:no').row()
          .text('❌ Отмена', 'cancel_setup');

        await ctx.reply(`Найден город: ${geoRes.data.name} (${displayNameShort}). Подтверждаете?`, { reply_markup: ikb });

      } else {
        await ctx.reply('❌ Город не найден. Попробуйте ввести снова или проверьте доступность города на https://nominatim.openstreetmap.org/ui/search.html');
        ctx.session.filters.step = 'city';
      }
    } catch (e) {
      console.error('[city step] geocode error', e);
      await ctx.reply('❌ Город не найден. Попробуйте ввести снова или проверьте доступность города на https://nominatim.openstreetmap.org/ui/search.html');
      ctx.session.filters.step = 'city';
    }
    return;
  }
  if (step === 'minPrice') {
    const min = Number(ctx.message.text)
    if (isNaN(min)) return ctx.reply('Пожалуйста, введи число!')
    ctx.session.filters.minPrice = min
    ctx.session.filters.step = 'maxPrice'
    await ctx.reply('Введи максимальную цену (или 0 если фри цена):', { reply_markup: cancelKeyboard })
    return
  }
  if (step === 'maxPrice') {
    const max = Number(ctx.message.text)
    if (isNaN(max)) return ctx.reply('Пожалуйста, введи число!')
    ctx.session.filters.maxPrice = max
    
    // Для всех категорий спрашиваем про год (не только для машин)
    ctx.session.filters.step = 'minYear'
    await ctx.reply('Введи минимальный год выпуска (или 0 если нет ограничений):', { reply_markup: cancelKeyboard })
    return
  }
  if (step === 'minYear') {
    const minYear = Number(ctx.message.text)
    if (isNaN(minYear)) return ctx.reply('Пожалуйста, введи год в числовом формате!')
    ctx.session.filters.minYear = minYear === 0 ? undefined : minYear
    ctx.session.filters.step = 'maxYear'
    await ctx.reply('Введи максимальный год выпуска (или 0 если нет ограничений):', { reply_markup: cancelKeyboard })
    return
  }
  if (step === 'maxYear') {
    const maxYear = Number(ctx.message.text)
    if (isNaN(maxYear)) return ctx.reply('Пожалуйста, введи год в числовом формате!')
    ctx.session.filters.maxYear = maxYear === 0 ? undefined : maxYear
    ctx.session.filters.step = 'ageLimit'
    const ageKb = new InlineKeyboard()
      .text('1 мин', 'age:1').text('1 час', 'age:60').row()
      .text('4 часа', 'age:240').text('12 часов', 'age:720').row()
      .text('день', 'age:1440').text('неделя', 'age:10080').row()
      .text('❌ Отмена', 'cancel_setup')
    await ctx.reply('Выбери максимальный возраст объявления:', { reply_markup: ageKb })
    return
  }
  await next()
})

bot.callbackQuery(/^city_confirm:(yes|no)/, async (ctx: MyContext) => {
  if (ctx.session.filters.step !== 'city_confirmation' || !ctx.session.filters.tmpCityData) {
    return ctx.answerCallbackQuery();
  }
  
  if (!ctx.match) return ctx.answerCallbackQuery();

  const choice = ctx.match[1];
  const tmpData = ctx.session.filters.tmpCityData;

  if (choice === 'yes') {
    ctx.session.filters.city = tmpData.city;
    ctx.session.filters.lat = tmpData.lat;
    ctx.session.filters.lon = tmpData.lon;
    ctx.session.filters.step = 'radius';
    
    await ctx.editMessageText('✓ Город подтвержден.');

    const ikb = new InlineKeyboard()
      .text('2 миль', 'radius:2').text('5 миль', 'radius:5').row()
      .text('10 миль', 'radius:10').text('20 миль', 'radius:20').row()
      .text('40 миль', 'radius:40').text('60 миль', 'radius:60').row()
      .text('80 миль', 'radius:80').text('100 миль', 'radius:100').row()
      .text('250 миль', 'radius:250').text('500 миль', 'radius:500').row()
      .text('❌ Отмена', 'cancel_setup');
    await ctx.reply('Выбери радиус поиска:', { reply_markup: ikb });

  } else { // 'no'
    ctx.session.filters.step = 'city';
    await ctx.editMessageText('Понял. Попробуйте ввести название города еще раз.');
  }

  ctx.session.filters.tmpCityData = undefined;
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^radius:(\d+)/, async (ctx: MyContext) => {
  if (ctx.session.filters.step !== 'radius') return ctx.answerCallbackQuery()
  if (!ctx.match) return ctx.answerCallbackQuery()
  ctx.session.filters.radius = Number(ctx.match[1])
  ctx.session.filters.step = 'minPrice'
  await ctx.editMessageText(`Радиус выбран: ${ctx.session.filters.radius} миль`)
  await ctx.reply('Введи минимальную цену (или 0 если фри цена):', { reply_markup: cancelKeyboard })
})

bot.callbackQuery(/^age:(\d+)/, async (ctx: MyContext) => {
  if (ctx.session.filters.step !== 'ageLimit') return ctx.answerCallbackQuery()
  if (!ctx.match) return ctx.answerCallbackQuery()
  ctx.session.filters.maxAgeMinutes = Number(ctx.match[1])
    ctx.session.filters.step = null
  await ctx.editMessageText(`Максимальный возраст: ${ctx.session.filters.maxAgeMinutes} мин.`)
    try {
      await axios.post(`${API_URL}/set-location`, { city: ctx.session.filters.city, radius: ctx.session.filters.radius, latitude: ctx.session.filters.lat, longitude: ctx.session.filters.lon })
      await axios.post(`${API_URL}/set-price-filter`, { minPrice: ctx.session.filters.minPrice, maxPrice: ctx.session.filters.maxPrice })
      if ((ctx.session.filters.minYear !== undefined && ctx.session.filters.minYear > 0) || 
          (ctx.session.filters.maxYear !== undefined && ctx.session.filters.maxYear > 0)) {
          await axios.post(`${API_URL}/set-year-filter`, { 
        minYear: ctx.session.filters.minYear ?? null,
        maxYear: ctx.session.filters.maxYear ?? null
      }).catch(() => {})
    }
    await axios.post(`${API_URL}/set-age-filter`, { maxAgeMinutes: ctx.session.filters.maxAgeMinutes })
      await ctx.reply('✅ Фильтры сохранены! Теперь можешь запустить мониторинг.', { reply_markup: mainMenu })
    } catch (error) {
      console.error('Ошибка при применении фильтров:', error)
    await ctx.reply('❌ ФАТАЛЬНАЯ ОШИБКА: Не удалось применить фильтры.', { reply_markup: mainMenu })
    }
})

bot.callbackQuery(/^clear_cache:(yes|no)/, async (ctx: MyContext) => {
  if (!ctx.match) return ctx.answerCallbackQuery();
  const choice = ctx.match[1];

  if (choice === 'yes') {
    await performFullClear(ctx);
    await ctx.editMessageText('✅ Кэш полностью очищен.');
  } else { // 'no'
    await ctx.editMessageText('❌ Очистка отменена.');
  }
  await ctx.answerCallbackQuery();
});

bot.callbackQuery('cancel_setup', async (ctx: MyContext) => {
  ctx.session.filters = { step: null };
  try {
    await axios.post(`${API_URL}/navigate-to-marketplace`, {});
  } catch (e) {
    console.error('[cancel_setup] Failed to reset browser state', e);
  }
  await ctx.editMessageText('Настройка отменена.');
  await ctx.reply('Главное меню:', { reply_markup: mainMenu });
  await ctx.answerCallbackQuery();
});

const monitoringIntervals = new Map<number, NodeJS.Timeout>();

bot.hears('🔎 Запустить мониторинг', async (ctx: MyContext) => {
  const f = ctx.session.filters
  if (!f.query || !f.city || !f.radius) return ctx.reply('Сначала настрой фильтры!', { reply_markup: mainMenu })
  if (ctx.session.monitoring) return ctx.reply('Мониторинг уже запущен!', { reply_markup: mainMenu })
  
  const apiAvailable = await checkApiStatus(API_URL);
  if (!apiAvailable) {
    await ctx.reply('❌ API сервер недоступен. Перезапуск...', { reply_markup: mainMenu });
    const restarted = await tryRestartApiServer();
    if (!restarted) {
      await ctx.reply('❌ Не удалось перезапустить API сервер.', { reply_markup: mainMenu });
      return;
    }
  }
  
  ctx.session.consecutiveEmptyScans = 0;
  ctx.session.lastStatusMessageId = undefined;
  console.log(`[Мониторинг] Сброшены счетчики мониторинга (кэш дубликатов сохранен)`);
  
  try {
    await axios.post(`${API_URL}/navigate-to-marketplace`, {});
    await axios.post(`${API_URL}/search`, { query: f.query });
    await axios.post(`${API_URL}/set-location`, { city: f.city, radius: f.radius, latitude: f.lat, longitude: f.lon });
    await axios.post(`${API_URL}/set-price-filter`, { minPrice: f.minPrice, maxPrice: f.maxPrice });
    
    if ((f.minYear !== undefined && f.minYear > 0) || (f.maxYear !== undefined && f.maxYear > 0)) {
      try {
        await axios.post(`${API_URL}/set-year-filter`, { 
          minYear: (f.minYear !== undefined && f.minYear > 0) ? f.minYear : null,
          maxYear: (f.maxYear !== undefined && f.maxYear > 0) ? f.maxYear : null 
        });
      } catch (yearError: any) {
        console.log('Фильтр года не найден, будет применена сортировка по году из заголовка')
      }
    }
    
    // Устанавливаем фильтр по возрасту объявления, если задан
    if (f.maxAgeMinutes && f.maxAgeMinutes > 0) {
      await axios.post(`${API_URL}/set-age-filter`, { maxAgeMinutes: f.maxAgeMinutes }).catch(() => {})
    }
    
    ctx.session.monitoring = true
    await sendListings(ctx)
    await ctx.reply('✅ Мониторинг запущен!', { reply_markup: mainMenu })
    
    if (!ctx.chat) return ctx.reply('❌ Ошибка: чат недоступен')
    
    if (monitoringIntervals.has(ctx.chat.id)) {
      clearInterval(monitoringIntervals.get(ctx.chat.id));
    }
    
    const chatId = ctx.chat.id;
    const intervalId = setInterval(() => {
      if (ctx.session && ctx.session.monitoring) {
        sendListings(ctx).catch(error => {
          console.error(`[Мониторинг] Ошибка: ${error}`);
        });
      } else {
        clearInterval(intervalId);
        monitoringIntervals.delete(chatId);
      }
    }, 5 * 60 * 1000);
    
    monitoringIntervals.set(chatId, intervalId);
    
  } catch (error) {
    console.error('Ошибка при применении фильтров:', error)
    await ctx.reply('❌ Не удалось применить фильтры.', { reply_markup: mainMenu })
    ctx.session.monitoring = false
  }
})

function isFakeListingByPrice(item: any): boolean {
  const title = item.title?.trim() || '';
  const price = item.price?.trim() || '';
  
  // Проверка 1: Точное совпадение title и price
  if (title === price) return true;
  
  // Проверка 2: Title начинается с $ и содержит только цифры/запятые
  if (title.startsWith('$') && /^\$[\d,]+$/.test(title)) return true;
  
  // Проверка 3: Title короче 10 символов и похож на цену
  if (title.length < 10 && /^\$\d/.test(title)) return true;
  
  return false;
}

async function sendListings(ctx: MyContext) {
  try {
    let statusRes;
    try {
      statusRes = await axios.get(`${API_URL}/status`);
      if (!statusRes.data || !statusRes.data.stage) {
        throw new Error('Некорректный ответ API');
      }
    } catch (apiError) {
      console.log('[sendListings] API недоступен');
      ctx.session.monitoring = false;
      await ctx.reply('❌ API недоступен. Мониторинг остановлен.', { reply_markup: mainMenu });
      return;
    }
    
    if (statusRes.data.restarting_soon) {
      console.log('[sendListings] API готовится к плановому перезапуску, пропускаю цикл мониторинга.');
      return;
    }

    const res = await axios.get(`${API_URL}/listings?count=10`);
    
    if (!res.data || !res.data.items) {
      console.log('[sendListings] Некорректный ответ API');
      return
    }
    
    const items = res.data.items || []
    console.log('[sendListings] Получено объявлений:', items.length)
    
    // Фильтрация фейковых объявлений по цене
    const filteredItems = items.filter((item: any) => {
      if (isFakeListingByPrice(item)) {
        console.log(`[sendListings] Отфильтрован фейк: ${item.title}`);
        return false;
      }
      return true;
    });
    
    let fakeFilteredCount = items.length - filteredItems.length;
    if (fakeFilteredCount > 0) {
      console.log(`[sendListings] Отфильтровано ${fakeFilteredCount} фейковых объявлений`);
    }
    
    // Логируем информацию о фильтрации по времени публикации
    if (res.data.timeFilteredCount && res.data.timeFilteredCount > 0) {
      console.log(`[sendListings] API отфильтровал ${res.data.timeFilteredCount} объявлений по времени публикации`);
    }
    
    await clearImages()
    
    const uniqueItems = [];
    let duplicatesRemoved = 0;
    
    for (const item of filteredItems as any[]) {
      const url = item.itemUrl;
      if (!url) continue;
      const normalizedUrl = url.split('?')[0];

      // Проверяем дубликаты по URL (быстрая проверка)
      if (ctx.session.sent.has(normalizedUrl) || ALL_KNOWN_URLS.has(normalizedUrl)) {
        duplicatesRemoved++;
        continue;
      }
      
      // Добавляем новое объявление (только URL)
      ALL_KNOWN_URLS.add(normalizedUrl); 
      ctx.session.sent.add(normalizedUrl); 
      uniqueItems.push(item);
      
      try {
        const timestamp = Date.now();
        db.prepare('INSERT OR IGNORE INTO sent_items (itemUrl, timestamp) VALUES (?, ?)').run(normalizedUrl, timestamp);
      } catch (insertError) {
        console.error('[sendListings] Ошибка сохранения:', insertError);
      }
    }
    
    console.log(`[sendListings] Новых: ${uniqueItems.length}, дубликатов: ${duplicatesRemoved}`);
    
    pruneSessionCache(ctx);
    if (ALL_KNOWN_URLS.size >= MAX_GLOBAL_URLS) flushGlobalUrlsToDB();
    
    // Логика уведомлений о результатах сканирования
    if (uniqueItems.length > 0) {
      // Найдены новые объявления - сбрасываем счетчик и удаляем старое статусное сообщение
      ctx.session.consecutiveEmptyScans = 0;
      ctx.session.lastStatusMessageId = undefined;
      
      // Отправляем сообщение об успехе
      let successText = uniqueItems.length === 1 
        ? '✅ Найдено 1 новое объявление!' 
        : `✅ Найдено ${uniqueItems.length} новых объявлений!`;
      
      // Добавляем информацию о временной фильтрации, если она применялась
      if (res.data.timeFilteredCount && res.data.timeFilteredCount > 0) {
        successText += ` (${res.data.timeFilteredCount} отфильтровано по времени публикации)`;
      }
      
      try {
        await ctx.reply(successText);
      } catch (error) {
        console.error('[sendListings] Ошибка отправки сообщения об успехе:', error);
      }
    } else {
      // Новых объявлений нет - увеличиваем счетчик
      ctx.session.consecutiveEmptyScans = (ctx.session.consecutiveEmptyScans || 0) + 1;
      
      // Проверяем, нужно ли запустить автовосстановление
      if (ctx.session.consecutiveEmptyScans >= 3) {
        console.log('🔄 Обнаружено 3+ пустых сканов подряд, проверяю необходимость автовосстановления...');
        try {
          // Проверяем статус API и пытаемся определить проблему
          const statusResponse = await axios.get(`${API_URL}/status`);
          if (statusResponse.data && statusResponse.data.stage) {
            console.log('📊 API работает, но возвращает 0 товаров - возможна ошибка Facebook');
            
            // Попытка рефреша страницы как мягкое восстановление
            try {
              await axios.post(`${API_URL}/refresh-page`);
              console.log('🔄 Выполнен refresh страницы');
            } catch (refreshError) {
              console.log('⚠️ Refresh не помог, возможно нужно полное автовосстановление');
            }
          }
        } catch (apiError) {
          console.error('❌ API недоступен при проверке автовосстановления:', apiError);
        }
      }
      
      const statusText = `🔍 Не найдено новых объявлений (сканов без результата: ${ctx.session.consecutiveEmptyScans})`;
      
      try {
        if (ctx.session.lastStatusMessageId) {
          // Обновляем существующее сообщение
          try {
            await ctx.api.editMessageText(ctx.chat?.id!, ctx.session.lastStatusMessageId, statusText);
          } catch (editError) {
            // Если редактирование не удалось, создаем новое сообщение
            console.log('[sendListings] Не удалось отредактировать сообщение, создаю новое');
            const newMessage = await ctx.reply(statusText);
            ctx.session.lastStatusMessageId = newMessage.message_id;
          }
        } else {
          // Создаем новое сообщение и сохраняем его ID
          const newMessage = await ctx.reply(statusText);
          ctx.session.lastStatusMessageId = newMessage.message_id;
        }
      } catch (error) {
        console.error('[sendListings] Ошибка отправки/редактирования статусного сообщения:', error);
        ctx.session.lastStatusMessageId = undefined;
      }
    }
    
    for (const item of uniqueItems) {
      try {
        await ctx.replyWithPhoto(item.imageUrl, {
          caption: `💬 <b>${item.title}</b>\n💸 ${item.price}\n📍 ${item.location}\n<a href="${item.itemUrl}">Открыть товар</a>`,
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().url('Открыть', item.itemUrl)
        });
        console.log(`[sendListings] Отправлено: ${item.title}`);
      } catch (sendError) {
        console.error('[sendListings] Ошибка отправки:', sendError);
      }
    }
    
  } catch (e) {
    console.error('[sendListings] Ошибка:', e)
    
    // Проверяем, является ли ошибка критической для браузера
    const errorString = String(e);
    if (errorString.includes('Timeout') || 
        errorString.includes('NS_BINDING_ABORTED') ||
        errorString.includes('detached') ||
        errorString.includes('Protocol error') ||
        errorString.includes('browser has disconnected')) {
      
      console.log('🔄 Обнаружена критическая ошибка в мониторинге, пытаемся перезапустить API...');
      
      // Попытка перезапуска API через запрос
      try {
        const restarted = await tryRestartApiServer();
        if (restarted) {
          console.log('✅ API перезапущен, возобновляем мониторинг');
          await ctx.reply('🔄 Обнаружена ошибка браузера. API перезапущен, мониторинг продолжается.', { reply_markup: mainMenu });
          return; // Не останавливаем мониторинг
        }
      } catch (restartError) {
        console.error('[sendListings] Ошибка перезапуска API:', restartError);
      }
    }
    
    ctx.session.monitoring = false 
    await ctx.reply('❌ Ошибка мониторинга. Остановлен.', { reply_markup: mainMenu })
  }
}

async function clearImages() {
  try {
    const imgDirs = [
      '/home/derx/Проекты/freelanceproj/api/src/img',  
      path.join(process.cwd(), 'api/src/img'),
      path.join(process.cwd(), '../api/src/img'),
      path.resolve(__dirname, '../../api/src/img'),
      path.join(__dirname, '../api/src/img'),
      '/home/derx/Проекты/freelanceproj/api/src/img',
      path.resolve(process.cwd(), 'api/src/img')
    ]
    
    console.log('Очистка старых изображений (старше 30 минут)...')
    const thirtyMinutesAgo = Date.now() - (30 * 60 * 1000);
    
    let dirCleaned = false
    for (const imgDir of imgDirs) {
      if (fs.existsSync(imgDir)) {
        console.log(`Проверка директории: ${imgDir}`)
        try {
          const files = fs.readdirSync(imgDir)
          let deleted = 0
          let skipped = 0
          let duplicatesRemoved = 0
          
          const fileGroups = new Map<string, Array<{name: string, path: string, mtime: number}>>()
          
          for (const file of files) {
            if (file.endsWith('.png') || file.endsWith('.jpg') || file.endsWith('.jpeg')) {
              const filePath = path.join(imgDir, file)
              try {
                const stats = fs.statSync(filePath);
                
                if (stats.mtime.getTime() < thirtyMinutesAgo) {
                  fs.unlinkSync(filePath)
                  deleted++
                  continue
                }
                
                const productKey = file.split('_').slice(0, 2).join('_')
                if (!fileGroups.has(productKey)) {
                  fileGroups.set(productKey, [])
                }
                fileGroups.get(productKey)!.push({
                  name: file,
                  path: filePath,
                  mtime: stats.mtime.getTime()
                })
                
                skipped++
              } catch (e) {
                const errorMsg = e instanceof Error ? e.message : String(e)
                console.error(`Ошибка при проверке ${filePath}: ${errorMsg}`)
              }
            }
          }
          
          for (const [productKey, group] of fileGroups.entries()) {
            if (group.length > 1) {
              group.sort((a, b) => b.mtime - a.mtime)
              for (let i = 1; i < group.length; i++) {
                try {
                  fs.unlinkSync(group[i].path)
                  duplicatesRemoved++
                  // Скрываем эти сообщения
                  // console.log(`Удален дубликат: ${group[i].name}`)
                } catch (e) {
                  console.error(`Ошибка при удалении дубликата ${group[i].path}: ${e}`)
                }
              }
            }
          }
          
          if (deleted > 0 || skipped > 0 || duplicatesRemoved > 0) {
            console.log(`Удалено ${deleted} старых файлов, ${duplicatesRemoved} дубликатов, оставлено ${skipped - duplicatesRemoved} уникальных в ${imgDir}`)
          }
          dirCleaned = true
        } catch (e) {
          const errorMsg = e instanceof Error ? e.message : String(e)
          console.error(`Ошибка при чтении директории ${imgDir}: ${errorMsg}`)
        }
      }
    }
    
    if (!dirCleaned) {
      console.error('Не найдена ни одна директория с изображениями! Проверены пути:', imgDirs)
    }
  } catch (e) {
    console.error('Критическая ошибка при очистке изображений:', e)
  }
}

bot.hears('⏹ Остановить', async (ctx: MyContext) => {
  ctx.session.monitoring = false
  ctx.session.consecutiveEmptyScans = 0
  ctx.session.lastStatusMessageId = undefined
  
  if (!ctx.chat) return ctx.reply('❌ Ошибка: чат недоступен')
  if (monitoringIntervals.has(ctx.chat.id)) {
    clearInterval(monitoringIntervals.get(ctx.chat.id));
    monitoringIntervals.delete(ctx.chat.id);
    console.log(`[Мониторинг] Остановлен интервал для чата ${ctx.chat.id}`);
  }
  
  try {
    console.log('[Остановка] Навигация на базовую страницу Marketplace...');
    const navigateResult = await withRetry(() => axios.post(`${API_URL}/navigate-to-marketplace`, {}), 3, 2000);
    if (navigateResult.data && navigateResult.data.success) {
      console.log('[Остановка] Успешная навигация на базовую страницу');
    } else {
      console.log('[Остановка] Навигация вернула ошибку:', navigateResult.data?.error || 'неизвестная ошибка');
    }
  } catch (navError) {
    console.error('[Остановка] Ошибка при навигации на базовую страницу:', navError);
  }
  
  await clearImages()
  
  const cacheSize = ALL_KNOWN_URLS.size
  const sessionCacheSize = ctx.session.sent.size
  console.log(`[Остановка] Глобальный кэш: ${cacheSize} URL, сессия пользователя: ${sessionCacheSize} URL (сохранены)`)
  
  await ctx.reply('✓', { reply_markup: mainMenu })
})

bot.hears('📋 Мои фильтры', async (ctx: MyContext) => {
  const f = ctx.session.filters
  if (!f.query) return ctx.reply('Фильтры не настроены.', { reply_markup: mainMenu })
  
  let filterText = `Ключевые слова: ${f.query}\nГород: ${f.city}\nРадиус: ${f.radius} миль\nЦена: ${f.minPrice}–${f.maxPrice}`;
  
  if ((f.minYear !== undefined && f.minYear > 0) || (f.maxYear !== undefined && f.maxYear > 0)) {
    const minYearStr = f.minYear !== undefined && f.minYear > 0 ? f.minYear.toString() : '-';
    const maxYearStr = f.maxYear !== undefined && f.maxYear > 0 ? f.maxYear.toString() : '-';
    filterText += `\nГод выпуска: ${minYearStr}–${maxYearStr}`;
  }
  
  if (f.maxAgeMinutes) {
    filterText += `\nМаксимальный возраст: ${f.maxAgeMinutes} мин.`;
  }
  
  await ctx.reply(filterText, { reply_markup: mainMenu })
})

bot.hears('ℹ️ Справка', async (ctx: MyContext) => {
  await ctx.reply(
    'Этот бот отслеживает новые объявления на Facebook Marketplace по твоим фильтрам и присылает их сюда.\n\n1. Настрой фильтры\n2. Запусти мониторинг\n3. Получай новые объявления!\n\nbot by @DerxKiwi',
    { reply_markup: mainMenu }
  )
})

bot.catch((err: any) => console.error('Ошибка:', err))
bot.start()

setInterval(() => flushGlobalUrlsToDB(), FLUSH_INTERVAL);

setInterval(() => {
  const heapUsed = process.memoryUsage().heapUsed;
  console.log(`[Memory] heapUsed ${(heapUsed / 1024 / 1024).toFixed(1)} MB`);
  if (heapUsed > 3 * 1024 * 1024 * 1024) {
    console.log('[Memory] Threshold exceeded, flushing caches');
    flushGlobalUrlsToDB();
    axios.post(`${API_URL}/clear-image-cache`).catch(() => {});
    if ((global as any).gc) (global as any).gc();
  }
}, 10 * 60 * 1000);

function saveAllCacheToDB() {
  try {
    console.log(`[Shutdown] Saving ${ALL_KNOWN_URLS.size} URLs to DB...`);
    const timestamp = Date.now();
    const insertStmt = db.prepare('INSERT OR IGNORE INTO sent_items (itemUrl, timestamp) VALUES (?, ?)');
    const transaction = db.transaction(() => {
      ALL_KNOWN_URLS.forEach(url => {
        if (url.startsWith('http')) insertStmt.run(url, timestamp);
      });
    });
    transaction();
    console.log('[Shutdown] Done');
  } catch (error) {
    console.error('[Shutdown] Error:', error);
  }
}

process.on('SIGINT', () => {
  console.log('[Shutdown] SIGINT');
  saveAllCacheToDB();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[Shutdown] SIGTERM');
  saveAllCacheToDB();
  process.exit(0);
});