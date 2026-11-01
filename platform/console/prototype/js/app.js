(function () {
  'use strict';

  var A = (window.ARGUS = window.ARGUS || {});
  var ui = A.ui, el = ui.el, clear = ui.clear, fmt = ui.fmt;

  var prefs = { density: 'comfortable', rail: false, timezone: 'utc', theme: 'system', idleLock: '15' };
  var PREF_VALUES = {
    density: ['comfortable', 'compact'],
    timezone: ['utc', 'local'],
    theme: ['system', 'light', 'dark'],
    idleLock: ['off', '5', '15', '30']
  };
  function loadPrefs() {
    try {
      var raw = window.localStorage.getItem('argus.prefs');
      if (!raw) return;
      var p = JSON.parse(raw);
      if (!p || typeof p !== 'object') return;
      Object.keys(prefs).forEach(function (k) {
        if (!(k in p)) return;
        if (PREF_VALUES[k]) { if (PREF_VALUES[k].indexOf(p[k]) !== -1) prefs[k] = p[k]; }
        else if (typeof p[k] === typeof prefs[k]) prefs[k] = p[k];
      });
    } catch (e) {  }
  }
  function savePrefs() {
    try { window.localStorage.setItem('argus.prefs', JSON.stringify(prefs)); } catch (e) {  }
  }
  A.prefs = function () { return prefs; };

  var darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function resolveTheme() {
    if (prefs.theme === 'light' || prefs.theme === 'dark') return prefs.theme;
    return darkQuery && darkQuery.matches ? 'dark' : 'light';
  }

  function applyTheme() {
    var t = resolveTheme();
    document.documentElement.setAttribute('data-theme', t);
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute('content', t);
    return t;
  }
  A.applyTheme = applyTheme;
  A.resolvedTheme = resolveTheme;

  A.setTheme = function (t) {
    if (PREF_VALUES.theme.indexOf(t) === -1) return;
    prefs.theme = t; savePrefs();
    var resolved = applyTheme();
    A.announce('Theme: ' + (t === 'system' ? 'follows the system, currently ' + resolved : t));
  };

  A.timezone = function () { return prefs.timezone; };
  A.setTimezone = function (tz) {
    if (PREF_VALUES.timezone.indexOf(tz) === -1) return;
    prefs.timezone = tz; savePrefs();
    A.announce('Timestamps now shown in ' + (tz === 'utc' ? 'UTC' : 'local time'));
    render({ keepOverlays: true });
  };

  var liveNode = null;
  A.announce = function (msg) {
    if (!liveNode) return;
    liveNode.textContent = '';
    window.setTimeout(function () { liveNode.textContent = msg; }, 30);
  };

  var flashHost = null;

  var FLASH_MAX = 5;
  var FLASH_TIMEOUT = { ok: 9000, info: 12000, warn: 20000, bad: 30000 };

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
        on: { click: function () { drop(node); } }
      }, '×')
    ]);

    function drop(n) {
      if (n.__flashTimer) { window.clearTimeout(n.__flashTimer); n.__flashTimer = null; }
      n.remove();
    }

    flashHost.appendChild(node);

    while (flashHost.children.length > FLASH_MAX) drop(flashHost.firstChild);

    A.announce(title + (detail ? '. ' + detail : ''));

    var ttl = opts.timeout || (opts.sticky ? 0 : FLASH_TIMEOUT[kind] || FLASH_TIMEOUT.info);
    if (ttl) node.__flashTimer = window.setTimeout(function () { drop(node); }, ttl);
    return node;
  };

  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  function trapFocus(container, onEscape) {
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onEscape(); return; }
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

  var openerStack = [];
  var openDialogs = [];
  A.dialog = function (opts) {
    var opener = document.activeElement;
    if (!opener || opener === document.body) opener = null;
    openerStack.push(opener);
    var titleId = 'dlg-title-' + Math.random().toString(36).slice(2, 8);
    var closeAllowed = !opts.locked;
    function unlockClose() { closeAllowed = true; close(); }

    var closed = false;
    function close() {
      if (closed) return;
      if (opts.locked && !closeAllowed) return;
      closed = true;
      untrap();
      scrim.remove();
      openerStack.pop();
      var ix = openDialogs.indexOf(handle);
      if (ix !== -1) openDialogs.splice(ix, 1);
      if (!openerStack.length) document.body.classList.remove('has-dialog');

      var target = (opener && opener.focus && document.contains(opener)) ? opener : null;
      for (var i = openerStack.length - 1; !target && i >= 0; i--) {
        var candidate = openerStack[i];
        if (candidate && candidate.focus && document.contains(candidate)) target = candidate;
      }
      if (target) target.focus();
    }

    var panel = el('div.dialog' + (opts.wide ? '.wide' : ''), {
      role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId
    }, [
      el('div.dialog-head', [
        el('h2', { id: titleId, tabindex: '-1', text: opts.title }),
        opts.locked ? null : el('button.x', { type: 'button', 'aria-label': 'Close dialog', on: { click: close } }, '×')
      ]),
      el('div.dialog-body', opts.body ? opts.body(opts.locked ? unlockClose : close) : null),
      el('div.dialog-foot', opts.actions ? opts.actions(opts.locked ? unlockClose : close) : ui.btn('Close', { onClick: close }))
    ]);

    var scrim = el('div.scrim.is-dialog' + (opts.locked ? '.is-locked' : ''), {
      on: { mousedown: function (e) { if (e.target === scrim) close(); } }
    }, panel);

    document.body.appendChild(scrim);
    document.body.classList.add('has-dialog');
    var untrap = trapFocus(panel, close);
    panel.querySelector('h2').focus();
    var handle = { close: close, panel: panel, locked: !!opts.locked };
    openDialogs.push(handle);
    return handle;
  };

  A.dismissOverlays = function () {
    var guard = 0;
    while (openDialogs.length && guard++ < 20) {
      var h = openDialogs[openDialogs.length - 1];
      if (h.locked) break;
      try { h.close(); } catch (e) { openDialogs.pop(); }
    }
    if (ui.closeMenus) ui.closeMenus();
  };

  A.confirmDestructive = function (opts) {
    var lockedTitle = 'Type ' + opts.match + ' to enable this';
    var go = ui.btn(opts.confirmLabel || 'Confirm', {
      variant: 'danger',
      disabled: true,
      title: lockedTitle,
      onClick: function () { if (close) { close(); } opts.onConfirm(); }
    });
    var close = null;
    function setReady(ready) {
      go.setDisabled(!ready);
      if (ready) go.removeAttribute('title');
      else go.title = lockedTitle;
    }

    A.dialog({
      title: opts.title,
      body: function () {
        var input = el('input.field', {
          type: 'text', id: 'confirm-name', autocomplete: 'off', spellcheck: 'false',
          'aria-describedby': 'confirm-help',
          on: {
            input: function () { setReady(input.value.trim() === opts.match); },
            keydown: function (e) {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              if (!go.isDisabled()) go.click();
            }
          }
        });
        return [
          el('p', { text: opts.detail }),
          el('div.callout.bad', [
            el('strong', { text: 'Environment: ' + (opts.environment || A.state.env) }),
            opts.blast ? el('p', { text: opts.blast }) : null
          ]),
          el('label.fieldlabel', { for: 'confirm-name', text: 'Type ' + opts.match + ' to confirm' }),
          input,
          el('p.hint', {
            id: 'confirm-help',
            text: opts.reversible || 'This cannot be undone from the console.'
          })
        ];
      },
      actions: function (closeFn) {
        close = closeFn;
        return [ui.btn('Cancel', { variant: 'ghost', onClick: closeFn }), go];
      }
    });
  };

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

  A.state = { env: 'production', route: 'overview', params: {} };

  var RECENT_MAX = 8;
  var recents = [];
  function loadRecents() {
    try {
      var raw = window.localStorage.getItem('argus.recent');
      var list = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(list)) return;
      recents = list.filter(function (r) {
        return r && typeof r === 'object' && typeof r.hash === 'string' && /^#\//.test(r.hash) &&
          typeof r.label === 'string' && r.label.length < 120;
      }).slice(0, RECENT_MAX);
    } catch (e) { recents = []; }
  }
  function saveRecents() {
    try { window.localStorage.setItem('argus.recent', JSON.stringify(recents)); } catch (e) {  }
  }
  function remember(hash, label, kind) {
    if (!hash || !label) return;
    recents = recents.filter(function (r) { return r.hash !== hash; });
    recents.unshift({ hash: hash, label: label, kind: kind || 'Screen', at: Date.now() });
    if (recents.length > RECENT_MAX) recents.length = RECENT_MAX;
    saveRecents();
  }
  A.recents = function () { return recents.slice(); };
  A.forgetRecents = function () { recents = []; saveRecents(); };

  A.me = function () { return String(A.data.me.upn || '').split('@')[0]; };

  A.record = function (action, target, pr, actor, role) {
    var me = A.data.me;
    var system = actor && actor !== A.me();
    var row = {
      at: new Date(A.data.now.getTime()),
      actor: actor || A.me(),
      role: role || (system ? 'System' : (me.elevation ? 'Admin' : (me.role || 'Operator'))),
      action: action,
      target: target,
      pr: pr === undefined ? null : pr,
      ip: system ? '10.30.0.31' : '10.99.0.14'
    };
    A.data.audit.unshift(row);
    return row;
  };

  A.undoable = function (label, undo) {
    var used = false;
    return ui.btn(label || 'Undo', {
      variant: 'ghost',
      onClick: function (e) {
        if (used) return;
        used = true;
        var flash = e && e.target && e.target.closest ? e.target.closest('.flash') : null;
        if (flash) flash.remove();
        undo();
      }
    });
  };

  A.unrecord = function (row) {
    var at = A.data.audit.indexOf(row);
    if (at !== -1) A.data.audit.splice(at, 1);
  };

  var SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
  function sevRank(sev) { return Object.prototype.hasOwnProperty.call(SEV_RANK, sev) ? SEV_RANK[sev] : 9; }

  A.evaluateAlarm = function (alarm) {
    var app = A.data.appByName(alarm.app);
    if (!app) return { state: 'INSUFFICIENT', value: null, text: 'No application called ' + alarm.app + ', so nothing is measured.' };
    var value = alarm.metric === 'errorRate' ? app.errorRate * 100 : app[alarm.metric];
    if (typeof value !== 'number') return { state: 'INSUFFICIENT', value: null, text: 'No ' + alarm.metric + ' is reported for ' + app.display + '.' };
    var hit = alarm.op === '<' ? value < alarm.threshold : value > alarm.threshold;
    var unit = alarm.metric === 'p95' ? ' ms' : alarm.metric === 'errorRate' ? '%' : ' req/s';
    return {
      state: hit ? 'ALARM' : 'OK', value: value, unit: unit,
      text: app.display + ' ' + alarm.metric + ' is ' + ui.fmt.num(value, alarm.metric === 'errorRate' ? 2 : 0) + unit + ', threshold ' + alarm.op + ' ' + alarm.threshold + unit + ' for ' + alarm.forMin + ' min.'
    };
  };

  A.tagEditor = function (resource, label, onDone) {
    var tags = Object.assign({}, resource.tags || {});
    var list = el('div.stack');
    var keyIn = el('input.field', { type: 'text', id: 'tag-key', autocomplete: 'off', spellcheck: 'false', placeholder: 'key, for example cost-centre', maxlength: '40' });
    var valIn = el('input.field', { type: 'text', id: 'tag-value', autocomplete: 'off', spellcheck: 'false', placeholder: 'value', maxlength: '80' });
    function paint() {
      clear(list);
      var keys = Object.keys(tags).sort();
      if (!keys.length) list.appendChild(el('p.muted', { text: 'No tags. Add one below.' }));
      keys.forEach(function (k) {
        list.appendChild(el('div.row', [
          el('span.chip.mono', { text: k + ': ' + tags[k] }),
          el('span.spacer'),
          ui.btn('Remove tag ' + k, { variant: 'ghost', onClick: function () { delete tags[k]; paint(); } })
        ]));
      });
    }
    function add() {
      var k = keyIn.value.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '');
      var v = valIn.value.trim();
      if (!k || !v) { A.announce('A tag needs both a key and a value'); return; }
      if (Object.keys(tags).length >= 20 && !tags[k]) { A.flash('info', 'Twenty tags is the limit', 'Remove one before adding another.'); return; }
      tags[k] = v;
      keyIn.value = ''; valIn.value = '';
      paint();
      keyIn.focus();
    }
    valIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    paint();
    A.dialog({
      title: 'Tags on ' + label,
      body: function () {
        return [
          el('p', { text: 'Tags are free key and value pairs carried in the declaration. Cost is allocated by cost-centre, data-class drives the backup and lock policy, and any tag can be filtered on.' }),
          list,
          el('div.row', [
            el('label.sr', { for: 'tag-key', text: 'Tag key' }), keyIn,
            el('label.sr', { for: 'tag-value', text: 'Tag value' }), valIn,
            ui.btn('Add tag', { variant: 'ghost', onClick: add })
          ]),
          el('p.hint', { text: 'Keys are lower case; letters, digits, dots, colons and dashes. At most twenty tags.' })
        ];
      },
      actions: function (close) {
        return [
          ui.btn('Cancel', { variant: 'ghost', onClick: close }),
          ui.btn('Save tags', {
            variant: 'primary',
            onClick: function () {
              var before = JSON.stringify(resource.tags || {});
              var after = JSON.stringify(tags);
              close();
              if (before === after) { A.announce('Tags unchanged'); return; }
              resource.tags = tags;
              A.record('tags.update', label + ': ' + (Object.keys(tags).map(function (k) { return k + '=' + tags[k]; }).join(', ') || 'no tags'));
              A.flash('ok', 'Tags saved on ' + label, Object.keys(tags).length + ' tag' + (Object.keys(tags).length === 1 ? '' : 's') + '. The change opens as part of the next pull request.', { timeout: 6000 });
              if (onDone) onDone(tags);
            }
          })
        ];
      }
    });
    keyIn.focus();
  };

  A.tagChips = function (resource) {
    var tags = resource.tags || {};
    var keys = Object.keys(tags).sort();
    if (!keys.length) return el('span.muted', { text: 'no tags' });
    return el('div.chips', keys.map(function (k) { return el('span.chip.mono', { text: k + ': ' + tags[k] }); }));
  };

  A.alertOpen = function (a) {
    if (a.state !== 'open') return false;
    if (a.silencedUntil && a.silencedUntil.getTime() > A.data.now.getTime()) return false;
    return true;
  };

  A.needsYou = function () {
    var d = A.data, out = [];
    var me = A.me();
    var freeze = A.freeze();
    if (freeze) {
      out.push({ kind: 'Freeze', tone: 'warn', text: 'A change freeze is in force until ' + ui.fmt.stamp(freeze.until) + ': ' + freeze.reason + '. Production approvals need security sign-off.',
        label: 'Open maintenance', route: 'ops', rest: ['maintenance'] });
    }
    (d.incidents || []).filter(function (i) { return i.state === 'open'; }).forEach(function (i) {
      out.push({ kind: 'Incident', tone: 'bad', text: i.title + ' on ' + i.host + ', ' + i.severity + ', commanded by ' + i.commander + '.',
        label: 'Open ' + i.id, route: 'security', rest: ['incidents'], params: { id: i.id } });
    });
    d.alerts.filter(function (a) { return A.alertOpen(a) && (a.severity === 'critical' || a.severity === 'high'); })
      .sort(function (a, b) { return sevRank(a.severity) - sevRank(b.severity); })
      .forEach(function (a) {
        out.push({ kind: 'Alert', tone: a.severity === 'critical' ? 'bad' : 'warn', text: a.severity + ': ' + a.rule + ' on ' + a.host + ', last seen ' + ui.fmt.ago(a.last) + '.',
          label: 'Open ' + a.id, route: 'security', rest: ['alerts'], params: { id: a.id } });
      });
    d.deployments.filter(function (p) { return p.state === 'awaiting'; }).forEach(function (p) {
      var app = d.appByName(p.app);
      var mine = p.author === me;
      out.push({ kind: 'Deployment', tone: 'info', text: (app ? app.display : p.app) + ' ' + p.version + ' is waiting for approval into ' + p.env + (mine ? ', opened by you, so somebody else must approve it.' : '.'),
        label: 'Review ' + p.id, route: 'deploys', rest: [String(p.id)] });
    });
    d.grants.filter(function (g) { return g.state === 'requested'; }).forEach(function (g) {
      out.push({ kind: 'Grant', tone: 'info', text: g.principal + ' asked to join ' + g.group + ': ' + g.reason + '.',
        label: 'Review ' + g.id, route: 'identity', rest: ['grants'], params: { id: g.id } });
    });
    d.vulns.filter(function (v) { return v.waiver && v.waiver.until < d.now; }).forEach(function (v) {
      out.push({ kind: 'Waiver', tone: 'bad', text: 'The waiver on ' + v.id + ' in ' + v.app + ' expired ' + ui.fmt.ago(v.waiver.until) + '.',
        label: 'Open vulnerabilities', route: 'security', rest: ['vulns'] });
    });
    d.secrets.filter(function (s) { return s.rotatedDays > s.policyDays; }).forEach(function (s) {
      out.push({ kind: 'Secret', tone: 'warn', text: s.path + ' is ' + s.rotatedDays + ' days old against a ' + s.policyDays + ' day policy.',
        label: 'Open ' + s.path, route: 'identity', rest: ['secrets'], params: { path: s.path } });
    });
    d.pipelines.filter(function (p) { return p.state === 'failed'; }).forEach(function (p) {
      out.push({ kind: 'Pipeline', tone: 'bad', text: p.asset + ' failed ' + ui.fmt.ago(p.lastRun) + ' and nothing downstream can refresh.',
        label: 'Open pipelines', route: 'ml', rest: ['pipelines'] });
    });
    (d.alarms || []).forEach(function (alarm) {
      var ev = A.evaluateAlarm(alarm);
      if (ev.state !== 'ALARM') return;
      out.push({ kind: 'Alarm', tone: 'warn', text: alarm.name + ': ' + ev.text,
        label: 'Open ' + alarm.id, route: 'ops', rest: ['alarms'], params: { id: alarm.id } });
    });
    return out;
  };

  A.inbox = function () {
    var items = A.needsYou();
    A.dialog({
      title: items.length ? fmt.num(items.length) + ' thing' + (items.length === 1 ? '' : 's') + ' need' + (items.length === 1 ? 's' : '') + ' you' : 'Nothing needs you',
      wide: true,
      body: function (close) {
        if (!items.length) {
          return ui.emptyState('The inbox is empty',
            'No incident is open, no critical or high alert is unacknowledged, no deployment or grant waits for an approver, no waiver has expired and no secret is past its policy.');
        }
        return el('div.stack.inbox', items.map(function (it) {
          return el('div.row.inbox-row', [
            ui.pill(it.kind, it.tone),
            el('span.inbox-text', { text: it.text }),
            ui.btn(it.label, {
              variant: 'ghost',
              onClick: function () { close(); A.go(it.route, it.rest, it.params); }
            })
          ]);
        }));
      }
    });
  };

  A.refreshBadges = function () {
    var d = A.data;
    paintEnv();
    if (typeof A.refreshAdvisorBadge === 'function') A.refreshAdvisorBadge();
    var open = d.alerts.filter(A.alertOpen).length;
    var awaiting = d.deployments.filter(function (p) { return p.state === 'awaiting'; }).length;
    var needs = A.needsYou().length;
    var alertBadge = document.getElementById('nav-alert-badge');
    var deployBadge = document.getElementById('nav-deploy-badge');
    var bell = document.getElementById('bell');
    if (alertBadge) { alertBadge.textContent = open ? String(open) : ''; alertBadge.hidden = !open; }
    if (deployBadge) { deployBadge.textContent = awaiting ? String(awaiting) : ''; deployBadge.hidden = !awaiting; }
    if (bell) {
      var word = needs ? needs + ' thing' + (needs === 1 ? '' : 's') + ' need' + (needs === 1 ? 's' : '') + ' you, ' + open + ' open alert' + (open === 1 ? '' : 's') : 'Open inbox, nothing needs you';
      bell.setAttribute('aria-label', word);
      bell.title = 'Open inbox';
      var dot = bell.querySelector('.dot');
      if (dot) dot.hidden = !needs;
    }
  };

  var screens = {};
  A.screen = function (id, def) { screens[id] = def; };
  A.screens = screens;

  var leaveHooks = [];
  A.onLeave = function (fn) { if (typeof fn === 'function') leaveHooks.push(fn); };
  function drain(hooks) {
    hooks.forEach(function (fn) {
      try { fn(); } catch (e) { if (window.console) window.console.warn('leave hook failed', e); }
    });
  }
  var routeGen = 0;
  var routeAbort = null;

  A.routeGeneration = function () { return routeGen; };

  A.routeSignal = function () {
    if (typeof window.AbortController !== 'function') return null;
    if (!routeAbort) routeAbort = new window.AbortController();
    return routeAbort.signal;
  };

  function abortRoute() {
    if (!routeAbort) return;
    var ctrl = routeAbort;
    routeAbort = null;
    try { ctrl.abort(); } catch (e) { if (window.console) window.console.warn('route abort failed', e); }
  }

  function runLeaveHooks() {
    var hooks = leaveHooks;
    leaveHooks = [];
    abortRoute();
    routeGen += 1;
    drain(hooks);
  }

  A.scopeLeaveHooks = function (fn) {
    var outer = leaveHooks;
    leaveHooks = [];
    var captured;
    try { fn(); } finally {
      captured = leaveHooks;
      leaveHooks = outer;
    }
    return function () { drain(captured); captured = []; };
  };

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  function parseHash() {
    var h = (window.location.hash || '#/overview').replace(/^#\/?/, '');
    var qi = h.indexOf('?');
    var params = {};
    if (qi !== -1) {
      h.slice(qi + 1).split('&').forEach(function (kv) {
        if (!kv) return;
        var eq = kv.indexOf('=');
        var k = eq === -1 ? kv : kv.slice(0, eq);
        var v = eq === -1 ? '' : kv.slice(eq + 1);
        if (k) params[safeDecode(k)] = safeDecode(v);
      });
      h = h.slice(0, qi);
    }
    var segs = h.split('/').filter(Boolean).map(safeDecode);
    return { route: segs[0] || 'overview', rest: segs.slice(1), params: params };
  }

  A.href = function (route, rest, params) {
    var h = '#/' + encodeURIComponent(route)
      + (rest && rest.length ? '/' + rest.map(function (s) { return encodeURIComponent(String(s)); }).join('/') : '');
    var q = Object.keys(params || {}).filter(function (k) { return params[k] !== null && params[k] !== undefined && params[k] !== ''; });
    if (q.length) h += '?' + q.map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
    return h;
  };
  A.go = function (route, rest, params) {
    var target = A.href(route, rest, params);
    var same = window.location.hash === target;
    window.location.hash = target;
    if (same) render();
  };
  A.link = function (label, route, rest, params, cls) {
    return el('a' + (cls ? '.' + cls : '.rlink'), { href: A.href(route, rest, params) }, label);
  };

  var mount, crumbHost, titleHost;

  function paintCrumb(r, def) {
    clear(crumbHost);
    crumbHost.appendChild(el('a.crumb-link', { href: A.href(r.route), text: def.crumb || def.title }));
    var labels = r.rest.slice();
    if (r.rest.length && typeof def.crumbs === 'function') {
      try { labels = def.crumbs(r.rest) || labels; } catch (e) { labels = r.rest.slice(); }
    }
    if (labels.length) {
      crumbHost.appendChild(el('span.sep', { 'aria-hidden': 'true', text: '/' }));
      crumbHost.appendChild(el('b', { text: labels.join(' / ') }));
    }
    var pageTitle = (labels.length ? labels[labels.length - 1] + ' - ' : '') + (def.title || r.route);
    document.title = pageTitle + ' - Argus Console';
    return pageTitle;
  }

  A.replaceHash = function (target) {
    if (!target || window.location.hash === target) return false;
    try { window.history.replaceState(null, '', target); } catch (e) { return false; }
    var r = parseHash();
    A.state.route = r.route; A.state.rest = r.rest; A.state.params = r.params;
    var def = screens[r.route];
    if (def && crumbHost) paintCrumb(r, def);
    return true;
  };

  A.refresh = function () { render(); };

  function render(opts) {
    opts = opts || {};
    if (window.location.hash && !/^#\//.test(window.location.hash)) return;
    if (!opts.keepOverlays) A.dismissOverlays();
    runLeaveHooks();
    var r = parseHash();
    A.state.route = r.route; A.state.rest = r.rest; A.state.params = r.params;
    var def = screens[r.route];

    document.querySelectorAll('.nav').forEach(function (n) {
      if (n.dataset.go === r.route) n.setAttribute('aria-current', 'page');
      else n.removeAttribute('aria-current');
    });
    paintNavTitles();
    A.refreshBadges();

    clear(mount);
    if (!def) {
      clear(crumbHost);
      crumbHost.appendChild(el('b', { text: 'Not found' }));
      mount.appendChild(ui.emptyState(
        'That screen does not exist',
        'The link may be from an older version of the console.',
        ui.btn('Go to Overview', { variant: 'primary', onClick: function () { A.go('overview'); } })));
      document.title = 'Not found - Argus Console';
      var missTitle = mount.querySelector('.empty-title');
      if (missTitle) { missTitle.tabIndex = -1; missTitle.focus({ preventScroll: true }); }
      window.scrollTo(0, 0);
      A.announce('That screen does not exist');
      closeDrawerNav();
      return;
    }

    var pageTitle = paintCrumb(r, def);

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
    remember(A.href(r.route, r.rest),
      r.rest.length ? (def.title || r.route) + ' / ' + r.rest.join(' / ') : (def.title || r.route),
      r.rest.length ? 'Resource' : 'Screen');
  }

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
    d.deployments.forEach(function (dep) {
      var app = d.appByName(dep.app);
      items.push({
        kind: 'Deployment', label: 'Deployment ' + dep.id + ' · ' + (app ? app.display : dep.app) + ' ' + dep.version,
        hint: dep.state + ' · ' + dep.env, run: function () { A.go('deploys', [String(dep.id)]); }
      });
    });
    d.alerts.forEach(function (a) {
      if (a.state === 'resolved') return;
      items.push({
        kind: 'Alert', label: a.rule, hint: a.id + ' · ' + a.severity + ' · ' + a.host,
        run: function () { A.go('security', ['alerts'], { id: a.id }); }
      });
    });
    d.secrets.forEach(function (sec) {
      items.push({
        kind: 'Secret path', label: sec.path, hint: 'metadata only',
        run: function () { A.go('identity', ['secrets'], { path: sec.path }); }
      });
    });
    d.people.forEach(function (p) {
      items.push({ kind: 'Person', label: p.name, hint: p.upn + ' · Tier ' + p.tier, run: function () { A.go('identity', ['people']); } });
    });
    (d.incidents || []).forEach(function (i) {
      items.push({ kind: 'Incident', label: i.title, hint: i.id + ' · ' + i.state + ' · ' + i.host, run: function () { A.go('security', ['incidents'], { id: i.id }); } });
    });
    (ui.views ? ui.views() : []).forEach(function (v) {
      items.push({ kind: 'Saved view', label: v.name, hint: v.screen, run: function () {
        if (window.location.hash === v.hash) render(); else window.location.hash = v.hash;
      } });
    });
    items.push({ kind: 'Action', label: 'What needs me', hint: 'Inbox', run: function () { A.inbox(); } });
    items.push({ kind: 'Action', label: 'Lock the console', hint: 'Needs your key to resume', run: function () { A.lock('locked by hand'); } });
    items.push({ kind: 'Action', label: 'Switch to ' + (A.state.env === 'production' ? 'staging' : 'production'), hint: 'Environment', run: function () { A.setEnv(A.state.env === 'production' ? 'staging' : 'production'); } });
    items.push({ kind: 'Action', label: 'Toggle compact density', hint: 'Rows per screen', run: function () { A.setDensity(prefs.density === 'compact' ? 'comfortable' : 'compact'); } });
    items.push({ kind: 'Action', label: 'Show keyboard shortcuts', hint: '?', run: function () { A.shortcuts(); } });
    items.push({ kind: 'Action', label: 'Console preferences', hint: 'Theme, timestamps, density', run: function () { A.settings(); } });
    items.push({ kind: 'Action', label: 'Switch to ' + (resolveTheme() === 'dark' ? 'the light theme' : 'the dark theme'), hint: 'Appearance', run: function () { A.setTheme(resolveTheme() === 'dark' ? 'light' : 'dark'); } });
    return items;
  }

  function fuzzy(n, h) {
    if (!n) return 0;
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

  function indexItem(it) {
    it.hay = (it.label + ' ' + (it.hint || '')).toLowerCase();
    return it;
  }

  function liveItemsFrom(payload) {
    var raw = (payload && payload.items) || [];
    var out = [];
    raw.forEach(function (r) {
      if (!r || !r.label || !r.route) return;
      out.push(indexItem({
        kind: r.kind || 'Resource',
        label: String(r.label),
        hint: r.hint ? String(r.hint) : '',
        run: function () { A.go(r.route, r.rest || [], r.params || {}); }
      }));
    });
    return out;
  }

  function liveSourceNote(payload) {
    var sources = (payload && payload.sources) || [];
    var bad = sources.filter(function (s) { return !s.ok; }).map(function (s) { return s.kind; });
    var note = 'Live: ' + ((payload && payload.count) || 0) + ' resource' + (((payload && payload.count) === 1) ? '' : 's') +
      ' from the console API.';
    if (payload && payload.truncated) {
      note += ' Capped at ' + payload.cap + ', so ' + payload.droppedForCap + ' were left out.';
    }
    if (bad.length) note += ' Unreadable: ' + bad.join(', ') + '.';
    return note;
  }

  var paletteOpen = null;

  A.palette = function () {
    if (paletteOpen && paletteOpen.panel && paletteOpen.panel.isConnected) {
      var again = paletteOpen.panel.querySelector('.pal-input');
      if (again) { again.focus(); again.select(); }
      return paletteOpen;
    }
    var items = paletteItems().map(indexItem);
    var results = [], active = 0;

    var input = el('input.pal-input', {
      type: 'text', 'aria-label': 'Search resources, screens and actions',
      placeholder: 'Jump to a resource, screen or action', autocomplete: 'off', spellcheck: 'false',
      role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'pal-list', 'aria-autocomplete': 'list'
    });
    var list = el('ul.pal-list', { id: 'pal-list', role: 'listbox', 'aria-label': 'Results' });
    var count = el('div.pal-count', { 'aria-live': 'polite' });
    var source = el('div.pal-source', {
      text: 'Screens and actions only. Bundled sample resources until the console API answers.'
    });

    var recentItems = A.recents().map(function (r) {
      return indexItem({
        kind: 'Recent', label: r.label, hint: r.kind,
        run: function () { if (window.location.hash === r.hash) render(); else window.location.hash = r.hash; }
      });
    });

    function paint() {
      var q = input.value.trim();
      var LIMIT = 40;
      var best = [];
      if (!q && recentItems.length) {
        results = recentItems.concat(items.filter(function (it) { return it.kind === 'Go to' || it.kind === 'Action'; })).slice(0, LIMIT);
        active = 0;
        clear(list);
        var recFrag = document.createDocumentFragment();
        results.forEach(function (it, i) {
          recFrag.appendChild(el('li.pal-item', {
            role: 'option', id: 'pal-opt-' + i, 'aria-selected': i === 0 ? 'true' : 'false',
            on: { click: function () { run(i); }, mousemove: function () { setActive(i); } }
          }, [
            el('span.pal-kind', { text: it.kind }),
            el('span.pal-label', { text: it.label }),
            it.hint ? el('span.pal-hint', { text: it.hint }) : null
          ]));
        });
        list.appendChild(recFrag);
        count.textContent = recentItems.length + ' recent, then screens and actions. Type to search everything.';
        setActive(0);
        return;
      }
      var lowest = -Infinity;
      var needle = q.toLowerCase();
      for (var ix = 0; ix < items.length; ix++) {
        var sc = q ? fuzzy(needle, items[ix].hay) : 0;
        if (sc < 0) continue;
        if (best.length === LIMIT && sc <= lowest) continue;
        var at = best.length;
        while (at > 0 && best[at - 1].s < sc) at--;
        best.splice(at, 0, { it: items[ix], s: sc });
        if (best.length > LIMIT) best.pop();
        lowest = best[best.length - 1].s;
      }
      results = best.map(function (r) { return r.it; });

      active = 0;
      clear(list);
      var palFrag = document.createDocumentFragment();
      results.forEach(function (it, i) {
        palFrag.appendChild(el('li.pal-item', {
          role: 'option', id: 'pal-opt-' + i, 'aria-selected': i === 0 ? 'true' : 'false',
          on: { click: function () { run(i); }, mousemove: function () { setActive(i); } }
        }, [
          el('span.pal-kind', { text: it.kind }),
          el('span.pal-label', { text: it.label }),
          it.hint ? el('span.pal-hint', { text: it.hint }) : null
        ]));
      });
      list.appendChild(palFrag);
      if (!results.length) list.appendChild(el('li.pal-empty', { text: 'Nothing matches ' + q }));
      count.textContent = results.length + ' result' + (results.length === 1 ? '' : 's');
      setActive(0);
    }

    function setActive(i) {
      if (!results.length) {
        input.removeAttribute('aria-activedescendant');
        return;
      }
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
      body: function () { return el('div.pal', [input, count, source, list]); },
      actions: function (close) {
        return el('div.pal-foot', [
          el('span.kbdhint', [el('kbd', '↑'), el('kbd', '↓'), ' to move ']),
          el('span.kbdhint', [el('kbd', 'Enter'), ' to open ']),
          el('span.kbdhint', [el('kbd', 'Esc'), ' to close']),
          ui.btn('Close', { variant: 'ghost', onClick: close })
        ]);
      }
    });
    paletteOpen = dlg;
    paint();
    input.focus();

    function stillOpen() { return !!(dlg.panel && dlg.panel.isConnected); }

    function mergeLive(env) {
      if (!stillOpen()) return;
      var liveMode = A.MODE ? A.MODE.LIVE : 'live';
      if (!env || env.mode !== liveMode || !env.ok) {
        source.textContent = 'Screens and actions only. ' +
          ((env && env.error && env.error.message) || 'The console API is not answering, so no real resource is listed here.');
        return;
      }
      var live = liveItemsFrom(env.data);
      if (!live.length) {
        source.textContent = liveSourceNote(env.data);
        return;
      }
      var wasActive = active;
      items = items.concat(live);
      source.textContent = liveSourceNote(env.data) + (env.stale ? ' This list is the last one that could be read.' : '');
      paint();
      setActive(wasActive);
    }

    if (typeof A.read === 'function') {
      A.read('/api/search/index', { ttlMs: 30000 }).then(mergeLive, function () {
        if (!stillOpen()) return;
        source.textContent = 'Screens and actions only. The resource index could not be read.';
      });
    }
    return dlg;
  };

  A.freeze = function () {
    var f = A.data.policy && A.data.policy.freeze;
    if (!f) return null;
    if (f.until && f.until.getTime() <= A.data.now.getTime()) return null;
    return f;
  };

  function paintEnv() {
    var env = A.state.env;
    var pill = document.getElementById('envbtn');
    if (!pill) return;
    var frozen = !!A.freeze();
    clear(pill);
    pill.classList.toggle('is-staging', env === 'staging');
    pill.classList.toggle('is-frozen', frozen);
    pill.appendChild(el('span.env-dot', { 'aria-hidden': 'true' }));
    pill.appendChild(el('span', { text: env === 'production' ? 'Production' : 'Staging' }));
    if (frozen) pill.appendChild(el('span.env-freeze', { text: 'Freeze' }));
    pill.setAttribute('aria-label', 'Environment: ' + env + (frozen ? '. A change freeze is in force: ' + A.freeze().reason : '') + '. Activate to switch.');
    pill.title = frozen ? 'Change freeze until ' + ui.fmt.stamp(A.freeze().until) + ': ' + A.freeze().reason : 'Switch between production and staging';
  }
  A.paintEnv = paintEnv;

  A.setEnv = function (env, quiet) {
    A.state.env = env;
    paintEnv();
    if (quiet) return;
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

  var elevationTimer = null;

  A.requestElevation = function (group, reason, hours, onGranted) {
    A.stepUp('Elevating to ' + group + ' needs a second factor.', function () {
      A.data.me.elevation = {
        group: group, reason: reason,
        grantedAt: Date.now(),
        expires: new Date(Date.now() + hours * 3600000)
      };
      var who = A.data.personByUpn(A.me());
      if (who) {
        who.elevated = true;
        who.elevationExpires = new Date(A.data.now.getTime() + hours * 3600000);
      }
      A.record('elevation.request', A.me() + ' to ' + group + ' for ' + hours + ' h: ' + reason);
      paintElevation();
      A.flash('warn', 'Elevated to ' + group,
        'Expires in ' + hours + ' h. Every action while elevated is recorded in the audit.');
      if (onGranted) onGranted();
    });
  };

  A.dropElevation = function () {
    var had = A.data.me.elevation;
    A.data.me.elevation = null;
    var who = A.data.personByUpn(A.me());
    if (who) { who.elevated = false; who.elevationExpires = null; }
    if (had) A.record('elevation.release', A.me() + ' from ' + had.group);
    paintElevation();
    A.flash('ok', 'Elevation released', 'You are back to your standing role.', { timeout: 5000 });
  };

  function paintElevation() {
    var host = document.getElementById('elevation');
    clear(host);
    var e = A.data.me.elevation;
    if (!e) { host.hidden = true; if (elevationTimer) { clearInterval(elevationTimer); elevationTimer = null; } return; }
    host.hidden = false;

    var ENDING_S = 300;
    var MAX_MS = 4 * 3600000;
    function tick() {
      var left = Math.max(0, Math.round((e.expires - new Date()) / 1000));
      var t = host.querySelector('.elev-time');
      if (t) t.textContent = ui.fmt.dur(left) + ' left';
      var ending = left > 0 && left <= ENDING_S;
      if (ending && !e.warned) {
        e.warned = true;
        host.classList.add('is-ending');
        A.flash('warn', 'Elevation ends in ' + ui.fmt.dur(left),
          'Anything still running under ' + e.group + ' fails at the next authorisation check. Extend it or finish up.',
          { timeout: 15000 });
      }
      if (!ending) host.classList.remove('is-ending');
      if (left <= 0) A.dropElevation();
    }

    function extend() {
      var grantedAt = e.grantedAt || (e.expires.getTime() - 2 * 3600000);
      var cap = grantedAt + MAX_MS;
      if (e.expires.getTime() >= cap) {
        A.flash('info', 'Already at the four hour maximum', 'Release this elevation and request a new one with a fresh reason.');
        return;
      }
      A.stepUp('Extending the elevation to ' + e.group + ' needs a second factor.', function () {
        e.expires = new Date(Math.min(cap, e.expires.getTime() + 3600000));
        e.warned = false;
        A.record('elevation.extend', A.me() + ' in ' + e.group + ' until ' + ui.fmt.stamp(e.expires));
        A.flash('ok', 'Elevation extended', 'Now ends ' + ui.fmt.stamp(e.expires) + '. The extension is in the audit.', { timeout: 6000 });
        paintElevation();
      });
    }

    host.appendChild(el('span.elev-glyph', { 'aria-hidden': 'true', text: '▲' }));
    host.appendChild(el('span', [el('strong', { text: e.group }), ' · ', e.reason]));
    host.appendChild(el('span.elev-time', { text: '', 'aria-hidden': 'true' }));
    host.appendChild(ui.btn('Extend 1 h', { variant: 'ghost', title: 'Add an hour, up to four in total, with a second factor', onClick: extend }));
    host.appendChild(ui.btn('Release now', { variant: 'ghost', onClick: A.dropElevation }));

    if (elevationTimer) { clearInterval(elevationTimer); elevationTimer = null; }
    tick();
    if (A.data.me.elevation) elevationTimer = window.setInterval(tick, 1000);
  }
  A.paintElevation = paintElevation;

  A.connect = function (vm, protocol) {
    var proto = protocol.toUpperCase();
    var invokedFrom = document.activeElement;
    var open = function () {
      var drawer = document.getElementById('drawer');
      sessionOpener = invokedFrom && document.contains(invokedFrom) ? invokedFrom : null;
      drawer.hidden = false;
      document.body.classList.add('has-drawer');
      var body = document.getElementById('drawer-body');
      clear(body);
      var elevation = A.data.me.elevation;
      var expires = elevation && elevation.expires instanceof Date
        ? new Date(A.data.now.getTime() + Math.max(0, elevation.expires.getTime() - Date.now()))
        : new Date(A.data.now.getTime() + 2 * 3600000);
      var reason = (elevation && elevation.reason) || 'unspecified';
      var label = proto === 'POWERSHELL' ? 'PowerShell (JEA)' : proto;
      var screenText;
      if (proto === 'SSH') {
        screenText = 'Last login: ' + ui.fmt.stamp(A.data.now) + ' from 10.99.0.14\n' + vm.name + ':~$ ';
      } else if (proto === 'POWERSHELL') {
        screenText = 'Connected to ' + vm.name + ' (' + vm.ip + ') through the constrained JEA endpoint.\n' +
          'Only the cmdlets your role allows are available, and every command is transcribed.\n\n[' + vm.name + ']: PS> ';
      } else if (proto === 'VNC') {
        screenText = 'Hypervisor console attached to ' + vm.name + ' on ' + vm.host + '.\n' +
          'The guest network is not needed for this session.\n\n';
      } else {
        screenText = 'Connected to ' + vm.name + ' (' + vm.ip + ')\nOne-time credential issued by OpenBao and never shown.\n\nC:\\Users\\adil> ';
      }
      A.record('session.start', vm.name + ' (' + label + ', recorded)');
      var startedAt = Date.now();
      var keys = [];
      var prompt = proto === 'SSH' ? vm.name + ':~$ ' : proto === 'POWERSHELL' ? '[' + vm.name + ']: PS> ' : 'C:\\Users\\adil> ';
      var screen = el('pre.term-screen', { tabindex: '0', 'aria-label': label + ' session on ' + vm.name + '. Output of what you type appears here.' }, screenText);
      var line = el('input.term-input', {
        type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off',
        'aria-label': 'Command to send to ' + vm.name + '. Every keystroke is recorded.',
        placeholder: proto === 'VNC' ? 'The hypervisor console takes no typed commands here' : 'Type a command and press Enter. Try help.'
      });
      if (proto === 'VNC') line.disabled = true;
      var MAX_LINES = 400;
      function say(text) {
        screen.textContent += text;
        var lines = screen.textContent.split('\n');
        if (lines.length > MAX_LINES) screen.textContent = lines.slice(lines.length - MAX_LINES).join('\n');
        screen.scrollTop = 1e9;
      }
      line.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        var cmd = line.value.trim();
        if (!cmd) return;
        line.value = '';
        keys.push({ at: Math.round((Date.now() - startedAt) / 1000), text: cmd });
        say(cmd + '\n' + A.terminalAnswer(vm, proto, cmd) + '\n' + prompt);
      });
      function endSession() {
        var durationS = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        var id = 's-' + ((A.data.sessions || []).reduce(function (m, s) { return Math.max(m, Number(String(s.id).replace(/\D/g, '')) || 0); }, 0) + 1);
        A.data.sessions.unshift({
          id: id, user: A.me(), target: vm.name, protocol: label, started: new Date(A.data.now.getTime()),
          duration: durationS, reason: reason, approver: 'self', recorded: true,
          sizeMB: Math.max(1, Math.round(durationS / 4) + keys.length), state: 'closed', keys: keys.slice()
        });
        A.record('session.end', vm.name + ' (' + label + ', ' + keys.length + ' command' + (keys.length === 1 ? '' : 's') + ', recording ' + id + ')');
        A.closeSession();
        A.flash('ok', 'Session ended, recording ' + id + ' sealed',
          keys.length + ' command' + (keys.length === 1 ? '' : 's') + ' recorded to argus-sessions and the one-time credential is revoked.', {
            action: ui.btn('Open the recording', { variant: 'ghost', onClick: function () { A.go('security', ['sessions'], { id: id }); } })
          });
      }
      body.appendChild(el('div.term', [
        el('div.term-banner', { role: 'status' }, [
          el('span.rec', { 'aria-hidden': 'true' }),
          el('strong', { text: 'Recorded session' }),
          ' · ' + vm.name + ' · ' + label + ' · expires ' + ui.fmt.stamp(expires),
          el('span.term-reason', { text: 'reason: ' + reason })
        ]),
        screen,
        el('div.term-line', [el('span.term-prompt', { 'aria-hidden': 'true', text: prompt.trim() }), line]),
        el('div.term-foot', [
          el('span.muted', { text: 'Clipboard: in only · File transfer: blocked for your role · every command is transcribed' }),
          ui.btn('Disconnect', { variant: 'danger', onClick: endSession })
        ])
      ]));
      if (proto !== 'VNC') line.focus();
      A.announce('Recorded ' + label + ' session opened on ' + vm.name);
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

  A.terminalAnswer = function (vm, proto, cmd) {
    var d = A.data;
    var word = cmd.split(/\s+/)[0].toLowerCase();
    var ps = proto === 'POWERSHELL';
    if (word === 'help' || word === 'get-help' || word === '?') {
      return ps
        ? 'Cmdlets allowed for your role on this endpoint:\n  Get-ArgusHealth  Get-Service  Get-Process  Get-Date  Get-EventLog -Newest\nEverything else is refused by the JEA configuration and the refusal is transcribed.'
        : 'Commands in this recorded shell: uptime, df -h, free -m, hostname, date, whoami, systemctl status <unit>, journalctl -n <n>, exit';
    }
    if (word === 'exit' || word === 'logout' || word === 'logoff') return 'Use Disconnect to end the session; the recording is sealed when you do.';
    if (word === 'whoami') return ps ? 'ARGUS\\' + A.me() + ' (JEA virtual account)' : A.me();
    if (word === 'hostname') return vm.name;
    if (word === 'date' || word === 'get-date') return ui.fmt.stamp(new Date(d.now.getTime() + 60000)) + ' (clock of ' + vm.name + ')';
    if (word === 'uptime') return ' 09:15:04 up 41 days,  3:12,  1 user,  load average: 0.' + (vm.vcpu + 11) + ', 0.' + (vm.vcpu + 4) + ', 0.' + vm.vcpu;
    if (word === 'df') return 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda2       240G  ' + (60 + vm.vcpu * 3) + 'G  ' + (170 - vm.vcpu * 3) + 'G  ' + (26 + vm.vcpu) + '% /\n/dev/sdb1       2.0T  1.1T  854G  57% /data';
    if (word === 'free') return '              total        used        free      shared  buff/cache   available\nMem:          ' + (vm.ram * 1024) + '      ' + Math.round(vm.ram * 1024 * 0.54) + '      ' + Math.round(vm.ram * 1024 * 0.21) + '        312      ' + Math.round(vm.ram * 1024 * 0.25) + '      ' + Math.round(vm.ram * 1024 * 0.43);
    if (word === 'systemctl') return '● ' + (cmd.split(/\s+/)[2] || 'unit') + ' - managed service\n     Loaded: loaded\n     Active: active (running) since ' + ui.fmt.stamp(A.time.daysAgo(3)) + '\n   Main PID: 1' + String(vm.vcpu) + '42';
    if (word === 'journalctl') return ui.fmt.stamp(d.now) + ' ' + vm.name + ' systemd[1]: Started session for argus.\n' + ui.fmt.stamp(d.now) + ' ' + vm.name + ' sshd[2211]: Accepted publickey for ' + A.me() + ' from 10.99.0.14';
    if (word === 'get-argushealth') return 'Host    : ' + vm.host + '\nMachine : ' + vm.name + '\nState   : ' + vm.state + '\nReplica : ' + vm.replica + '\nZone    : ' + vm.zone;
    if (word === 'get-service') return 'Status   Name               DisplayName\n------   ----               -----------\nRunning  ArgusAgent         Argus host agent\nRunning  WinRM              Windows Remote Management\nStopped  Spooler            Print Spooler';
    if (word === 'get-process') return ' NPM(K)    PM(M)      WS(M)     CPU(s)     Id  ProcessName\n ------    -----      -----     ------     --  -----------\n    412   ' + (vm.ram * 3) + '.1    ' + (vm.ram * 5) + '.4     812.3   4120  sqlservr\n     88     41.2      72.9       3.1   1' + String(vm.vcpu) + '42  ArgusAgent';
    if (word === 'get-eventlog') return 'Index Time          EntryType   Source                 Message\n----- ----          ---------   ------                 -------\n 9120 ' + ui.fmt.stamp(d.now).slice(5, 16) + ' Information Argus                  Health probe ok';
    if (ps) return 'The term \'' + word + '\' is not allowed on this constrained endpoint. The attempt is transcribed.';
    return word + ': command not found';
  };

  var SHORTCUTS = [
    ['Ctrl/Cmd + K', 'Open the command palette'],
    ['/', 'Focus the filter on the current screen'],
    ['g then o', 'Overview'], ['g then a', 'Applications'], ['g then d', 'Deployments'],
    ['g then c', 'Compute'], ['g then t', 'Data'], ['g then i', 'Identity and secrets'],
    ['g then s', 'Security'], ['g then m', 'ML and geospatial'], ['g then p', 'Operations'],
    ['g then u', 'Audit'], ['g then k', 'Stack'], ['g then y', 'System'],
    ['g then b', 'Object storage'], ['g then l', 'Logs'], ['g then v', 'Advisor'],
    ['?', 'This list'], ['Escape', 'Close a dialog, drawer or palette'],
    ['g then ,', 'Console preferences']
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

  A.settings = function () {
    var groups = [
      {
        key: 'theme', legend: 'Appearance',
        hint: 'Dark is for a bridge call at three in the morning. System follows the machine.',
        options: [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']],
        get: function () { return prefs.theme; },
        set: function (v) { A.setTheme(v); }
      },
      {
        key: 'timezone', legend: 'Timestamps',
        hint: 'UTC is what the logs, the audit trail and the runbooks use. Local time always carries its offset.',
        options: [['utc', 'UTC'], ['local', 'Local time']],
        get: function () { return prefs.timezone; },
        set: function (v) { A.setTimezone(v); }
      },
      {
        key: 'density', legend: 'Density',
        hint: 'Compact fits roughly a third more rows on a 13-inch laptop.',
        options: [['comfortable', 'Comfortable'], ['compact', 'Compact']],
        get: function () { return prefs.density; },
        set: function (v) { A.setDensity(v); }
      },
      {
        key: 'idleLock', legend: 'Lock when idle',
        hint: 'A console left open on a desk is a signed-in session for whoever walks past. Resuming needs your security key.',
        options: [['off', 'Never'], ['5', 'After 5 min'], ['15', 'After 15 min'], ['30', 'After 30 min']],
        get: function () { return prefs.idleLock; },
        set: function (v) { A.setIdleLock(v); }
      }
    ];

    A.dialog({
      title: 'Console preferences',
      body: function () {
        return groups.map(function (g) {
          var uid = g.key + '-' + Math.random().toString(36).slice(2, 7);
          return el('fieldset.prefgroup', [
            el('legend', { text: g.legend }),
            el('div.prefopts', g.options.map(function (o, i) {
              var id = uid + '-' + i;
              return el('label.prefopt', { for: id }, [
                el('input', {
                  type: 'radio', id: id, name: uid, value: o[0],
                  checked: g.get() === o[0] ? true : null,
                  on: { change: function () { g.set(o[0]); } }
                }),
                el('span', { text: o[1] })
              ]);
            })),
            el('p.hint', { text: g.hint })
          ]);
        });
      }
    });
  };

  var GO_KEYS = { o: 'overview', a: 'apps', d: 'deploys', c: 'compute', t: 'data', i: 'identity', s: 'security', m: 'ml', p: 'ops', u: 'audit', k: 'stack', y: 'system', b: 'storage', l: 'logs', v: 'advisor' };
  var goArmed = false, goTimer = null;

  function isTyping(e) {
    var t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  function closeDrawerNav(restoreFocus) {
    var wasOpen = document.body.classList.contains('navopen');
    document.body.classList.remove('navopen');
    var s = document.getElementById('scrim');
    if (s) s.hidden = true;
    var b = document.getElementById('burger');
    if (b) b.setAttribute('aria-expanded', 'false');
    if (wasOpen) paintNavTitles();
    if (wasOpen && restoreFocus && b && document.contains(b)) b.focus();
  }
  function openDrawerNav() {
    document.body.classList.add('navopen');
    document.getElementById('scrim').hidden = false;
    document.getElementById('burger').setAttribute('aria-expanded', 'true');
    paintNavTitles();
    var first = document.querySelector('.side .nav');
    if (first) first.focus();
  }

  var MODE_WORD = { live: 'Live', sample: 'Sample data', stale: 'Stale', down: 'API down', unknown: 'Connecting', signedout: 'Signed out' };

  function paintMode(snap) {
    var pill = document.getElementById('modepill');
    if (!pill) return;
    var key, detail;
    if (snap.mode === 'live' && snap.signedOut) {
      key = 'signedout';
      detail = 'The console API is there but this browser is not signed in. Nothing live can be read until you sign in.';
    } else if (snap.mode === 'live' && snap.stale) {
      key = snap.lastOkAt ? 'stale' : 'down';
      detail = 'The console API answered at first but the last read failed' +
        (snap.lastError && snap.lastError.message ? ': ' + snap.lastError.message : '.') +
        (snap.lastOkAt ? ' Last good read ' + ui.fmt.stamp(new Date(snap.lastOkAt)) + '.' : '');
    } else if (snap.mode === 'live') {
      key = 'live';
      detail = 'Reading the console API. ' + snap.reads + ' read' + (snap.reads === 1 ? '' : 's') + ' this session' +
        (snap.lastOkAt ? ', last at ' + ui.fmt.stamp(new Date(snap.lastOkAt)) : '') + '.';
    } else if (snap.mode === 'sample') {
      key = 'sample';
      detail = (snap.probeError && snap.probeError.message) || 'Bundled sample data. Nothing here has been measured.';
    } else {
      key = 'unknown';
      detail = 'Asking the console API whether it is there.';
    }
    pill.className = 'modepill is-' + key;
    clear(pill);
    pill.appendChild(el('span.mode-dot', { 'aria-hidden': 'true' }));
    pill.appendChild(el('span', { text: MODE_WORD[key] }));
    pill.title = detail;
    pill.setAttribute('aria-label', 'Data source: ' + MODE_WORD[key] + '. ' + detail + ' Activate for the detail.');
    lastSnap = snap;
    lastKey = key;
    lastDetail = detail;
  }

  var lastSnap = null, lastKey = 'unknown', lastDetail = '';

  A.livePanel = function (title, path, render, opts) {
    opts = opts || {};
    var body = el('div');
    var card = ui.card(title, body, opts.card || {});
    var alive = true;
    A.onLeave(function () { alive = false; });
    body.appendChild(ui.skeleton(opts.skeletonRows || 3));
    A.read(path, { ttlMs: opts.ttlMs === undefined ? 15000 : opts.ttlMs }).then(function (env) {
      if (!alive) return;
      ui.clear(body);
      if (env.mode === A.MODE.SAMPLE) {
        if (opts.sample) { opts.sample(body); return; }
        body.appendChild(ui.emptyState(
          opts.sampleTitle || 'Not available on sample data',
          opts.sampleDetail || 'This panel reads the console API. Open the console the API serves and sign in to read it.'));
        return;
      }
      if (!env.ok) {
        var e = env.error || {};
        if (e.reason === 'unauthenticated') {
          body.appendChild(ui.emptyState('Sign in to read this', 'The console API answers only to a signed-in operator.'));
          return;
        }
        if (e.reason === 'not-configured' && opts.notConfigured) { opts.notConfigured(body, e); return; }
        body.appendChild(ui.errorState(
          opts.errorTitle || 'This could not be read',
          e.message || 'The request failed.',
          function () { A.forget(path); A.refresh(); }));
        return;
      }
      if (env.stale) {
        body.appendChild(el('div.callout.warn', [
          el('strong', { text: 'Showing the last value that could be read.' }),
          el('p', { text: 'A fresh read failed' + (env.error && env.error.message ? ': ' + env.error.message : '.') +
            ' The figures below are from ' + ui.fmt.stamp(new Date(env.at)) + '.' })
        ]));
      }
      render(body, env.data, env);
    });
    return card;
  };

  A.whenProbed = function (fn) {
    var alive = true;
    A.onLeave(function () { alive = false; });
    return A.probe().then(function (snap) { if (alive) fn(A.storeMode(), snap); });
  };

  A.sampleNotice = function (what, detail) {
    return el('div.callout.info', { 'data-sample-notice': what || '' }, [
      el('strong', { text: 'Sample data.' }),
      el('p', { text: (what ? what + ' ' : 'What is below ') + 'comes from the bundled sample dataset, not from this stack.' +
        (detail ? ' ' + detail : '') })
    ]);
  };

  A.notInStack = function (what, detail) {
    return el('div.callout.info', { 'data-not-in-stack': what || '' }, [
      el('strong', { text: 'Not in this stack.' }),
      el('p', { text: what + ' ' + (detail || 'has no source the console can read here, so nothing is shown rather than a figure nobody measured.') })
    ]);
  };

  A.dataSource = function () {
    var snap = lastSnap || (typeof A.storeHealth === 'function' ? A.storeHealth() : null) || {};
    var stampOf = function (t) { return t ? ui.fmt.stamp(new Date(t)) : 'never'; };
    A.dialog({
      title: 'Data source: ' + MODE_WORD[lastKey],
      body: function () {
        return [
          el('p', { text: lastDetail }),
          ui.dl([
            ['Mode', snap.mode || 'unknown'],
            ['Probed', stampOf(snap.probedAt)],
            ['Last good read', stampOf(snap.lastOkAt)],
            ['Last failed read', stampOf(snap.lastFailAt)],
            ['Reads this session', ui.fmt.num(snap.reads || 0)],
            ['Failures this session', ui.fmt.num(snap.failures || 0)],
            ['Last error', snap.lastError && snap.lastError.message ? snap.lastError.message : (snap.probeError && snap.probeError.message) || 'none']
          ]),
          el('p.hint', {
            text: snap.mode === 'live'
              ? 'Every figure on a live screen was read from the console API at the time shown on that screen. A stale read is shown with a warning on the panel it belongs to.'
              : 'Nothing on a sample screen has been measured. Start the console API and open the console it serves to read the estate.'
          })
        ];
      },
      actions: function (close) {
        var out = [ui.btn('Close', { variant: 'ghost', onClick: close })];
        if (snap.auth && snap.auth.authenticated) {
          out.push(ui.btn('Sign out', { variant: 'ghost', onClick: function () { close(); A.signOutNow(); } }));
        } else if (snap.mode === 'live' && snap.signedOut) {
          out.push(ui.btn('Sign in', { variant: 'primary', onClick: function () { close(); A.signInDialog(); } }));
        }
        if (A.state.route !== 'system') {
          out.push(ui.btn('Open the System screen', { variant: 'primary', onClick: function () { close(); A.go('system'); } }));
        } else {
          out.push(ui.btn('Re-read everything', {
            variant: 'primary',
            onClick: function () { close(); if (typeof A.forget === 'function') A.forget(); render(); }
          }));
        }
        return out;
      }
    });
  };

  var signInHandle = null;

  function initialsOf(name) {
    var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }

  var sampleMe = null;

  function paintWho(snap) {
    var who = document.getElementById('whobtn');
    if (!who) return;
    var avatar = who.querySelector('.avatar');
    var name = who.querySelector('.who-text b');
    var role = who.querySelector('.who-text span');
    if (!sampleMe) sampleMe = { name: A.data.me.name, upn: A.data.me.upn, text: role ? role.textContent : '' };
    var principal = snap.auth && snap.auth.authenticated ? snap.auth.principal : null;
    if (principal) {
      A.data.me.name = principal.displayName || principal.subject;
      A.data.me.upn = principal.subject;
      if (avatar) avatar.textContent = initialsOf(A.data.me.name);
      if (name) name.textContent = A.data.me.name;
      if (role) role.textContent = principal.roles && principal.roles.length ? principal.roles.join(' · ') : 'Operator';
      who.title = 'Signed in as ' + principal.subject;
    } else {
      A.data.me.name = sampleMe.name;
      A.data.me.upn = sampleMe.upn;
      if (avatar) avatar.textContent = initialsOf(sampleMe.name);
      if (name) name.textContent = sampleMe.name;
      if (role) role.textContent = sampleMe.text;
      who.title = '';
    }
  }

  A.signInDialog = function () {
    if (signInHandle) return signInHandle;
    if (typeof A.signIn !== 'function') return null;
    var subject = el('input.field', { type: 'text', id: 'signin-subject', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', placeholder: 'operator' });
    var password = el('input.field', { type: 'password', id: 'signin-password', autocomplete: 'current-password' });
    var error = el('p.form-error', { id: 'signin-error', role: 'alert', hidden: true });
    var busy = false;
    var go;

    function fail(err) {
      busy = false;
      if (go) go.setDisabled(false);
      error.hidden = false;
      var text = (err && err.message) || 'Sign-in failed.';
      if (err && err.retryAfter) text += ' Try again in ' + err.retryAfter + ' seconds.';
      error.textContent = text;
      password.value = '';
      password.focus();
    }

    function submit(close) {
      if (busy) return;
      var s = subject.value.trim();
      if (!s || !password.value) {
        error.hidden = false;
        error.textContent = 'Enter the operator name and the password.';
        (s ? password : subject).focus();
        return;
      }
      busy = true;
      if (go) go.setDisabled(true);
      error.hidden = true;
      A.signIn(s, password.value).then(function (auth) {
        signInHandle = null;
        close();
        var who = auth && auth.principal ? (auth.principal.displayName || auth.principal.subject) : s;
        A.announce('Signed in as ' + who);
        A.flash('ok', 'Signed in', 'Reading the console API as ' + who + '.');
        A.refresh();
      }, fail);
    }

    function onKey(close) {
      return function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(close); } };
    }

    signInHandle = A.dialog({
      title: 'Sign in to the console',
      locked: true,
      body: function (close) {
        subject.addEventListener('keydown', onKey(close));
        password.addEventListener('keydown', onKey(close));
        return [
          el('p', { text: 'This console is served by the Argus API, which answers only to a signed-in operator. Use the operator name and password from the stack bootstrap.' }),
          el('label.fieldlabel', { for: 'signin-subject', text: 'Operator' }), subject,
          el('label.fieldlabel', { for: 'signin-password', text: 'Password' }), password,
          error,
          el('p.hint', { text: 'Five failed attempts lock the operator for a while. The session ends after thirty minutes idle or eight hours in all.' })
        ];
      },
      actions: function (close) {
        go = ui.btn('Sign in', { variant: 'primary', onClick: function () { submit(close); } });
        return [
          ui.btn('Browse sample data instead', {
            variant: 'ghost',
            onClick: function () {
              signInHandle = null;
              close();
              if (typeof A.useSample === 'function') A.useSample('signed-out');
              A.announce('Showing sample data');
              A.refresh();
            }
          }),
          go
        ];
      }
    });
    window.setTimeout(function () { subject.focus(); }, 0);
    return signInHandle;
  };

  A.signOutNow = function () {
    if (typeof A.signOut !== 'function') return;
    A.signOut().then(function () {
      A.announce('Signed out');
      A.flash('info', 'Signed out', 'The console API session has ended.');
      A.refresh();
    });
  };

  var narrowQuery = window.matchMedia ? window.matchMedia('(max-width: 1200px)') : null;

  function paintNavTitles() {
    var collapsed = document.body.classList.contains('railed') || !!(narrowQuery && narrowQuery.matches);
    var drawerOpen = document.body.classList.contains('navopen');
    document.querySelectorAll('.side .nav').forEach(function (n) {
      var lbl = n.querySelector('.lbl');
      if (!lbl) return;
      if (collapsed && !drawerOpen) n.title = lbl.textContent.trim();
      else n.removeAttribute('title');
    });
  }
  A.paintNavTitles = paintNavTitles;

  var sessionOpener = null;

  A.isSessionOpen = function () {
    var d = document.getElementById('drawer');
    return !!d && !d.hidden;
  };

  A.closeSession = function () {
    var drawer = document.getElementById('drawer');
    if (!drawer || drawer.hidden) return false;
    drawer.hidden = true;
    document.body.classList.remove('has-drawer');
    ui.clear(document.getElementById('drawer-body'));
    if (sessionOpener && sessionOpener.focus && document.contains(sessionOpener)) sessionOpener.focus();
    sessionOpener = null;
    return true;
  };

  var idleTimer = null;
  var lockHandle = null;

  function idleMs() {
    var n = Number(prefs.idleLock);
    return isFinite(n) && n > 0 ? n * 60000 : 0;
  }

  function armIdle() {
    if (idleTimer) { window.clearTimeout(idleTimer); idleTimer = null; }
    var ms = idleMs();
    if (!ms || lockHandle) return;
    idleTimer = window.setTimeout(function () { idleTimer = null; A.lock('idle for ' + prefs.idleLock + ' min'); }, ms);
  }

  A.setIdleLock = function (v) {
    if (PREF_VALUES.idleLock.indexOf(v) === -1) return;
    prefs.idleLock = v; savePrefs();
    armIdle();
    A.announce(v === 'off' ? 'The console will not lock on its own' : 'The console locks after ' + v + ' minutes idle');
  };

  A.isLocked = function () { return !!lockHandle; };

  A.lock = function (why) {
    if (lockHandle) return lockHandle;
    if (idleTimer) { window.clearTimeout(idleTimer); idleTimer = null; }
    A.dismissOverlays();
    A.closeSession();
    document.body.classList.add('is-locked');
    A.record('session.lock', why || 'locked');
    var sinceAt = new Date();
    lockHandle = A.dialog({
      title: 'Console locked',
      locked: true,
      body: function () {
        return [
          el('div.stepup-key', { 'aria-hidden': 'true', text: '🔒' }),
          el('p', { text: 'Locked ' + (why || 'by hand') + ' at ' + ui.fmt.stamp(sinceAt) + '. Nothing behind this dialog can be read or pressed until you resume with your security key.' }),
          el('p.hint', { text: 'The session itself has not ended: an elevation keeps counting down, and a deployment in flight keeps rolling.' })
        ];
      },
      actions: function (close) {
        return [ui.btn('Resume with security key', {
          variant: 'primary',
          onClick: function () {
            lockHandle = null;
            document.body.classList.remove('is-locked');
            A.record('session.unlock', A.me());
            close();
            A.announce('Console unlocked');
            armIdle();
          }
        })];
      }
    });
    A.announce('Console locked. Resume with your security key.');
    return lockHandle;
  };

  function boot() {
    loadPrefs();
    loadRecents();
    applyTheme();
    if (darkQuery) {
      var onSchemeChange = function () { if (prefs.theme === 'system') applyTheme(); };
      if (darkQuery.addEventListener) darkQuery.addEventListener('change', onSchemeChange);
      else if (darkQuery.addListener) darkQuery.addListener(onSchemeChange);
    }
    liveNode = document.getElementById('live');
    flashHost = document.getElementById('flashes');
    mount = document.getElementById('main');
    crumbHost = document.getElementById('crumb');

    if (prefs.density === 'compact') document.body.classList.add('is-compact');
    if (prefs.rail) document.body.classList.add('railed');

    document.querySelector('.side').addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('.nav[data-go]');
      if (!btn) return;
      e.preventDefault();
      A.go(btn.dataset.go);
    });

    document.getElementById('kbar').addEventListener('click', A.palette);
    document.getElementById('envbtn').addEventListener('click', function () {
      A.setEnv(A.state.env === 'production' ? 'staging' : 'production');
    });
    document.getElementById('burger').addEventListener('click', function () {
      document.body.classList.contains('navopen') ? closeDrawerNav(true) : openDrawerNav();
    });
    document.getElementById('scrim').addEventListener('click', function () { closeDrawerNav(true); });
    var railBtn = document.getElementById('railbtn');
    railBtn.setAttribute('aria-label', prefs.rail ? 'Expand navigation' : 'Collapse navigation');
    railBtn.addEventListener('click', function () {
      prefs.rail = document.body.classList.toggle('railed');
      savePrefs();
      this.setAttribute('aria-label', prefs.rail ? 'Expand navigation' : 'Collapse navigation');
      paintNavTitles();
      A.announce(prefs.rail ? 'Navigation collapsed' : 'Navigation expanded');
    });
    if (narrowQuery) {
      if (narrowQuery.addEventListener) narrowQuery.addEventListener('change', paintNavTitles);
      else if (narrowQuery.addListener) narrowQuery.addListener(paintNavTitles);
    }
    paintNavTitles();
    document.getElementById('drawer-close').addEventListener('click', A.closeSession);
    document.getElementById('helpbtn').addEventListener('click', A.shortcuts);
    document.getElementById('prefsbtn').addEventListener('click', A.settings);
    document.getElementById('bell').addEventListener('click', function () { A.inbox(); });
    var modePill = document.getElementById('modepill');
    if (modePill) {
      modePill.addEventListener('click', function () { A.dataSource(); });
      if (typeof A.watchStore === 'function') {
        A.watchStore(paintMode);
        A.watchStore(function (snap) {
          paintWho(snap);
          if (snap.mode === 'live' && snap.signedOut) A.signInDialog();
        });
      }
      if (typeof A.probe === 'function') A.probe();
    }
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
      if (e.key === 'Escape') { if (!A.closeSession()) closeDrawerNav(true); return; }
      if (goArmed && e.key === ',') { e.preventDefault(); goArmed = false; A.settings(); return; }
      if (goArmed && GO_KEYS[e.key]) { e.preventDefault(); goArmed = false; A.go(GO_KEYS[e.key]); return; }
      if (e.key === 'g') {
        goArmed = true;
        if (goTimer) clearTimeout(goTimer);
        goTimer = window.setTimeout(function () { goArmed = false; }, 1400);
      }
    });

    window.addEventListener('hashchange', function () { render(); });
    ['keydown', 'pointerdown', 'hashchange', 'focus'].forEach(function (name) {
      window.addEventListener(name, function () { if (!lockHandle) armIdle(); }, true);
    });
    armIdle();
    A.setEnv('production', true);
    paintElevation();
    render();
  }

  A.boot = boot;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
