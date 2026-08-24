/* ---------------------------------------------------------------------------
   Дашборд медиамониторинга: Виферон на фоне конкурентов.
   Данные приходят из Cloudflare-функции /api/media, которая собирает нужные
   листы Google Таблицы. Общие хелперы — в ../assets/common.js.
   --------------------------------------------------------------------------- */
'use strict';

var D = window.DASH;
var $ = D.$;
var node = D.node;

var CONFIG = {
  apiUrl: '../api/media',
  fallbackUrl: '../data/media.json',
  autoRefreshMs: 5 * 60 * 1000,
  timeoutMs: 20000,
};

var HERO = 'Виферон';

var MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

var VIFERON_METRICS = {
  mentions: { label: 'Упоминания', format: D.fmt },
  positive: { label: 'Позитив', format: D.fmt },
  negative: { label: 'Негатив', format: D.fmt },
  loyalty: { label: 'Индекс лояльности', format: D.fmt2 },
  consultants: { label: 'Консультанты', format: D.fmt },
};

var SHARE_METRICS = {
  shareMentions: { label: 'Доля упоминаний', count: 'mentions' },
  sharePositive: { label: 'Доля позитива', count: 'positive' },
  shareNegative: { label: 'Доля негатива', count: 'negative' },
};

var STATE = {
  data: null,
  shareMetric: 'shareMentions',
  viferonMetric: 'mentions',
  rival: '',
  rivalScale: 'months',
  rivalMetric: 'mentions',
  kpiKind: 'count',
  sort: { key: 'mentions', dir: 'desc' },
};

/* --- Форматирование дат ----------------------------------------------------- */

function formatDay(iso) {
  if (!iso) return '—';
  var p = String(iso).split('-');
  return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0] : String(iso);
}

function formatMonth(key) {
  var p = String(key).split('-');
  if (p.length < 2) return String(key);
  return MONTHS_SHORT[Number(p[1]) - 1] + ' ' + p[0];
}

/* --- Дельты ----------------------------------------------------------------- */

/**
 * Подпись изменения. `goodUp` говорит, считается ли рост улучшением:
 * для негатива рост — это плохо, поэтому цвет меняется на противоположный.
 * Цвет никогда не единственный носитель смысла — рядом всегда стрелка и число.
 */
function deltaChip(delta, goodUp, text) {
  var cls = 'delta delta--flat';
  var arrow = '';
  if (delta > 0) { cls = goodUp ? 'delta delta--good' : 'delta delta--bad'; arrow = '▲ '; }
  else if (delta < 0) { cls = goodUp ? 'delta delta--bad' : 'delta delta--good'; arrow = '▼ '; }
  return node('span', { className: cls }, arrow + text);
}

function relative(now, before) {
  if (!before) return null;
  return (now - before) / before;
}

