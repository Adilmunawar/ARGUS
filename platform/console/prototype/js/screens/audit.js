/* Audit: every action by anyone, kept forever.
 *
 * Classic script, no modules, ES5 only, no network. Actor names, action names
 * and target strings are written by whoever performed the action, including
 * automation outside this codebase, so every one of them is a text node.
 */
(function () {
  'use strict';

  var A = window.ARGUS, ui = A.ui, el = ui.el, fmt = ui.fmt;

  var ROLE_TONE = { System: 'idle', Admin: 'bad', Approver: 'info', Operator: 'ok' };

  /** RFC 4180: quote a field, and double any quote inside it. */
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
            /* No blob download link on purpose: the prototype runs from file://
             * under a strict CSP where a download never starts and the operator
             * is left staring at a button that did nothing. */
            text: 'The text is shown rather than downloaded because this prototype opens from file:// with '
              + 'downloads blocked, so a download link would silently do nothing. Select all and copy. '
              + 'A real deployment streams the same rows from the API, signed, without loading them into a page.'
          })
        ];
      },
      actions: function (close) {
        return [
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
    render: function (mount) {
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
            // Both times, always: relative for reading, absolute UTC for quoting
            // in an incident report where "3 h ago" means nothing a week later.
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
        { key: 'ip', label: 'Source IP', render: function (r) { return el('span.mono', { text: r.ip }); } }
      ];

      var tableHost = el('div');
      var visible = d.audit.slice();

      function paint(tokens) {
        visible = ui.applyTokens(d.audit, tokens || [], accessors);
        ui.clear(tableHost);
        tableHost.appendChild(ui.table(cols, visible, {
          caption: 'Audit events, newest first, with actor, role, action, target, pull request and source address',
          empty: 'No event matches every filter. Remove a token to widen the search.',
          sortKey: 'at', sortDir: 'desc',
          rowKey: function (r) { return r.at.toISOString() + r.action; }
        }));
      }

      var filter = ui.propertyFilter([
        { key: 'actor', label: 'Actor' },
        { key: 'action', label: 'Action' },
        { key: 'target', label: 'Target' },
        { key: 'role', label: 'Role' }
      ], paint);

      mount.appendChild(ui.pageHeader(
        'Audit',
        'Every action by anyone, kept forever. This is the record an auditor is given.',
        [ui.btn('Export as CSV', {
          variant: 'primary',
          title: 'Show the filtered audit events as CSV text',
          onClick: function () { exportDialog(visible); }
        })]));

      mount.appendChild(el('div.tiles', [
        ui.statTile('Events, last 24 hours', fmt.num(last24), { note: 'Of ' + fmt.num(d.audit.length) + ' retained' }),
        ui.statTile('Distinct actors', fmt.num(Object.keys(actors).length), { note: 'People and automation, counted the same way' }),
        ui.statTile('Privileged actions', fmt.num(privileged), { note: 'Admin role, a grant, or the reconciler being overridden' }),
        ui.statTile('Pull requests referenced', fmt.num(Object.keys(prs).length), { note: 'Every change traceable to a diff somebody approved' })
      ]));

      mount.appendChild(el('div.callout.info', [
        el('strong', { text: 'Filters combine with AND.' }),
        el('p', {
          text: 'AWS CloudTrail lets you filter on one attribute at a time, which is the single most complained-about '
            + 'thing about it: you cannot ask for "actor adil and action grant" in one query. Here you can stack as '
            + 'many predicates as you like and they all apply at once.'
        })
      ]));

      mount.appendChild(filter);
      mount.appendChild(tableHost);
      paint([]);
    }
  });
})();
