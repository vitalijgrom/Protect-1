/**
 * Прослойка для дашборда отзывов: лист с плоской таблицей карточек товара.
 *
 * GET /api/reviews            — нормализованные строки листа
 * GET /api/reviews?refresh=1  — обойти edge-кэш и сходить в Google
 *
 * Переменные окружения (wrangler.toml или Pages → Variables):
 *   SHEET_ID    — id таблицы
 *   SHEET_NAME  — имя листа, по умолчанию "Data"
 *   CACHE_TTL   — время жизни edge-кэша в секундах, по умолчанию 300
 */

import { fetchTable, serveCached, clampTtl, preflight } from '../../lib/sheets.js';

const DEFAULT_SHEET_ID = '1LvR1dNFDnPKpOLRFNkyJ3HPjDWivmVuaDA4Mggy2COk';
const DEFAULT_SHEET_NAME = 'Data';

/**
 * Сопоставление колонок таблицы с полями JSON.
 * Порядок важен: «Ссылка на товар» тоже содержит слово «товар»,
 * поэтому url ищется раньше product.
 */
const FIELDS = [
  { key: 'url', test: /ссыл|url|link/i, fallback: 3 },
  { key: 'reviews', test: /отзыв/i, fallback: 4 },
  { key: 'status', test: /статус|примеч|коммент/i, fallback: 5 },
  { key: 'n', test: /^№|номер|^#/i, fallback: 0 },
  { key: 'site', test: /сайт|площад|домен/i, fallback: 1 },
  { key: 'product', test: /sku|товар|продукт|позиц/i, fallback: 2 },
];

export function onRequestGet(context) {
  const { env } = context;
  const sheetId = env.SHEET_ID || DEFAULT_SHEET_ID;
  const sheetName = env.SHEET_NAME || DEFAULT_SHEET_NAME;

  return serveCached(context, {
    ttl: clampTtl(env.CACHE_TTL),
    lastGoodKey: 'https://cache.internal/reviews/last-good',
    load: () => loadSheet(sheetId, sheetName),
  });
}

export const onRequestOptions = preflight;

export async function loadSheet(sheetId, sheetName) {
  const { labels, rows: raw } = await fetchTable(sheetId, sheetName);
  const map = mapColumns(labels);
  const rows = [];

  for (const cells of raw) {
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

function mapColumns(labels) {
  const used = new Set();
  const map = {};

  for (const field of FIELDS) {
    let idx = labels.findIndex((label, i) => !used.has(i) && field.test.test(label));
    if (idx === -1 && !used.has(field.fallback) && field.fallback < labels.length) {
      idx = field.fallback;
    }
    if (idx !== -1) used.add(idx);
    map[field.key] = idx;
  }
  return map;
}

function pick(cells, idx) {
  if (idx === undefined || idx === -1) return null;
  const value = cells[idx];
  return value === undefined ? null : value;
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
