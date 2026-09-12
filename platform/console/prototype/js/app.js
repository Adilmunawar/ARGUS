/* Argus Console: the shell.
 *
 * Routing, the command palette, the flash bar, dialogs and focus management,
 * the session drawer, elevation state, and the preferences that persist.
 *
 * Design notes worth keeping in the code rather than a wiki:
 *
 *  - Every screen is a hash route, so every resource has a link somebody can
 *    paste into an alert or a runbook.
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
  var prefs = { density: 'comfortable', rail: false, timezone: 'utc', theme: 'light' };
  var PREF_VALUES = {
    density: ['comfortable', 'compact'],
    timezone: ['utc', 'local'],
    theme: ['system', 'light', 'dark']
  };
  function loadPrefs() {
    try {
      var raw = window.localStorage.getItem('argus.prefs');
      if (!raw) return;
      var p = JSON.parse(raw);
      if (!p || typeof p !== 'object') return;
      // Only known keys with known values are taken: localStorage is writable
      // by anything else served from this origin, and a junk value for density
      // would put the shell into a class that no stylesheet defines.
      Object.keys(prefs).forEach(function (k) {
        if (!(k in p)) return;
        if (PREF_VALUES[k]) { if (PREF_VALUES[k].indexOf(p[k]) !== -1) prefs[k] = p[k]; }
        else if (typeof p[k] === typeof prefs[k]) prefs[k] = p[k];
      });
    } catch (e) { /* private window, cleared storage, or blocked: use defaults */ }
  }
  function savePrefs() {
    try { window.localStorage.setItem('argus.prefs', JSON.stringify(prefs)); } catch (e) { /* not fatal */ }
  }
  A.prefs = function () { return prefs; };

  /* ------------------------------------------------------------- theme --- */

  // 'system' is resolved here rather than in a second copy of every token
  // under prefers-color-scheme: the console is a JavaScript application, so
  // the cheaper and less duplicative place to decide is one attribute on
  // <html>. The media query is still watched, so a machine that flips to dark
  // at sunset takes the console with it without a reload.
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

  /* ---------------------------------------------------------- timezone --- */

  // Times are formatted through ui.fmt, so one hook here reaches every screen.
  A.timezone = function () { return prefs.timezone; };
  A.setTimezone = function (tz) {
    if (PREF_VALUES.timezone.indexOf(tz) === -1) return;
    prefs.timezone = tz; savePrefs();
    A.announce('Timestamps now shown in ' + (tz === 'utc' ? 'UTC' : 'local time'));
    // Timestamps are formatted at build time by ui.fmt, so the screen does have
    // to be rebuilt -- but the dialog this was chosen in stays open.
    render({ keepOverlays: true });
  };

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

  /*
   * Notifications expire, and the bar has a ceiling.
   *
   * A default expiry rather than clearing on navigation, because an action
   * that navigates should still be able to tell you it worked. Bad news gets
   * longer than good news; anything that must persist passes sticky.
   */
  var FLASH_MAX = 5;
  var FLASH_TIMEOUT = { ok: 9000, info: 12000, warn: 20000, bad: 30000 };

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
        on: { click: function () { drop(node); } }
      }, '×')
    ]);

    // A pending expiry timer holds a reference to its node, so it is cancelled
    // on removal to release the node immediately.
    function drop(n) {
      if (n.__flashTimer) { window.clearTimeout(n.__flashTimer); n.__flashTimer = null; }
      n.remove();
    }

    flashHost.appendChild(node);

    // Oldest first, so the bar never grows past the ceiling however many
    // actions an operator fires during an incident.
    while (flashHost.children.length > FLASH_MAX) drop(flashHost.firstChild);

    A.announce(title + (detail ? '. ' + detail : ''));

    var ttl = opts.timeout || (opts.sticky ? 0 : FLASH_TIMEOUT[kind] || FLASH_TIMEOUT.info);
    if (ttl) node.__flashTimer = window.setTimeout(function () { drop(node); }, ttl);
    return node;
  };

  /* ----------------------------------------------------- focus + modal --- */

  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  function trapFocus(container, onEscape) {
    function onKey(e) {
      // stopPropagation matters as much as preventDefault here: without it the
      // same keydown reaches the document handler, which reads Escape as
      // "close the recorded session".
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

  /**
   * A modal dialog. Returns nothing; call close() from inside.
   * opts: {title, body(close), actions(close) -> [nodes], describedBy, wide}
   * Focus is trapped, Escape closes, and focus returns to whatever opened it.
   */
  var openerStack = [];
  var openDialogs = [];
  A.dialog = function (opts) {
    /*
     * The opener is whatever actually held focus, always. Ctrl+K and ? are not
     * suppressed while a dialog is up, so a dialog can open over another that
     * stays open; capturing the real activeElement means focus returns into
     * whatever is still on screen. When the opener is gone from the document
     * by close time, close() falls back down the stack to the nearest opener
     * that survived.
     */
    var opener = document.activeElement;
    if (!opener || opener === document.body) opener = null;
    openerStack.push(opener);
    var titleId = 'dlg-title-' + Math.random().toString(36).slice(2, 8);

    var closed = false;
    function close() {
      // Idempotent: navigation dismisses overlays, and the dialog that caused
      // the navigation may already have closed itself on the way out. Popping
      // the opener stack twice for one dialog corrupts the opener of the next.
      if (closed) return;
      closed = true;
      untrap();
      scrim.remove();
      openerStack.pop();
      var ix = openDialogs.indexOf(handle);
      if (ix !== -1) openDialogs.splice(ix, 1);
      if (!openerStack.length) document.body.classList.remove('has-dialog');

      // Restore to this dialog's own opener when it is still in the document.
      // When it is not -- because the dialog that held it has itself closed --
      // walk down the remaining stack to the nearest opener that survived,
      // rather than dropping focus on <body>.
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
    var handle = { close: close, panel: panel };
    openDialogs.push(handle);
    return handle;
  };

  /**
   * Close every open overlay. A dialog and an overflow menu both outlive the
   * screen that opened them: the scrim and the menu are mounted on <body>,
   * not inside main, so navigation has to dismiss them explicitly.
   */
  A.dismissOverlays = function () {
    var guard = 0;
    while (openDialogs.length && guard++ < 20) {
      var h = openDialogs[openDialogs.length - 1];
      try { h.close(); } catch (e) { openDialogs.pop(); }
    }
    if (ui.closeMenus) ui.closeMenus();
  };

  /**
   * The delete ladder, step three: an irreversible action that requires the
   * operator to type the resource name. Used for anything that cannot be undone
   * by a revert commit.
   */
  A.confirmDestructive = function (opts) {
    var go = ui.btn(opts.confirmLabel || 'Confirm', {
      variant: 'danger',
      disabled: true,
      title: 'Type ' + opts.match + ' to enable this',
      onClick: function () { if (close) { close(); } opts.onConfirm(); }
    });
    var close = null;

    A.dialog({
      title: opts.title,
      body: function () {
        var input = el('input.field', {
          type: 'text', id: 'confirm-name', autocomplete: 'off', spellcheck: 'false',
          'aria-describedby': 'confirm-help',
          on: {
            input: function () { go.setDisabled(input.value.trim() !== opts.match); }
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
          /* The ladder is for anything that repoints live traffic, not only
             for the irreversible -- so a caller that CAN undo its action says
             so rather than being made to contradict its own detail text. */
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

  // Anything a screen starts that outlives a single paint (a timer, an
  // interval, a listener on document) is registered here and torn down on the
  // next navigation.
  var leaveHooks = [];
  A.onLeave = function (fn) { if (typeof fn === 'function') leaveHooks.push(fn); };
  function drain(hooks) {
    hooks.forEach(function (fn) {
      try { fn(); } catch (e) { if (window.console) window.console.warn('leave hook failed', e); }
    });
  }
  function runLeaveHooks() {
    var hooks = leaveHooks;
    leaveHooks = [];
    drain(hooks);
  }

  /**
   * Run fn, capturing anything it registers with onLeave, and hand back a
   * teardown for just that work. Switching a tab does not navigate, so a
   * panel's timers and listeners are torn down here rather than waiting for
   * the next route change.
   */
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

  /**
   * decodeURIComponent throws URIError on a malformed escape such as "%" or
   * "%zz", and parseHash runs on every hashchange, before the try/catch that
   * guards a screen's render. Decode defensively and keep the raw text when
   * it cannot be decoded.
   */
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
        // Split on the first '=' only: a value such as a base64 filter
        // ("q=YWRtaW4=") may legitimately contain one.
        var eq = kv.indexOf('=');
        var k = eq === -1 ? kv : kv.slice(0, eq);
        var v = eq === -1 ? '' : kv.slice(eq + 1);
        if (k) params[safeDecode(k)] = safeDecode(v);
      });
      h = h.slice(0, qi);
    }
    // Path segments are encoded by A.href, so they are decoded here.
    var segs = h.split('/').filter(Boolean).map(safeDecode);
    return { route: segs[0] || 'overview', rest: segs.slice(1), params: params };
  }

  /** Build a hash link. go('apps', ['mills'], {tab:'logs'}) */
  A.href = function (route, rest, params) {
    // Segments are encoded so that parseHash can decode them symmetrically.
    var h = '#/' + encodeURIComponent(route)
      + (rest && rest.length ? '/' + rest.map(function (s) { return encodeURIComponent(String(s)); }).join('/') : '');
    var q = Object.keys(params || {}).filter(function (k) { return params[k] !== null && params[k] !== undefined && params[k] !== ''; });
    if (q.length) h += '?' + q.map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
    return h;
  };
  /**
   * Navigate, and re-render even when the destination is where we already are.
   *
   * location.hash only fires hashchange when the value changes, so same-route
   * navigation (Refresh, Try again) re-renders explicitly. Assign first: that
   * writes the history entry the back button needs.
   */
  A.go = function (route, rest, params) {
    var target = A.href(route, rest, params);
    var same = window.location.hash === target;
    window.location.hash = target;
    if (same) render();
  };
  /** An anchor that routes. Real hrefs, so middle-click and copy-link work. */
  A.link = function (label, route, rest, params, cls) {
    return el('a' + (cls ? '.' + cls : '.rlink'), { href: A.href(route, rest, params) }, label);
  };

  var mount, crumbHost, titleHost;

  /**
   * Build the screen the hash names.
   *
   * opts.keepOverlays re-renders in place without dismissing what is open:
   * a preference change is not a navigation, and the dialog it was made in
   * stays open.
   */
  function render(opts) {
    opts = opts || {};
    // An in-page anchor such as the skip link sets a hash that is not a route.
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

    clear(mount);
    if (!def) {
      /* The not-found state gets the same treatment as any other screen. */
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
    items.push({ kind: 'Action', label: 'Console preferences', hint: 'Theme, timestamps, density', run: function () { A.settings(); } });
    items.push({ kind: 'Action', label: 'Switch to ' + (resolveTheme() === 'dark' ? 'the light theme' : 'the dark theme'), hint: 'Appearance', run: function () { A.setTheme(resolveTheme() === 'dark' ? 'light' : 'dark'); } });
    return items;
  }

  /** Subsequence match, the behaviour people expect from a palette. */
  /* `hay` arrives already lowercased. */
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

  A.palette = function () {
    var items = paletteItems();
    // One lowercased haystack per item, built once per open instead of twice
    // per item per keystroke.
    items.forEach(function (it) {
      it.hay = (it.label + ' ' + (it.hint || '')).toLowerCase();
    });
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
      /*
       * Score, keep the best forty, and never sort the whole inventory.
       *
       * The haystack is precomputed once per open (see paletteItems), and the
       * top forty are kept by insertion into a small ordered list, so the cost
       * is one pass and a bounded insert rather than an n log n sort.
       */
      var LIMIT = 40;
      var best = [];
      var lowest = -Infinity;
      for (var ix = 0; ix < items.length; ix++) {
        var sc = q ? fuzzy(q, items[ix].hay) : 0;
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
      // Built detached and attached once, rather than forty live insertions.
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
        // With nothing to point at, a leftover aria-activedescendant still
        // names an option id that has just been removed from the list, and a
        // screen reader goes on announcing the last match as selected while
        // the visible list reads "Nothing matches".
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

  /**
   * Set the environment. `quiet` paints the pill without announcing a change
   * or re-rendering; boot passes it so the first load neither announces an
   * environment the operator did not choose nor renders twice.
   */
  A.setEnv = function (env, quiet) {
    A.state.env = env;
    var pill = document.getElementById('envbtn');
    clear(pill);
    pill.classList.toggle('is-staging', env === 'staging');
    pill.appendChild(el('span.env-dot', { 'aria-hidden': 'true' }));
    pill.appendChild(el('span', { text: env === 'production' ? 'Production' : 'Staging' }));
    pill.setAttribute('aria-label', 'Environment: ' + env + '. Activate to switch.');
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

  /* ----------------------------------------------- elevation + sessions --- */

  var elevationTimer = null;

  A.requestElevation = function (group, reason, hours, onGranted) {
    A.stepUp('Elevating to ' + group + ' needs a second factor.', function () {
      A.data.me.elevation = {
        group: group, reason: reason,
        // Wall clock, not the fixed demo clock: tick() counts against the real
        // time.
        expires: new Date(Date.now() + hours * 3600000)
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
    /* The banner is role="status", so anything that rewrites its text is
       re-announced. The countdown changes once a minute for hours and then
       once a second for the final minute, which reads the whole banner over
       whatever the operator is doing. aria-hidden on the ticking part leaves
       the grant and the group announced once, as intended, and the remaining
       time reachable visually and from the Release button's own label. */
    host.appendChild(el('span.elev-time', { text: '', 'aria-hidden': 'true' }));
    host.appendChild(ui.btn('Release now', { variant: 'ghost', onClick: A.dropElevation }));

    if (elevationTimer) { clearInterval(elevationTimer); elevationTimer = null; }
    tick();
    // tick() may have dropped the elevation already, in which case there is
    // nothing left to count down and installing an interval would leave a
    // stale closure firing forever.
    if (A.data.me.elevation) elevationTimer = window.setInterval(tick, 1000);
  }
  A.paintElevation = paintElevation;

  /**
   * Open a recorded session in the drawer. The drawer is deliberately never
   * unmounted on navigation: an operator mid-restore should be able to check a
   * dashboard without dropping the shell they are working in.
   */
  A.connect = function (vm, protocol) {
    var proto = protocol.toUpperCase();
    // Captured before any dialog runs, because by the time the drawer opens
    // the elevation dialog has already returned focus to its own opener.
    var invokedFrom = document.activeElement;
    var open = function () {
      var drawer = document.getElementById('drawer');
      sessionOpener = invokedFrom && document.contains(invokedFrom) ? invokedFrom : null;
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
              A.closeSession();
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
    ['g then u', 'Audit'], ['g then k', 'Stack'], ['g then y', 'System'],
    ['g then b', 'Object storage'], ['g then l', 'Logs'],
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

  /* -------------------------------------------------------- preferences --- */

  /**
   * Console preferences. Radio groups rather than switches, because each of
   * these has a third state ("follow the system") or a name worth reading, and
   * a switch cannot express either. Every group is a real fieldset with a
   * legend, so a screen reader announces what the choice is for.
   */
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
      }
    ];

    A.dialog({
      title: 'Console preferences',
      body: function () {
        return groups.map(function (g) {
          // Ids are suffixed per dialog instance: two dialogs open at once
          // would otherwise share an id and the label would point at the
          // wrong control.
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

  var GO_KEYS = { o: 'overview', a: 'apps', d: 'deploys', c: 'compute', t: 'data', i: 'identity', s: 'security', m: 'ml', p: 'ops', u: 'audit', k: 'stack', y: 'system', b: 'storage', l: 'logs' };
  var goArmed = false, goTimer = null;

  function isTyping(e) {
    var t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  /* -------------------------------------------------------- drawer nav --- */

  function closeDrawerNav(restoreFocus) {
    var wasOpen = document.body.classList.contains('navopen');
    document.body.classList.remove('navopen');
    var s = document.getElementById('scrim');
    if (s) s.hidden = true;
    var b = document.getElementById('burger');
    if (b) b.setAttribute('aria-expanded', 'false');
    /* Off-canvas is a transform, not display:none, so the nav items stay in
       the tab order. Hand focus back to the control that opened the drawer --
       but only when the drawer is being dismissed, not when a navigation
       closed it, because render() has already moved focus to the new page
       heading by then. */
    if (wasOpen && restoreFocus && b && document.contains(b)) b.focus();
  }
  function openDrawerNav() {
    document.body.classList.add('navopen');
    document.getElementById('scrim').hidden = false;
    document.getElementById('burger').setAttribute('aria-expanded', 'true');
    var first = document.querySelector('.side .nav');
    if (first) first.focus();
  }

  /* ---------------------------------------------------- session drawer --- */

  // Whatever opened the session drawer, so focus can go back there when it
  // closes. Closing a drawer and dropping focus onto <body> strands a keyboard
  // user at the top of the document.
  var sessionOpener = null;

  A.isSessionOpen = function () {
    var d = document.getElementById('drawer');
    return !!d && !d.hidden;
  };

  /**
   * Close the session drawer. One helper serves the close button, the
   * Disconnect action and the Escape key alike.
   */
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

  /* ------------------------------------------------------------- boot --- */

  function boot() {
    loadPrefs();
    applyTheme();
    // A machine that flips to dark at sunset takes the console with it, but
    // only while the operator has not made an explicit choice.
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

    /* Delegated from the rail so it survives the rail being rebuilt. */
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
    // Not `addEventListener('click', closeDrawerNav)`: the listener would hand
    // the MouseEvent in as restoreFocus, which is truthy, and the argument
    // would work only by accident.
    document.getElementById('scrim').addEventListener('click', function () { closeDrawerNav(true); });
    /* The label has to be right on boot too, not only after a click, because
       the rail preference persists. */
    var railBtn = document.getElementById('railbtn');
    railBtn.setAttribute('aria-label', prefs.rail ? 'Expand navigation' : 'Collapse navigation');
    railBtn.addEventListener('click', function () {
      prefs.rail = document.body.classList.toggle('railed');
      savePrefs();
      this.setAttribute('aria-label', prefs.rail ? 'Expand navigation' : 'Collapse navigation');
      A.announce(prefs.rail ? 'Navigation collapsed' : 'Navigation expanded');
    });
    document.getElementById('drawer-close').addEventListener('click', A.closeSession);
    document.getElementById('helpbtn').addEventListener('click', A.shortcuts);
    document.getElementById('prefsbtn').addEventListener('click', A.settings);
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
      // Innermost surface first: a recorded session, then the mobile nav.
      if (e.key === 'Escape') { if (!A.closeSession()) closeDrawerNav(true); return; }
      if (goArmed && e.key === ',') { e.preventDefault(); goArmed = false; A.settings(); return; }
      if (goArmed && GO_KEYS[e.key]) { e.preventDefault(); goArmed = false; A.go(GO_KEYS[e.key]); return; }
      if (e.key === 'g') {
        goArmed = true;
        if (goTimer) clearTimeout(goTimer);
        goTimer = window.setTimeout(function () { goArmed = false; }, 1400);
      }
    });

    // Wrapped: passing render directly hands it the HashChangeEvent as its
    // options object, and any future option would read as truthy off an event.
    window.addEventListener('hashchange', function () { render(); });
    A.setEnv('production', true);
    paintElevation();
    render();
  }

  A.boot = boot;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