function signedPercent(value) {
  if (value === null || value === undefined) return '—';
  var text = Math.abs(value * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
  return (value > 0 ? '+' : value < 0 ? '−' : '') + text + ' %';
}

/* --- Производные величины --------------------------------------------------- */

function brands() { return (STATE.data && STATE.data.brands) || []; }

function heroBrand() {
  return brands().filter(function (b) { return b.brand === HERO; })[0] || null;
}

/** Места в рейтинге по выбранной метрике внутри одного периода. */
function rankMap(metric, period) {
  var list = brands()
    .filter(function (b) { return b[period]; })
    .sort(function (a, b) { return (b[period][metric] || 0) - (a[period][metric] || 0); });
  var map = {};
  list.forEach(function (item, i) { map[item.brand] = i + 1; });
  return map;
}

/* --- Загрузка и общий рендер ------------------------------------------------ */

function onData(payload) {
  STATE.data = payload;
  fillRivalSelect();
  renderPeriodHead();
  render();
}

function render() {
  renderKpis();
  renderDumbbell();
  renderSentiment();
  renderLoyalty();
  renderViferonYears();
  renderViferonLine();
  renderRivals();
  renderKpiChart();
  renderReposts();
  renderBans();
  renderTable();
}

function renderPeriodHead() {
  var r = STATE.data.report || {};
  $('period-2').textContent = formatDay(r.from2) + ' — ' + formatDay(r.to2);
  $('period-1').textContent = formatDay(r.from1) + ' — ' + formatDay(r.to1);
}

/* --- KPI-плитки ------------------------------------------------------------- */

function renderKpis() {
  var hero = heroBrand();
  if (!hero || !hero.p2) return;

  var p1 = hero.p1 || {};
  var p2 = hero.p2;

  $('kpi-mentions').textContent = D.fmt(p2.mentions);
  setHint('kpi-mentions-hint', [
    deltaChip(p2.mentions - (p1.mentions || 0), true, signedPercent(relative(p2.mentions, p1.mentions))),
    node('span', {}, ' к прошлому периоду (' + D.fmt(p1.mentions) + ')'),
  ]);

  $('kpi-share').textContent = D.pct(p2.shareMentions);
  setHint('kpi-share-hint', [
    deltaChip(p2.shareMentions - (p1.shareMentions || 0), true, D.pp(p2.shareMentions - (p1.shareMentions || 0))),
  ]);

  var rank2 = rankMap('shareMentions', 'p2')[HERO];
  var rank1 = rankMap('shareMentions', 'p1')[HERO];
  $('kpi-rank').textContent = rank2 ? rank2 + ' из ' + brands().length : '—';
  setHint('kpi-rank-hint', [rankMove(rank1, rank2)]);

  $('kpi-loyalty').textContent = D.fmt2(p2.loyalty);
  setHint('kpi-loyalty-hint', [
    deltaChip(p2.loyalty - (p1.loyalty || 0), true, D.fmt2(Math.abs(p2.loyalty - (p1.loyalty || 0)))),
    node('span', {}, ' позитивных на негатив'),
  ]);

  $('kpi-negative').textContent = D.fmt(p2.negative);
  setHint('kpi-negative-hint', [
    deltaChip(p2.negative - (p1.negative || 0), false, signedPercent(relative(p2.negative, p1.negative))),
    node('span', {}, ' · ' + D.pct(p2.negative / p2.mentions) + ' от упоминаний'),
  ]);
}

function setHint(id, parts) {
  var el = $(id);
  el.textContent = '';
  parts.forEach(function (part) { el.appendChild(part); });
}

function rankMove(before, after) {
  if (!before || !after) return node('span', { className: 'rank-move rank-move--same' }, 'в прошлом периоде — нет данных');
  if (after < before) return node('span', { className: 'rank-move rank-move--up' }, '▲ поднялся с ' + before + ' места');
  if (after > before) return node('span', { className: 'rank-move rank-move--down' }, '▼ опустился с ' + before + ' места');
  return node('span', { className: 'rank-move rank-move--same' }, 'место не изменилось');
}

/* --- Гантели: доля голоса период к периоду ---------------------------------- */

function renderDumbbell() {
  var container = $('chart-dumbbell');
  container.textContent = '';

  var metric = STATE.shareMetric;
  var countKey = SHARE_METRICS[metric].count;
  var ranks2 = rankMap(metric, 'p2');
  var ranks1 = rankMap(metric, 'p1');

  var rows = brands()
    .filter(function (b) { return b.p2; })
    .sort(function (a, b) { return (b.p2[metric] || 0) - (a.p2[metric] || 0); });

  var max = rows.reduce(function (m, b) {
    return Math.max(m, b.p2[metric] || 0, (b.p1 && b.p1[metric]) || 0);
  }, 0) || 1;

  var wrap = node('div', { className: 'dumbbell' });

  rows.forEach(function (item) {
    var now = item.p2[metric] || 0;
    var before = (item.p1 && item.p1[metric]) || 0;
    var isHero = item.brand === HERO;

    var row = node('div', { className: 'dumbbell__row' + (isHero ? ' dumbbell__row--hero' : '') });
    row.tabIndex = 0;

    row.appendChild(node('span', { className: 'dumbbell__rank' }, String(ranks2[item.brand] || '')));
    row.appendChild(node('span', { className: 'dumbbell__name' }, item.brand));

    var track = node('div', { className: 'dumbbell__track' });
    var a = (before / max) * 100;
    var b = (now / max) * 100;
    var link = node('div', { className: 'dumbbell__link' });
    link.style.left = Math.min(a, b) + '%';
    link.style.width = Math.abs(b - a) + '%';
    track.appendChild(link);

    var dot1 = node('div', { className: 'dumbbell__dot dumbbell__dot--p1' });
    dot1.style.left = a + '%';
    var dot2 = node('div', { className: 'dumbbell__dot dumbbell__dot--p2' });
    dot2.style.left = b + '%';
    track.appendChild(dot1);
    track.appendChild(dot2);
    row.appendChild(track);

    var values = node('div', { className: 'dumbbell__values' });
    values.appendChild(node('span', { className: 'dumbbell__now' }, D.pct(now)));
    values.appendChild(deltaChip(now - before, metric !== 'shareNegative', D.pp(now - before)));
    row.appendChild(values);

    D.bindTooltip(row, function () {
      var rankNow = ranks2[item.brand];
      var rankBefore = ranks1[item.brand];
      return {
        value: D.pct(now) + ' · ' + D.fmt(item.p2[countKey]) + ' упом.',
        label: item.brand,
        meta: 'было ' + D.pct(before) + ' (' + D.fmt(item.p1 ? item.p1[countKey] : null) + ')' +
          ' · место ' + (rankBefore || '—') + ' → ' + (rankNow || '—'),
      };
    });

    wrap.appendChild(row);
  });

  container.appendChild(wrap);

  var legend = $('dumbbell-legend');
  legend.textContent = '';
  [['Прошлый период', 'var(--p1)'], ['Отчётный период', 'var(--p2)']].forEach(function (pair) {
    var item = node('div', { className: 'legend__item' });
    var swatch = node('span', { className: 'legend__swatch' });
    swatch.style.background = pair[1];
    swatch.style.borderRadius = '50%';
    swatch.style.width = '8px';
    swatch.style.height = '8px';
    item.appendChild(swatch);
    item.appendChild(node('span', {}, pair[0]));
    legend.appendChild(item);
  });
}

/* --- Тональность: расходящаяся стопка --------------------------------------- */

function renderSentiment() {
  var container = $('chart-sentiment');
  container.textContent = '';

  var rows = brands()
    .filter(function (b) { return b.p2 && b.p2.mentions; })
    .map(function (b) {
      var m = b.p2.mentions;
      return {
        brand: b.brand,
        neg: b.p2.negative / m,
        neu: b.p2.neutral / m,
        pos: b.p2.positive / m,
        counts: b.p2,
      };
    })
    .sort(function (a, b) { return b.pos - a.pos; });

  if (!rows.length) return;

  // Ноль проходит по середине нейтрального блока: негатив уходит влево,
  // позитив вправо — так строки сравнимы между собой.
  var halfMax = rows.reduce(function (m, r) {
    return Math.max(m, r.neg + r.neu / 2, r.pos + r.neu / 2);
  }, 0) || 1;
  var scale = 50 / halfMax;

  var wrap = node('div', { className: 'sentiment' });

  rows.forEach(function (r) {
    var isHero = r.brand === HERO;
    var row = node('div', { className: 'sentiment__row' + (isHero ? ' sentiment__row--hero' : '') });
    row.tabIndex = 0;
    row.appendChild(node('span', { className: 'sentiment__name' }, r.brand));

    var track = node('div', { className: 'sentiment__track' });
    var start = 50 - (r.neg + r.neu / 2) * scale;

    var neg = node('div', { className: 'sentiment__seg sentiment__seg--neg' });
    neg.style.left = start + '%';
    neg.style.width = r.neg * scale + '%';

    var neu = node('div', { className: 'sentiment__seg sentiment__seg--neu' });
    neu.style.left = start + r.neg * scale + '%';
    neu.style.width = r.neu * scale + '%';

    var pos = node('div', { className: 'sentiment__seg sentiment__seg--pos' });
    pos.style.left = start + (r.neg + r.neu) * scale + '%';
    pos.style.width = r.pos * scale + '%';

    var zero = node('div', { className: 'sentiment__zero' });
    zero.style.left = '50%';

    track.appendChild(neg);
    track.appendChild(neu);
    track.appendChild(pos);
    track.appendChild(zero);
    row.appendChild(track);

    D.bindTooltip(row, function () {
      return {
        value: D.pct(r.pos) + ' позитива · ' + D.pct(r.neg) + ' негатива',
        label: r.brand,
        meta: 'из ' + D.fmt(r.counts.mentions) + ' упоминаний: позитив ' + D.fmt(r.counts.positive) +
          ', нейтрально ' + D.fmt(r.counts.neutral) + ', негатив ' + D.fmt(r.counts.negative),
      };
    });

    wrap.appendChild(row);
  });

  container.appendChild(wrap);

  var legend = $('sentiment-legend');
  legend.textContent = '';
  [['Негатив', 'var(--neg)'], ['Нейтрально', 'var(--neu)'], ['Позитив', 'var(--pos)']].forEach(function (pair) {
    var item = node('div', { className: 'legend__item' });
    var swatch = node('span', { className: 'legend__swatch' });
    swatch.style.background = pair[1];
    item.appendChild(swatch);
    item.appendChild(node('span', {}, pair[0]));
    legend.appendChild(item);
  });
}

/* --- Индекс лояльности ------------------------------------------------------ */

function renderLoyalty() {
  var container = $('chart-loyalty');
  container.textContent = '';

  var rows = brands()
    .filter(function (b) { return b.p2 && b.p2.loyalty !== null; })
    .map(function (b) {
      return { label: b.brand, value: b.p2.loyalty, before: b.p1 ? b.p1.loyalty : null, counts: b.p2 };
    })
    .sort(function (a, b) { return b.value - a.value; });

  barList(container, rows, {
    hero: HERO,
    format: D.fmt2,
    tooltip: function (item) {
      return {
        value: D.fmt2(item.value) + ' позитивных на 1 негативное',
        label: item.label,
        meta: 'было ' + D.fmt2(item.before) + ' · позитив ' + D.fmt(item.counts.positive) +
          ', негатив ' + D.fmt(item.counts.negative),
      };
    },
  });

  container.appendChild(node('p', { className: 'note' },
    'Шкала линейная, поэтому лидер визуально подавляет остальных: значения подписаны у каждого столбца.'));
}

/**
 * Горизонтальные бары одного цвета: длина уже кодирует величину.
 * `hero` подсвечивает одну строку, когда остальные — фон.
 */
function barList(container, items, options) {
  if (!items.length) {
    container.appendChild(node('p', { className: 'empty' }, 'Нет данных'));
    return;
  }
  var max = items.reduce(function (m, it) { return Math.max(m, it.value || 0); }, 0) || 1;
  var wrap = node('div', { className: 'bars' });

  items.forEach(function (item) {
    var row = node('div', { className: 'bar-row' + (item.value ? '' : ' bar-row--muted') });
    row.tabIndex = 0;

    var label = node('span', { className: 'bar-row__label' });
    label.appendChild(node('span', { className: 'bar-row__labeltext' }, item.label));
    if (options.hero && item.label === options.hero) label.style.fontWeight = '600';
    row.appendChild(label);

    var track = node('div', { className: 'bar-row__track' });
    var fill = node('div', { className: 'bar-row__fill' });
    fill.style.width = Math.max((Math.abs(item.value || 0) / max) * 100, item.value ? 1 : 0) + '%';
    if (options.hero && item.label !== options.hero) fill.style.background = 'var(--dim)';
    track.appendChild(fill);
    row.appendChild(track);

    row.appendChild(node('span', { className: 'bar-row__value' }, options.format(item.value)));

    if (options.tooltip) D.bindTooltip(row, function () { return options.tooltip(item); });
    wrap.appendChild(row);
  });

  container.appendChild(wrap);
}

/* --- Тональность Виферона по годам ------------------------------------------ */

function renderViferonYears() {
  var years = (STATE.data.viferon && STATE.data.viferon.years) || [];
  var items = years.map(function (y) {
    return {
      label: String(y.year),
      segments: [
        { value: y.negative, className: 'sentiment__seg--neg', name: 'Негатив' },
        { value: y.neutral, className: 'sentiment__seg--neu', name: 'Нейтрально' },
        { value: y.positive, className: 'sentiment__seg--pos', name: 'Позитив' },
      ],
      total: y.mentions,
      meta: 'консультанты: ' + D.fmt(y.consultants),
    };
  });

  stackedColumns($('chart-viferon-years'), items, {
    note: years.length ? 'Последний год в таблице неполный — он идёт до даты выгрузки.' : '',
  });
  simpleLegend($('viferon-years-legend'), [
    ['Негатив', 'var(--neg)'], ['Нейтрально', 'var(--neu)'], ['Позитив', 'var(--pos)'],
  ]);
}

/** Столбцы со стопкой: сегменты разделены 2px просветом фона, не обводкой. */
function stackedColumns(container, items, options) {
  container.textContent = '';
  if (!items.length) {
    container.appendChild(node('p', { className: 'empty' }, 'Нет данных'));
    return;
  }
  var opts = options || {};
  var max = items.reduce(function (m, it) { return Math.max(m, it.total || 0); }, 0) || 1;

  var chart = node('div', { className: 'columns' });
  var labels = node('div', { className: 'columns-row' });

  items.forEach(function (item, index) {
    var column = node('div', { className: 'column' });
    column.tabIndex = 0;
    var stack = node('div', { className: 'column__stack' });
    stack.style.height = ((item.total || 0) / max) * 100 + '%';

    item.segments.forEach(function (seg) {
      if (!seg.value) return;
      var block = node('div', { className: 'column__seg ' + seg.className });
      block.style.height = ((seg.value / (item.total || 1)) * 100) + '%';
      if (seg.color) block.style.background = seg.color;
      stack.appendChild(block);
    });

    column.appendChild(stack);
    chart.appendChild(column);

    var showLabel = !opts.labelEvery || index % opts.labelEvery === 0;
    labels.appendChild(node('div', { className: 'column__label' }, showLabel ? item.label : ''));

    D.bindTooltip(column, function () {
      var parts = item.segments
        .filter(function (s) { return s.value; })
        .map(function (s) { return s.name + ': ' + D.fmt(s.value); });
      return {
        value: D.fmt(item.total),
        label: item.label,
        meta: parts.join(' · ') + (item.meta ? ' · ' + item.meta : ''),
      };
    });
  });

  container.appendChild(chart);
  container.appendChild(labels);
  if (opts.note) container.appendChild(node('p', { className: 'note' }, opts.note));
}

function simpleLegend(el, pairs) {
  el.textContent = '';
  pairs.forEach(function (pair) {
    var item = node('div', { className: 'legend__item' });
    var swatch = node('span', { className: 'legend__swatch' });
    swatch.style.background = pair[1];
    item.appendChild(swatch);
    item.appendChild(node('span', {}, pair[0]));
    el.appendChild(item);
  });
}

/* --- Линейные графики ------------------------------------------------------- */

var SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs) {
  var el = document.createElementNS(SVG_NS, tag);
  Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
  return el;
}

