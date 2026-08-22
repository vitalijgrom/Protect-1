/**
 * Cloudflare Pages Function — прослойка между дашбордом и Google Sheets.
 *
 * GET /api/reviews          — нормализованные данные листа (из edge-кэша, если он тёплый)
 * GET /api/reviews?refresh=1 — принудительно обойти кэш и сходить в Google
 *
 * Зачем прослойка:
 *  1. ID таблицы не уезжает в браузер — он живёт только в переменных окружения Pages;
 *  2. ответ кэшируется на edge (Google отдаёт no-store, поэтому кэшируем сами);
 *  3. последний удачный ответ хранится отдельно и отдаётся как stale,
 *     если Google недоступен — дашборд не белеет;
 *  4. сырой ответ gviz приводится к стабильной JSON-схеме, одинаковой со снапшотом.
 *
 * Переменные окружения (Pages → Settings → Variables):
 *   SHEET_ID    — id таблицы (обязательна в проде)
 *   SHEET_NAME  — имя листа, по умолчанию "Data"
 *   CACHE_TTL   — время жизни edge-кэша в секундах, по умолчанию 300
 */

const DEFAULT_SHEET_ID = '1LvR1dNFDnPKpOLRFNkyJ3HPjDWivmVuaDA4Mggy2COk';
const DEFAULT_SHEET_NAME = 'Data';
const DEFAULT_TTL = 300;

/** Ключ, под которым в edge-кэше лежит последний успешный ответ. */
const LAST_GOOD_KEY = 'https://cache.internal/reviews/last-good';

/**
 * Сопоставление колонок таблицы с полями JSON.
 * Порядок важен: «Ссылка на товар» тоже содержит слово «товар»,
 * поэтому url ищется раньше product.
 */
const FIELDS = [
  { key: 'url', test: /ссыл|url|link/i, fallback: 3 },
  { key: 'reviews', test: /отзыв/i, fallback: 4, numeric: true },
  { key: 'status', test: /статус|примеч|коммент/i, fallback: 5 },
  { key: 'n', test: /^№|номер|^#/i, fallback: 0, numeric: true },
  { key: 'site', test: /сайт|площад|домен/i, fallback: 1 },
  { key: 'product', test: /sku|товар|продукт|позиц/i, fallback: 2 },
];

export async function onRequestGet(context) {
  const { request, env, waitUntil } = context;
  const url = new URL(request.url);
  const bypass = url.searchParams.has('refresh');

  const sheetId = env.SHEET_ID || DEFAULT_SHEET_ID;
  const sheetName = env.SHEET_NAME || DEFAULT_SHEET_NAME;
  const ttl = clampTtl(env.CACHE_TTL);

  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}${url.pathname}`, { method: 'GET' });

  if (!bypass) {
    const hit = await cache.match(cacheKey);
    if (hit) return withHeaders(hit, { 'x-cache': 'HIT' });
  }

  try {
    const payload = await loadSheet(sheetId, sheetName);
    const fresh = json(payload, {
      'cache-control': `public, max-age=60, s-maxage=${ttl}`,
      'x-cache': bypass ? 'BYPASS' : 'MISS',
      'x-data-source': 'google-sheets',
    });

    // Кладём и в обычный ключ (истекает по TTL), и в «последний удачный» (живёт дольше).
    waitUntil(cache.put(cacheKey, fresh.clone()));
    waitUntil(
      cache.put(
        new Request(LAST_GOOD_KEY, { method: 'GET' }),
        json(payload, { 'cache-control': 'public, max-age=86400' })
      )
    );

    return fresh;
  } catch (err) {
    const stale = await cache.match(new Request(LAST_GOOD_KEY, { method: 'GET' }));
    if (stale) {
      return withHeaders(stale, {
        'x-cache': 'STALE',
        'x-data-source': 'google-sheets-stale',
        'cache-control': 'no-store',
      });
    }
    return json(
      { ok: false, error: String(err && err.message ? err.message : err) },
      { 'cache-control': 'no-store' },
      502
    );
  }
}

/** Preflight — дашборд может жить на другом домене, чем эта функция. */
export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-max-age': '86400',
    },
  });
}

export async function loadSheet(sheetId, sheetName) {
  const src =
    `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq` +
    `?tqx=out:json&headers=1&sheet=${encodeURIComponent(sheetName)}`;

  const res = await fetch(src, {
    headers: { 'user-agent': 'viferon-reviews-dashboard/1.0' },
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  if (!res.ok) throw new Error(`Google Sheets ответил ${res.status}`);

  const table = parseGviz(await res.text());
  const map = mapColumns(table.cols || []);
  const rows = [];

  for (const row of table.rows || []) {
    const cells = row.c || [];
    const item = {
      n: num(pick(cells, map.n)),
      site: text(pick(cells, map.site)),
      product: text(pick(cells, map.product)),
      url: text(pick(cells, map.url)),
      reviews: num(pick(cells, map.reviews)),
      status: text(pick(cells, map.status)),
    };
    // Пустые строки-разделители в таблице пропускаем.
    if (!item.site && !item.product) continue;
    item.n = item.n === null ? rows.length + 1 : item.n;
    item.reviews = item.reviews === null ? 0 : item.reviews;
    rows.push(item);
  }

  return {
    ok: true,
    source: 'google-sheets',
    sheet: sheetName,
    fetchedAt: new Date().toISOString(),
    count: rows.length,
    rows,
  };
}

/** gviz отдаёт JS-обёртку `/*O_o*\/google.visualization.Query.setResponse({...});` */
function parseGviz(body) {
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Неожиданный формат ответа gviz');
  const data = JSON.parse(body.slice(start, end + 1));
  if (data.status === 'error') {
    const reason = (data.errors || []).map((e) => e.detailed_message || e.message).join('; ');
    throw new Error(reason || 'gviz вернул ошибку');
  }
  if (!data.table) throw new Error('В ответе gviz нет таблицы');
  return data.table;
}

function mapColumns(cols) {
  const labels = cols.map((c) => String((c && c.label) || ''));
  const used = new Set();
  const map = {};

  for (const field of FIELDS) {
    let idx = labels.findIndex((label, i) => !used.has(i) && field.test.test(label));
    if (idx === -1 && !used.has(field.fallback) && field.fallback < cols.length) {
      idx = field.fallback;
    }
    if (idx !== -1) used.add(idx);
    map[field.key] = idx;
  }
  return map;
}

function pick(cells, idx) {
  if (idx === undefined || idx === -1) return null;
  const cell = cells[idx];
  return cell ? cell.v : null;
}

function text(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function clampTtl(raw) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_TTL;
  return Math.min(Math.max(Math.trunc(parsed), 30), 3600);
}

function json(payload, headers = {}, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      ...headers,
    },
  });
}

function withHeaders(response, headers) {
  const next = new Response(response.body, response);
  for (const [key, value] of Object.entries(headers)) next.headers.set(key, value);
  return next;
}
