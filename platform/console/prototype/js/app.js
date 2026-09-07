/* Argus Console: the shell.
 *
 * Routing, the command palette, the flash bar, dialogs and focus management,
 * the session drawer, elevation state, and the preferences that persist.
 *
 * Design notes worth keeping in the code rather than a wiki:
 *
 *  - Every screen is a hash route, so every resource has a link somebody can
 *    paste into an alert or a runbook. Azure's blade state is the anti-pattern.
 *  - Navigation is two levels at most: a list, then a detail with tabs. No
 *    stacking panels.
 *  - One live region, announced deliberately. A streaming log on aria-live
 *    makes a screen reader unusable, so the log view is aria-live="off" with
 *    an explicit control instead.
 *  - The session drawer is never unmounted, because a terminal that dies when
 *    you navigate is worse than no terminal.
 */
(function () {
  'use strict';

  var A = (window.ARGUS = window.ARGUS || {});
  var ui = A.ui, el = ui.el, clear = ui.clear;

  /* ------------------------------------------------------- preferences --- */

  // localStorage can throw outright in a locked-down browser, so every access
  // is guarded and the console renders correctly with nothing stored.
  var prefs = { density: 'comfortable', rail: false, timezone: 'utc' };
  function loadPrefs() {
    try {
      var raw = window.localStorage.getItem('argus.prefs');
      if (raw) { var p = JSON.parse(raw); Object.keys(p).forEach(function (k) { prefs[k] = p[k]; }); }
    } catch (e) { /* private window, cleared storage, or blocked: use defaults */ }
  }
  function savePrefs() {
    try { window.localStorage.setItem('argus.prefs', JSON.stringify(prefs)); } catch (e) { /* not fatal */ }
  }

  /* ------------------------------------------------------- live region --- */

  var liveNode = null;
  A.announce = function (msg) {
    if (!liveNode) return;
    // Re-setting identical text does not re-announce, so clear first.
    liveNode.textContent = '';
    window.setTimeout(function () { liveNode.textContent = msg; }, 30);
  };

  /* ---------------------------------------------------------- flashbar --- */

  var flashHost = null;
  /** kind: ok | warn | bad | info. Returns a handle with .remove(). */
  A.flash = function (kind, title, detail, opts) {
    opts = opts || {};
    var node = el('div.flash.' + kind, { role: kind === 'bad' ? 'alert' : 'status' }, [
      el('span.flash-glyph', { 'aria-hidden': 'true', text: { ok: '✓', warn: '!', bad: '✕', info: 'i' }[kind] || 'i' }),
      el('div.flash-text', [
        el('strong', { text: title }),
        detail ? el('span', { text: ' ' + detail }) : null
      ]),
      opts.action || null,
      el('button.x', {
        type: 'button', 'aria-label': 'Dismiss: ' + title,
        on: { click: function () { node.remove(); } }
      }, '×')
    ]);
    flashHost.appendChild(node);
    A.announce(title + (detail ? '. ' + detail : ''));
    if (opts.timeout) window.setTimeout(function () { node.remove(); }, opts.timeout);
    return node;
  };

  /* ----------------------------------------------------- focus + modal --- */

  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  function trapFocus(container, onEscape) {
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); onEscape(); return; }
      if (e.key !== 'Tab') return;
      var items = Array.prototype.filter.call(container.querySelectorAll(FOCUSABLE), function (n) {
        return n.offsetParent !== null || n === document.activeElement;
      });
      if (!items.length) return;
      var first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    container.addEventListener('keydown', onKey);
    return function () { container.removeEventListener('keydown', onKey); };
  }

  /**
   * A modal dialog. Returns nothing; call close() from inside.
   * opts: {title, body(close), actions(close) -> [nodes], describedBy, wide}
   * Focus is trapped, Escape closes, and focus returns to whatever opened it.
   */
  A.dialog = function (opts) {
    var opener = document.activeElement;
    var titleId = 'dlg-title-' + Math.random().toString(36).slice(2, 8);

    function close() {
      untrap();
      scrim.remove();
      document.body.classList.remove('has-dialog');
      if (opener && opener.focus) opener.focus();
    }

    var panel = el('div.dialog' + (opts.wide ? '.wide' : ''), {
      role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId
    }, [
      el('div.dialog-head', [
        el('h2', { id: titleId, tabindex: '-1', text: opts.title }),
        el('button.x', { type: 'button', 'aria-label': 'Close dialog', on: { click: close } }, '×')
      ]),
      el('div.dialog-body', opts.body ? opts.body(close) : null),
      el('div.dialog-foot', opts.actions ? opts.actions(close) : ui.btn('Close', { onClick: close }))
    ]);

    var scrim = el('div.scrim.is-dialog', {
      on: { mousedown: function (e) { if (e.target === scrim) close(); } }
    }, panel);

    document.body.appendChild(scrim);
    document.body.classList.add('has-dialog');
    var untrap = trapFocus(panel, close);
    panel.querySelector('h2').focus();
    return { close: close, panel: panel };
  };

  /**
   * The delete ladder, step three: an irreversible action that requires the
   * operator to type the resource name. Used for anything that cannot be undone
   * by a revert commit.
   */
  A.confirmDestructive = function (opts) {
    A.dialog({
      title: opts.title,
      body: function () {
        var input = el('input.field', {
          type: 'text', id: 'confirm-name', autocomplete: 'off', spellcheck: 'false',
          'aria-describedby': 'confirm-help'
        });
        var go = ui.btn(opts.confirmLabel || 'Confirm', { variant: 'danger', disabled: true });
        input.addEventListener('input', function () {
          var ok = input.value.trim() === opts.match;
          go.disabled = !ok;
          go.classList.toggle('is-disabled', !ok);
          go.setAttribute('aria-disabled', ok ? 'false' : 'true');
        });
        opts._input = input; opts._go = go;
        return [
          el('p', { text: opts.detail }),
          el('div.callout.bad', [
            el('strong', { text: 'Environment: ' + (opts.environment || A.state.env) }),
            opts.blast ? el('p', { text: opts.blast }) : null
          ]),
          el('label.fieldlabel', { for: 'confirm-name', text: 'Type ' + opts.match + ' to confirm' }),
          input,
          el('p.hint', { id: 'confirm-help', text: 'This cannot be undone from the console.' })
        ];
      },
      actions: function (close) {
        var go = opts._go;
        go.addEventListener('click', function () {
          if (go.disabled) return;
          close();
          opts.onConfirm();
        });
        return [ui.btn('Cancel', { variant: 'ghost', onClick: close }), go];
      }
    });
  };

  /**
   * Step-up authentication. NIST SP 800-63B expects re-authentication before a
   * sensitive operation; the prototype renders the flow, a real deployment
   * would hand off to AD FS. Nothing here ever touches a real credential.
   */
  A.stepUp = function (reason, onOk) {
    A.dialog({
      title: 'Confirm it is you',
      body: function () {
        return [
          el('p', { text: reason }),
          el('div.callout.info', { text: 'Touch your security key. The console never sees a password, and this prototype performs no authentication at all.' }),
          el('div.stepup-key', { 'aria-hidden': 'true', text: '🔑' })
        ];
      },
      actions: function (close) {
        return [
          ui.btn('Cancel', { variant: 'ghost', onClick: close }),
          ui.btn('Simulate key touch', {
            variant: 'primary', onClick: function () { close(); onOk(); }
          })
        ];
      }
    });
  };

  /* ----------------------------------------------------------- routing --- */

  A.state = { env: 'production', route: 'overview', params: {} };

  var screens = {};
  /** Screens register themselves: ARGUS.screen('id', {title, crumb, render}). */
  A.screen = function (id, def) { screens[id] = def; };
  A.screens = screens;

  function parseHash() {
    var h = (window.location.hash || '#/overview').replace(/^#\/?/, '');
    var qi = h.indexOf('?');
    var params = {};
    if (qi !== -1) {
      h.slice(qi + 1).split('&').forEach(function (kv) {
        var p = kv.split('=');
        if (p[0]) params[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
      });
      h = h.slice(0, qi);
    }
    var segs = h.split('/').filter(Boolean);
    return { route: segs[0] || 'overview', rest: segs.slice(1), params: params };
  }

  /** Build a hash link. go('apps', ['mills'], {tab:'logs'}) */
  A.href = function (route, rest, params) {
    var h = '#/' + route + (rest && rest.length ? '/' + rest.join('/') : '');
    var q = Object.keys(params || {}).filter(function (k) { return params[k] !== null && params[k] !== undefined && params[k] !== ''; });
    if (q.length) h += '?' + q.map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
    return h;
  };
  A.go = function (route, rest, params) { window.location.hash = A.href(route, rest, params); };
  /** An anchor that routes. Real hrefs, so middle-click and copy-link work. */
  A.link = function (label, route, rest, params, cls) {
    return el('a' + (cls ? '.' + cls : '.rlink'), { href: A.href(route, rest, params) }, label);
  };

  var mount, crumbHost, titleHost;

  function render() {
    var r = parseHash();
    A.state.route = r.route; A.state.rest = r.rest; A.state.params = r.params;
    var def = screens[r.route];

    document.querySelectorAll('.nav').forEach(function (n) {
      if (n.dataset.go === r.route) n.setAttribute('aria-current', 'page');
      else n.removeAttribute('aria-current');
    });

    clear(mount);
    if (!def) {
      mount.appendChild(ui.emptyState(
        'That screen does not exist',
        'The link may be from an older version of the console.',
        ui.btn('Go to Overview', { variant: 'primary', onClick: function () { A.go('overview'); } })));
      document.title = 'Not found - Argus Console';
      return;
    }

    // Breadcrumb: at most two levels, by design.
    clear(crumbHost);
    crumbHost.appendChild(el('a.crumb-link', { href: A.href(r.route) , text: def.crumb || def.title }));
    if (r.rest.length) {
      crumbHost.appendChild(el('span.sep', { 'aria-hidden': 'true', text: '/' }));
      crumbHost.appendChild(el('b', { text: r.rest.join(' / ') }));
    }

    var pageTitle = (r.rest.length ? r.rest[r.rest.length - 1] + ' - ' : '') + (def.title || r.route);
    document.title = pageTitle + ' - Argus Console';

    try {
      def.render(mount, { rest: r.rest, params: r.params, env: A.state.env });
    } catch (err) {
      mount.appendChild(ui.errorState(
        'This screen failed to render',
        String(err && err.message ? err.message : err),
        function () { render(); }));
      if (window.console && window.console.error) window.console.error(err);
    }

    var h1 = mount.querySelector('h1');
    if (h1) h1.focus({ preventScroll: true });
    window.scrollTo(0, 0);
    A.announce(pageTitle + ' loaded');
    closeDrawerNav();
  }

  /* ---------------------------------------------------- command palette --- */

  /** Everything the palette can reach. Rebuilt per open so it reflects state. */
  function paletteItems() {
    var d = A.data, items = [];
    Object.keys(screens).forEach(function (id) {
      items.push({ kind: 'Go to', label: screens[id].title, hint: screens[id].crumb || '', run: function () { A.go(id); } });
    });
    d.apps.forEach(function (app) {
      items.push({ kind: 'Application', label: app.display, hint: app.name + ' · ' + app.version, run: function () { A.go('apps', [app.name]); } });
    });
    d.vms.forEach(function (vm) {
      items.push({ kind: 'Virtual machine', label: vm.name, hint: vm.role, run: function () { A.go('compute', ['vm', vm.name]); } });
      if (vm.connect.indexOf('rdp') !== -1) {
        items.push({ kind: 'Connect', label: 'Desktop on ' + vm.name, hint: 'Recorded RDP', run: function () { A.connect(vm, 'rdp'); } });
      }
      if (vm.connect.indexOf('ssh') !== -1) {
        items.push({ kind: 'Connect', label: 'Shell on ' + vm.name, hint: 'Recorded SSH', run: function () { A.connect(vm, 'ssh'); } });
      }
    });
    d.hosts.forEach(function (h) {
      items.push({ kind: 'Host', label: h.name, hint: h.role, run: function () { A.go('compute', ['host', h.name]); } });
    });
    d.buckets.forEach(function (b) {
      items.push({ kind: 'Bucket', label: b.name, hint: ui.fmt.bytesTB(b.sizeTB), run: function () { A.go('data', ['bucket', b.name]); } });
    });
    d.databases.forEach(function (b) {
      items.push({ kind: 'Database', label: b.name, hint: b.engine, run: function () { A.go('data', ['database', b.name]); } });
    });
    d.runbooks.forEach(function (rb) {
      items.push({ kind: 'Runbook', label: rb.title, hint: rb.id, run: function () { A.go('ops', ['runbook', rb.id]); } });
    });
    items.push({ kind: 'Action', label: 'Switch to ' + (A.state.env === 'production' ? 'staging' : 'production'), hint: 'Environment', run: function () { A.setEnv(A.state.env === 'production' ? 'staging' : 'production'); } });
    items.push({ kind: 'Action', label: 'Toggle compact density', hint: 'Rows per screen', run: function () { A.setDensity(prefs.density === 'compact' ? 'comfortable' : 'compact'); } });
    items.push({ kind: 'Action', label: 'Show keyboard shortcuts', hint: '?', run: function () { A.shortcuts(); } });
    return items;
  }

  /** Subsequence match, the behaviour people expect from a palette. */
  function fuzzy(needle, hay) {
    if (!needle) return 0;
    var n = needle.toLowerCase(), h = hay.toLowerCase();
    var direct = h.indexOf(n);
    if (direct !== -1) return 1000 - direct;
    var hi = 0, score = 0;
    for (var i = 0; i < n.length; i++) {
      var at = h.indexOf(n[i], hi);
      if (at === -1) return -1;
      score += at === hi ? 3 : 1;
      hi = at + 1;
    }
    return score;
  }

  A.palette = function () {
    var items = paletteItems();
    var results = [], active = 0;

    var input = el('input.pal-input', {
      type: 'text', 'aria-label': 'Search resources, screens and actions',
      placeholder: 'Jump to a resource, screen or action', autocomplete: 'off', spellcheck: 'false',
      role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'pal-list', 'aria-autocomplete': 'list'
    });
    var list = el('ul.pal-list', { id: 'pal-list', role: 'listbox', 'aria-label': 'Results' });
    var count = el('div.pal-count', { 'aria-live': 'polite' });

    function paint() {
      var q = input.value.trim();
      results = items.map(function (it) { return { it: it, s: q ? fuzzy(q, it.label + ' ' + it.hint) : 0 }; })
        .filter(function (r) { return r.s >= 0; })
        .sort(function (a, b) { return b.s - a.s; })
        .slice(0, 40).map(function (r) { return r.it; });
      active = 0;
      clear(list);
      results.forEach(function (it, i) {
        list.appendChild(el('li.pal-item', {
          role: 'option', id: 'pal-opt-' + i, 'aria-selected': i === 0 ? 'true' : 'false',
          on: { click: function () { run(i); }, mousemove: function () { setActive(i); } }
        }, [
          el('span.pal-kind', { text: it.kind }),
          el('span.pal-label', { text: it.label }),
          it.hint ? el('span.pal-hint', { text: it.hint }) : null
        ]));
      });
      if (!results.length) list.appendChild(el('li.pal-empty', { text: 'Nothing matches ' + q }));
      count.textContent = results.length + ' result' + (results.length === 1 ? '' : 's');
      setActive(0);
    }

    function setActive(i) {
      if (!results.length) return;
      active = Math.max(0, Math.min(results.length - 1, i));
      Array.prototype.forEach.call(list.children, function (li, j) {
        li.setAttribute('aria-selected', j === active ? 'true' : 'false');
        li.classList.toggle('is-active', j === active);
      });
      input.setAttribute('aria-activedescendant', 'pal-opt-' + active);
      var node = list.children[active];
      if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
    }

    function run(i) { var it = results[i]; if (!it) return; dlg.close(); it.run(); }

    input.addEventListener('input', paint);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); run(active); }
    });

    var dlg = A.dialog({
      title: 'Command palette',
      wide: true,
      body: function () { return el('div.pal', [input, count, list]); },
      actions: function (close) {
        return el('div.pal-foot', [
          el('span.kbdhint', [el('kbd', '↑'), el('kbd', '↓'), ' to move ']),
          el('span.kbdhint', [el('kbd', 'Enter'), ' to open ']),
          el('span.kbdhint', [el('kbd', 'Esc'), ' to close']),
          ui.btn('Close', { variant: 'ghost', onClick: close })
        ]);
      }
    });
    paint();
    input.focus();
  };

  /* ------------------------------------------------------- environment --- */

  A.setEnv = function (env) {
    A.state.env = env;
    var pill = document.getElementById('envbtn');
    clear(pill);
    pill.classList.toggle('is-staging', env === 'staging');
    pill.appendChild(el('span.env-dot', { 'aria-hidden': 'true' }));
    pill.appendChild(el('span', { text: env === 'production' ? 'Production' : 'Staging' }));
    pill.setAttribute('aria-label', 'Environment: ' + env + '. Activate to switch.');
    A.flash(env === 'production' ? 'info' : 'warn', 'Environment: ' + env,
      env === 'production' ? 'Destructive actions will name this environment before they run.' : 'Changes here do not affect production.',
      { timeout: 6000 });
    render();
  };

  A.setDensity = function (d) {
    prefs.density = d; savePrefs();
    document.body.classList.toggle('is-compact', d === 'compact');
    A.announce('Density: ' + d);
  };

  /* ----------------------------------------------- elevation + sessions --- */

  var elevationTimer = null;

  A.requestElevation = function (group, reason, hours, onGranted) {
    A.stepUp('Elevating to ' + group + ' needs a second factor.', function () {
      A.data.me.elevation = {
        group: group, reason: reason,
        expires: new Date(A.data.now.getTime() + hours * 3600000)
      };
      paintElevation();
      A.flash('warn', 'Elevated to ' + group,
        'Expires in ' + hours + ' h. Every action while elevated is recorded in the audit.');
      if (onGranted) onGranted();
    });
  };

  A.dropElevation = function () {
    A.data.me.elevation = null;
    paintElevation();
    A.flash('ok', 'Elevation released', 'You are back to your standing role.', { timeout: 5000 });
  };

  function paintElevation() {
    var host = document.getElementById('elevation');
    clear(host);
    var e = A.data.me.elevation;
    if (!e) { host.hidden = true; if (elevationTimer) { clearInterval(elevationTimer); elevationTimer = null; } return; }
    host.hidden = false;

    function tick() {
      var left = Math.max(0, Math.round((e.expires - new Date()) / 1000));
      var t = host.querySelector('.elev-time');
      if (t) t.textContent = ui.fmt.dur(left) + ' left';
      if (left <= 0) A.dropElevation();
    }

    host.appendChild(el('span.elev-glyph', { 'aria-hidden': 'true', text: '▲' }));
    host.appendChild(el('span', [el('strong', { text: e.group }), ' · ', e.reason]));
    host.appendChild(el('span.elev-time', { text: '' }));
    host.appendChild(ui.btn('Release now', { variant: 'ghost', onClick: A.dropElevation }));
    tick();
    if (elevationTimer) clearInterval(elevationTimer);
    elevationTimer = window.setInterval(tick, 1000);
  }
  A.paintElevation = paintElevation;

  /**
   * Open a recorded session in the drawer. The drawer is deliberately never
   * unmounted on navigation: an operator mid-restore should be able to check a
   * dashboard without dropping the shell they are working in.
   */
  A.connect = function (vm, protocol) {
    var proto = protocol.toUpperCase();
    var open = function () {
      var drawer = document.getElementById('drawer');
      drawer.hidden = false;
      document.body.classList.add('has-drawer');
      var body = document.getElementById('drawer-body');
      clear(body);
      var expires = new Date(A.data.now.getTime() + 2 * 3600000);
      body.appendChild(el('div.term', [
        el('div.term-banner', { role: 'status' }, [
          el('span.rec', { 'aria-hidden': 'true' }),
          el('strong', { text: 'Recorded session' }),
          ' · ' + vm.name + ' · ' + proto + ' · expires ' + ui.fmt.stamp(expires),
          el('span.term-reason', { text: 'reason: restore drill' })
        ]),
        el('pre.term-screen', { tabindex: '0', 'aria-label': proto + ' session on ' + vm.name },
          proto === 'SSH'
            ? 'Last login: ' + ui.fmt.stamp(A.data.now) + ' from 10.99.0.14\n' + vm.name + ':~$ '
            : 'Connected to ' + vm.name + ' (' + vm.ip + ')\nOne-time credential issued by OpenBao and never shown.\n\nC:\\Users\\adil> '),
        el('div.term-foot', [
          el('span.muted', { text: 'Clipboard: in only · File transfer: blocked for your role' }),
          ui.btn('Disconnect', {
            variant: 'danger', onClick: function () {
              document.getElementById('drawer').hidden = true;
              document.body.classList.remove('has-drawer');
              A.flash('ok', 'Session ended',
                'The recording is written to argus-sessions and the one-time credential is revoked.');
            }
          })
        ])
      ]));
      A.announce('Recorded ' + proto + ' session opened on ' + vm.name);
    };

    if (!A.data.me.elevation) {
      A.dialog({
        title: 'Elevation required',
        body: function () {
          return [
            el('p', { text: 'Connecting to ' + vm.name + ' needs Tier 1 operator rights, which you do not hold right now.' }),
            el('label.fieldlabel', { for: 'elev-reason', text: 'Reason (recorded in the audit)' }),
            el('input.field', { type: 'text', id: 'elev-reason', value: 'Restore drill', autocomplete: 'off' }),
            el('label.fieldlabel', { for: 'elev-hours', text: 'Duration' }),
            el('select.field', { id: 'elev-hours' }, [
              el('option', { value: '1', text: '1 hour' }),
              el('option', { value: '2', selected: true, text: '2 hours (default)' }),
              el('option', { value: '4', text: '4 hours (maximum)' })
            ]),
            el('p.hint', { text: 'Longer than four hours defeats the point of time-boxing, so the console does not offer it.' })
          ];
        },
        actions: function (close) {
          return [
            ui.btn('Cancel', { variant: 'ghost', onClick: close }),
            ui.btn('Request elevation', {
              variant: 'primary', onClick: function () {
                var reason = document.getElementById('elev-reason').value || 'unspecified';
                var hours = Number(document.getElementById('elev-hours').value);
                close();
                A.requestElevation('Argus-Tier1-Operators', reason, hours, open);
              }
            })
          ];
        }
      });
      return;
    }
    open();
  };

  /* --------------------------------------------------------- shortcuts --- */

  var SHORTCUTS = [
    ['Ctrl/Cmd + K', 'Open the command palette'],
    ['/', 'Focus the filter on the current screen'],
    ['g then o', 'Overview'], ['g then a', 'Applications'], ['g then d', 'Deployments'],
    ['g then c', 'Compute'], ['g then t', 'Data'], ['g then i', 'Identity and secrets'],
    ['g then s', 'Security'], ['g then m', 'ML and geospatial'], ['g then p', 'Operations'],
    ['g then u', 'Audit'],
    ['?', 'This list'], ['Escape', 'Close a dialog, drawer or palette']
  ];

  A.shortcuts = function () {
    A.dialog({
      title: 'Keyboard shortcuts',
      body: function () {
        return el('table.shortcuts', [
          el('caption.sr', { text: 'Keyboard shortcuts' }),
          el('tbody', SHORTCUTS.map(function (s) {
            return el('tr', [el('th', { scope: 'row' }, el('kbd', s[0])), el('td', { text: s[1] })]);
          }))
        ]);
      }
    });
  };

  var GO_KEYS = { o: 'overview', a: 'apps', d: 'deploys', c: 'compute', t: 'data', i: 'identity', s: 'security', m: 'ml', p: 'ops', u: 'audit' };
  var goArmed = false, goTimer = null;

  function isTyping(e) {
    var t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  /* -------------------------------------------------------- drawer nav --- */

  function closeDrawerNav() {
    document.body.classList.remove('navopen');
    var s = document.getElementById('scrim');
    if (s) s.hidden = true;
    var b = document.getElementById('burger');
    if (b) b.setAttribute('aria-expanded', 'false');
  }
  function openDrawerNav() {
    document.body.classList.add('navopen');
    document.getElementById('scrim').hidden = false;
    document.getElementById('burger').setAttribute('aria-expanded', 'true');
    var first = document.querySelector('.side .nav');
    if (first) first.focus();
  }

  /* ------------------------------------------------------------- boot --- */

  function boot() {
    loadPrefs();
    liveNode = document.getElementById('live');
    flashHost = document.getElementById('flashes');
    mount = document.getElementById('main');
    crumbHost = document.getElementById('crumb');

    if (prefs.density === 'compact') document.body.classList.add('is-compact');
    if (prefs.rail) document.body.classList.add('railed');

    document.getElementById('kbar').addEventListener('click', A.palette);
    document.getElementById('envbtn').addEventListener('click', function () {
      A.setEnv(A.state.env === 'production' ? 'staging' : 'production');
    });
    document.getElementById('burger').addEventListener('click', function () {
      document.body.classList.contains('navopen') ? closeDrawerNav() : openDrawerNav();
    });
    document.getElementById('scrim').addEventListener('click', closeDrawerNav);
    document.getElementById('railbtn').addEventListener('click', function () {
      prefs.rail = document.body.classList.toggle('railed');
      savePrefs();
      this.setAttribute('aria-label', prefs.rail ? 'Expand navigation' : 'Collapse navigation');
      A.announce(prefs.rail ? 'Navigation collapsed' : 'Navigation expanded');
    });
    document.getElementById('drawer-close').addEventListener('click', function () {
      document.getElementById('drawer').hidden = true;
      document.body.classList.remove('has-drawer');
    });
    document.getElementById('helpbtn').addEventListener('click', A.shortcuts);
    document.getElementById('bell').addEventListener('click', function () { A.go('security', ['alerts']); });
    document.getElementById('whobtn').addEventListener('click', function () { A.go('identity', ['people']); });

    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); A.palette(); return; }
      if (isTyping(e)) return;
      if (e.key === '?') { e.preventDefault(); A.shortcuts(); return; }
      if (e.key === '/') {
        var f = mount.querySelector('.pf-input, .filter-input');
        if (f) { e.preventDefault(); f.focus(); }
        return;
      }
      if (e.key === 'Escape') { closeDrawerNav(); return; }
      if (goArmed && GO_KEYS[e.key]) { e.preventDefault(); goArmed = false; A.go(GO_KEYS[e.key]); return; }
      if (e.key === 'g') {
        goArmed = true;
        if (goTimer) clearTimeout(goTimer);
        goTimer = window.setTimeout(function () { goArmed = false; }, 1400);
      }
    });

    window.addEventListener('hashchange', render);
    A.setEnv('production');
    paintElevation();
    render();
  }

  A.boot = boot;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
