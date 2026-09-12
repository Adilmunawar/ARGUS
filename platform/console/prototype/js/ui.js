(function () {
  'use strict';

  var A = (window.ARGUS = window.ARGUS || {});
  var UI = {};

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs, children) {
    var parts = String(tag).split(/(?=[.#])/);
    var name = parts.shift() || 'div';
    var node = document.createElement(name);

    parts.forEach(function (p) {
      if (p[0] === '.') node.classList.add(p.slice(1));
      else if (p[0] === '#') node.id = p.slice(1);
    });

    if (attrs && (Array.isArray(attrs) || attrs instanceof Node || typeof attrs === 'string' || typeof attrs === 'number')) {
      children = attrs; attrs = null;
    }

    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') { String(v).split(/\s+/).filter(Boolean).forEach(function (c) { node.classList.add(c); }); return; }
        if (k === 'text') { node.textContent = String(v); return; }
        if (k === 'html') { throw new Error('ui.el: html is not accepted; build nodes instead'); }
        if (k === 'on') { Object.keys(v).forEach(function (ev) { node.addEventListener(ev, v[ev]); }); return; }
        if (k === 'data') { Object.keys(v).forEach(function (d) { node.dataset[d] = v[d]; }); return; }
        if (k === 'style' && typeof v === 'object') { Object.keys(v).forEach(function (s) { node.style.setProperty(s, v[s]); }); return; }
        if (v === true) { node.setAttribute(k, ''); return; }
        node.setAttribute(k, String(v));
      });
    }

    append(node, children);
    return node;
  }

  function append(node, children) {
    if (children === null || children === undefined || children === false) return;
    if (Array.isArray(children)) { children.forEach(function (c) { append(node, c); }); return; }
    if (children instanceof Node) { node.appendChild(children); return; }
    node.appendChild(document.createTextNode(String(children)));
  }

  function svg(tag, attrs, children) {
    var node = document.createElementNS(SVG_NS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, String(attrs[k]));
    });
    if (children) (Array.isArray(children) ? children : [children]).forEach(function (c) {
      if (c) node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    });
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

  var collator = new Intl.Collator('en-GB', { numeric: true });
  var numFormats = {};
  function numFormat(dp) {
    if (!numFormats[dp]) {
      numFormats[dp] = new Intl.NumberFormat('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    }
    return numFormats[dp];
  }

  var fmt = {
    num: function (n, dp) {
      if (n === null || n === undefined) return '-';
      return numFormat(dp === undefined ? 0 : dp).format(Number(n));
    },
    pct: function (n, dp) { return (n === null || n === undefined) ? '-' : Number(n).toFixed(dp === undefined ? 1 : dp) + '%'; },
    ratioPct: function (n, dp) {
      return (n === null || n === undefined) ? '-' : fmt.pct(Number(n) * 100, dp);
    },
    bytesTB: function (tb) {
      if (tb === null || tb === undefined) return '-';
      if (tb < 0.001) return fmt.num(tb * 1024 * 1024, 0) + ' MB';
      if (tb < 1) return fmt.num(tb * 1024, 1) + ' GB';
      return fmt.num(tb, 2) + ' TB';
    },
    ms: function (n) { return n === null || n === undefined ? '-' : (n >= 1000 ? fmt.num(n / 1000, 2) + ' s' : fmt.num(n) + ' ms'); },
    dur: function (s) {
      if (s === null || s === undefined) return '-';
      if (s < 60) return Math.round(s) + ' s';
      var mins = Math.round(s / 60);
      if (mins < 60) return mins + ' min';
      var h = Math.floor(mins / 60), m = mins % 60;
      return h + ' h' + (m ? ' ' + m + ' min' : '');
    },
    ago: function (d) {
      if (!d) return 'never';
      var s = Math.round((A.data.now - d) / 1000);
      var future = s < 0; s = Math.abs(s);
      var out;
      if (s < 60) out = s + ' s';
      else if (s < 3600) out = Math.round(s / 60) + ' min';
      else if (s < 86400) out = Math.round(s / 3600) + ' h';
      else out = Math.round(s / 86400) + ' d';
      return future ? 'in ' + out : out + ' ago';
    },
    stamp: function (d) {
      if (!d) return '';
      if (A.timezone && A.timezone() === 'local') {
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        var off = -d.getTimezoneOffset();
        var sign = off < 0 ? '-' : '+';
        var oh = Math.floor(Math.abs(off) / 60), om = Math.abs(off) % 60;
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
          ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) +
          ' ' + sign + pad(oh) + ':' + pad(om);
      }
      return d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
    },
    time: function (d) {
      if (!d) return el('span.muted', { text: 'never' });
      return el('time', { datetime: d.toISOString(), title: fmt.stamp(d), text: fmt.ago(d) });
    }
  };

  function pill(text, tone, opts) {
    opts = opts || {};
    var p = el('span.pill.' + (tone || 'idle'), { text: text });
    var glyph = { ok: '●', warn: '▲', bad: '■', info: '◆', idle: '○' }[tone || 'idle'];
    p.insertBefore(el('span.pill-glyph', { 'aria-hidden': 'true', text: glyph }), p.firstChild);
    if (opts.title) p.title = opts.title;
    return p;
  }

  function btn(label, opts) {
    opts = opts || {};
    var disabled = !!opts.disabled;
    var b = el('button.btn' + (opts.variant ? '.' + opts.variant : ''), {
      type: 'button',
      'aria-disabled': disabled ? 'true' : null,
      title: opts.title || null,
      on: {
        click: function (e) {
          if (disabled) { e.preventDefault(); e.stopPropagation(); return; }
          if (opts.onClick) opts.onClick(e);
        }
      }
    }, label);
    if (disabled) b.classList.add('is-disabled');
    b.setDisabled = function (v) {
      disabled = !!v;
      b.classList.toggle('is-disabled', disabled);
      b.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    };
    b.isDisabled = function () { return disabled; };
    return b;
  }

  function pageHeader(title, desc, actions) {
    return el('header.pagehead', [
      el('div.pagehead-text', [
        el('h1', { tabindex: '-1', text: title }),
        desc ? el('p.pagehead-desc', { text: desc }) : null
      ]),
      actions && actions.length ? el('div.pagehead-actions', actions) : null
    ]);
  }

  function statTile(label, value, opts) {
    opts = opts || {};
    return el('div.tile', [
      el('div.tile-label', { text: label }),
      el('div.tile-value', [
        String(value),
        opts.unit ? el('span.tile-unit', { text: ' ' + opts.unit }) : null
      ]),
      opts.delta ? el('div.delta.' + (opts.delta.good ? 'up' : 'down'), [
        el('span', { 'aria-hidden': 'true', text: opts.delta.dir === 'up' ? '↑' : '↓' }),
        el('span.sr', { text: (opts.delta.dir === 'up' ? 'up, ' : 'down, ') + (opts.delta.good ? 'good' : 'bad') + ': ' }),
        ' ' + opts.delta.value
      ]) : null,
      opts.note ? el('div.tile-note', { text: opts.note }) : null
    ]);
  }

  function card(title, body, opts) {
    opts = opts || {};
    return el('section.card' + (opts.grow ? '.grow' : ''), [
      title ? el('div.card-head', [
        el('h2.card-title', { text: title }),
        opts.actions ? el('div.card-actions', opts.actions) : null
      ]) : null,
      el('div.card-body' + (opts.flush ? '.flush' : ''), body)
    ]);
  }

  function table(cols, rows, opts) {
    opts = opts || {};
    var state = { key: opts.sortKey || null, dir: opts.sortDir || 'asc' };
    var announceNext = false;
    var current = rows.slice();

    var wrap = el('div.tablewrap', { tabindex: '0', role: 'region', 'aria-label': opts.caption });
    var t = el('table');
    t.appendChild(el('caption.sr', { text: opts.caption || 'Table' }));
    var thead = el('thead');
    var headRow = el('tr');
    var tbody = el('tbody');

    function sortRows(list, col, dir) {
      var decorated = list.map(function (row, i) {
        return { row: row, k: col.sort ? col.sort(row) : row[col.key], i: i };
      });
      var sign = dir === 'desc' ? -1 : 1;
      decorated.sort(function (a, b) {
        var av = a.k, bv = b.k;
        if (av === bv) return a.i - b.i;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        if (typeof av === 'number' && typeof bv === 'number') return sign * (av - bv);
        return sign * collator.compare(String(av), String(bv));
      });
      return decorated.map(function (d) { return d.row; });
    }

    var rowsShown = [];
    function rowFromEvent(e) {
      var tr = e.target && e.target.closest ? e.target.closest('tr') : null;
      if (!tr || !tbody.contains(tr) || tr.dataset.rowIndex === undefined) return null;
      return rowsShown[Number(tr.dataset.rowIndex)];
    }
    if (opts.onRow) {
      tbody.addEventListener('click', function (e) {
        if (e.target.closest('button, a, input, select, textarea')) return;
        var row = rowFromEvent(e);
        if (row) opts.onRow(row);
      });
      tbody.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        if (e.target.tagName !== 'TR') return;
        var row = rowFromEvent(e);
        if (row) { e.preventDefault(); opts.onRow(row); }
      });
    }

    var VIRTUAL_MIN = 150;
    var OVERSCAN = 10;
    var rowHeight = 0;
    var windowed = false;

    function buildRow(row, absoluteIndex) {
      var tr = el('tr');
      tr.dataset.rowIndex = String(absoluteIndex);
      tr.setAttribute('aria-rowindex', String(absoluteIndex + 2));
      if (opts.rowKey) tr.dataset.key = opts.rowKey(row);
      cols.forEach(function (c) {
        var td = el('td' + (c.align === 'right' ? '.num' : '') + (c.status ? '.st' : ''));
        var v = c.render ? c.render(row) : row[c.key];
        append(td, v === undefined || v === null ? '-' : v);
        tr.appendChild(td);
      });
      if (opts.onRow) {
        tr.classList.add('is-clickable');
        tr.tabIndex = 0;
      }
      return tr;
    }

    function spacer(height) {
      return el('tr.vspacer', { 'aria-hidden': 'true' },
        el('td', { colspan: String(cols.length), style: { height: height + 'px', padding: '0' } }));
    }

    function focusedRowKey() {
      var active = document.activeElement;
      if (!active || !tbody.contains(active)) return null;
      var tr = active.closest ? active.closest('tr') : null;
      if (!tr || tr !== active || !tr.dataset) return null;
      return tr.dataset.key || null;
    }

    function restoreRowFocus(key) {
      if (!key || typeof window.CSS !== 'object' || typeof window.CSS.escape !== 'function') return;
      var again = tbody.querySelector('tr[data-key="' + window.CSS.escape(key) + '"]');
      if (again) again.focus({ preventScroll: true });
      else wrap.focus({ preventScroll: true });
    }

    function renderWindow() {
      var list = current;
      var keepFocus = focusedRowKey();
      var viewH = wrap.clientHeight || 480;
      var scrollAt = wrap.scrollTop;
      clear(tbody);

      if (!list.length) {
        tbody.appendChild(el('tr', el('td', { colspan: String(cols.length) },
          el('div.empty-inline', { text: opts.empty || 'Nothing to show.' }))));
        restoreRowFocus(keepFocus);
        return;
      }

      var frag = document.createDocumentFragment();

      if (!windowed) {
        list.forEach(function (row, i) { frag.appendChild(buildRow(row, i)); });
        tbody.appendChild(frag);
        restoreRowFocus(keepFocus);
        return;
      }

      if (!rowHeight) {
        var probe = buildRow(list[0], 0);
        tbody.appendChild(probe);
        rowHeight = probe.offsetHeight || 34;
        clear(tbody);
      }

      var first = Math.max(0, Math.floor(scrollAt / rowHeight) - OVERSCAN);
      var count = Math.ceil(viewH / rowHeight) + OVERSCAN * 2;
      var last = Math.min(list.length, first + count);

      if (first > 0) frag.appendChild(spacer(first * rowHeight));
      for (var i = first; i < last; i++) frag.appendChild(buildRow(list[i], i));
      if (last < list.length) frag.appendChild(spacer((list.length - last) * rowHeight));

      tbody.appendChild(frag);
      if (wrap.scrollTop !== scrollAt) wrap.scrollTop = scrollAt;
      restoreRowFocus(keepFocus);
    }

    var scrollQueued = false;
    function onScroll() {
      if (!windowed || scrollQueued) return;
      scrollQueued = true;
      window.requestAnimationFrame(function () { scrollQueued = false; renderWindow(); });
    }

    var paintedKey, paintedDir;
    function paint() {
      var sortChanged = state.key !== paintedKey || state.dir !== paintedDir;
      paintedKey = state.key;
      paintedDir = state.dir;
      var list = rows.slice();
      if (state.key) {
        var col = cols.filter(function (c) { return c.key === state.key; })[0];
        if (col) list = sortRows(list, col, state.dir);
      }
      current = list;
      rowsShown = list;

      var wasWindowed = windowed;
      windowed = list.length > VIRTUAL_MIN;
      wrap.classList.toggle('is-virtual', windowed);
      t.setAttribute('aria-rowcount', String(list.length + 1));
      if (windowed && !wasWindowed) wrap.addEventListener('scroll', onScroll);
      if (!windowed && wasWindowed) wrap.removeEventListener('scroll', onScroll);
      if (windowed && (sortChanged || !wasWindowed)) wrap.scrollTop = 0;

      renderWindow();

      if (announceNext && state.key) {
        announceNext = false;
        var col2 = cols.filter(function (c) { return c.key === state.key; })[0];
        if (col2) A.announce('Sorted by ' + col2.label + ', ' + (state.dir === 'asc' ? 'ascending' : 'descending') + ', ' + list.length + ' rows');
      }
    }

    cols.forEach(function (c) {
      var th = el('th', { scope: 'col', style: c.width ? { width: c.width } : null });
      if (c.align === 'right') th.classList.add('num');
      if (c.sortable === false || (!c.key && !c.sort)) {
        th.textContent = c.label;
      } else {
        var sortBtn = el('button.th-sort', {
          type: 'button',
          on: {
            click: function () {
              if (state.key === c.key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
              else { state.key = c.key; state.dir = 'asc'; }
              announceNext = true;
              cols.forEach(function (other) {
                var oth = headRow.querySelector('[data-col="' + other.key + '"]');
                if (oth) oth.setAttribute('aria-sort', other.key === state.key ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none');
              });
              paint();
            }
          }
        }, [c.label, el('span.th-arrow', { 'aria-hidden': 'true', text: '↕' })]);
        th.dataset.col = c.key;
        th.setAttribute('aria-sort', state.key === c.key ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none');
        th.appendChild(sortBtn);
      }
      headRow.appendChild(th);
    });

    thead.appendChild(headRow);
    t.appendChild(thead);
    t.appendChild(tbody);
    wrap.appendChild(t);
    paint();
    wrap.repaint = paint;
    wrap.currentRows = function () { return current.slice(); };
    wrap.setRows = function (next) { rows = next || []; paint(); };
    return wrap;
  }

  function emptyState(title, detail, action) {
    return el('div.empty', [
      el('div.empty-title', { text: title }),
      detail ? el('p.empty-detail', { text: detail }) : null,
      action || null
    ]);
  }

  function errorState(title, detail, retry) {
    return el('div.empty.is-error', { role: 'alert' }, [
      el('div.empty-title', { text: title }),
      detail ? el('p.empty-detail', { text: detail }) : null,
      retry ? btn('Try again', { variant: 'ghost', onClick: retry }) : null
    ]);
  }

  function skeleton(rows) {
    return el('div.skel', { 'aria-hidden': 'true' },
      Array.apply(null, Array(rows || 3)).map(function () { return el('div.skel-row'); }));
  }

  function dl(items) {
    return el('dl.deflist', items.filter(Boolean).map(function (kv) {
      return el('div.deflist-row', [el('dt', { text: kv[0] }), el('dd', kv[1])]);
    }));
  }

  function tabs(items, opts) {
    opts = opts || {};
    var listId = 'tabs-' + Math.random().toString(36).slice(2, 8);
    var start = 0;
    if (opts.initial !== undefined && opts.initial !== null) {
      items.forEach(function (it, i) { if (it.id === opts.initial) start = i; });
      if (typeof opts.initial === 'number' && opts.initial >= 0 && opts.initial < items.length) start = opts.initial;
    }
    var panel = el('div.tabpanels');
    var list = el('div.tablist', { role: 'tablist', 'aria-label': opts.label || 'Sections' });
    var buttons = [];

    var disposePanel = null;

    function select(i, focus) {
      buttons.forEach(function (b, j) {
        b.setAttribute('aria-selected', j === i ? 'true' : 'false');
        b.tabIndex = j === i ? 0 : -1;
        b.classList.toggle('is-active', j === i);
      });

      if (disposePanel) { disposePanel(); disposePanel = null; }
      clear(panel);
      panel.setAttribute('aria-labelledby', listId + '-' + i);

      try {
        if (A.scopeLeaveHooks) {
          var built;
          disposePanel = A.scopeLeaveHooks(function () { built = items[i].render(); });
          append(panel, built);
        } else {
          append(panel, items[i].render());
        }
      } catch (err) {
        append(panel, errorState(
          'This section failed to render',
          String(err && err.message ? err.message : err),
          function () { select(i, false); }));
        if (window.console && window.console.error) window.console.error(err);
      }

      if (focus) buttons[i].focus();
      if (opts.onSelect) opts.onSelect(items[i].id);
    }

    if (A.onLeave) A.onLeave(function () { if (disposePanel) { disposePanel(); disposePanel = null; } });

    items.forEach(function (it, i) {
      var b = el('button.tab', {
        type: 'button', role: 'tab', id: listId + '-' + i,
        'aria-selected': 'false', tabindex: '-1',
        on: {
          click: function () { select(i); },
          keydown: function (e) {
            var next = null;
            if (e.key === 'ArrowRight') next = (i + 1) % items.length;
            if (e.key === 'ArrowLeft') next = (i - 1 + items.length) % items.length;
            if (e.key === 'Home') next = 0;
            if (e.key === 'End') next = items.length - 1;
            if (next !== null) { e.preventDefault(); select(next, true); }
          }
        }
      }, it.label);
      buttons.push(b);
      list.appendChild(b);
    });

    panel.setAttribute('role', 'tabpanel');
    panel.tabIndex = 0;
    select(start);
    return el('div.tabs', [list, panel]);
  }

  var LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
  var LOG_LEVEL_LABEL = { debug: 'Debug', info: 'Info', warn: 'Warning', error: 'Error' };

  function logLevel(raw) {
    var v = String(raw || '').toLowerCase();
    if (v === 'err' || v === 'error' || v === 'fatal' || v === 'critical') return 'error';
    if (v === 'warn' || v === 'warning') return 'warn';
    if (v === 'debug' || v === 'trace') return 'debug';
    if (v === 'info' || v === 'notice') return 'info';
    return 'info';
  }

  function padLevel(level) {
    var word = level.toUpperCase();
    while (word.length < 5) word += ' ';
    return word;
  }

  function logView(opts) {
    var cap = opts.cap;
    var view = el('div.logview.logstream', {
      role: 'log',
      tabindex: '0',
      'aria-live': 'off',
      'aria-label': opts.label
    });

    var pending = [];
    var frame = null;
    var timer = null;
    var pinned = true;
    var latest = null;
    var placeholder = null;

    view.addEventListener('scroll', function () {
      var atEnd = (view.scrollHeight - view.scrollTop - view.clientHeight) < 24;
      if (atEnd === pinned) return;
      pinned = atEnd;
      if (opts.onFollow) opts.onFollow(pinned);
    });

    view.addEventListener('keydown', function (e) {
      var page = Math.max(40, view.clientHeight * 0.9);
      var handled = true;
      if (e.key === 'End') view.scrollTop = view.scrollHeight;
      else if (e.key === 'Home') view.scrollTop = 0;
      else if (e.key === 'PageDown') view.scrollTop += page;
      else if (e.key === 'PageUp') view.scrollTop -= page;
      else if (e.key === 'ArrowDown') view.scrollTop += 26;
      else if (e.key === 'ArrowUp') view.scrollTop -= 26;
      else handled = false;
      if (handled) e.preventDefault();
    });

    function lineNode(line) {
      return el('div.logline', [
        el('span.logts', { text: fmt.stamp(line.at) }),
        ' ',
        el('span.lvl-' + line.level, { text: padLevel(line.level) }),
        ' ',
        el('span.logsrc', { text: line.stream }),
        ' ',
        line.text
      ]);
    }

    function unschedule() {
      if (frame !== null) { window.cancelAnimationFrame(frame); frame = null; }
      if (timer !== null) { window.clearTimeout(timer); timer = null; }
    }

    function flush() {
      unschedule();
      if (!pending.length) return;
      if (placeholder && placeholder.parentNode === view) {
        view.removeChild(placeholder);
        placeholder = null;
      }
      var frag = document.createDocumentFragment();
      for (var i = 0; i < pending.length; i++) frag.appendChild(lineNode(pending[i]));
      latest = pending[pending.length - 1];
      pending.length = 0;
      view.appendChild(frag);
      while (view.childElementCount > cap) view.removeChild(view.firstElementChild);
      if (pinned) view.scrollTop = 1e9;
      if (opts.onFlush) opts.onFlush(view.childElementCount);
    }

    function schedule() {
      if (frame !== null || timer !== null) return;
      if (typeof window.requestAnimationFrame === 'function') {
        frame = window.requestAnimationFrame(flush);
        timer = window.setTimeout(flush, 250);
        return;
      }
      timer = window.setTimeout(flush, 16);
    }

    return {
      node: view,
      append: function (line) { pending.push(line); schedule(); },
      appendMany: function (lines) {
        if (!lines.length) return;
        for (var i = 0; i < lines.length; i++) pending.push(lines[i]);
        schedule();
      },
      flushNow: function () { flush(); },
      say: function (text) {
        unschedule();
        clear(view);
        pending.length = 0;
        latest = null;
        placeholder = el('div.logline.logempty', { text: text });
        view.appendChild(placeholder);
      },
      reset: function () {
        unschedule();
        clear(view);
        pending.length = 0;
        latest = null;
        placeholder = null;
      },
      setCap: function (n) {
        cap = n;
        while (view.childElementCount > cap) view.removeChild(view.firstElementChild);
      },
      count: function () { return placeholder ? 0 : view.childElementCount; },
      latest: function () { return latest; },
      following: function () { return pinned; },
      follow: function (on) {
        pinned = !!on;
        if (pinned) view.scrollTop = 1e9;
        if (opts.onFollow) opts.onFollow(pinned);
      },
      stop: function () {
        unschedule();
        pending.length = 0;
      }
    };
  }

  function sparkline(values, opts) {
    opts = opts || {};
    var w = opts.width || 120, h = opts.height || 28, pad = 2;
    var samples = values || [];

    var clean = [];
    for (var i = 0; i < samples.length; i++) {
      var raw = samples[i];
      var n = (raw === null || raw === undefined) ? NaN : Number(raw);
      clean.push(isFinite(n) ? n : null);
    }
    var present = clean.filter(function (v) { return v !== null; });

    var min = opts.min !== undefined && opts.min !== null ? Number(opts.min)
      : (present.length ? Math.min.apply(null, present) : 0);
    var max = opts.max !== undefined && opts.max !== null ? Number(opts.max)
      : (present.length ? Math.max.apply(null, present) : 1);
    var span = (max - min) || 1;

    var runs = [], run = [];
    for (var j = 0; j < clean.length; j++) {
      if (clean[j] === null) {
        if (run.length) { runs.push(run); run = []; }
        continue;
      }
      var x = pad + (j / (clean.length - 1 || 1)) * (w - pad * 2);
      var y = h - pad - ((clean[j] - min) / span) * (h - pad * 2);
      run.push(x.toFixed(1) + ',' + y.toFixed(1));
    }
    if (run.length) runs.push(run);

    var s = svg('svg', {
      viewBox: '0 0 ' + w + ' ' + h, width: w, height: h, class: 'spark',
      role: opts.label ? 'img' : 'presentation',
      'aria-label': opts.label || null, 'aria-hidden': opts.label ? null : 'true', focusable: 'false'
    }, runs.map(function (points) {
      return svg('polyline', {
        points: points.join(' '), fill: 'none',
        stroke: 'var(' + (opts.stroke || '--c1') + ')',
        'stroke-width': '1.6', 'stroke-linejoin': 'round', 'stroke-linecap': 'round'
      });
    }));
    return s;
  }

  var TONE_WORD = { warn: 'over the warning threshold', bad: 'over the critical threshold' };
  function bar(ratio, opts) {
    opts = opts || {};
    var pct = Math.max(0, Math.min(1, ratio)) * 100;
    var base = opts.label || (Math.round(pct) + '%');
    var word = TONE_WORD[opts.tone];
    return el('div.bar', {
      role: 'img',
      'aria-label': word ? base + ', ' + word : base
    }, el('div.bar-fill' + (opts.tone ? '.' + opts.tone : ''), { style: { width: pct.toFixed(1) + '%' } }));
  }

  var BEAT = { DOWN: 0, UP: 1, PENDING: 2, MAINTENANCE: 3 };
  var BEAT_TONE = { 0: 'bad', 1: 'ok', 2: 'warn', 3: 'maint' };
  var BEAT_WORD = { 0: 'down', 1: 'up', 2: 'pending', 3: 'in maintenance' };

  function beatAt(beat) {
    if (!beat) return null;
    if (typeof beat.at === 'number') return beat.at;
    if (beat.at instanceof Date) return beat.at.getTime();
    if (typeof beat.at === 'string') {
      var t = Date.parse(beat.at);
      return isFinite(t) ? t : null;
    }
    return null;
  }

  function beatTone(beat) {
    if (!beat) return 'none';
    var tone = BEAT_TONE[beat.status];
    return tone || 'none';
  }

  function uptimeOf(beats, opts) {
    opts = opts || {};
    var list = beats || [];
    var clock = opts.now === undefined ? Date.now() : opts.now;
    var from = opts.windowMs ? clock - opts.windowMs : null;
    var up = 0, down = 0, unmeasured = 0, first = null, last = null;

    for (var i = 0; i < list.length; i++) {
      var beat = list[i];
      if (!beat) continue;
      var at = beatAt(beat);
      if (from !== null && at !== null && at < from) continue;
      if (at !== null) {
        if (first === null || at < first) first = at;
        if (last === null || at > last) last = at;
      }
      if (beat.status === BEAT.UP || beat.status === BEAT.MAINTENANCE) up += 1;
      else if (beat.status === BEAT.DOWN || beat.status === BEAT.PENDING) down += 1;
      else unmeasured += 1;
    }

    var counted = up + down;
    return {
      ratio: counted ? up / counted : null,
      up: up, down: down, unmeasured: unmeasured, counted: counted,
      firstAt: first, lastAt: last,
      coveredMs: (first !== null && last !== null) ? last - first : 0,
      windowMs: opts.windowMs || null,
      complete: opts.windowMs ? ((first !== null && last !== null) && (last - first) >= opts.windowMs * 0.95) : true
    };
  }

  function incidentsOf(beats) {
    var list = beats || [], out = [], prev = null;
    for (var i = 0; i < list.length; i++) {
      var beat = list[i];
      if (!beat) continue;
      var at = beatAt(beat);
      var changed = prev !== null && beat.status !== prev.status;
      if (changed || (beat.important === true && prev !== null)) {
        out.push({
          at: at,
          from: prev.status,
          to: beat.status,
          fromWord: BEAT_WORD[prev.status] || 'not measured',
          toWord: BEAT_WORD[beat.status] || 'not measured',
          heldMs: (at !== null && prev.at !== null) ? at - prev.at : null,
          message: beat.msg || beat.message || null
        });
      }
      prev = { status: beat.status, at: at };
    }
    return out;
  }

  function heartbeatSentence(beats, opts) {
    opts = opts || {};
    var u = uptimeOf(beats, { windowMs: opts.windowMs, now: opts.now });
    var who = opts.name ? opts.name + ': ' : '';
    if (!u.counted) return who + 'no check has been recorded yet.';
    var window = opts.windowWord ? ' over ' + opts.windowWord : '';
    return who + 'last ' + fmt.num(u.counted) + ' checks, ' + fmt.num(u.up) + ' up, ' +
      fmt.num(u.down) + ' down, ' + fmt.pct(u.ratio * 100, 1) + ' uptime' + window + '.';
  }

  function heartbeatBar(beats, opts) {
    opts = opts || {};
    var slots = opts.slots || 50;
    var w = opts.width || 260, h = opts.height || 26, gap = 2;
    var barW = Math.max(1, (w - gap * (slots - 1)) / slots);
    var tail = (beats || []).slice(-slots);
    var pad = slots - tail.length;
    var kids = [];

    for (var i = 0; i < slots; i++) {
      var beat = i < pad ? null : tail[i - pad];
      var tone = beatTone(beat);
      var x = i * (barW + gap);
      var y = 0, height = h, rx = 2;
      if (tone === 'warn') { y = h * 0.42; height = h * 0.58; }
      else if (tone === 'maint') { rx = Math.min(barW, h) / 2; }
      else if (tone === 'none') { y = h - 4; height = 4; }

      kids.push(svg('rect', {
        x: x.toFixed(2), y: y.toFixed(2),
        width: barW.toFixed(2), height: height.toFixed(2), rx: rx.toFixed(2),
        class: 'hb hb-' + tone
      }));
      if (tone === 'bad') {
        kids.push(svg('rect', {
          x: x.toFixed(2), y: (h / 2 - 1.5).toFixed(2),
          width: barW.toFixed(2), height: '3', class: 'hb hb-notch'
        }));
      }
    }

    return svg('svg', {
      viewBox: '0 0 ' + w + ' ' + h, width: w, height: h, class: 'hbbar',
      role: 'img', focusable: 'false',
      'aria-label': opts.label || heartbeatSentence(beats, opts)
    }, kids);
  }

  function graph(nodes, edges, opts) {
    opts = opts || {};
    var colW = opts.colWidth || 190, rowH = 54, boxW = 156, boxH = 38;

    var depth = {};
    nodes.forEach(function (n) { depth[n.id] = 0; });
    for (var pass = 0; pass < nodes.length; pass++) {
      var moved = false;
      for (var ei = 0; ei < edges.length; ei++) {
        var e = edges[ei];
        if (depth[e[1]] < depth[e[0]] + 1) { depth[e[1]] = depth[e[0]] + 1; moved = true; }
      }
      if (!moved) break;
    }
    var cols = {};
    nodes.forEach(function (n) { (cols[depth[n.id]] = cols[depth[n.id]] || []).push(n); });
    var maxDepth = Math.max.apply(null, Object.keys(cols).map(Number));
    var maxRows = Math.max.apply(null, Object.keys(cols).map(function (k) { return cols[k].length; }));
    var W = (maxDepth + 1) * colW, H = Math.max(maxRows * rowH + 20, 90);

    var pos = {};
    Object.keys(cols).forEach(function (d) {
      cols[d].forEach(function (n, i) {
        pos[n.id] = { x: Number(d) * colW + 10, y: i * rowH + 20 + ((maxRows - cols[d].length) * rowH) / 2 };
      });
    });

    var g = svg('svg', {
      viewBox: '0 0 ' + W + ' ' + H, class: 'graph', role: 'img',
      'aria-label': opts.label || 'Dependency graph', focusable: 'false',
      preserveAspectRatio: 'xMinYMid meet'
    });

    edges.forEach(function (e) {
      var a = pos[e[0]], b = pos[e[1]];
      if (!a || !b) return;
      var x1 = a.x + boxW, y1 = a.y + boxH / 2, x2 = b.x, y2 = b.y + boxH / 2;
      var mid = (x1 + x2) / 2;
      g.appendChild(svg('path', {
        d: 'M' + x1 + ',' + y1 + ' C' + mid + ',' + y1 + ' ' + mid + ',' + y2 + ' ' + x2 + ',' + y2,
        fill: 'none', stroke: 'var(--grid)', 'stroke-width': '1.4'
      }));
    });

    nodes.forEach(function (n) {
      var p = pos[n.id];
      var kind = String(n.kind || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      var grp = svg('g', { class: 'gnode gnode-' + (kind || 'app') });
      grp.appendChild(svg('rect', { x: p.x, y: p.y, width: boxW, height: boxH, rx: 9 }));
      grp.appendChild(svg('text', { x: p.x + 11, y: p.y + 16, class: 'gnode-label' }, n.label));
      grp.appendChild(svg('text', { x: p.x + 11, y: p.y + 29, class: 'gnode-kind' }, n.kind || ''));
      g.appendChild(grp);
    });

    var verb = opts.verb || 'depends on';

    var byId = Object.create(null);
    nodes.forEach(function (n) { byId[n.id] = n; });

    var described = [];
    var mentioned = Object.create(null);
    edges.forEach(function (e) {
      var a = byId[e[0]], b = byId[e[1]];
      if (!a || !b) return;
      mentioned[a.id] = true; mentioned[b.id] = true;
      described.push(a.label + ' ' + verb + ' ' + b.label);
    });
    nodes.forEach(function (n) {
      var kind = n.kind ? ' (' + n.kind + ')' : '';
      if (!mentioned[n.id]) described.push(n.label + kind + ' has no connections');
      else if (n.kind) described.push(n.label + ' is a ' + n.kind);
    });

    return el('div.graphwrap', [
      g,
      el('div.sr', { text: (opts.label || 'Dependency graph') + '. ' + (described.join('. ') || 'No dependencies.') })
    ]);
  }

  function heatgrid(rowLabels, colLabels, scoreFor, opts) {
    opts = opts || {};
    var head = el('tr', [el('th', { scope: 'col', text: opts.corner || '' })].concat(
      colLabels.map(function (c) { return el('th.heat-col', { scope: 'col' }, el('span', { text: c })); })));
    var body = rowLabels.map(function (r) {
      return el('tr', [el('th', { scope: 'row', text: r })].concat(colLabels.map(function (c, ci) {
        var v = scoreFor(r, ci);
        var tone = v === null ? 'na' : v >= 95 ? 'ok' : v >= 85 ? 'warn' : 'bad';
        return el('td.heat', el('button.heatcell.' + tone, {
          type: 'button',
          'aria-label': r + ', ' + c + ': ' + (v === null ? 'not applicable' : v + ' percent'),
          title: r + ' / ' + c + ': ' + (v === null ? 'n/a' : v + '%'),
          on: opts.onCell ? { click: function () { opts.onCell(r, c, v); } } : null
        }, el('span', { 'aria-hidden': 'true', text: v === null ? '-' : String(v) })));
      })));
    });
    return el('div.tablewrap', { tabindex: '0', role: 'region', 'aria-label': opts.caption || 'Heat grid' },
      el('table.heatgrid', [
        el('caption.sr', { text: opts.caption || 'Heat grid' }),
        el('thead', head), el('tbody', body)
      ]));
  }

  function timeline(segments, opts) {
    opts = opts || {};
    return el('div.timeline', { role: 'img', 'aria-label': opts.label || 'Timeline' },
      segments.map(function (s) {
        return el('span.tl-seg.' + (s.tone || 'ok'), {
          style: { flex: String(s.weight === undefined || s.weight === null ? 1 : s.weight) },
          title: s.label
        });
      }));
  }

  function propertyFilter(fields, onChange) {
    var tokens = [];
    var input = el('input.pf-input', {
      type: 'text', 'aria-label': 'Filter', placeholder: 'Filter by property, then press Enter',
      autocomplete: 'off', spellcheck: 'false'
    });
    var tokenBox = el('div.pf-tokens');
    var fieldSel = el('select.pf-field', { 'aria-label': 'Property to filter on' },
      fields.map(function (f) { return el('option', { value: f.key, text: f.label }); }));

    function repaintTokens() {
      clear(tokenBox);
      tokens.forEach(function (t, i) {
        tokenBox.appendChild(el('span.pf-token', [
          el('span.pf-token-text', { text: t.label + ': ' + t.value }),
          el('button.pf-token-x', {
            type: 'button', 'aria-label': 'Remove filter ' + t.label + ' ' + t.value,
            on: { click: function () { tokens.splice(i, 1); repaintTokens(); onChange(tokens); A.announce('Filter removed, ' + tokens.length + ' remaining'); } }
          }, '×')
        ]));
      });
      if (tokens.length > 1) {
        tokenBox.appendChild(btn('Clear all', {
          variant: 'ghost', onClick: function () { tokens = []; repaintTokens(); onChange(tokens); A.announce('All filters cleared'); }
        }));
      }
    }

    function add() {
      var v = input.value.trim();
      if (!v) {
        input.focus();
        A.announce('Type a value first, then add the filter');
        return;
      }
      var f = fields.filter(function (x) { return x.key === fieldSel.value; })[0];
      tokens.push({ key: f.key, label: f.label, value: v });
      input.value = '';
      repaintTokens();
      onChange(tokens);
      A.announce('Filter added, ' + f.label + ' ' + v);
    }

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); add(); }
      if (e.key === 'Backspace' && !input.value && tokens.length) {
        tokens.pop(); repaintTokens(); onChange(tokens);
      }
    });

    return el('div.pf', [
      el('div.pf-row', [fieldSel, input, btn('Add filter', { variant: 'ghost', onClick: add })]),
      tokenBox
    ]);
  }

  function applyTokens(rows, tokens, accessors) {
    if (!tokens.length) return rows;
    return rows.filter(function (r) {
      return tokens.every(function (t) {
        var get = accessors[t.key];
        var v = get ? get(r) : r[t.key];
        return String(v === null || v === undefined ? '' : v).toLowerCase().indexOf(String(t.value).toLowerCase()) !== -1;
      });
    });
  }

  var openMenus = [];

  UI.closeMenus = function () {
    while (openMenus.length) {
      var fn = openMenus.pop();
      try { fn(); } catch (e) {  }
    }
  };

  function menu(items, opts) {
    opts = opts || {};
    var open = false, pop = null, offClick = null, onScroll = null;

    var trigger = el('button.iconbtn.menubtn', {
      type: 'button',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      'aria-label': opts.label || 'More actions',
      title: opts.label || 'More actions',
      on: {
        click: function (e) { e.stopPropagation(); open ? close() : show(); },
        keydown: function (e) {
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(0); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); show(-1); }
        }
      }
    }, el('span.menudots', { 'aria-hidden': 'true', text: '⋯' }));

    function entries() {
      return pop ? Array.prototype.filter.call(pop.querySelectorAll('.menuitem'), function () { return true; }) : [];
    }

    function focusAt(i) {
      var list = entries();
      if (!list.length) return;
      var n = ((i % list.length) + list.length) % list.length;
      list[n].focus();
    }

    function close(refocus) {
      if (!open) return;
      open = false;
      var ix = openMenus.indexOf(closeQuietly);
      if (ix !== -1) openMenus.splice(ix, 1);
      trigger.setAttribute('aria-expanded', 'false');
      if (pop) { pop.remove(); pop = null; }
      if (offClick) { document.removeEventListener('mousedown', offClick, true); offClick = null; }
      if (onScroll) {
        window.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onScroll);
        onScroll = null;
      }
      if (refocus !== false) trigger.focus();
    }

    function closeQuietly() { close(false); }

    function show(startAt) {
      if (open) return;
      open = true;
      openMenus.push(closeQuietly);
      trigger.setAttribute('aria-expanded', 'true');

      pop = el('div.menu', { role: 'menu', 'aria-label': opts.label || 'More actions' },
        items.map(function (it) {
          if (it === 'divider') return el('div.menudiv', { role: 'separator' });
          var disabled = !!it.disabled;
          return el('button.menuitem' + (it.danger ? '.danger' : ''), {
            type: 'button', role: 'menuitem',
            'aria-disabled': disabled ? 'true' : null,
            title: it.title || null,
            class: disabled ? 'is-disabled' : null,
            on: {
              click: function () { if (disabled) return; close(); if (it.onSelect) it.onSelect(); }
            }
          }, [
            el('span.menuitem-label', { text: it.label }),
            it.hint ? el('span.menuitem-hint', { text: it.hint }) : null
          ]);
        }));

      pop.addEventListener('keydown', function (e) {
        var list = entries(), at = list.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(at + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(at - 1); }
        else if (e.key === 'Home') { e.preventDefault(); focusAt(0); }
        else if (e.key === 'End') { e.preventDefault(); focusAt(list.length - 1); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
        else if (e.key === 'Tab') {
          if (trigger && trigger.focus) trigger.focus();
          close(false);
        }
      });

      document.body.appendChild(pop);

      var r = trigger.getBoundingClientRect();
      var h = pop.offsetHeight, w = pop.offsetWidth, GAP = 5, EDGE = 8;

      var top = r.bottom + GAP;
      if (top + h + EDGE > window.innerHeight) top = Math.max(EDGE, r.top - h - GAP);
      var left = r.right - w;
      if (left < EDGE) left = EDGE;
      if (left + w + EDGE > window.innerWidth) left = Math.max(EDGE, window.innerWidth - w - EDGE);
      pop.style.top = top + 'px';
      pop.style.left = left + 'px';

      offClick = function (e) { if (pop && !pop.contains(e.target) && e.target !== trigger) close(false); };
      document.addEventListener('mousedown', offClick, true);

      onScroll = function () { close(false); };
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', onScroll);

      if (startAt !== undefined) focusAt(startAt === -1 ? entries().length - 1 : startAt);
    }

    var wrap = el('span.menuwrap', trigger);
    wrap.closeMenu = close;
    return wrap;
  }

  function revealRow(host, key, opts) {
    opts = opts || {};
    if (!host || !key) return false;
    var want = String(key);

    window.setTimeout(function () {
      var scope = host && host.isConnected ? host : document;
      var row = null;
      var candidates = scope.querySelectorAll('[data-key]');
      for (var i = 0; i < candidates.length; i++) {
        if (candidates[i].getAttribute('data-key') === want) { row = candidates[i]; break; }
      }
      if (!row) return;
      row.classList.add('is-linked');
      row.setAttribute('tabindex', '-1');
      try { row.scrollIntoView({ block: 'center' }); } catch (e) { row.scrollIntoView(); }
      row.focus({ preventScroll: true });
      if (opts.announce !== false && A.announce) A.announce(opts.label || (want + ' is highlighted below'));
    }, 0);
    return true;
  }
  UI.revealRow = revealRow;

  UI.el = el; UI.svg = svg; UI.clear = clear; UI.append = append; UI.fmt = fmt;
  UI.pill = pill; UI.btn = btn; UI.pageHeader = pageHeader; UI.statTile = statTile;
  UI.card = card; UI.table = table; UI.emptyState = emptyState; UI.errorState = errorState;
  UI.skeleton = skeleton; UI.dl = dl; UI.tabs = tabs; UI.sparkline = sparkline; UI.bar = bar;
  UI.graph = graph; UI.heatgrid = heatgrid; UI.timeline = timeline;
  UI.heartbeatBar = heartbeatBar; UI.uptimeOf = uptimeOf; UI.incidentsOf = incidentsOf;
  UI.logView = logView; UI.logLevel = logLevel; UI.LOG_LEVELS = LOG_LEVELS; UI.LOG_LEVEL_LABEL = LOG_LEVEL_LABEL;
  UI.heartbeatSentence = heartbeatSentence; UI.BEAT = BEAT;
  UI.propertyFilter = propertyFilter; UI.applyTokens = applyTokens; UI.menu = menu;

  A.ui = UI;
})();
