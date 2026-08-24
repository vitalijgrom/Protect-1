/* ---------------------------------------------------------------------------
   Дашборд отзывов о Виферон.
   Данные приходят из Cloudflare-функции /api/reviews, которая ходит в Google
   Таблицу. Если функция недоступна (локальная статика, обрыв связи) —
   подхватывается снапшот data/fallback.json, и об этом говорит баннер.
   Общие хелперы — в common.js.
   --------------------------------------------------------------------------- */
'use strict';

var D = window.DASH;
var $ = D.$;
var node = D.node;

var CONFIG = {
  apiUrl: 'api/reviews',
  fallbackUrl: 'data/fallback.json',
  autoRefreshMs: 5 * 60 * 1000,
  timeoutMs: 12000,
};

/* Площадки, которые являются отзовиками или форумами, а не аптеками.
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
  { min: 0, label: '0' },
  { min: 1, label: '1–4' },
  { min: 5, label: '5–14' },
  { min: 15, label: '15–49' },
  { min: 50, label: '50–99' },
  { min: 100, label: '100–299' },
  { min: 300, label: '300+' },
];

var STATE = {
  rows: [],
  filters: { search: '', type: '', site: '', category: '', zeroOnly: false },
  sort: { key: 'reviews', dir: 'desc' },
};

/* --- Таксономия ------------------------------------------------------------- */

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

/* --- Фильтрация ------------------------------------------------------------- */

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
  var sites = D.unique(STATE.rows.map(function (r) { return r.site; }))
    .sort(function (a, b) { return a.localeCompare(b, 'ru'); });
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

/* --- Рендер ----------------------------------------------------------------- */

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
  var sites = D.unique(rows.map(function (r) { return r.site; })).length;
  var zero = rows.filter(function (r) { return r.reviews === 0; }).length;

  $('kpi-total').textContent = D.fmt(total);
  $('kpi-sites').textContent = D.fmt(sites);
  $('kpi-cards').textContent = D.fmt(rows.length);
  $('kpi-zero').textContent = D.fmt(zero);
  $('kpi-median').textContent = D.fmt(median(rows.map(function (r) { return r.reviews; })));

  $('kpi-total-hint').textContent = rows.length !== STATE.rows.length
    ? 'по текущему фильтру'
    : 'по всем отслеживаемым карточкам';

  var pharm = rows.filter(function (r) { return r.type === 'pharmacy'; });
  var revs = rows.filter(function (r) { return r.type === 'reviews'; });
  $('kpi-sites-hint').textContent =
    D.unique(pharm.map(function (r) { return r.site; })).length + ' аптечных · ' +
    D.unique(revs.map(function (r) { return r.site; })).length + ' отзовиков';

  var maxRow = rows.reduce(function (best, r) { return !best || r.reviews > best.reviews ? r : best; }, null);
  $('kpi-cards-hint').textContent = maxRow ? 'максимум — ' + D.fmt(maxRow.reviews) + ' на ' + maxRow.site : ' ';

  $('kpi-zero-hint').textContent = rows.length
    ? Math.round((zero / rows.length) * 100) + '% карточек — точки роста'
    : ' ';

  $('kpi-median-hint').textContent = rows.length
    ? 'среднее — ' + D.fmt(total / rows.length)
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
    row.appendChild(node('span', { className: 'bar-row__value' }, D.fmt(item.value)));

    D.bindTooltip(row, function () {
      return {
        value: D.fmt(item.value) + ' отзыв' + D.plural(item.value, '', 'а', 'ов'),
        label: item.label,
        meta: options && options.meta ? options.meta(item) : '',
      };
    });

    wrap.appendChild(row);
  });

  container.appendChild(wrap);
}

function renderSites(rows) {
  var byKey = D.groupBy(rows, 'site');
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
  var byKey = D.groupBy(rows, 'category');
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
    group.sites = D.unique(subset.map(function (r) { return r.site; })).length;
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
    D.bindTooltip(seg, function () {
      return {
        value: D.fmt(group.value) + ' (' + D.pct(group.value / total, 0) + ')',
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
      D.fmt(group.value) + ' (' + D.pct(group.value / total, 0) + ')'));
    legend.appendChild(item);
  });
  container.appendChild(legend);
}

function renderHeat(rows) {
  var container = $('chart-heat');
  container.textContent = '';

  var sites = D.unique(rows.map(function (r) { return r.site; }));
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
        td.textContent = D.fmt(entry.reviews);
        td.tabIndex = 0;
        D.bindTooltip(td, function () {
          return {
            value: D.fmt(entry.reviews) + ' отзыв' + D.plural(entry.reviews, '', 'а', 'ов'),
            label: site + ' · ' + cat,
            meta: 'карточек: ' + entry.cards,
          };
        });
      }
      tr.appendChild(td);
    });

    tr.appendChild(node('td', { className: 'total' }, D.fmt(totals[site])));
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
    ? D.fmt(sorted.length) + ' карточек'
    : D.fmt(sorted.length) + ' из ' + D.fmt(STATE.rows.length) + ' карточек';

  if (!sorted.length) {
    var tr = node('tr');
    tr.appendChild(node('td', { colSpan: 7, className: 'empty' }, 'Под фильтр ничего не попало'));
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
    tr.appendChild(node('td', { className: 'num' + (row.reviews ? '' : ' zero') }, D.fmt(row.reviews)));
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
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir || a.n - b.n;
    return String(x).localeCompare(String(y), 'ru') * dir || a.n - b.n;
  };
}

/* --- Управление ------------------------------------------------------------- */

function exportCsv() {
  var rows = visibleRows().slice().sort(comparator(STATE.sort));
  D.downloadCsv(
    'viferon-otzyvy.csv',
    ['№', 'Площадка', 'Тип', 'Товар', 'Форма', 'Отзывы', 'Ссылка', 'Статус'],
    rows.map(function (row) {
      return [row.n, row.site, TYPE_LABEL[row.type], row.product, row.category, row.reviews, row.url, row.status];
    })
  );
}

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

  $('export').addEventListener('click', exportCsv);

  Array.prototype.forEach.call(document.querySelectorAll('#table thead th[data-sort]'), function (th) {
    th.addEventListener('click', function () {
      var key = th.dataset.sort;
      if (STATE.sort.key === key) STATE.sort.dir = STATE.sort.dir === 'asc' ? 'desc' : 'asc';
      else {
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
  D.initTooltip();
  bindControls();

  D.createLoader({
    apiUrl: CONFIG.apiUrl,
    fallbackUrl: CONFIG.fallbackUrl,
    autoRefreshMs: CONFIG.autoRefreshMs,
    timeoutMs: CONFIG.timeoutMs,
    describe: function (payload) { return 'строк: ' + payload.count; },
    onData: function (payload) {
      STATE.rows = enrich(payload.rows);
      buildFilterOptions();
      render();
    },
  }).start();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
