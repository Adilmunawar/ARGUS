(function () {
  'use strict';

  var A = window.ARGUS, ui = A.ui, el = ui.el, fmt = ui.fmt;

  var ROLE_TONE = { System: 'idle', Admin: 'bad', Approver: 'info', Operator: 'ok' };

  function csvField(v) {
    var s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function buildCsv(rows) {
    var head = ['when_utc', 'actor', 'role', 'action', 'target', 'pr', 'source_ip'];
    var lines = [head.join(',')];
    rows.forEach(function (r) {
      lines.push([
        csvField(r.at.toISOString()),
        csvField(r.actor),
        csvField(r.role),
        csvField(r.action),
        csvField(r.target),
        csvField(r.pr === null || r.pr === undefined ? '' : r.pr),
        csvField(r.ip)
      ].join(','));
    });
    return lines.join('\n');
  }

  function isPrivileged(r) {
    return r.role === 'Admin'
      || r.action.indexOf('grant') !== -1
      || r.action.indexOf('reconciler') !== -1;
  }

  function rowText(r, prev) {
    return [prev || 'genesis', r.at.toISOString(), r.actor, r.role, r.action, r.target, r.pr === null || r.pr === undefined ? '' : String(r.pr), r.ip].join('|');
  }

  function fnv(text) {
    var h1 = 2166136261, h2 = 1431655765;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
      h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
    }
    return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
  }

  function digest(text) {
    var subtle = window.crypto && window.crypto.subtle;
    if (!subtle || typeof TextEncoder !== 'function') return Promise.resolve('fnv:' + fnv(text));
    return subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
      var bytes = new Uint8Array(buf), out = '';
      for (var i = 0; i < bytes.length; i++) out += ('0' + bytes[i].toString(16)).slice(-2);
      return 'sha256:' + out;
    }, function () { return 'fnv:' + fnv(text); });
  }

  function verifyChain(rows) {
    var ordered = rows.slice().sort(function (a, b) { return a.at - b.at || rows.indexOf(a) - rows.indexOf(b); });
    var prev = null, index = 0;
    var result = { rows: ordered.length, sealedNow: 0, verified: 0, broken: null };
    function step() {
      if (index >= ordered.length) return Promise.resolve(result);
      var r = ordered[index];
      return digest(rowText(r, prev)).then(function (h) {
        if (r.hash) {
          if (r.hash === h) result.verified += 1;
          else if (!result.broken) result.broken = { index: index + 1, row: r, expected: h, found: r.hash };
        } else {
          r.hash = h;
          result.sealedNow += 1;
        }
        prev = r.hash;
        index += 1;
        return step();
      });
    }
    return step();
  }

  function chainCard(d) {
    var status = el('p', { role: 'status', text: 'Not verified in this session yet.' });
    var sealedCount = d.audit.filter(function (r) { return r.hash; }).length;
    var summary = el('p.hint', { text: fmt.num(sealedCount) + ' of ' + fmt.num(d.audit.length) + ' rows carry a seal. Each seal is the hash of the row and the seal before it, so editing or removing any row breaks every seal after it.' });
    var verify = ui.btn('Verify the chain', {
      variant: 'primary',
      onClick: function () {
        verify.setDisabled(true);
        status.textContent = 'Verifying ' + fmt.num(d.audit.length) + ' rows.';
        verifyChain(d.audit).then(function (res) {
          verify.setDisabled(false);
          summary.textContent = fmt.num(d.audit.filter(function (r) { return r.hash; }).length) + ' of ' + fmt.num(d.audit.length) + ' rows carry a seal.';
          if (res.broken) {
            status.textContent = 'Chain broken at row ' + res.broken.index + ' (' + res.broken.row.actor + ' ' + res.broken.row.action + ' ' + fmt.stamp(res.broken.row.at) + '). ' +
              'The seal on that row does not match its contents, so it or a row before it was altered after sealing. ' + fmt.num(res.verified) + ' rows before it verified.';
            A.flash('bad', 'Audit chain broken', 'Row ' + res.broken.index + ' does not match its seal. Treat the trail as tampered from there.', { sticky: true });
            A.record('audit.verify', 'broken at row ' + res.broken.index);
          } else {
            status.textContent = 'Chain intact: ' + fmt.num(res.verified) + ' rows verified' + (res.sealedNow ? ', ' + fmt.num(res.sealedNow) + ' sealed for the first time' : '') + '.';
            A.flash('ok', 'Audit chain intact', fmt.num(res.rows) + ' rows, every seal matches.', { timeout: 6000 });
          }
          if (table) table.repaint();
        });
      }
    });
    return ui.card('Tamper evidence', [
      el('div.row', [verify, status]),
      summary,
      ui.disclosure('Details', [el('p', { text: 'Every audit row is sealed with a SHA-256 over its contents and the seal of the row before it. A real deployment writes the same chain into an object-locked bucket at the end of every day; here it is computed in the page so you can see it break.' })])
    ], { description: 'Each row is sealed with a hash of its contents and the seal before it.' });
  }

  function setCounter(node, n) {
    var card = node && node.closest ? node.closest('.card') : null;
    var row = card ? card.querySelector('.card-titlerow') : null;
    if (!row) return;
    var c = row.querySelector('.card-counter');
    if (!c) { c = el('span.card-counter'); row.appendChild(c); }
    c.textContent = '(' + fmt.num(n) + ')';
  }

  function setHeadCounter(mount, n) {
    var title = mount.querySelector('.pagehead-title');
    if (!title) return;
    var c = title.querySelector('.pagehead-counter');
    if (!c) { c = el('span.pagehead-counter'); title.insertBefore(c, title.querySelector('h1').nextSibling); }
    c.textContent = '(' + fmt.num(n) + ')';
  }

  var table = null;
  var browserBaseline = A.data && A.data.audit ? A.data.audit.length : 0;
  var LIVE_PATH = '/api/audit/recent?limit=500';
  var liveShared = { key: null, rows: [] };
  var liveTable = null;

  function exportDialog(rows, csvText, noteText) {
    A.dialog({
      wide: true,
      title: 'Export ' + fmt.num(rows.length) + ' audit events as CSV',
      body: function () {
        var text = el('textarea.field.mono', {
          id: 'audit-csv', rows: '14', readonly: true, spellcheck: 'false',
          'aria-label': 'Audit export in CSV format, read only',
          'aria-describedby': 'audit-csv-note'
        });
        text.value = csvText === undefined ? buildCsv(rows) : csvText;
        return [
          el('p', { text: 'This is exactly what the filtered table holds, in the order it is sorted.' }),
          text,
          el('p.hint', {
            id: 'audit-csv-note',
            text: noteText || ('The text is shown rather than downloaded because this prototype opens from file:// with '
              + 'downloads blocked, so a download link would silently do nothing. Select all and copy. '
              + 'A real deployment streams the same rows from the API, signed, without loading them into a page.')
          })
        ];
      },
      actions: function (close) {
        return [
          ui.btn('Copy the CSV', {
            variant: 'ghost',
            onClick: function () {
              var t = document.getElementById('audit-csv');
              if (!t) return;
              var done = function () { A.flash('ok', 'CSV copied', fmt.num(rows.length) + ' events are on the clipboard.', { timeout: 5000 }); };
              var fallback = function () { t.focus(); t.select(); A.announce('The clipboard refused the copy, so the text is selected instead. Press Ctrl C.'); };
              try {
                if (window.navigator && navigator.clipboard && navigator.clipboard.writeText) {
                  navigator.clipboard.writeText(t.value).then(done, fallback);
                  return;
                }
              } catch (e) {  }
              fallback();
            }
          }),
          ui.btn('Select the CSV text', {
            variant: 'ghost',
            onClick: function () {
              var t = document.getElementById('audit-csv');
              if (t) { t.focus(); t.select(); A.announce('CSV text selected, ready to copy'); }
            }
          }),
          ui.btn('Close', { variant: 'primary', onClick: close })
        ];
      }
    });
  }

  function renderSample(mount, ctx) {
      var d = A.data;

      var accessors = {
        actor: function (r) { return r.actor; },
        action: function (r) { return r.action; },
        target: function (r) { return r.target; },
        role: function (r) { return r.role; }
      };

      var cols = [
        {
          key: 'at', label: 'Event time',
          sort: function (r) { return r.at.getTime(); },
          render: function (r) {
            return el('time.mono', { datetime: r.at.toISOString(), title: fmt.ago(r.at), text: fmt.stamp(r.at), style: { 'white-space': 'nowrap' } });
          }
        },
        { key: 'actor', label: 'Actor' },
        {
          key: 'role', label: 'Role', status: true,
          render: function (r) { return ui.pill(r.role, ROLE_TONE[r.role] || 'idle'); }
        },
        {
          key: 'action', label: 'Action',
          render: function (r) {
            return el('span.row', [el('span.mono', { text: r.action }), isPrivileged(r) ? ui.badge('Privileged', 'warn') : null]);
          }
        },
        {
          key: 'target', label: 'Target',
          csv: function (r) { return r.target + (r.pr === null || r.pr === undefined ? '' : ' (#' + r.pr + ')'); },
          render: function (r) {
            if (r.pr === null || r.pr === undefined) return r.target;
            var a = A.link('#' + r.pr, 'deploys', [String(r.pr)]);
            a.title = 'Open deployment ' + r.pr;
            return el('span', [r.target + ' ', a]);
          }
        },
        { key: 'ip', label: 'Source IP', render: function (r) { return el('span.mono', { text: r.ip }); } },
        {
          key: 'hash', label: 'Seal', sortable: false,
          csv: function (r) { return r.hash || ''; },
          render: function (r) {
            return r.hash
              ? el('span.chain', { title: r.hash }, [ui.pill('sealed', 'ok'), el('span.mono.muted', { text: r.hash.split(':')[1].slice(0, 12) })])
              : ui.pill('unsealed', 'idle', { title: 'Verify the chain to seal this row' });
          }
        }
      ];

      var tableHost = el('div');
      var visible = d.audit.slice();
      table = null;

      function syncUrl(tokens) {
        A.replaceHash(A.href('audit', [], { f: ui.encodeTokens(tokens) }));
      }

      function paint(tokens) {
        visible = ui.applyTokens(d.audit, tokens || [], accessors);
        if (table) { table.setRows(visible); return; }
        table = ui.table(cols, visible, {
          id: 'audit.events',
          caption: 'Audit events, newest first, with actor, role, action, target, pull request and source address',
          emptyTitle: 'No matches',
          empty: 'No event matches every filter. Remove a token to widen the search.',
          sortKey: 'at', sortDir: 'desc',
          rowKey: function (r) { return r.at.toISOString() + r.action; }
        });
        tableHost.appendChild(table);
      }

      function exportRows() {
        return table && table.currentRows ? table.currentRows() : visible;
      }

      var filter = ui.propertyFilter([
        { key: 'actor', label: 'Actor' },
        { key: 'action', label: 'Action' },
        { key: 'target', label: 'Target' },
        { key: 'role', label: 'Role' }
      ], function (tokens) { paint(tokens); syncUrl(tokens); }, {
        initial: ui.decodeTokens((ctx && ctx.params && ctx.params.f) || (A.state.params && A.state.params.f))
      });

      mount.appendChild(ui.pageHeader(
        'Audit',
        'Every action by anyone, kept forever.',
        [ui.btn('Export as CSV', {
          variant: 'primary',
          title: 'Show the filtered audit events as CSV text',
          onClick: function () { exportDialog(exportRows()); }
        })], { counter: d.audit.length }));

      var events = ui.card('Event history', [filter, tableHost], {
        counter: d.audit.length,
        description: 'Filters combine with AND and are kept in the address.',
        actions: [
          ui.viewsBar('audit', function () { return window.location.hash; }),
          ui.columnsButton(function () { return table; }, 'audit events')
        ]
      });
      tableHost.style.setProperty('margin', '0 calc(-1 * var(--s-l)) calc(-1 * var(--s-l))');
      var chain = chainCard(d);
      chain.style.setProperty('margin-top', 'var(--s-l)');
      mount.appendChild(chain);
      mount.insertBefore(events, chain);
      paint(filter.tokens());
  }

  var OUTCOME_TONE = { success: 'ok', failure: 'bad', defer: 'info' };

  var LIVE_HEAD = ['when_utc', 'actor', 'event', 'outcome', 'reason', 'path', 'source_address', 'request_id'];

  function liveWhen(ts) {
    return String(ts || '').replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  }

  function liveRow(e) {
    return {
      seq: e.seq,
      raw: e,
      ts: e.ts,
      at: new Date(e.ts),
      actor: e.subject ? String(e.subject) : 'anonymous',
      event: e.event || '',
      outcome: e.outcome || '',
      reason: e.reason || '',
      path: e.path || '',
      source: e.sourceAddress || '',
      requestId: e.requestId || '',
      hash: null
    };
  }

  function liveRowText(r, prev) {
    return [prev || 'genesis', r.seq, r.ts, r.actor, r.event, r.outcome, r.reason, r.path, r.source, r.requestId].join('|');
  }

  function liveOrdered(rows) {
    return rows.slice().sort(function (a, b) { return a.seq - b.seq; });
  }

  function sealLive(rows) {
    var ordered = liveOrdered(rows), prev = null, i = 0;
    function step() {
      if (i >= ordered.length) return Promise.resolve(rows);
      var r = ordered[i];
      return digest(liveRowText(r, prev)).then(function (h) {
        r.hash = h;
        prev = h;
        i += 1;
        return step();
      });
    }
    return step();
  }

  function verifyLive(rows) {
    var ordered = liveOrdered(rows), prev = null, i = 0;
    var result = { rows: ordered.length, verified: 0, broken: null };
    function step() {
      if (i >= ordered.length) return Promise.resolve(result);
      var r = ordered[i];
      return digest(liveRowText(r, prev)).then(function (h) {
        if (r.hash === h) result.verified += 1;
        else if (!result.broken) result.broken = { index: i + 1, row: r };
        prev = r.hash;
        i += 1;
        return step();
      });
    }
    return step();
  }

  function liveRowsOf(env) {
    var events = (env.data && env.data.events) || [];
    var key = (env.data && env.data.total) + ':' + events.length + ':' + (events.length ? events[0].seq : '');
    if (liveShared.key !== key) {
      var rows = events.map(liveRow);
      liveShared = { key: key, rows: rows, sealed: sealLive(rows), tampered: null };
    }
    return liveShared;
  }

  function liveCsv(rows) {
    var lines = [LIVE_HEAD.join(',')];
    rows.forEach(function (r) {
      lines.push([r.ts, r.actor, r.event, r.outcome, r.reason, r.path, r.source, r.requestId].map(csvField).join(','));
    });
    return lines.join('\n');
  }

  function liveDetail(r) {
    var keys = Object.keys(r.raw);
    A.dialog({
      wide: true,
      title: 'Audit event ' + r.seq + ': ' + r.event,
      body: function () {
        return [
          el('p.hint', { text: 'The whole record exactly as the API holds it. The actor column shows "anonymous" when the record has no subject.' }),
          ui.dl(keys.map(function (k) {
            var v = r.raw[k];
            return [k, el('span.mono', { text: v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v) })];
          }))
        ];
      }
    });
  }

  function liveHeader(body, data, env) {
    var rows = liveRowsOf(env).rows;
    body.appendChild(el('p', {
      id: 'audit-live-summary',
      text: fmt.num(data.total) + ' events held, ' + fmt.num(data.dropped) + ' dropped, since ' + fmt.stamp(new Date(data.since)) + '.'
    }));
    body.appendChild(el('p', [el('span.mono', { text: 'persistence: ' + data.persistence }), ', the newest ' + fmt.num(rows.length) + ' shown.']));
    body.appendChild(el('p.hint', [
      'Emptied when the API restarts. Older events are in the API log: ',
      A.link('Logs', 'logs'),
      '.'
    ]));
  }

  function liveChain(body, data, env) {
    var shared = liveRowsOf(env);
    var rows = shared.rows;
    var status = el('p', { role: 'status', id: 'audit-live-chain', text: 'Sealing ' + fmt.num(rows.length) + ' rows as received.' });
    var verify = ui.btn('Verify the chain', { variant: 'primary', onClick: function () { run(); } });
    var alter = ui.btn('Alter one row in this page', { variant: 'ghost', onClick: function () {
      if (!rows.length) return;
      if (!shared.tampered) {
        var victim = liveOrdered(rows)[Math.floor(rows.length / 2)];
        shared.tampered = { row: victim, reason: victim.reason };
      }
      shared.tampered.row.reason = 'altered in this browser';
      status.textContent = 'Row ' + shared.tampered.row.seq + ' was altered in this page. The API was not touched. Verify the chain.';
    } });
    var restore = ui.btn('Restore the row', { variant: 'ghost', onClick: function () {
      if (shared.tampered) { shared.tampered.row.reason = shared.tampered.reason; shared.tampered = null; }
      status.textContent = 'Row restored. Verify the chain again.';
    } });
    function run() {
      verify.setDisabled(true);
      status.textContent = 'Verifying ' + fmt.num(rows.length) + ' rows.';
      shared.sealed.then(function () { return verifyLive(rows); }).then(function (res) {
        verify.setDisabled(false);
        if (res.broken) {
          status.textContent = 'Chain broken at row ' + res.broken.index + ' (seq ' + res.broken.row.seq + ', ' + res.broken.row.event + '). '
            + 'That row no longer matches the seal made when it arrived. ' + fmt.num(res.verified) + ' rows before it verified.';
        } else {
          status.textContent = 'Chain intact: ' + fmt.num(res.verified) + ' of ' + fmt.num(res.rows) + ' rows verified.';
        }
      });
    }
    body.appendChild(el('div.row', [verify, status]));
    body.appendChild(el('p.hint', { text: 'Seals are made in this page as rows arrive. Verifying proves no row changed since; it does not show the API\'s memory was untouched.' }));
    body.appendChild(ui.disclosure('Demonstration of tamper evidence', [
      el('p.hint', { text: 'Alter one row in this page only, then verify: the chain breaks at that row. Restore it and verify again.' }),
      el('div.row', [alter, restore])
    ]));
  }

  function liveTablePanel(body, data, env, ctx) {
    var rows = liveRowsOf(env).rows;
    var visible = rows.slice();
    var accessors = {
      actor: function (r) { return r.actor; },
      event: function (r) { return r.event; },
      outcome: function (r) { return r.outcome; },
      path: function (r) { return r.path; },
      source: function (r) { return r.source; }
    };
    var cols = [
      { key: 'seq', label: 'When (UTC)', sort: function (r) { return r.seq; },
        render: function (r) { return el('span.mono', { text: liveWhen(r.ts), style: { 'white-space': 'nowrap' } }); },
        csv: function (r) { return r.ts; } },
      { key: 'actor', label: 'Actor' },
      { key: 'event', label: 'Event', render: function (r) { return el('span.mono', { text: r.event }); } },
      { key: 'outcome', label: 'Outcome', status: true,
        render: function (r) { return r.outcome ? ui.pill(r.outcome, OUTCOME_TONE[r.outcome] || 'idle') : el('span.muted', { text: '-' }); } },
      { key: 'reason', label: 'Reason' },
      { key: 'path', label: 'Path', render: function (r) { return el('span.mono', { text: r.path || '-' }); } },
      { key: 'source', label: 'Source address', render: function (r) { return el('span.mono', { text: r.source || '-' }); } },
      { key: 'requestId', label: 'Request id', render: function (r) { return r.requestId ? el('span.mono', { title: r.requestId, text: String(r.requestId).slice(0, 12) }) : el('span.mono', { text: '-' }); } }
    ];
    var host = el('div');
    host.style.setProperty('margin', '0 calc(-1 * var(--s-l))');
    setCounter(body, rows.length);
    liveTable = null;
    function paint(tokens) {
      visible = ui.applyTokens(rows, tokens || [], accessors);
      if (liveTable) { liveTable.setRows(visible); return; }
      liveTable = ui.table(cols, visible, {
        id: 'audit.live',
        defaultHidden: ['requestId'],
        caption: 'Audit events held by the console API, newest first, with actor, event, outcome, reason, path, source address and request id',
        emptyTitle: rows.length ? 'No matches' : 'No events',
        empty: rows.length ? 'No event matches every filter. Remove a token to widen the search.' : 'The API has recorded no audit events yet.',
        sortKey: 'seq', sortDir: 'desc',
        rowKey: function (r) { return String(r.seq); },
        onRow: liveDetail
      });
      host.appendChild(liveTable);
    }
    var filter = ui.propertyFilter([
      { key: 'actor', label: 'Actor' },
      { key: 'event', label: 'Event' },
      { key: 'outcome', label: 'Outcome' },
      { key: 'path', label: 'Path' },
      { key: 'source', label: 'Source' }
    ], function (tokens) {
      paint(tokens);
      A.replaceHash(A.href('audit', [], { f: ui.encodeTokens(tokens) }));
    }, { initial: ui.decodeTokens((ctx && ctx.params && ctx.params.f) || (A.state.params && A.state.params.f)) });
    body.appendChild(el('div.row', [filter, el('span.spacer'), ui.columnsButton(function () { return liveTable; }, 'audit events')]));
    body.appendChild(host);
    var head = body.closest ? body.closest('#main') : null;
    if (head) setHeadCounter(head, rows.length);
    paint(filter.tokens());
  }

  function browserSection() {
    var all = A.data && A.data.audit ? A.data.audit : [];
    var mine = all.slice(0, Math.max(0, all.length - browserBaseline));
    if (!mine.length) return null;
    var t = ui.table([
      { key: 'at', label: 'When', render: function (r) { return el('span.mono', { text: fmt.stamp(r.at) }); }, sort: function (r) { return r.at.getTime(); } },
      { key: 'actor', label: 'Actor' },
      { key: 'action', label: 'Action', render: function (r) { return el('span.mono', { text: r.action }); } },
      { key: 'target', label: 'Target' }
    ], mine, {
      id: 'audit.browser',
      caption: 'Actions recorded by this browser only',
      sortKey: 'at', sortDir: 'desc',
      rowKey: function (r) { return r.at.toISOString() + r.action + r.target; }
    });
    return ui.card('This browser', [t], {
      counter: mine.length,
      description: 'Actions taken in this page since it loaded. Not sent anywhere and not part of the API trail.'
    });
  }

  function renderLive(mount, ctx) {
    mount.appendChild(ui.pageHeader(
      'Audit',
      'Sign-ins, refusals and session events recorded by the console API.',
      [
        ui.btn('Refresh', { variant: 'ghost', onClick: function () { A.forget(LIVE_PATH); A.refresh(); } }),
        ui.btn('Export as CSV', {
          variant: 'primary',
          title: 'Show the filtered audit events as CSV text',
          onClick: function () {
            if (!liveTable) { A.flash('info', 'Nothing to export', 'The audit events have not been read yet.'); return; }
            var rows = liveTable.currentRows();
            exportDialog(rows, liveCsv(rows), 'This is exactly what the filtered table holds, in the order it is sorted. Select all and copy. The API keeps these events in memory only; Loki holds the full history from the API\'s log.');
          }
        })
      ]));
    var opts = { ttlMs: 5000, skeletonRows: 4 };
    var layout = el('div.grid');
    mount.appendChild(layout);
    layout.appendChild(A.livePanel('Event history', LIVE_PATH, function (b, d, e) { liveTablePanel(b, d, e, ctx); }, opts));
    layout.appendChild(el('div.grid.grid-2', [
      A.livePanel('Trail', LIVE_PATH, liveHeader, opts),
      A.livePanel('Tamper evidence', LIVE_PATH, liveChain, opts)
    ]));
    var mine = browserSection();
    if (mine) layout.appendChild(mine);
  }

  A.screen('audit', {
    title: 'Audit',
    crumb: 'Audit',
    render: function (mount, ctx) {
      var mode = A.storeMode();
      if (mode === 'live') { renderLive(mount, ctx); return; }
      if (mode !== 'sample') {
        var host = el('div');
        mount.appendChild(host);
        A.whenProbed(function (m) {
          if (m === 'live') renderLive(host, ctx);
          else renderSample(host, ctx);
        });
        return;
      }
      renderSample(mount, ctx);
    }
  });
})();
