/* ---------------------------------------------------------------------------
   Дашборд отзывов о Виферон.
   Данные приходят из Cloudflare-функции /api/reviews, которая ходит в Google
   Таблицу. Если функция недоступна (локальная статика, обрыв связи) —
   подхватывается снапшот public/data/fallback.json, и об этом говорит баннер.
   --------------------------------------------------------------------------- */
'use strict';

var CONFIG = {
  apiUrl: 'api/reviews',
  fallbackUrl: 'data/fallback.json',
  autoRefreshMs: 5 * 60 * 1000,
  requestTimeoutMs: 12000,
};

/* Площадки, которые являются отзовиками/форумами, а не аптеками.
   Всё, чего нет в списке, считается аптечным сайтом или e-com. */
var REVIEW_PLATFORMS = [
  'irecommend.ru', 'otzovik.com', 'otzyvru.com', 'otzyv.com',
  'spasibovsem.ru', 'vashe-mnenie.com', 'woman.ru', 'baby.ru',
  'flap.rf', 'zoon.ru', 'prodoctorov.ru',
];

var TYPE_LABEL = { pharmacy: 'Аптеки и e-com', reviews: 'Отзовики и форумы' };

/* Порядок форм выпуска — от младшей дозировки к общим карточкам. */
var CATEGORY_ORDER = [
  'Супп. 150 000 МЕ',
  'Супп. 500 000 МЕ',
  'Супп. 1 000 000 МЕ',
  'Супп. 3 000 000 МЕ',
  'Супп. (без дозировки)',
  'Мазь',
  'Гель',
  'Бренд целиком',
];

/* Пороги тепловой карты. Распределение отзывов очень «длиннохвостое»
   (от 0 до 1000+), поэтому шаги неравномерные. */
var HEAT_BINS = [
  { min: 0,   label: '0' },
  { min: 1,   label: '1–4' },
  { min: 5,   label: '5–14' },
  { min: 15,  label: '15–49' },
  { min: 50,  label: '50–99' },
  { min: 100, label: '100–299' },
  { min: 300, label: '300+' },
];

var STATE = {
  rows: [],
  meta: null,
  filters: { search: '', type: '', site: '', category: '', zeroOnly: false },
  sort: { key: 'reviews', dir: 'desc' },
  loading: false,
};

var nf = new Intl.NumberFormat('ru-RU');
var $ = function (id) { return document.getElementById(id); };

/* --- Таксономия ----------------------------------------------------------- */

function classifySite(site) {
  var host = String(site || '').toLowerCase().replace(/^www\./, '').trim();
  return REVIEW_PLATFORMS.indexOf(host) !== -1 ? 'reviews' : 'pharmacy';
}

function classifyForm(product) {
  var s = String(product || '').toLowerCase();
  if (/мазь|маз[ьи]\b/.test(s)) return 'Мазь';
  if (/гель|гел[ья]\b/.test(s)) return 'Гель';
  if (/супп|свеч/.test(s)) return 'Суппозитории';
  return 'Без формы';
}

function classifyDose(product) {
  var s = String(product || '').toLowerCase().replace(/ /g, ' ');
  if (/3\s*0{3}\s*0{3}|3\s*млн|3000000/.test(s)) return '3 000 000 МЕ';
  if (/1\s*0{3}\s*0{3}|1\s*млн|1000000/.test(s)) return '1 000 000 МЕ';
  if (/500\s*0{3}|500\s*тыс|500000/.test(s)) return '500 000 МЕ';
  if (/150\s*0{3}|150\s*тыс|150000/.test(s)) return '150 000 МЕ';
  return '';
}

function categoryOf(form, dose) {
  if (form === 'Суппозитории') return dose ? 'Супп. ' + dose : 'Супп. (без дозировки)';
  if (form === 'Мазь' || form === 'Гель') return form;
  return 'Бренд целиком';
}

