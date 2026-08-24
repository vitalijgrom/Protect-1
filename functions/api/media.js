/**
 * Прослойка для дашборда медиамониторинга.
 *
 * GET /api/media            — собранные данные всех нужных листов
 * GET /api/media?refresh=1  — обойти edge-кэш и сходить в Google
 *
 * Листы этой таблицы имеют многоуровневые шапки, а на одном листе рядом лежат
 * несколько блоков, поэтому каждый блок берётся точным диапазоном. Диапазон
 * всегда начинается со строки шапки: gviz предсказуемо работает только в
 * режиме `headers=1`. Строки взяты с запасом — лишние отсеиваются при разборе.
 *
 * Переменные окружения:
 *   MEDIA_SHEET_ID  — id таблицы медиамониторинга
 *   CACHE_TTL       — время жизни edge-кэша в секундах, по умолчанию 300
 */

import { fetchTable, serveCached, clampTtl, preflight } from '../../lib/sheets.js';

const DEFAULT_SHEET_ID = '18xL7SvIsXgU5aKOhTzYKucLs290cjCITR8Xxk29gXL4';

/**
 * Названия листов должны совпадать с ярлыками вкладок символ в символ: если имя
 * не найдено, gviz не отдаёт ошибку, а молча возвращает ПЕРВЫЙ лист таблицы.
 * Сверяться нужно именно с ярлыком — выгрузка в xlsx режет названия до 31
 * символа («…перевернуто» превращается в «…перевернут»). На случай, если лист
 * всё же переименуют, разбор ниже проверяет, что данные пришли ожидаемые.
 */
const BLOCKS = [
  { key: 'periods', sheet: 'Аналитика период к периоду', range: 'A1:N40' },
  { key: 'viferonMonths', sheet: 'Периоды Виферон', range: 'A2:I200' },
  { key: 'viferonYears', sheet: 'Периоды Виферон', range: 'R2:W25' },
  { key: 'brandYears', sheet: 'Аналитика год к году перевернуто', range: 'A1:O20' },
  { key: 'brandMonths', sheet: 'Аналитика по месяцам перевернуто', range: 'B1:FA20' },
  { key: 'kpiCount', sheet: 'KPI (кол-во)', range: 'A3:F20' },
  { key: 'kpiRatio', sheet: 'KPI (коэфицент) ', range: 'A2:F20' },
  { key: 'reposts', sheet: 'Репосты по периоду', range: 'A1:E20' },
  { key: 'bans', sheet: 'Бан контроль', range: 'A1:B95' },
];

/** «Анаферон (1 период)» → бренд «Анаферон», период 1 */
const PERIOD_LABEL = /^(.+?)\s*\(\s*([12])\s*период\s*\)\s*$/;

/** Служебные строки-итоги, которые не являются брендами. */
const NOT_A_BRAND = /^(сумма|итого?|всего|доля|прочие)/i;

export function onRequestGet(context) {
  const { env } = context;
  const sheetId = env.MEDIA_SHEET_ID || DEFAULT_SHEET_ID;

  return serveCached(context, {
    ttl: clampTtl(env.CACHE_TTL),
    lastGoodKey: 'https://cache.internal/media/last-good',
    load: () => loadWorkbook(sheetId),
  });
}

export const onRequestOptions = preflight;

export async function loadWorkbook(sheetId) {
  const blocks = {};
  await Promise.all(
    BLOCKS.map(async (block) => {
      blocks[block.key] = await fetchTable(sheetId, block.sheet, block.range);
    })
  );

  const { report, brands, totals } = parsePeriods(blocks.periods.rows);

  return {
    ok: true,
    source: 'google-sheets',
    fetchedAt: new Date().toISOString(),
    report,
    brands,
    totals,
    viferon: {
      months: parseViferonMonths(blocks.viferonMonths.rows),
      years: parseViferonYears(blocks.viferonYears.rows),
    },
    // Годы — в строках, бренды — в шапке.
    brandYears: seriesFromColumns(blocks.brandYears, toYear, 'Аналитика год к году перевернуто'),
    // Наоборот: бренды — в строках, месяцы — в шапке.
    brandMonths: seriesFromRows(blocks.brandMonths, toMonth, 'Аналитика по месяцам перевернуто'),
    kpi: {
      count: parseKpi(blocks.kpiCount.rows),
      ratio: parseKpi(blocks.kpiRatio.rows),
    },
    reposts: parseReposts(blocks.reposts.rows),
    bans: parseBans(blocks.bans.rows),
  };
}

/* --- Отчётный период: 14 брендов × 2 периода -------------------------------- */

function parsePeriods(rows) {
  const byBrand = new Map();
  const totals = {};
  const report = { from1: null, to1: null, from2: null, to2: null };

  for (const row of rows) {
    const match = PERIOD_LABEL.exec(text(row[0]));
    if (!match) continue;

    const label = match[1].trim();
    const period = Number(match[2]);
    const metrics = {
      neutral: num(row[3]),
      positive: num(row[4]),
      negative: num(row[5]),
      mentions: num(row[6]),
      positiveShare: num(row[7]),
      shareNeutral: num(row[9]),
      sharePositive: num(row[10]),
      shareNegative: num(row[11]),
      shareMentions: num(row[12]),
      loyalty: num(row[13]),
    };

    if (NOT_A_BRAND.test(label)) {
      totals[`p${period}`] = metrics;
      continue;
    }

    // Даты периодов одинаковы для всех брендов — берём из первой строки.
    if (period === 1 && !report.from1) { report.from1 = row[1]; report.to1 = row[2]; }
    if (period === 2 && !report.from2) { report.from2 = row[1]; report.to2 = row[2]; }

    if (!byBrand.has(label)) byBrand.set(label, { brand: label, p1: null, p2: null });
    byBrand.get(label)[`p${period}`] = metrics;
  }

  const brands = Array.from(byBrand.values());
  if (!brands.length) {
    throw new Error('Лист «Аналитика период к периоду» не дал ни одной строки бренда');
  }
  return { report, totals, brands };
}

