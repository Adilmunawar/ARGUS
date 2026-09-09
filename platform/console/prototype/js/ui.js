/* Argus Console: the component library every screen is built from.
 *
 * Screens never write HTML strings and never touch innerHTML with data. They
 * build DOM through el(), which escapes by construction, because this console
 * renders alert rules, log lines, commit messages and file names that come from
 * outside the product. One innerHTML on that path is a stored XSS in an admin
 * tool, which is the highest-value target on the platform.
 *
 * Classic script, no modules: the console has to open from file:// with no
 * build step and no network (ADR-0027).
 */
(function () {
  'use strict';

  var A = (window.ARGUS = window.ARGUS || {});
  var UI = {};

  /* ---------------------------------------------------------------- DOM --- */

  var SVG_NS = 'http://www.w3.org/2000/svg';

  /**
   * el('div.card', {attrs}, [children]) builds an element.
   * The tag accepts a CSS-ish shorthand: 'button.btn.primary', 'span#id.pill'.
   * Children may be nodes, strings, numbers, arrays, or null (skipped).
   * Attribute keys: 'class', 'text', 'html' (rejected), 'on' (event map),
   * 'data' (dataset map), 'aria-*', anything else set as an attribute.
   */
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

  /* ------------------------------------------------------------ format --- */

  /* Intl objects are expensive to construct and cheap to reuse, and both of
     these sit on hot paths: the collator runs n log n times per sort, and
     fmt.num runs several times per row per paint. toLocaleString with an
     options bag rebuilds a formatter on essentially every call. One instance
     per distinct shape, built on first use, is the whole optimisation. */
  /* numeric:true is the one deliberate behaviour change: it sorts hv-2 before
     hv-10 rather than after it, which is what an operator reading a host list
     expects. Everything else is left at the default so the ordering matches
     what localeCompare produced before. */
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
    // Guarded here rather than relying on pct: Number(null) * 100 is 0, so a
    // missing ratio printed a confident "0.0%" where every sibling formatter
    // prints "-", and Number(undefined) * 100 printed "NaN%".
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
      // Round to whole minutes FIRST, then split. Flooring the hours while
      // rounding the remainder independently let the remainder reach 60, so
      // the elevation countdown read "1 h 60 min left" for the ~30 seconds
      // either side of the two-hour mark, and "60 min" just under one hour.
      var mins = Math.round(s / 60);
      if (mins < 60) return mins + ' min';
      var h = Math.floor(mins / 60), m = mins % 60;
      return h + ' h' + (m ? ' ' + m + ' min' : '');
    },
    /** Relative time, always with an absolute title so nothing is ambiguous. */
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
    /**
     * An absolute timestamp, in whichever clock the operator chose.
     *
     * Local time always carries its offset. A console that renders a bare
     * "14:30" is unreadable on a bridge call with a colleague in another zone,
     * and Argus runs across two sites; the offset is what makes the number
     * quotable.
     */
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
    /** A time element carrying both the relative and the absolute value. */
    time: function (d) {
      if (!d) return el('span.muted', { text: 'never' });
      return el('time', { datetime: d.toISOString(), title: fmt.stamp(d), text: fmt.ago(d) });
    }
  };

  /* --------------------------------------------------------- components --- */

  /** Status pill. Tone is one of ok, warn, bad, info, idle. */
  function pill(text, tone, opts) {
    opts = opts || {};
    var p = el('span.pill.' + (tone || 'idle'), { text: text });
    // Colour is never the only carrier of meaning: each tone gets a glyph too,
    // for colour-blind readers and for anyone reading a greyscale printout.
    var glyph = { ok: '●', warn: '▲', bad: '■', info: '◆', idle: '○' }[tone || 'idle'];
    p.insertBefore(el('span.pill-glyph', { 'aria-hidden': 'true', text: glyph }), p.firstChild);
    if (opts.title) p.title = opts.title;
    return p;
  }

  /**
   * A button.
   *
   * Disabled is expressed with aria-disabled rather than the native property,
   * so the control keeps its place in the tab order and its title stays
   * discoverable: an operator needs to read *why* Approve is unavailable, and
   * a natively disabled button tells them nothing. That only works if the
   * guard is real, so the click handler is always attached and always consults
   * the live flag. An earlier version captured opts.disabled and checked a
   * native property that was never set, which made the type-to-confirm step of
   * every destructive dialog a no-op.
   */
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

  /** A page header: title, optional description, optional action cluster. */
  function pageHeader(title, desc, actions) {
    return el('header.pagehead', [
      el('div.pagehead-text', [
        el('h1', { tabindex: '-1', text: title }),
        desc ? el('p.pagehead-desc', { text: desc }) : null
      ]),
      actions && actions.length ? el('div.pagehead-actions', actions) : null
    ]);
  }

  /** A single statistic. delta is {value, dir:'up'|'down', good:boolean}. */
  function statTile(label, value, opts) {
    opts = opts || {};
    return el('div.tile', [
      el('div.tile-label', { text: label }),
      el('div.tile-value', [
        String(value),
        opts.unit ? el('span.tile-unit', { text: ' ' + opts.unit }) : null
      ]),
      opts.delta ? el('div.delta.' + (opts.delta.good ? 'up' : 'down'), [
        /* The arrow shows DIRECTION and the class shows whether that is good,
           so a good-but-falling metric renders as a green down arrow and the
           only thing carrying "good" was the colour. The word makes it
           readable in greyscale and to a screen reader. */
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

  /**
   * A data table.
   * cols: [{key, label, align, width, render(row) -> node|string, sort(row) -> comparable, th}]
   * opts: {caption (required, may be sr-only), empty, sortKey, sortDir, onRow, rowKey}
   */
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

    /**
     * Sort, decorate-sort-undecorate, in the requested direction.
     *
     * Two things were wrong with sorting a row list directly and reversing it
     * for descending order:
     *
     *   - The comparator called col.sort() on both operands, so the key was
     *     recomputed 2 n log n times instead of n. Extracting it once per row
     *     up front is the whole of the decorate-sort-undecorate idiom.
     *   - Reversing an ascending sort also reverses where the comparator
     *     deliberately put rows with no value. They are sunk to the bottom on
     *     purpose; reversed, every blank row floated to the top of a
     *     "largest first" sort. Descending negates the comparator instead, so
     *     missing values stay at the bottom in both directions.
     *
     * String comparison goes through one cached Intl.Collator. localeCompare
     * builds a collator per call, and at n log n comparisons that was the
     * single most expensive thing in a sort click.
     */
    function sortRows(list, col, dir) {
      var decorated = list.map(function (row, i) {
        return { row: row, k: col.sort ? col.sort(row) : row[col.key], i: i };
      });
      var sign = dir === 'desc' ? -1 : 1;
      decorated.sort(function (a, b) {
        var av = a.k, bv = b.k;
        if (av === bv) return a.i - b.i;                       // stable
        if (av === null || av === undefined) return 1;         // blanks last, both ways
        if (bv === null || bv === undefined) return -1;
        if (typeof av === 'number' && typeof bv === 'number') return sign * (av - bv);
        return sign * collator.compare(String(av), String(bv));
      });
      return decorated.map(function (d) { return d.row; });
    }

    /*
     * Row activation is delegated to the tbody rather than bound per row.
     *
     * Two listeners on every row, each a closure over the row object, were
     * registered and thrown away on every paint -- 10,000 registrations for a
     * 5,000-row table, redone on every sort click. One pair on the container
     * is O(1) and survives repaints, and `rowIndex` maps the event back to the
     * row it came from without holding a reference to anything.
     */
    var rowsShown = [];
    function rowFromEvent(e) {
      var tr = e.target && e.target.closest ? e.target.closest('tr') : null;
      if (!tr || !tbody.contains(tr) || tr.dataset.rowIndex === undefined) return null;
      return rowsShown[Number(tr.dataset.rowIndex)];
    }
    if (opts.onRow) {
      tbody.addEventListener('click', function (e) {
        // A control inside the row handles its own click; the row is only the
        // fallback target.
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

    function paint() {
      clear(tbody);
      var list = rows.slice();
      if (state.key) {
        var col = cols.filter(function (c) { return c.key === state.key; })[0];
        if (col) list = sortRows(list, col, state.dir);
      }
      // The order the operator is looking at, so an export can match the claim
      // it makes about being "in the order it is sorted".
      current = list;
      rowsShown = list;

      // Build detached and attach once. Appending each row to a tbody that is
      // already in the document makes the browser invalidate the table on every
      // one of them.
      var frag = document.createDocumentFragment();

      if (!list.length) {
        frag.appendChild(el('tr', el('td', { colspan: String(cols.length) },
          el('div.empty-inline', { text: opts.empty || 'Nothing to show.' }))));
      }
      list.forEach(function (row, rowIndex) {
        var tr = el('tr');
        tr.dataset.rowIndex = String(rowIndex);
        if (opts.rowKey) tr.dataset.key = opts.rowKey(row);
        cols.forEach(function (c) {
          var td = el('td' + (c.align === 'right' ? '.num' : '') + (c.status ? '.st' : ''));
          var v = c.render ? c.render(row) : row[c.key];
          append(td, v === undefined || v === null ? '-' : v);
          tr.appendChild(td);
        });
        if (opts.onRow) {
          /* No role="link" here. An explicit role REPLACES the implicit `row`,
             so the tr stopped being a row of its table and its cells lost their
             header association -- on exactly the rows that are the main way
             into every detail screen. The row stays a row; it keeps its
             tabindex so it is still reachable without a mouse, and the
             listeners live on the tbody. */
          tr.classList.add('is-clickable');
          tr.tabIndex = 0;
        }
        frag.appendChild(tr);
      });
      tbody.appendChild(frag);
      // Only a sort the operator asked for is worth announcing. Announcing the
      // first paint of all 31 tables races the route-change announcement and
      // silently drops it.
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
    /** The rows as currently shown, in the order shown. */
    wrap.currentRows = function () { return current.slice(); };
    /**
     * Swap the data without rebuilding the table.
     *
     * Every filter consumer used to clear its host and construct a whole new
     * ui.table, which threw away the thead, every sort button, and -- because
     * `state` is per instance -- the sort the operator had chosen. Adding a
     * filter token silently reset the ordering back to the default, which is a
     * correctness defect as much as a cost.
     */
    wrap.setRows = function (next) { rows = next || []; paint(); };
    return wrap;
  }

  /** An honest empty state: what happened, and what to do about it. */
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

  /** Definition list for detail panes. items: [[label, value], ...] */
  function dl(items) {
    return el('dl.deflist', items.filter(Boolean).map(function (kv) {
      return el('div.deflist-row', [el('dt', { text: kv[0] }), el('dd', kv[1])]);
    }));
  }

  /** Tabs. items: [{id, label, render() -> node}]. Follows the ARIA tabs pattern. */
  function tabs(items, opts) {
    opts = opts || {};
    var listId = 'tabs-' + Math.random().toString(36).slice(2, 8);
    // opts.initial may be a tab id or an index, so #/identity/grants can open
    // the tab the URL names instead of always landing on the first one.
    var start = 0;
    if (opts.initial !== undefined && opts.initial !== null) {
      items.forEach(function (it, i) { if (it.id === opts.initial) start = i; });
      if (typeof opts.initial === 'number' && opts.initial >= 0 && opts.initial < items.length) start = opts.initial;
    }
    var panel = el('div.tabpanels');
    var list = el('div.tablist', { role: 'tablist', 'aria-label': opts.label || 'Sections' });
    var buttons = [];

    // Teardown for the panel currently on screen. A tab switch does not go
    // through the router, so without this nothing ever drained what a panel
    // registered on render and every switch retained its subtree.
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

      if (A.scopeLeaveHooks) {
        var built;
        disposePanel = A.scopeLeaveHooks(function () { built = items[i].render(); });
        append(panel, built);
      } else {
        append(panel, items[i].render());
      }

      if (focus) buttons[i].focus();
      if (opts.onSelect) opts.onSelect(items[i].id);
    }

    // The last panel still has to be torn down when the screen itself goes.
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

  /* ------------------------------------------------------------ charts --- */

  /** An inline sparkline. Decorative by default; pass a label to expose it. */
  function sparkline(values, opts) {
    opts = opts || {};
    var w = opts.width || 120, h = opts.height || 28, pad = 2;
    var min = Math.min.apply(null, values), max = Math.max.apply(null, values);
    var span = (max - min) || 1;
    var pts = values.map(function (v, i) {
      var x = pad + (i / (values.length - 1 || 1)) * (w - pad * 2);
      var y = h - pad - ((v - min) / span) * (h - pad * 2);
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');

    var s = svg('svg', {
      viewBox: '0 0 ' + w + ' ' + h, width: w, height: h, class: 'spark',
      role: opts.label ? 'img' : 'presentation',
      'aria-label': opts.label || null, 'aria-hidden': opts.label ? null : 'true', focusable: 'false'
    }, [
      svg('polyline', { points: pts, fill: 'none', stroke: 'var(' + (opts.stroke || '--c1') + ')', 'stroke-width': '1.6', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' })
    ]);
    return s;
  }

  /** A horizontal bar, used for utilisation and share-of-total. */
  /**
   * A horizontal bar.
   *
   * The tone says "this has crossed a threshold", and it said it in hue alone:
   * the value beside the bar tells you it is 87%, not that 87% is over the
   * line. Validated against the console's own status palette, `warn` and `bad`
   * separate by a deuteranopic delta-E of 2.9 -- the two states that matter
   * most in an operations console are close to indistinguishable by colour.
   * So a toned fill now also carries a texture, and the tone is named in the
   * accessible label rather than left to the eye.
   */
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

  /**
   * A left-to-right dependency graph. nodes:[{id,label,kind}], edges:[[from,to]].
   * Rendered as SVG with a text alternative, because a picture of a graph that a
   * screen reader cannot read is not information, it is decoration.
   */
  function graph(nodes, edges, opts) {
    opts = opts || {};
    var colW = opts.colWidth || 190, rowH = 54, boxW = 156, boxH = 38;

    // Longest-path layering, which is enough for the shallow graphs here.
    var depth = {};
    nodes.forEach(function (n) { depth[n.id] = 0; });
    // Relax until nothing moves, rather than always running one pass per node.
    // Depths settle in two or three passes for the shapes drawn here, so the
    // unconditional O(nodes x edges) loop did most of its work for nothing --
    // 2.5 million comparisons for a thousand-asset pipeline graph. The pass
    // ceiling stays as the guard against a cycle in the input.
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

    // The equivalent, in words, for anyone who cannot see the picture.
    /*
     * The text alternative.
     *
     * Two full scans of `nodes` per edge, each allocating an array, made this
     * O(edges x nodes); one index makes it O(edges). It also described edges
     * only, so a node's KIND -- "database", "bucket", "external", and on the
     * pipeline graph "fresh", "stale", "failed" -- never reached anybody
     * listening, and a node with no edges was never mentioned at all. The
     * kinds are drawn as SVG text inside a role="img", so they are dropped
     * from the accessibility tree and this sentence is the only place they can
     * come back.
     */
    var byId = Object.create(null);
    nodes.forEach(function (n) { byId[n.id] = n; });

    var described = [];
    var mentioned = Object.create(null);
    edges.forEach(function (e) {
      var a = byId[e[0]], b = byId[e[1]];
      if (!a || !b) return;
      mentioned[a.id] = true; mentioned[b.id] = true;
      described.push(a.label + ' depends on ' + b.label);
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

  /** A heat grid: rows x cols of scores, each cell a button opening a detail. */
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

  /** A horizontal timeline band, one segment per event. */
  function timeline(segments, opts) {
    opts = opts || {};
    return el('div.timeline', { role: 'img', 'aria-label': opts.label || 'Timeline' },
      segments.map(function (s) {
        return el('span.tl-seg.' + (s.tone || 'ok'), {
          // `s.weight || 1` gave a zero-length segment the same width as a
          // normal one -- the falsy-zero trap again, in the component library.
          style: { flex: String(s.weight === undefined || s.weight === null ? 1 : s.weight) },
          title: s.label
        });
      }));
  }

  /* ----------------------------------------------------- property filter --- */

  /**
   * Token filtering, the one Cloudscape pattern worth copying wholesale:
   * type a value, get a removable token, combine tokens with AND.
   * fields: [{key, label, options?}]. onChange(activeTokens) repaints the caller.
   */
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
        // Pressing "Add filter" with an empty box used to return silently, so
        // the control looked broken rather than unsatisfied. Say what is
        // missing and put the cursor where it has to go.
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

  /** Applies propertyFilter tokens to a row set. */
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

  /**
   * An overflow menu: the "..." that carries a row's secondary actions.
   *
   * A table row cannot afford six visible buttons, and a console that hides
   * its secondary actions behind a right-click hides them from keyboard and
   * touch alike. This is the pattern every mature console settled on, built
   * to the WAI-ARIA menu-button pattern rather than approximated:
   *
   *  - the trigger owns aria-haspopup and aria-expanded, so assistive tech
   *    announces that there is a menu and whether it is open;
   *  - Up/Down/Home/End move within the menu and wrap, Escape closes it and
   *    returns focus to the trigger, Tab closes it and moves on;
   *  - a disabled item keeps its place in the order and states its reason,
   *    for the same reason ui.btn does.
   *
   * items: [{label, onSelect, danger, disabled, title, hint}] or 'divider'.
   */
  var openMenus = [];

  /** Close every open overflow menu. Navigation calls this. */
  UI.closeMenus = function () {
    while (openMenus.length) {
      var fn = openMenus.pop();
      try { fn(); } catch (e) { /* already gone */ }
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
          /* Move focus back to the trigger BEFORE removing the popup. Removing
             it while a menu item held focus left document.activeElement as
             <body>, and the browser's default Tab then continued from there --
             to the first tabbable node in the document, which is the skip link
             at the very top of the page. The component's own doc comment
             promises "Tab closes it and moves on"; from the trigger, it does. */
          if (trigger && trigger.focus) trigger.focus();
          close(false);
        }
      });

      /* The menu is mounted on <body> and positioned fixed rather than
       * absolutely inside the row. Every table in the console scrolls
       * horizontally, and an absolutely positioned popup inside a scroll
       * container is clipped by it: the first build of this menu opened
       * half off the right edge of the table with its labels sliced in
       * half. Fixed coordinates computed from the trigger avoid the
       * clipping entirely. */
      document.body.appendChild(pop);

      var r = trigger.getBoundingClientRect();
      var h = pop.offsetHeight, w = pop.offsetWidth, GAP = 5, EDGE = 8;

      // Right-aligned to the trigger, flipped up when the last row of a long
      // table would otherwise open past the bottom of the viewport.
      var top = r.bottom + GAP;
      if (top + h + EDGE > window.innerHeight) top = Math.max(EDGE, r.top - h - GAP);
      var left = r.right - w;
      if (left < EDGE) left = EDGE;
      if (left + w + EDGE > window.innerWidth) left = Math.max(EDGE, window.innerWidth - w - EDGE);
      pop.style.top = top + 'px';
      pop.style.left = left + 'px';

      offClick = function (e) { if (pop && !pop.contains(e.target) && e.target !== trigger) close(false); };
      document.addEventListener('mousedown', offClick, true);

      // A fixed popup cannot follow its row, so scrolling dismisses it rather
      // than leaving it floating over unrelated content.
      onScroll = function () { close(false); };
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', onScroll);

      if (startAt !== undefined) focusAt(startAt === -1 ? entries().length - 1 : startAt);
    }

    var wrap = el('span.menuwrap', trigger);
    wrap.closeMenu = close;
    return wrap;
  }

  /**
   * Reveal the row a deep link names.
   *
   * Overview builds "#/security/alerts?id=al-9021" and "#/identity/grants?id=g-442",
   * and the Config tab builds "#/identity/secrets?path=kv/mills/jwt-signing-key".
   * The right tab opened, and then nothing happened: a link labelled "Open
   * alert al-9021" landed the operator on an unfiltered list of six and left
   * them to find it. Tables already stamp data-key on every row, so the row is
   * findable; this marks it, scrolls it into view and says so.
   */
  function revealRow(host, key, opts) {
    opts = opts || {};
    if (!host || !key) return false;
    // Scanned rather than composed into a selector: a key may contain quotes,
    // brackets or a slash (secret paths do), and building a selector out of
    // one is how a valid key turns into a syntax error at runtime.
    var want = String(key);
    var row = null;
    var candidates = host.querySelectorAll('[data-key]');
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i].getAttribute('data-key') === want) { row = candidates[i]; break; }
    }
    if (!row) return false;
    row.classList.add('is-linked');
    row.setAttribute('tabindex', '-1');
    // After paint, so the row has a box to scroll to.
    window.setTimeout(function () {
      try { row.scrollIntoView({ block: 'center' }); } catch (e) { row.scrollIntoView(); }
      row.focus({ preventScroll: true });
      if (opts.announce !== false && A.announce) A.announce(opts.label || (String(key) + ' is highlighted below'));
    }, 0);
    return true;
  }
  UI.revealRow = revealRow;

  UI.el = el; UI.svg = svg; UI.clear = clear; UI.append = append; UI.fmt = fmt;
  UI.pill = pill; UI.btn = btn; UI.pageHeader = pageHeader; UI.statTile = statTile;
  UI.card = card; UI.table = table; UI.emptyState = emptyState; UI.errorState = errorState;
  UI.skeleton = skeleton; UI.dl = dl; UI.tabs = tabs; UI.sparkline = sparkline; UI.bar = bar;
  UI.graph = graph; UI.heatgrid = heatgrid; UI.timeline = timeline;
  UI.propertyFilter = propertyFilter; UI.applyTokens = applyTokens; UI.menu = menu;

  A.ui = UI;
})();