function enrich(raw) {
  return raw.map(function (row, i) {
    var product = String(row.product || '').trim();
    var form = classifyForm(product);
    var dose = classifyDose(product);
    return {
      n: typeof row.n === 'number' ? row.n : i + 1,
      site: String(row.site || '').trim(),
      product: product,
      url: String(row.url || '').trim(),
      reviews: Number(row.reviews) || 0,
      status: String(row.status || '').trim(),
      type: classifySite(row.site),
      form: form,
      dose: dose,
      category: categoryOf(form, dose),
    };
  });
}

/* --- Загрузка ------------------------------------------------------------- */

function fetchJson(url, timeoutMs) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  return fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json().then(function (data) {
        return { data: data, cache: res.headers.get('x-cache') || '' };
      });
    })
    .finally(function () { clearTimeout(timer); });
}

function load(force) {
  if (STATE.loading) return Promise.resolve();
  STATE.loading = true;
  $('refresh').disabled = true;
  setStatus(STATE.rows.length ? 'Обновление…' : 'Загрузка данных…');

  var url = CONFIG.apiUrl + (force ? '?refresh=1' : '');

  return fetchJson(url, CONFIG.requestTimeoutMs)
    .then(function (result) {
      if (!result.data || result.data.ok === false || !Array.isArray(result.data.rows)) {
        throw new Error((result.data && result.data.error) || 'Некорректный ответ прослойки');
      }
      apply(result.data, result.cache, null);
    })
    .catch(function (apiError) {
      // Прослойка недоступна — показываем снапшот, но честно об этом пишем.
      return fetchJson(CONFIG.fallbackUrl, CONFIG.requestTimeoutMs)
        .then(function (result) {
          apply(result.data, '', apiError);
        })
        .catch(function () {
          setStatus('Данные не загрузились');
          showBanner(
            'Не удалось получить данные ни из Cloudflare-прослойки, ни из локального снапшота. ' +
            'Проверьте /api/reviews. Причина: ' + apiError.message
          );
        });
    })
    .finally(function () {
      STATE.loading = false;
      $('refresh').disabled = false;
    });
}

function apply(payload, cacheHeader, apiError) {
  STATE.rows = enrich(payload.rows);
  STATE.meta = {
    source: payload.source || 'unknown',
    fetchedAt: payload.fetchedAt || null,
    cache: cacheHeader,
    stale: cacheHeader === 'STALE',
  };

  if (apiError) {
    showBanner(
      'Показан локальный снапшот данных: прослойка /api/reviews недоступна (' + apiError.message + '). ' +
      'При деплое на Cloudflare Pages функция появится автоматически.'
    );
  } else if (STATE.meta.stale) {
    showBanner('Google Таблица сейчас недоступна — показан последний удачный ответ из кэша Cloudflare.');
  } else {
    hideBanner();
  }

  buildFilterOptions();
  render();
  setStatus(describeMeta());
  $('foot-meta').textContent = describeSource();
}

function describeMeta() {
  if (!STATE.meta || !STATE.meta.fetchedAt) return 'Данные загружены';
  var d = new Date(STATE.meta.fetchedAt);
  if (isNaN(d.getTime())) return 'Данные загружены';
  var time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  var date = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  return 'Данные от ' + date + ', ' + time;
}

function describeSource() {
  if (!STATE.meta) return '';
  var parts = [];
  parts.push(STATE.meta.source === 'google-sheets' ? 'Источник: Google Таблица' : 'Источник: локальный снапшот');
  if (STATE.meta.cache) parts.push('edge-кэш: ' + STATE.meta.cache);
  parts.push('строк: ' + nf.format(STATE.rows.length));
  return parts.join(' · ');
}

function setStatus(text) { $('status').textContent = text; }

function showBanner(text) {
  var banner = $('banner');
  banner.textContent = text;
  banner.hidden = false;
}
function hideBanner() { $('banner').hidden = true; }

/* --- Фильтрация ----------------------------------------------------------- */

function visibleRows() {
  var f = STATE.filters;
  var needle = f.search.trim().toLowerCase();
  return STATE.rows.filter(function (row) {
    if (f.type && row.type !== f.type) return false;
    if (f.site && row.site !== f.site) return false;
    if (f.category && row.category !== f.category) return false;
    if (f.zeroOnly && row.reviews > 0) return false;
    if (needle) {
      var haystack = (row.site + ' ' + row.product + ' ' + row.url + ' ' + row.status).toLowerCase();
      if (haystack.indexOf(needle) === -1) return false;
    }
    return true;
  });
}

