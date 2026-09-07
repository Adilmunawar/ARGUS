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

  var fmt = {
    num: function (n, dp) {
      if (n === null || n === undefined) return '-';
      return Number(n).toLocaleString('en-GB', { minimumFractionDigits: dp || 0, maximumFractionDigits: dp === undefined ? 0 : dp });
    },
    pct: function (n, dp) { return (n === null || n === undefined) ? '-' : Number(n).toFixed(dp === undefined ? 1 : dp) + '%'; },
    ratioPct: function (n, dp) { return fmt.pct(Number(n) * 100, dp); },
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
      if (s < 3600) return Math.round(s / 60) + ' min';
      var h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
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
    stamp: function (d) {
      if (!d) return '';
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

  function btn(label, opts) {
    opts = opts || {};
    var b = el('button.btn' + (opts.variant ? '.' + opts.variant : ''), {
      type: 'button',
      'aria-disabled': opts.disabled ? 'true' : null,
      title: opts.title || null,
      on: opts.onClick ? {
        click: function (e) {
          if (opts.disabled) { e.preventDefault(); return; }
          opts.onClick(e);
        }
      } : null
    }, label);
    if (opts.disabled) b.classList.add('is-disabled');
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
        el('span', { 'aria-hidden': 'true', text: opts.delta.dir === 'up' ? '↑' : '↓' }),
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

    var wrap = el('div.tablewrap', { tabindex: '0', role: 'region', 'aria-label': opts.caption });
    var t = el('table');
    t.appendChild(el('caption.sr', { text: opts.caption || 'Table' }));
    var thead = el('thead');
    var headRow = el('tr');
    var tbody = el('tbody');

    function comparator(col) {
      return function (a, b) {
        var av = col.sort ? col.sort(a) : (a[col.key]);
        var bv = col.sort ? col.sort(b) : (b[col.key]);
        if (av === bv) return 0;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        if (typeof av === 'number' && typeof bv === 'number') return av - bv;
        return String(av).localeCompare(String(bv));
      };
    }

    function paint() {
      clear(tbody);
      var list = rows.slice();
      if (state.key) {
        var col = cols.filter(function (c) { return c.key === state.key; })[0];
        if (col) { list.sort(comparator(col)); if (state.dir === 'desc') list.reverse(); }
      }
      if (!list.length) {
        tbody.appendChild(el('tr', el('td', { colspan: String(cols.length) },
          el('div.empty-inline', { text: opts.empty || 'Nothing to show.' }))));
      }
      list.forEach(function (row) {
        var tr = el('tr');
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
          tr.setAttribute('role', 'link');
          tr.addEventListener('click', function () { opts.onRow(row); });
          tr.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opts.onRow(row); }
          });
        }
        tbody.appendChild(tr);
      });
      // Sorting changes what is on screen, so it has to be announced.
      if (state.key) {
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
    var panel = el('div.tabpanels');
    var list = el('div.tablist', { role: 'tablist', 'aria-label': opts.label || 'Sections' });
    var buttons = [];

    function select(i, focus) {
      buttons.forEach(function (b, j) {
        b.setAttribute('aria-selected', j === i ? 'true' : 'false');
        b.tabIndex = j === i ? 0 : -1;
        b.classList.toggle('is-active', j === i);
      });
      clear(panel);
      panel.setAttribute('aria-labelledby', listId + '-' + i);
      append(panel, items[i].render());
      if (focus) buttons[i].focus();
      if (opts.onSelect) opts.onSelect(items[i].id);
    }

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
    select(0);
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
  function bar(ratio, opts) {
    opts = opts || {};
    var pct = Math.max(0, Math.min(1, ratio)) * 100;
    return el('div.bar', {
      role: 'img',
      'aria-label': opts.label || (Math.round(pct) + '%')
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
    for (var pass = 0; pass < nodes.length; pass++) {
      edges.forEach(function (e) {
        if (depth[e[1]] < depth[e[0]] + 1) depth[e[1]] = depth[e[0]] + 1;
      });
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
      var grp = svg('g', { class: 'gnode gnode-' + (n.kind || 'app') });
      grp.appendChild(svg('rect', { x: p.x, y: p.y, width: boxW, height: boxH, rx: 9 }));
      grp.appendChild(svg('text', { x: p.x + 11, y: p.y + 16, class: 'gnode-label' }, n.label));
      grp.appendChild(svg('text', { x: p.x + 11, y: p.y + 29, class: 'gnode-kind' }, n.kind || ''));
      g.appendChild(grp);
    });

    // The equivalent, in words, for anyone who cannot see the picture.
    var described = edges.map(function (e) {
      var a = nodes.filter(function (n) { return n.id === e[0]; })[0];
      var b = nodes.filter(function (n) { return n.id === e[1]; })[0];
      return a && b ? a.label + ' depends on ' + b.label : null;
    }).filter(Boolean);

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
          style: { flex: String(s.weight || 1) },
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
      if (!v) return;
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

  UI.el = el; UI.svg = svg; UI.clear = clear; UI.append = append; UI.fmt = fmt;
  UI.pill = pill; UI.btn = btn; UI.pageHeader = pageHeader; UI.statTile = statTile;
  UI.card = card; UI.table = table; UI.emptyState = emptyState; UI.errorState = errorState;
  UI.skeleton = skeleton; UI.dl = dl; UI.tabs = tabs; UI.sparkline = sparkline; UI.bar = bar;
  UI.graph = graph; UI.heatgrid = heatgrid; UI.timeline = timeline;
  UI.propertyFilter = propertyFilter; UI.applyTokens = applyTokens;

  A.ui = UI;
})();
