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

  A.verifyAuditChain = function () { return verifyChain(A.data.audit); };

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
      el('p', { text: 'Every audit row is sealed with a SHA-256 over its contents and the seal of the row before it. A real deployment writes the same chain into an object-locked bucket at the end of every day; here it is computed in the page so you can see it break.' }),
      el('div.row', [verify, status]),
      summary
    ]);
  }

  var table = null;

  function exportDialog(rows) {
    A.dialog({
      wide: true,
      title: 'Export ' + fmt.num(rows.length) + ' audit events as CSV',
      body: function () {
        var text = el('textarea.field.mono', {
          id: 'audit-csv', rows: '14', readonly: true, spellcheck: 'false',
          'aria-label': 'Audit export in CSV format, read only',
          'aria-describedby': 'audit-csv-note'
        });
        text.value = buildCsv(rows);
        return [
          el('p', { text: 'This is exactly what the filtered table holds, in the order it is sorted.' }),
          text,
          el('p.hint', {
            id: 'audit-csv-note',
            text: 'The text is shown rather than downloaded because this prototype opens from file:// with '
              + 'downloads blocked, so a download link would silently do nothing. Select all and copy. '
              + 'A real deployment streams the same rows from the API, signed, without loading them into a page.'
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

  A.screen('audit', {
    title: 'Audit',
    crumb: 'Audit',
    render: function (mount, ctx) {
      var d = A.data;

      var since = d.now.getTime() - 86400000;
      var last24 = d.audit.filter(function (r) { return r.at.getTime() >= since; }).length;

      var actors = {}, prs = {};
      d.audit.forEach(function (r) {
        actors[r.actor] = true;
        if (r.pr !== null && r.pr !== undefined) prs[r.pr] = true;
      });
      var privileged = d.audit.filter(isPrivileged).length;

      var accessors = {
        actor: function (r) { return r.actor; },
        action: function (r) { return r.action; },
        target: function (r) { return r.target; },
        role: function (r) { return r.role; }
      };

      var cols = [
        {
          key: 'at', label: 'When',
          sort: function (r) { return r.at.getTime(); },
          render: function (r) {
            return el('div.col', [
              fmt.time(r.at),
              el('div.muted', el('span.mono', { text: fmt.stamp(r.at) }))
            ]);
          }
        },
        { key: 'actor', label: 'Actor' },
        {
          key: 'role', label: 'Role', status: true,
          render: function (r) { return ui.pill(r.role, ROLE_TONE[r.role] || 'idle'); }
        },
        { key: 'action', label: 'Action', render: function (r) { return el('span.mono', { text: r.action }); } },
        { key: 'target', label: 'Target' },
        {
          key: 'pr', label: 'PR', sortable: false,
          render: function (r) {
            if (r.pr === null || r.pr === undefined) return el('span.muted', { text: '-' });
            var a = A.link('#' + r.pr, 'deploys', [String(r.pr)]);
            a.title = 'Open deployment ' + r.pr;
            return a;
          }
        },
        { key: 'ip', label: 'Source IP', render: function (r) { return el('span.mono', { text: r.ip }); } },
        {
          key: 'hash', label: 'Seal', sortable: false,
          csv: function (r) { return r.hash || ''; },
          render: function (r) {
            return r.hash
              ? el('span.chain', { title: r.hash }, [ui.pill('sealed', 'ok'), el('span.mono.muted', { text: r.hash.split(':')[1].slice(0, 8) })])
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
        'Every action by anyone, kept forever. This is the record an auditor is given.',
        [ui.btn('Export as CSV', {
          variant: 'primary',
          title: 'Show the filtered audit events as CSV text',
          onClick: function () { exportDialog(exportRows()); }
        })]));

      mount.appendChild(el('div.tiles', [
        ui.statTile('Events, last 24 hours', fmt.num(last24), { note: 'Of ' + fmt.num(d.audit.length) + ' retained' }),
        ui.statTile('Distinct actors', fmt.num(Object.keys(actors).length), { note: 'People and automation, counted the same way' }),
        ui.statTile('Privileged actions', fmt.num(privileged), { note: 'Admin role, a grant, or the reconciler being overridden' }),
        ui.statTile('Pull requests referenced', fmt.num(Object.keys(prs).length), { note: 'Every change traceable to a diff somebody approved' })
      ]));

      mount.appendChild(chainCard(d));

      mount.appendChild(el('div.callout.info', [
        el('strong', { text: 'Filters combine with AND.' }),
        el('p', {
          text: 'AWS CloudTrail lets you filter on one attribute at a time, which is the single most complained-about '
            + 'thing about it: you cannot ask for "actor adil and action grant" in one query. Here you can stack as '
            + 'many predicates as you like and they all apply at once. The filter is part of the address, so a '
            + 'filtered view can be handed to somebody as a link.'
        })
      ]));

      mount.appendChild(el('div.row', [filter, el('span.spacer'),
        ui.viewsBar('audit', function () { return window.location.hash; }),
        ui.columnsButton(function () { return table; }, 'audit events')]));
      mount.appendChild(tableHost);
      paint(filter.tokens());
    }
  });
})();