/** Красивый шаг оси: 1, 2, 5 × 10^n. */
function niceStep(range, steps) {
  var raw = range / steps;
  var mag = Math.pow(10, Math.floor(Math.log10(raw)));
  var norm = raw / mag;
  var step = norm > 5 ? 10 : norm > 2 ? 5 : norm > 1 ? 2 : 1;
  return step * mag;
}

/**
 * Линейный график с сеткой, подписями осей и общим тултипом по вертикали.
 * series: [{ name, values, kind: 'hero' | 'rival' | 'dim', area: bool }]
 */
function lineChart(container, options) {
  container.textContent = '';
  var keys = options.keys || [];
  var series = (options.series || []).filter(function (s) { return s.values.some(function (v) { return v || v === 0; }); });
  if (!keys.length || !series.length) {
    container.appendChild(node('p', { className: 'empty' }, 'Нет данных'));
    return;
  }

  var width = Math.max(container.clientWidth || 640, 320);
  var height = options.height || 280;
  var m = { l: 54, r: 16, t: 12, b: 28 };
  var plotW = width - m.l - m.r;
  var plotH = height - m.t - m.b;

  var max = 0;
  series.forEach(function (s) {
    s.values.forEach(function (v) { if (v !== null && v > max) max = v; });
  });
  if (!max) max = 1;

  var step = niceStep(max, 4);
  var top = Math.ceil(max / step) * step;

  var x = function (i) { return m.l + (keys.length === 1 ? plotW / 2 : (i / (keys.length - 1)) * plotW); };
  var y = function (v) { return m.t + plotH - (v / top) * plotH; };

  var root = svg('svg', { width: width, height: height, role: 'img' });
  root.setAttribute('aria-label', options.ariaLabel || 'График');

  // Сетка и подписи по Y
  for (var v = 0; v <= top + 1e-9; v += step) {
    var gy = y(v);
    root.appendChild(svg('line', { class: v === 0 ? 'ln-axis' : 'ln-grid', x1: m.l, x2: width - m.r, y1: gy, y2: gy }));
    var label = svg('text', { class: 'ln-tick ln-tick--y', x: m.l - 8, y: gy + 4 });
    label.textContent = options.formatAxis ? options.formatAxis(v) : D.fmt(v);
    root.appendChild(label);
  }

  // Подписи по X — не чаще, чем помещается, и без повторов подряд:
  // на помесячной шкале соседние засечки часто попадают в один и тот же год.
  var maxTicks = Math.max(2, Math.floor(plotW / 70));
  var everyX = Math.ceil(keys.length / maxTicks);
  var lastLabel = null;
  keys.forEach(function (key, i) {
    if (i % everyX !== 0 && i !== keys.length - 1) return;
    var label = options.formatX ? options.formatX(key, i) : String(key);
    if (label === lastLabel) return;
    lastLabel = label;
    var text = svg('text', { class: 'ln-tick ln-tick--x', x: x(i), y: height - 8 });
    text.textContent = label;
    root.appendChild(text);
  });

  // Сначала фоновые серии, герой рисуется поверх
  var order = series.slice().sort(function (a, b) {
    var weight = { dim: 0, rival: 1, hero: 2 };
    return (weight[a.kind] || 0) - (weight[b.kind] || 0);
  });

  order.forEach(function (s) {
    if (s.area) {
      var areaPoints = [];
      s.values.forEach(function (val, i) { if (val !== null) areaPoints.push(x(i) + ',' + y(val)); });
      if (areaPoints.length > 1) {
        var first = areaPoints[0].split(',')[0];
        var last = areaPoints[areaPoints.length - 1].split(',')[0];
        root.appendChild(svg('polygon', {
          class: 'ln-area',
          points: first + ',' + y(0) + ' ' + areaPoints.join(' ') + ' ' + last + ',' + y(0),
        }));
      }
    }
    var d = '';
    var pen = false;
    s.values.forEach(function (val, i) {
      if (val === null) { pen = false; return; }
      d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(val).toFixed(1) + ' ';
      pen = true;
    });
    root.appendChild(svg('path', { class: 'ln-path ln-path--' + s.kind, d: d.trim() }));
  });

  // Слой наведения: перекрестие и точки на «живых» сериях
  var focus = svg('g', { style: 'display:none' });
  var cross = svg('line', { class: 'ln-cross', y1: m.t, y2: m.t + plotH });
  focus.appendChild(cross);
  var dots = series.filter(function (s) { return s.kind !== 'dim'; }).map(function (s) {
    var dot = svg('circle', { class: 'ln-dot ln-dot--' + s.kind, r: 4 });
    focus.appendChild(dot);
    return { series: s, el: dot };
  });
  root.appendChild(focus);

  var hit = svg('rect', { x: m.l, y: m.t, width: plotW, height: plotH, fill: 'transparent', style: 'cursor:crosshair' });
  root.appendChild(hit);

  function indexAt(event) {
    var box = root.getBoundingClientRect();
    var px = ((event.clientX - box.left) / box.width) * width;
    var ratio = (px - m.l) / plotW;
    return Math.max(0, Math.min(keys.length - 1, Math.round(ratio * (keys.length - 1))));
  }

  hit.addEventListener('mousemove', function (event) {
    var i = indexAt(event);
    focus.setAttribute('style', 'display:block');
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    dots.forEach(function (item) {
      var val = item.series.values[i];
      if (val === null || val === undefined) { item.el.setAttribute('style', 'display:none'); return; }
      item.el.setAttribute('style', '');
      item.el.setAttribute('cx', x(i));
      item.el.setAttribute('cy', y(val));
    });
    showTooltip(event, {
      value: (options.formatValue || D.fmt)(series[0].values[i]),
      label: (options.formatX ? options.formatX(keys[i], i, true) : String(keys[i])) + ' · ' + series[0].name,
      meta: series.slice(1).filter(function (s) { return s.kind !== 'dim'; })
        .map(function (s) { return s.name + ': ' + (options.formatValue || D.fmt)(s.values[i]); }).join(' · '),
    });
  });

  hit.addEventListener('mouseleave', function () {
    focus.setAttribute('style', 'display:none');
    D.hideTooltip();
  });

  container.appendChild(root);
}