function buildFilterOptions() {
  var sites = unique(STATE.rows.map(function (r) { return r.site; })).sort(function (a, b) {
    return a.localeCompare(b, 'ru');
  });
  fillSelect($('f-site'), sites, 'Все площадки', STATE.filters.site);

  var cats = CATEGORY_ORDER.filter(function (c) {
    return STATE.rows.some(function (r) { return r.category === c; });
  });
  fillSelect($('f-form'), cats, 'Все формы', STATE.filters.category);
}

function fillSelect(select, values, allLabel, current) {
  select.textContent = '';
  select.appendChild(new Option(allLabel, ''));
  values.forEach(function (value) { select.appendChild(new Option(value, value)); });
  select.value = values.indexOf(current) !== -1 ? current : '';
}

function unique(list) {
  var seen = Object.create(null);
  var out = [];
  list.forEach(function (item) {
    if (item && !seen[item]) { seen[item] = true; out.push(item); }
  });
  return out;
}

/* --- Рендер --------------------------------------------------------------- */

function render() {
  var rows = visibleRows();
  renderKpis(rows);
  renderSites(rows);
  renderCategories(rows);
  renderSplit(rows);
  renderHeat(rows);
  renderTable(rows);
}

function sum(rows, key) {
  return rows.reduce(function (acc, r) { return acc + (key ? r[key] : 1); }, 0);
}

