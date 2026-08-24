/* ---------------------------------------------------------------------------
   Общее для обоих дашбордов: форматирование, мини-DOM, тултип, тема и загрузка
   данных через Cloudflare-прослойку с откатом на локальный снапшот.
   Подключается перед app.js и кладёт всё в window.DASH.
   --------------------------------------------------------------------------- */
(function (global) {
  'use strict';

  var nf = new Intl.NumberFormat('ru-RU');

  function $(id) { return document.getElementById(id); }

  /** Мини-хелпер для DOM: текст всегда через textContent, не через innerHTML. */
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

  function fmt(value) {
    return value === null || value === undefined ? '—' : nf.format(Math.round(value));
  }

  function fmt1(value) {
    if (value === null || value === undefined) return '—';
    return value.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }

  function fmt2(value) {
    if (value === null || value === undefined) return '—';
    return value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /** Доля 0…1 → «11,4 %». */
  function pct(value, digits) {
    if (value === null || value === undefined) return '—';
    var d = digits === undefined ? 1 : digits;
    return (value * 100).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d }) + ' %';
  }

  /** Разница долей в процентных пунктах. */
  function pp(value, digits) {
    if (value === null || value === undefined) return '—';
    var d = digits === undefined ? 1 : digits;
    var text = Math.abs(value * 100).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
    return (value > 0 ? '+' : value < 0 ? '−' : '') + text + ' п.п.';
  }

  function plural(n, one, few, many) {
    var mod10 = n % 10;
    var mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }

  function unique(list) {
    var seen = Object.create(null);
    var out = [];
    list.forEach(function (item) {
      if (item && !seen[item]) { seen[item] = true; out.push(item); }
    });
    return out;
  }

  function groupBy(rows, key) {
    var out = {};
    rows.forEach(function (row) { (out[row[key]] || (out[row[key]] = [])).push(row); });
    return out;
  }

  /* --- Тултип --------------------------------------------------------------- */

  var tooltip = null;

  function initTooltip() { tooltip = $('tooltip'); }

  function bindTooltip(el, getContent) {
    var show = function (event) {
      if (!tooltip) return;
      var data = getContent();
      if (!data) return;
      tooltip.textContent = '';
      tooltip.appendChild(node('div', { className: 'tooltip__value' }, data.value));
      if (data.label) tooltip.appendChild(node('div', { className: 'tooltip__label' }, data.label));
      if (data.meta) tooltip.appendChild(node('div', { className: 'tooltip__meta' }, data.meta));
      tooltip.classList.add('is-visible');
      tooltip.setAttribute('aria-hidden', 'false');
      place(event, el);
    };
    var hide = function () {
      if (!tooltip) return;
      tooltip.classList.remove('is-visible');
      tooltip.setAttribute('aria-hidden', 'true');
    };

    el.addEventListener('mouseenter', show);
    el.addEventListener('mousemove', function (event) { place(event, el); });
    el.addEventListener('mouseleave', hide);
    el.addEventListener('focus', show);
    el.addEventListener('blur', hide);
  }

  function place(event, el) {
    if (!tooltip || !tooltip.classList.contains('is-visible')) return;
    var rect = el.getBoundingClientRect();
    var x = event && event.clientX ? event.clientX + 14 : rect.left + rect.width / 2;
    var y = (event && event.clientY ? event.clientY : rect.top) - 8;

    tooltip.style.left = '0px';
    tooltip.style.top = '0px';
    var box = tooltip.getBoundingClientRect();

    tooltip.style.left = Math.min(Math.max(8, x), window.innerWidth - box.width - 8) + 'px';
    tooltip.style.top = Math.min(Math.max(8, y - box.height), window.innerHeight - box.height - 8) + 'px';
  }

  function hideTooltip() {
    if (!tooltip) return;
    tooltip.classList.remove('is-visible');
    tooltip.setAttribute('aria-hidden', 'true');
  }

  /* --- Тема ----------------------------------------------------------------- */

  function toggleTheme() {
    var root = document.documentElement;
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var current = root.dataset.theme || (prefersDark ? 'dark' : 'light');
    var next = current === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem('viferon-dashboard-theme', next); } catch (e) {}
    return next;
  }

  /* --- Загрузка данных ------------------------------------------------------ */

  function fetchJson(url, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs || 15000);
    return fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json().then(function (data) {
          return { data: data, cache: res.headers.get('x-cache') || '' };
        });
      })
      .finally(function () { clearTimeout(timer); });
  }

  /**
   * Один и тот же сценарий на обоих дашбордах: сходить в прослойку, при неудаче
   * показать снапшот и честно об этом написать.
   *
   * @param {object} options { apiUrl, fallbackUrl, autoRefreshMs, describe, onData }
   */
  function createLoader(options) {
    var busy = false;
    var meta = null;

    function setStatus(text) { var el = $('status'); if (el) el.textContent = text; }

    function banner(text) {
      var el = $('banner');
      if (!el) return;
      if (text) { el.textContent = text; el.hidden = false; }
      else el.hidden = true;
    }

    function describeTime() {
      if (!meta || !meta.fetchedAt) return 'Данные загружены';
      var d = new Date(meta.fetchedAt);
      if (isNaN(d.getTime())) return 'Данные загружены';
      return 'Данные от ' +
        d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) + ', ' +
        d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    }

    function apply(payload, cache, apiError) {
      meta = { source: payload.source || 'unknown', fetchedAt: payload.fetchedAt || null, cache: cache };

      if (apiError) {
        banner('Показан локальный снапшот данных: прослойка ' + options.apiUrl +
          ' недоступна (' + apiError.message + '). При деплое на Cloudflare Pages функция появится автоматически.');
      } else if (cache === 'STALE') {
        banner('Google Таблица сейчас недоступна — показан последний удачный ответ из кэша Cloudflare.');
      } else {
        banner('');
      }

      options.onData(payload);
      setStatus(describeTime());

      var foot = $('foot-meta');
      if (foot) {
        var parts = [meta.source === 'google-sheets' ? 'Источник: Google Таблица' : 'Источник: локальный снапшот'];
        if (meta.cache) parts.push('edge-кэш: ' + meta.cache);
        if (options.describe) parts.push(options.describe(payload));
        foot.textContent = parts.join(' · ');
      }
    }

    function load(force) {
      if (busy) return Promise.resolve();
      busy = true;
      var refresh = $('refresh');
      if (refresh) refresh.disabled = true;
      setStatus(meta ? 'Обновление…' : 'Загрузка данных…');

      return fetchJson(options.apiUrl + (force ? '?refresh=1' : ''), options.timeoutMs)
        .then(function (result) {
          if (!result.data || result.data.ok === false) {
            throw new Error((result.data && result.data.error) || 'Некорректный ответ прослойки');
          }
          apply(result.data, result.cache, null);
        })
        .catch(function (apiError) {
          return fetchJson(options.fallbackUrl, options.timeoutMs)
            .then(function (result) { apply(result.data, '', apiError); })
            .catch(function () {
              setStatus('Данные не загрузились');
              banner('Не удалось получить данные ни из Cloudflare-прослойки, ни из локального снапшота. ' +
                'Проверьте ' + options.apiUrl + '. Причина: ' + apiError.message);
            });
        })
        .finally(function () {
          busy = false;
          if (refresh) refresh.disabled = false;
        });
    }

    function start() {
      var refresh = $('refresh');
      if (refresh) refresh.addEventListener('click', function () { load(true); });
      var theme = $('theme');
      if (theme) theme.addEventListener('click', function () { toggleTheme(); if (options.onTheme) options.onTheme(); });

      load(false);
      if (options.autoRefreshMs) {
        setInterval(function () { if (!document.hidden) load(false); }, options.autoRefreshMs);
      }
    }

    return { load: load, start: start };
  }

  /* --- CSV ------------------------------------------------------------------ */

  function downloadCsv(filename, header, rows) {
    var lines = [header.join(';')];
    rows.forEach(function (row) { lines.push(row.map(csvCell).join(';')); });
    // BOM — чтобы Excel открыл кириллицу без плясок с кодировкой.
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function csvCell(value) {
    var s = String(value === null || value === undefined ? '' : value);
    return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  global.DASH = {
    $: $, node: node, nf: nf,
    fmt: fmt, fmt1: fmt1, fmt2: fmt2, pct: pct, pp: pp,
    plural: plural, unique: unique, groupBy: groupBy,
    initTooltip: initTooltip, bindTooltip: bindTooltip, hideTooltip: hideTooltip,
    toggleTheme: toggleTheme, fetchJson: fetchJson, createLoader: createLoader,
    downloadCsv: downloadCsv,
  };
})(window);