/** Тултип линейного графика ведём вручную: содержимое меняется на каждом шаге. */
function showTooltip(event, data) {
  var el = $('tooltip');
  el.textContent = '';
  el.appendChild(node('div', { className: 'tooltip__value' }, data.value));
  if (data.label) el.appendChild(node('div', { className: 'tooltip__label' }, data.label));
  if (data.meta) el.appendChild(node('div', { className: 'tooltip__meta' }, data.meta));
  el.classList.add('is-visible');
  el.setAttribute('aria-hidden', 'false');
  var box = el.getBoundingClientRect();
  el.style.left = Math.min(Math.max(8, event.clientX + 14), window.innerWidth - box.width - 8) + 'px';
  el.style.top = Math.min(Math.max(8, event.clientY - 8 - box.height), window.innerHeight - box.height - 8) + 'px';
}

/* --- Виферон по месяцам ------------------------------------------------------ */

function renderViferonLine() {
  var months = (STATE.data.viferon && STATE.data.viferon.months) || [];
  var metric = STATE.viferonMetric;
  var spec = VIFERON_METRICS[metric];

  lineChart($('chart-viferon'), {
    keys: months.map(function (m) { return m.start; }),
    series: [{ name: spec.label, kind: 'hero', area: true, values: months.map(function (m) { return m[metric]; }) }],
    formatValue: spec.format,
    formatAxis: metric === 'loyalty' ? D.fmt1 : D.fmt,
    formatX: function (iso, i, full) {
      var p = String(iso).split('-');
      return full ? MONTHS_SHORT[Number(p[1]) - 1] + ' ' + p[0] : p[0];
    },
    ariaLabel: 'Виферон, ' + spec.label.toLowerCase() + ' по месяцам',
  });
}

