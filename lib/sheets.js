/**
 * Общий слой доступа к Google Таблицам для Cloudflare Pages Functions.
 *
 * Здесь живёт всё, что одинаково для любого дашборда: запрос к gviz, разбор
 * его JS-обёртки, приведение значений, edge-кэш с отдачей последнего удачного
 * ответа и формирование HTTP-ответа. Конкретные функции в functions/api/
 * описывают только то, какие листы и диапазоны им нужны.
 */

const DEFAULT_TTL = 300;

/**
 * gviz отдаёт JS-обёртку вида
 * `/*O_o*\/google.visualization.Query.setResponse({...});`
 * Достаём из неё JSON.
 */
export function parseGviz(body) {
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

/**
 * Даты gviz присылает строкой `Date(2025,5,20)` — месяц с нуля.
 * Приводим к ISO, всё остальное отдаём как есть.
 */
export function normalizeCell(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const m = /^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?\)$/.exec(value);
    if (m) {
      const pad = (n) => String(n).padStart(2, '0');
      return `${m[1]}-${pad(Number(m[2]) + 1)}-${pad(Number(m[3]))}`;
    }
  }
  return value;
}

function gvizUrl(sheetId, params) {
  const query = new URLSearchParams({ tqx: 'out:json', ...params });
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?${query}`;
}

async function requestSheet(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'viferon-dashboards/1.0' },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!res.ok) throw new Error(`Google Sheets ответил ${res.status}`);
  return parseGviz(await res.text());
}

/**
 * Читает лист или его диапазон, считая ПЕРВУЮ строку шапкой.
 *
 * Режим `headers=1` — единственный предсказуемый: при `headers=0` gviz всё
 * равно превращает первую строку в подписи колонок, если она текстовая.
 * Поэтому диапазон всегда начинается со строки шапки, а данные приходят следом.
 *
 * @returns {{labels: string[], rows: Array<Array<*>>}}
 */
export async function fetchTable(sheetId, sheet, range) {
  const params = { headers: '1', sheet };
  if (range) params.range = range;

  const table = await requestSheet(gvizUrl(sheetId, params));
  return {
    labels: (table.cols || []).map((c) => String((c && c.label) || '').trim()),
    rows: (table.rows || []).map((row) => (row.c || []).map((cell) => normalizeCell(cell ? cell.v : null))),
  };
}

export function clampTtl(raw, fallback = DEFAULT_TTL) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 30), 3600);
}

export function json(payload, headers = {}, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      ...headers,
    },
  });
}

export function withHeaders(response, headers) {
  const next = new Response(response.body, response);
  for (const [key, value] of Object.entries(headers)) next.headers.set(key, value);
  return next;
}

export function preflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-max-age': '86400',
    },
  });
}

/**
 * Обёртка вокруг загрузчика данных: edge-кэш на TTL, обход по `?refresh=1`
 * и отдача последнего удачного ответа, если Google недоступен.
 *
 * @param {object} context   контекст Pages Function (request, waitUntil)
 * @param {object} options   { ttl, lastGoodKey, load }
 */
export async function serveCached(context, options) {
  const { request, waitUntil } = context;
  const { ttl, lastGoodKey, load } = options;

  const url = new URL(request.url);
  const bypass = url.searchParams.has('refresh');

  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}${url.pathname}`, { method: 'GET' });
  const lastGood = new Request(lastGoodKey, { method: 'GET' });

  if (!bypass) {
    const hit = await cache.match(cacheKey);
    if (hit) return withHeaders(hit, { 'x-cache': 'HIT' });
  }

  try {
    const payload = await load();
    const fresh = json(payload, {
      'cache-control': `public, max-age=60, s-maxage=${ttl}`,
      'x-cache': bypass ? 'BYPASS' : 'MISS',
      'x-data-source': 'google-sheets',
    });

    waitUntil(cache.put(cacheKey, fresh.clone()));
    waitUntil(cache.put(lastGood, json(payload, { 'cache-control': 'public, max-age=86400' })));

    return fresh;
  } catch (err) {
    const stale = await cache.match(lastGood);
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