function median(values) {
  if (!values.length) return 0;
  var sorted = values.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function renderKpis(rows) {
  var total = sum(rows, 'reviews');
  var sites = unique(rows.map(function (r) { return r.site; })).length;
  var zero = rows.filter(function (r) { return r.reviews === 0; }).length;
  var med = median(rows.map(function (r) { return r.reviews; }));

  $('kpi-total').textContent = nf.format(total);
  $('kpi-sites').textContent = nf.format(sites);
  $('kpi-cards').textContent = nf.format(rows.length);
  $('kpi-zero').textContent = nf.format(zero);
  $('kpi-median').textContent = nf.format(med);

  var isFiltered = rows.length !== STATE.rows.length;
  $('kpi-total-hint').textContent = isFiltered
    ? 'по текущему фильтру'
    : 'по всем отслеживаемым карточкам';

  var pharm = rows.filter(function (r) { return r.type === 'pharmacy'; });
  var revs = rows.filter(function (r) { return r.type === 'reviews'; });
  $('kpi-sites-hint').textContent =
    unique(pharm.map(function (r) { return r.site; })).length + ' аптечных · ' +
    unique(revs.map(function (r) { return r.site; })).length + ' отзовиков';

  var maxRow = rows.reduce(function (best, r) { return !best || r.reviews > best.reviews ? r : best; }, null);
  $('kpi-cards-hint').textContent = maxRow
    ? 'максимум — ' + nf.format(maxRow.reviews) + ' на ' + maxRow.site
    : ' ';

  $('kpi-zero-hint').textContent = rows.length
    ? Math.round((zero / rows.length) * 100) + '% карточек — точки роста'
    : ' ';

  $('kpi-median-hint').textContent = rows.length
    ? 'среднее — ' + nf.format(Math.round(total / rows.length))
    : ' ';
}

/**
 * Горизонтальные бары. Категории номинальные, поэтому все бары одного цвета:
 * длина уже кодирует величину, красить её ещё и оттенком нечем и незачем.
 */
function renderBars(container, items, options) {
  container.textContent = '';
  if (!items.length) {
    container.appendChild(node('p', { className: 'empty' }, 'Под фильтр ничего не попало'));
    return;
  }
  var max = items.reduce(function (m, it) { return Math.max(m, it.value); }, 0) || 1;
  var wrap = node('div', { className: 'bars' });

  items.forEach(function (item) {
    var row = node('div', { className: 'bar-row' + (item.value === 0 ? ' bar-row--muted' : '') });
    row.tabIndex = 0;

    var label = node('span', { className: 'bar-row__label' });
    if (item.dot) label.appendChild(node('span', { className: 'pill__dot pill--' + item.dot }));
    label.appendChild(node('span', { className: 'bar-row__labeltext' }, item.label));
    label.title = item.label;

    var track = node('div', { className: 'bar-row__track' });
    var fill = node('div', { className: 'bar-row__fill' });
    fill.style.width = Math.max((item.value / max) * 100, item.value > 0 ? 1 : 0) + '%';
    track.appendChild(fill);

    row.appendChild(label);
    row.appendChild(track);
    row.appendChild(node('span', { className: 'bar-row__value' }, nf.format(item.value)));

    bindTooltip(row, function () {
      return {
        value: nf.format(item.value) + ' отзыв' + plural(item.value, '', 'а', 'ов'),
        label: item.label,
        meta: options && options.meta ? options.meta(item) : '',
      };
    });

    wrap.appendChild(row);
  });

  container.appendChild(wrap);
}

function renderSites(rows) {
  var byKey = groupBy(rows, 'site');
  var items = Object.keys(byKey).map(function (site) {
    var group = byKey[site];
    return {
      label: site,
      value: sum(group, 'reviews'),
      cards: group.length,
      type: group[0].type,
      dot: group[0].type,
      zero: group.filter(function (r) { return r.reviews === 0; }).length,
    };
  }).sort(function (a, b) { return b.value - a.value || a.label.localeCompare(b.label, 'ru'); });

  renderBars($('chart-sites'), items, {
    meta: function (item) {
      return TYPE_LABEL[item.type] + ' · карточек: ' + item.cards +
        (item.zero ? ' · без отзывов: ' + item.zero : '');
    },
  });

  var legend = node('div', { className: 'legend legend--inline' });
  [['pharmacy', 'var(--series-1)'], ['reviews', 'var(--series-2)']].forEach(function (pair) {
    var item = node('div', { className: 'legend__item' });
    var swatch = node('span', { className: 'legend__swatch legend__swatch--dot' });
    swatch.style.background = pair[1];
    item.appendChild(swatch);
    item.appendChild(node('span', {}, TYPE_LABEL[pair[0]]));
    legend.appendChild(item);
  });
  $('chart-sites').appendChild(legend);
}

function renderCategories(rows) {
  var byKey = groupBy(rows, 'category');
  var items = CATEGORY_ORDER.filter(function (c) { return byKey[c]; }).map(function (cat) {
    var group = byKey[cat];
    return { label: cat, value: sum(group, 'reviews'), cards: group.length };
  }).sort(function (a, b) { return b.value - a.value; });

  renderBars($('chart-forms'), items, {
    meta: function (item) { return 'карточек: ' + item.cards; },
  });
}

function renderSplit(rows) {
  var container = $('chart-split');
  container.textContent = '';

  var groups = [
    { key: 'pharmacy', label: TYPE_LABEL.pharmacy, cls: 'split__seg--1', swatch: 'var(--series-1)' },
    { key: 'reviews', label: TYPE_LABEL.reviews, cls: 'split__seg--2', swatch: 'var(--series-2)' },
  ].map(function (group) {
    var subset = rows.filter(function (r) { return r.type === group.key; });
    group.value = sum(subset, 'reviews');
    group.cards = subset.length;
    group.sites = unique(subset.map(function (r) { return r.site; })).length;
    return group;
  });

  var total = groups[0].value + groups[1].value;
  if (!total) {
    container.appendChild(node('p', { className: 'empty' }, 'Под фильтр ничего не попало'));
    return;
  }

  var bar = node('div', { className: 'split' });
  groups.forEach(function (group) {
    if (!group.value) return;
    var seg = node('div', { className: 'split__seg ' + group.cls });
    seg.style.flex = group.value + ' 1 0';
    seg.tabIndex = 0;
    bindTooltip(seg, function () {
      return {
        value: nf.format(group.value) + ' (' + pct(group.value, total) + ')',
        label: group.label,
        meta: 'площадок: ' + group.sites + ' · карточек: ' + group.cards,
      };
    });
    bar.appendChild(seg);
  });
  container.appendChild(bar);

  // Легенда обязательна: цвет никогда не остаётся единственным носителем смысла.
  var legend = node('div', { className: 'legend' });
  groups.forEach(function (group) {
    var item = node('div', { className: 'legend__item' });
    var swatch = node('span', { className: 'legend__swatch' });
    swatch.style.background = group.swatch;
    item.appendChild(swatch);
    item.appendChild(node('span', {}, group.label + ' — '));
    item.appendChild(node('span', { className: 'legend__value' },
      nf.format(group.value) + ' (' + pct(group.value, total) + ')'));
    legend.appendChild(item);
  });
  container.appendChild(legend);
}

function renderHeat(rows) {
  var container = $('chart-heat');
  container.textContent = '';

  var sites = unique(rows.map(function (r) { return r.site; }));
  var cats = CATEGORY_ORDER.filter(function (cat) {
    return rows.some(function (r) { return r.category === cat; });
  });

  if (!sites.length || !cats.length) {
    container.appendChild(node('p', { className: 'empty' }, 'Под фильтр ничего не попало'));
    $('heat-legend').textContent = '';
    return;
  }

  // cell[site][category] = { reviews, cards } — отсутствие ключа означает,
  // что карточки на площадке нет вовсе (это не то же самое, что «0 отзывов»).
  var cell = {};
  rows.forEach(function (row) {
    var bucket = (cell[row.site] || (cell[row.site] = {}));
    var entry = (bucket[row.category] || (bucket[row.category] = { reviews: 0, cards: 0 }));
    entry.reviews += row.reviews;
    entry.cards += 1;
  });

  var totals = {};
  sites.forEach(function (site) {
    totals[site] = rows.reduce(function (acc, r) { return r.site === site ? acc + r.reviews : acc; }, 0);
  });
  sites.sort(function (a, b) { return totals[b] - totals[a] || a.localeCompare(b, 'ru'); });

  var table = node('table', { className: 'heat' });
  var thead = node('thead');
  var headRow = node('tr');
  headRow.appendChild(node('th', { scope: 'col' }, 'Площадка'));
  cats.forEach(function (cat) { headRow.appendChild(node('th', { scope: 'col' }, cat)); });
  headRow.appendChild(node('th', { scope: 'col' }, 'Всего'));
  thead.appendChild(headRow);
  table.appendChild(thead);

  var tbody = node('tbody');
  sites.forEach(function (site) {
    var tr = node('tr');
    tr.appendChild(node('th', { scope: 'row' }, site));

    cats.forEach(function (cat) {
      var entry = cell[site] && cell[site][cat];
      var td = node('td');
      if (!entry) {
        td.className = 'is-empty';
        td.textContent = '·';
        td.title = site + ' — карточка «' + cat + '» не отслеживается';
      } else {
        td.className = 'l' + binOf(entry.reviews);
        td.textContent = nf.format(entry.reviews);
        td.tabIndex = 0;
        bindTooltip(td, function () {
          return {
            value: nf.format(entry.reviews) + ' отзыв' + plural(entry.reviews, '', 'а', 'ов'),
            label: site + ' · ' + cat,
            meta: 'карточек: ' + entry.cards,
          };
        });
      }
      tr.appendChild(td);
    });

    var totalCell = node('td', { className: 'total' }, nf.format(totals[site]));
    tr.appendChild(totalCell);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.appendChild(table);

  renderHeatLegend();
}

function renderHeatLegend() {
  var legend = $('heat-legend');
  legend.textContent = '';
  legend.appendChild(node('span', { className: 'legend__caption' }, 'Отзывов в клетке:'));

  HEAT_BINS.forEach(function (bin, i) {
    var step = node('span', { className: 'scale-step' });
    var chip = node('span', { className: 'scale-step__chip' });
    chip.style.background = 'var(--h' + i + ')';
    step.appendChild(chip);
    step.appendChild(node('span', {}, bin.label));
    legend.appendChild(step);
  });

  var empty = node('span', { className: 'scale-step' });
  var chip = node('span', { className: 'scale-step__chip' });
  chip.style.background = 'transparent';
  chip.style.boxShadow = 'inset 0 0 0 1px var(--grid)';
  empty.appendChild(chip);
  empty.appendChild(node('span', {}, 'нет карточки'));
  legend.appendChild(empty);
}

function binOf(value) {
  var index = 0;
  for (var i = 0; i < HEAT_BINS.length; i++) {
    if (value >= HEAT_BINS[i].min) index = i;
  }
  return index;
}

function renderTable(rows) {
  var body = $('table-body');
  body.textContent = '';

  var sorted = rows.slice().sort(comparator(STATE.sort));
  $('table-sub').textContent = sorted.length === STATE.rows.length
    ? nf.format(sorted.length) + ' карточек'
    : nf.format(sorted.length) + ' из ' + nf.format(STATE.rows.length) + ' карточек';

  if (!sorted.length) {
    var tr = node('tr');
    var td = node('td', { colSpan: 7, className: 'empty' }, 'Под фильтр ничего не попало');
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }

  var fragment = document.createDocumentFragment();
  sorted.forEach(function (row) {
    var tr = node('tr');
    tr.appendChild(node('td', { className: 'num' }, String(row.n)));

    var siteCell = node('td');
    if (row.url) {
      var link = node('a', { href: row.url }, row.site);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = row.url;
      siteCell.appendChild(link);
    } else {
      siteCell.textContent = row.site;
    }
    tr.appendChild(siteCell);

    var typeCell = node('td');
    var pill = node('span', { className: 'pill pill--' + row.type });
    pill.appendChild(node('span', { className: 'pill__dot' }));
    pill.appendChild(node('span', {}, TYPE_LABEL[row.type]));
    typeCell.appendChild(pill);
    tr.appendChild(typeCell);

    tr.appendChild(node('td', { className: 'product' }, row.product));
    tr.appendChild(node('td', {}, row.category));
    tr.appendChild(node('td', { className: 'num' + (row.reviews ? '' : ' zero') }, nf.format(row.reviews)));
    tr.appendChild(node('td', { className: 'status' }, row.status || '—'));

    fragment.appendChild(tr);
  });
  body.appendChild(fragment);
}

function comparator(sort) {
  var dir = sort.dir === 'asc' ? 1 : -1;
  return function (a, b) {
    var x = a[sort.key];
    var y = b[sort.key];
    if (typeof x === 'number' && typeof y === 'number') {
      return (x - y) * dir || a.n - b.n;
    }
    return String(x).localeCompare(String(y), 'ru') * dir || a.n - b.n;
  };
}

function groupBy(rows, key) {
  var out = {};
  rows.forEach(function (row) {
    (out[row[key]] || (out[row[key]] = [])).push(row);
  });
  return out;
}

function pct(value, total) {
  if (!total) return '0%';
  var share = (value / total) * 100;
  return (share < 10 ? share.toFixed(1) : Math.round(share)) + '%';
}

function plural(n, one, few, many) {
  var mod10 = n % 10;
  var mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** Мини-хелпер для DOM: значения всегда кладём через textContent. */
function node(tag, props, text) {
  var el = document.createElement(tag);
  if (props) {
    Object.keys(props).forEach(function (key) {
      if (key === 'className') el.className = props[key];
      else if (key === 'colSpan') el.colSpan = props[key];
      else el.setAttribute(key, props[key]);
    });
  }
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
}

/* --- Тултип --------------------------------------------------------------- */

var tooltip = null;

function bindTooltip(el, getContent) {
  var show = function (event) {
    var data = getContent();
    tooltip.textContent = '';
    tooltip.appendChild(node('div', { className: 'tooltip__value' }, data.value));
    tooltip.appendChild(node('div', { className: 'tooltip__label' }, data.label));
    if (data.meta) tooltip.appendChild(node('div', { className: 'tooltip__meta' }, data.meta));
    tooltip.classList.add('is-visible');
    tooltip.setAttribute('aria-hidden', 'false');
    position(event, el);
  };
  var hide = function () {
    tooltip.classList.remove('is-visible');
    tooltip.setAttribute('aria-hidden', 'true');
  };

  el.addEventListener('mouseenter', show);
  el.addEventListener('mousemove', function (event) { position(event, el); });
  el.addEventListener('mouseleave', hide);
  el.addEventListener('focus', show);
  el.addEventListener('blur', hide);
}

function position(event, el) {
  var rect = el.getBoundingClientRect();
  var x = event && event.clientX ? event.clientX + 14 : rect.left + rect.width / 2;
  var y = (event && event.clientY ? event.clientY : rect.top) - 8;

  tooltip.style.left = '0px';
  tooltip.style.top = '0px';
  var box = tooltip.getBoundingClientRect();

  var left = Math.min(Math.max(8, x), window.innerWidth - box.width - 8);
  var top = Math.min(Math.max(8, y - box.height), window.innerHeight - box.height - 8);
  tooltip.style.left = left + 'px';
  tooltip.style.top = top + 'px';
}

/* --- CSV ------------------------------------------------------------------ */

function exportCsv() {
  var rows = visibleRows().slice().sort(comparator(STATE.sort));
  var header = ['№', 'Площадка', 'Тип', 'Товар', 'Форма', 'Отзывы', 'Ссылка', 'Статус'];
  var lines = [header.join(';')];

  rows.forEach(function (row) {
    lines.push([
      row.n, row.site, TYPE_LABEL[row.type], row.product,
      row.category, row.reviews, row.url, row.status,
    ].map(csvCell).join(';'));
  });

  // BOM — чтобы Excel открыл кириллицу без плясок с кодировкой.
  var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var link = document.createElement('a');
  link.href = url;
  link.download = 'viferon-otzyvy.csv';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

function csvCell(value) {
  var s = String(value === null || value === undefined ? '' : value);
  return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/* --- Тема ----------------------------------------------------------------- */

function toggleTheme() {
  var root = document.documentElement;
  var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  var current = root.dataset.theme || (prefersDark ? 'dark' : 'light');
  var next = current === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try { localStorage.setItem('viferon-dashboard-theme', next); } catch (e) {}
}

/* --- Инициализация -------------------------------------------------------- */

function bindControls() {
  var search = $('f-search');
  var debounce;
  search.addEventListener('input', function () {
    clearTimeout(debounce);
    debounce = setTimeout(function () {
      STATE.filters.search = search.value;
      render();
    }, 120);
  });

  $('f-type').addEventListener('change', function (e) { STATE.filters.type = e.target.value; render(); });
  $('f-site').addEventListener('change', function (e) { STATE.filters.site = e.target.value; render(); });
  $('f-form').addEventListener('change', function (e) { STATE.filters.category = e.target.value; render(); });
  $('f-zero').addEventListener('change', function (e) { STATE.filters.zeroOnly = e.target.checked; render(); });

  $('reset').addEventListener('click', function () {
    STATE.filters = { search: '', type: '', site: '', category: '', zeroOnly: false };
    search.value = '';
    $('f-type').value = '';
    $('f-site').value = '';
    $('f-form').value = '';
    $('f-zero').checked = false;
    render();
  });

  $('refresh').addEventListener('click', function () { load(true); });
  $('theme').addEventListener('click', toggleTheme);
  $('export').addEventListener('click', exportCsv);

  Array.prototype.forEach.call(document.querySelectorAll('#table thead th[data-sort]'), function (th) {
    th.addEventListener('click', function () {
      var key = th.dataset.sort;
      if (STATE.sort.key === key) {
        STATE.sort.dir = STATE.sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        STATE.sort.key = key;
        STATE.sort.dir = key === 'reviews' || key === 'n' ? 'desc' : 'asc';
      }
      Array.prototype.forEach.call(document.querySelectorAll('#table thead th[data-sort]'), function (other) {
        other.removeAttribute('aria-sort');
      });
      th.setAttribute('aria-sort', STATE.sort.dir === 'asc' ? 'ascending' : 'descending');
      renderTable(visibleRows());
    });
  });
}

function init() {
  tooltip = $('tooltip');
  bindControls();
  load(false);
  setInterval(function () {
    if (!document.hidden) load(false);
  }, CONFIG.autoRefreshMs);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