/* --- Виферон против конкурентов ---------------------------------------------- */

function renderRivals() {
  var source = STATE.rivalScale === 'years' ? STATE.data.brandYears : STATE.data.brandMonths;
  if (!source) return;

  var asShare = STATE.rivalMetric === 'share';
  // Доля голоса считается по сумме всех брендов в этом же периоде.
  var totals = source.keys.map(function (_, i) {
    return source.series.reduce(function (acc, s) { return acc + (s.values[i] || 0); }, 0);
  });

  var series = source.series.map(function (s) {
    var kind = s.brand === HERO ? 'hero' : s.brand === STATE.rival ? 'rival' : 'dim';
    var values = asShare
      ? s.values.map(function (v, i) { return totals[i] ? (v || 0) / totals[i] : null; })
      : s.values;
    return { name: s.brand, kind: kind, values: values };
  }).sort(function (a, b) {
    // Герой первым — он определяет заголовок тултипа.
    var weight = { hero: 0, rival: 1, dim: 2 };
    return weight[a.kind] - weight[b.kind];
  });

  lineChart($('chart-rivals'), {
    keys: source.keys,
    series: series,
    height: 300,
    formatValue: asShare ? function (v) { return D.pct(v); } : D.fmt,
    formatAxis: asShare ? function (v) { return D.pct(v, 0); } : D.fmt,
    formatX: function (key, i, full) {
      if (STATE.rivalScale === 'years') return String(key);
      var p = String(key).split('-');
      return full ? MONTHS_SHORT[Number(p[1]) - 1] + ' ' + p[0] : p[0];
    },
    ariaLabel: asShare ? 'Доля голоса брендов' : 'Упоминания брендов',
  });

  var legend = $('rivals-legend');
  legend.textContent = '';
  var pairs = [[HERO, 'var(--series-1)']];
  if (STATE.rival) pairs.push([STATE.rival, 'var(--series-2)']);
  pairs.push(['Остальные бренды', 'var(--dim)']);
  simpleLegend(legend, pairs);
}