/* --- Виферон по месяцам и годам --------------------------------------------- */

function parseViferonMonths(rows) {
  const out = [];
  for (const row of rows) {
    const mentions = num(row[6]);
    // Будущие месяцы заведены в таблице заранее и заполнены нулями.
    if (!row[0] || !mentions) continue;
    out.push({
      start: row[0],
      end: row[1],
      quarter: text(row[2]),
      neutral: num(row[3]),
      positive: num(row[4]),
      negative: num(row[5]),
      mentions,
      loyalty: num(row[7]),
      consultants: num(row[8]) || 0,
    });
  }
  if (!out.length) throw new Error('Лист «Периоды Виферон» не дал ни одного месяца');
  return out;
}

function parseViferonYears(rows) {
  const out = [];
  for (const row of rows) {
    const year = toYear(row[0]);
    const mentions = num(row[4]);
    if (!year || !mentions) continue;
    out.push({
      year,
      neutral: num(row[1]),
      positive: num(row[2]),
      negative: num(row[3]),
      mentions,
      consultants: num(row[5]) || 0,
    });
  }
  return out;
}

/* --- Матрицы «период × бренд» ------------------------------------------------ */

/** Бренды в шапке, периоды в первой колонке. */
function seriesFromColumns({ labels, rows }, toKey, sheetName) {
  const brands = labels.slice(1).filter((label) => label && !NOT_A_BRAND.test(label));
  assertHasViferon(brands, sheetName);

  const keys = [];
  const seen = new Set();
  const columns = brands.map(() => []);

  for (const row of rows) {
    const key = toKey(row[0]);
    if (key === null) continue;
    // Ниже основной таблицы на листе лежит ещё один блок с теми же периодами —
    // повтор ключа означает, что данные закончились.
    if (seen.has(key)) break;
    const values = brands.map((_, i) => num(row[i + 1]));
    if (!values.some((v) => v)) continue; // периоды, заведённые на будущее
    seen.add(key);
    keys.push(key);
    values.forEach((v, i) => columns[i].push(v));
  }

  return { keys, series: brands.map((brand, i) => ({ brand, values: columns[i] })) };
}

/** Бренды в первой колонке, периоды в шапке. */
function seriesFromRows({ labels, rows }, toKey, sheetName) {
  const keys = [];
  const indexes = [];
  labels.forEach((label, i) => {
    if (i === 0) return;
    const key = toKey(label);
    if (key !== null) { keys.push(key); indexes.push(i); }
  });

  const series = [];
  const seen = new Set();
  for (const row of rows) {
    const brand = text(row[0]);
    if (!brand || NOT_A_BRAND.test(brand)) continue;
    // Ниже основной таблицы идёт повторный блок с теми же брендами.
    if (seen.has(brand)) break;
    const values = indexes.map((i) => num(row[i]));
    if (!values.some((v) => v)) continue;
    seen.add(brand);
    series.push({ brand, values });
  }

  assertHasViferon(series.map((s) => s.brand), sheetName);
  return trimTail({ keys, series });
}

/**
 * Месяцы в таблице заведены до конца года вперёд. Обрезаем хвост, в котором
 * у всех брендов нули, — иначе график тянется в пустоту.
 */
function trimTail({ keys, series }) {
  let last = keys.length - 1;
  while (last >= 0 && !series.some((s) => s.values[last])) last--;
  if (last === keys.length - 1) return { keys, series };
  return {
    keys: keys.slice(0, last + 1),
    series: series.map((s) => ({ brand: s.brand, values: s.values.slice(0, last + 1) })),
  };
}

/** Если gviz подсунул не тот лист, среди брендов не окажется Виферона. */
function assertHasViferon(brands, sheetName) {
  if (!brands.includes('Виферон')) {
    throw new Error(`Лист «${sheetName}» вернул не те данные: среди брендов нет Виферона`);
  }
}

/* --- KPI, репосты, баны ------------------------------------------------------ */

function parseKpi(rows) {
  const out = [];
  for (const row of rows) {
    // Ниже данных лежат служебные строки со средними — отсекаем по году.
    const year = toYear(row[0]);
    if (!year) continue;
    out.push({
      year,
      quarters: [num(row[1]), num(row[2]), num(row[3]), num(row[4])],
      average: num(row[5]),
    });
  }
  return out;
}

function parseReposts(rows) {
  const out = [];
  for (const row of rows) {
    const year = toYear(row[0]);
    if (!year) continue;
    out.push({
      year,
      reposts: num(row[1]) || 0,
      comments: num(row[2]) || 0,
      posts: num(row[3]) || 0,
      total: num(row[4]) || 0,
    });
  }
  return out.sort((a, b) => a.year - b.year);
}

function parseBans(rows) {
  const out = [];
  for (const row of rows) {
    const accounts = num(row[1]);
    if (!row[0] || accounts === null) continue;
    out.push({ date: row[0], accounts });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/* --- Приведение значений ------------------------------------------------------ */

function toYear(value) {
  const year = num(value);
  return year && year >= 2000 && year <= 2100 ? year : null;
}

/** Подписи месяцев в шапке приходят как «01.2016». */
function toMonth(value) {
  const m = /^(\d{2})\.(\d{4})$/.exec(text(value));
  return m ? `${m[2]}-${m[1]}` : null;
}

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Number(String(value).replace(',', '.').replace(/[^\d.eE+-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}