function fillRivalSelect() {
  var select = $('rival');
  var current = STATE.rival;
  select.textContent = '';
  select.appendChild(new Option('Никем', ''));
  brands()
    .map(function (b) { return b.brand; })
    .filter(function (name) { return name !== HERO; })
    .sort(function (a, b) { return a.localeCompare(b, 'ru'); })
    .forEach(function (name) { select.appendChild(new Option(name, name)); });
  select.value = current;
}

/* --- KPI по годам ------------------------------------------------------------ */

function renderKpiChart() {
  var container = $('chart-kpi');
  container.textContent = '';

  var rows = (STATE.data.kpi && STATE.data.kpi[STATE.kpiKind]) || [];
  if (!rows.length) {
    container.appendChild(node('p', { className: 'empty' }, 'Нет данных'));
    return;
  }

  var format = STATE.kpiKind === 'count' ? D.fmt : D.fmt2;
  var max = rows.reduce(function (m, r) { return Math.max(m, Math.abs(r.average || 0)); }, 0) || 1;
  var hasNegative = rows.some(function (r) { return (r.average || 0) < 0; });
  var zero = hasNegative ? 50 : 0;
  var scale = hasNegative ? 50 / max : 100 / max;

  var wrap = node('div', { className: 'sentiment' });

  rows.forEach(function (r) {
    var row = node('div', { className: 'sentiment__row' });
    row.tabIndex = 0;
    row.appendChild(node('span', { className: 'sentiment__name' }, String(r.year)));

    var track = node('div', { className: 'sentiment__track' });
    var value = r.average || 0;
    var length = Math.abs(value) * scale;

    var bar = node('div', { className: 'sentiment__seg' });
    bar.style.background = value < 0 ? 'var(--neg)' : 'var(--series-1)';
    bar.style.left = (value < 0 ? zero - length : zero) + '%';
    bar.style.width = length + '%';
    bar.style.borderRadius = value < 0 ? '4px 0 0 4px' : '0 4px 4px 0';
    track.appendChild(bar);

    if (hasNegative) {
      var zeroLine = node('div', { className: 'sentiment__zero' });
      zeroLine.style.left = zero + '%';
      track.appendChild(zeroLine);
    }
    row.appendChild(track);

    D.bindTooltip(row, function () {
      return {
        value: format(r.average),
        label: r.year + ' · среднее за год',
        meta: 'кварталы: ' + r.quarters.map(function (q, i) { return 'Q' + (i + 1) + ' ' + format(q); }).join(', '),
      };
    });

    wrap.appendChild(row);
  });

  container.appendChild(wrap);
}

/* --- Активность и баны -------------------------------------------------------- */

function renderReposts() {
  var rows = STATE.data.reposts || [];
  var items = rows.map(function (r) {
    return {
      label: String(r.year),
      segments: [
        { value: r.posts, className: 'seg-a', name: 'Посты' },
        { value: r.comments, className: 'seg-b', name: 'Комментарии' },
        { value: r.reposts, className: 'seg-c', name: 'Репосты' },
      ],
      total: r.total || (r.posts + r.comments + r.reposts),
    };
  });
  stackedColumns($('chart-reposts'), items);
  simpleLegend($('reposts-legend'), [
    ['Посты', 'var(--series-1)'], ['Комментарии', 'var(--series-2)'], ['Репосты', 'var(--series-3)'],
  ]);
}

function renderBans() {
  var rows = STATE.data.bans || [];
  var items = rows.map(function (b) {
    return {
      label: formatMonth(String(b.date).slice(0, 7)),
      segments: [{ value: b.accounts, className: 'seg-a', name: 'Аккаунты' }],
      total: b.accounts,
    };
  });
  stackedColumns($('chart-bans'), items, { labelEvery: Math.max(1, Math.ceil(items.length / 12)) });
}

/* --- Таблица ------------------------------------------------------------------ */

function tableRows() {
  var ranks = rankMap('shareMentions', 'p2');
  return brands().filter(function (b) { return b.p2; }).map(function (b) {
    var p1 = b.p1 || {};
    return {
      rank: ranks[b.brand] || 0,
      brand: b.brand,
      mentions: b.p2.mentions,
      mentionsDelta: relative(b.p2.mentions, p1.mentions),
      share: b.p2.shareMentions,
      shareDelta: b.p2.shareMentions - (p1.shareMentions || 0),
      positive: b.p2.positive,
      negative: b.p2.negative,
      loyalty: b.p2.loyalty,
    };
  });
}

function renderTable() {
  var body = $('table-body');
  body.textContent = '';

  var rows = tableRows().sort(function (a, b) {
    var dir = STATE.sort.dir === 'asc' ? 1 : -1;
    var x = a[STATE.sort.key];
    var y = b[STATE.sort.key];
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
    return String(x).localeCompare(String(y), 'ru') * dir;
  });

  $('table-sub').textContent = rows.length + ' ' + D.plural(rows.length, 'бренд', 'бренда', 'брендов') +
    ' · отчётный период';

  rows.forEach(function (r) {
    var tr = node('tr');
    tr.appendChild(node('td', { className: 'num' }, String(r.rank)));

    var name = node('td', {}, r.brand);
    if (r.brand === HERO) name.style.fontWeight = '600';
    tr.appendChild(name);

    tr.appendChild(node('td', { className: 'num' }, D.fmt(r.mentions)));

    var d1 = node('td', { className: 'num' });
    d1.appendChild(deltaChip(r.mentionsDelta, true, signedPercent(r.mentionsDelta)));
    tr.appendChild(d1);

    tr.appendChild(node('td', { className: 'num' }, D.pct(r.share)));

    var d2 = node('td', { className: 'num' });
    d2.appendChild(deltaChip(r.shareDelta, true, D.pp(r.shareDelta)));
    tr.appendChild(d2);

    tr.appendChild(node('td', { className: 'num' }, D.fmt(r.positive)));
    tr.appendChild(node('td', { className: 'num' }, D.fmt(r.negative)));
    tr.appendChild(node('td', { className: 'num' }, D.fmt2(r.loyalty)));

    body.appendChild(tr);
  });
}

function exportCsv() {
  var rows = tableRows().sort(function (a, b) { return a.rank - b.rank; });
  D.downloadCsv(
    'viferon-mediamonitoring.csv',
    ['Место', 'Бренд', 'Упоминания', 'Δ упоминаний, %', 'Доля голоса, %', 'Δ доли, п.п.', 'Позитив', 'Негатив', 'Индекс лояльности'],
    rows.map(function (r) {
      return [
        r.rank, r.brand, r.mentions,
        r.mentionsDelta === null ? '' : (r.mentionsDelta * 100).toFixed(1),
        (r.share * 100).toFixed(2),
        (r.shareDelta * 100).toFixed(2),
        r.positive, r.negative,
        r.loyalty === null ? '' : r.loyalty.toFixed(2),
      ];
    })
  );
}

/* --- Управление ---------------------------------------------------------------- */

function bindSegmented(selector, attribute, apply) {
  var buttons = Array.prototype.slice.call(document.querySelectorAll(selector));
  buttons.forEach(function (button) {
    button.addEventListener('click', function () {
      buttons.forEach(function (other) { other.setAttribute('aria-pressed', String(other === button)); });
      apply(button.getAttribute(attribute));
    });
  });
}

function bindControls() {
  bindSegmented('[data-share]', 'data-share', function (value) {
    STATE.shareMetric = value;
    renderDumbbell();
  });

  bindSegmented('[data-metric]', 'data-metric', function (value) {
    STATE.viferonMetric = value;
    renderViferonLine();
  });

  bindSegmented('[data-scale]', 'data-scale', function (value) {
    STATE.rivalScale = value;
    renderRivals();
  });

  bindSegmented('[data-rival-metric]', 'data-rival-metric', function (value) {
    STATE.rivalMetric = value;
    renderRivals();
  });

  bindSegmented('[data-kpi]', 'data-kpi', function (value) {
    STATE.kpiKind = value;
    renderKpiChart();
  });

  $('rival').addEventListener('change', function (e) {
    STATE.rival = e.target.value;
    renderRivals();
  });

  $('export').addEventListener('click', exportCsv);

  Array.prototype.forEach.call(document.querySelectorAll('#table thead th[data-sort]'), function (th) {
    th.addEventListener('click', function () {
      var key = th.dataset.sort;
      if (STATE.sort.key === key) STATE.sort.dir = STATE.sort.dir === 'asc' ? 'desc' : 'asc';
      else {
        STATE.sort.key = key;
        STATE.sort.dir = key === 'brand' ? 'asc' : 'desc';
      }
      Array.prototype.forEach.call(document.querySelectorAll('#table thead th[data-sort]'), function (other) {
        other.removeAttribute('aria-sort');
      });
      th.setAttribute('aria-sort', STATE.sort.dir === 'asc' ? 'ascending' : 'descending');
      renderTable();
    });
  });

  // Ширина графиков зависит от вёрстки, поэтому пересобираем их при ресайзе.
  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (!STATE.data) return;
      renderViferonLine();
      renderRivals();
    }, 160);
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
    describe: function (payload) { return 'брендов: ' + payload.brands.length; },
    onData: onData,
  }).start();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
