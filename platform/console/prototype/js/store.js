(function () {
  'use strict';

  var A = (window.ARGUS = window.ARGUS || {});

  var MODE = { UNKNOWN: 'unknown', LIVE: 'live', SAMPLE: 'sample' };
  var state = {
    mode: MODE.UNKNOWN,
    base: '',
    capabilities: null,
    probedAt: null,
    probeError: null,
    auth: { mode: null, authenticated: false, principal: null },
    signedOut: false
  };

  var inflight = {};
  var cached = {};

  function now() { return Date.now(); }

  var health = { lastOkAt: null, lastFailAt: null, lastError: null, reads: 0, failures: 0 };
  var watchers = [];

  function summary() {
    var stale = health.lastFailAt !== null && (health.lastOkAt === null || health.lastFailAt > health.lastOkAt);
    return {
      mode: state.mode,
      probedAt: state.probedAt,
      probeError: state.probeError,
      lastOkAt: health.lastOkAt,
      lastFailAt: health.lastFailAt,
      lastError: health.lastError,
      reads: health.reads,
      failures: health.failures,
      stale: stale,
      signedOut: state.signedOut,
      auth: state.auth
    };
  }

  function notify() {
    var snap = summary();
    watchers.slice().forEach(function (fn) {
      try { fn(snap); } catch (e) { if (window.console) window.console.warn('store watcher failed', e); }
    });
  }

  A.watchStore = function (fn) {
    if (typeof fn !== 'function') return function () {};
    watchers.push(fn);
    fn(summary());
    return function () {
      var at = watchers.indexOf(fn);
      if (at !== -1) watchers.splice(at, 1);
    };
  };

  A.storeHealth = summary;

  function routeSignal() {
    return typeof A.routeSignal === 'function' ? A.routeSignal() : null;
  }

  function routeGeneration() {
    return typeof A.routeGeneration === 'function' ? A.routeGeneration() : 0;
  }

  function request(path, opts) {
    opts = opts || {};
    var timeoutMs = opts.timeoutMs || 10000;

    if (typeof window.fetch !== 'function') {
      return Promise.reject({ reason: 'no-fetch', message: 'This browser cannot reach the console API.' });
    }

    var outer = opts.abortable === false ? null : (opts.signal || routeSignal());
    var controller = typeof window.AbortController === 'function' ? new window.AbortController() : null;
    var timedOut = false;
    var timer = window.setTimeout(function () {
      timedOut = true;
      if (controller) controller.abort();
    }, timeoutMs);

    function onOuterAbort() { if (controller) controller.abort(); }
    if (outer && controller) {
      if (outer.aborted) controller.abort();
      else outer.addEventListener('abort', onOuterAbort);
    }
    function release() {
      window.clearTimeout(timer);
      if (outer && outer.removeEventListener) outer.removeEventListener('abort', onOuterAbort);
    }

    return window.fetch(state.base + path, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller ? controller.signal : undefined
    }).then(function (res) {
      release();
      if (res.status === 401 && state.auth.mode === 'session') {
        markSignedOut();
        return Promise.reject({
          reason: 'unauthenticated',
          message: 'The console API wants you to sign in again.'
        });
      }
      if (!res.ok) {
        return Promise.reject({
          reason: 'http-' + res.status,
          message: 'The console API answered ' + res.status + ' for ' + path + '.'
        });
      }
      return res.json();
    }, function (err) {
      release();
      var aborted = err && (err.name === 'AbortError');
      var cancelled = aborted && !timedOut;
      return Promise.reject({
        reason: cancelled ? 'cancelled' : (aborted ? 'timeout' : 'unreachable'),
        message: cancelled
          ? 'This request was abandoned because the console left the screen that asked for it. Nothing is wrong with the server.'
          : (aborted
            ? 'The console API did not answer within ' + Math.round(timeoutMs / 1000) + ' seconds.'
            : 'The console API is not reachable. Is it running? `npm start` in platform/console/server.')
      });
    });
  }

  function markSignedOut() {
    var was = state.signedOut;
    state.signedOut = true;
    state.auth = { mode: state.auth.mode || 'session', authenticated: false, principal: null };
    cached = {};
    if (!was) notify();
  }

  function readAuth(caps) {
    var auth = caps && caps.auth ? caps.auth : {};
    var authenticated = auth.authenticated === true;
    state.auth = {
      mode: auth.mode || null,
      authenticated: authenticated,
      principal: authenticated ? {
        subject: auth.subject || '',
        displayName: auth.displayName || auth.subject || '',
        roles: auth.roles || [],
        expiresAt: auth.expiresAt || null,
        idleExpiresAt: auth.idleExpiresAt || null
      } : null
    };
    state.signedOut = auth.mode === 'session' && !authenticated;
  }

  A.probe = function () {
    if (state.probedAt) return Promise.resolve(state);
    if (window.location.protocol === 'file:') {
      state.mode = MODE.SAMPLE;
      state.probedAt = now();
      state.probeError = { reason: 'file-url', message: 'Opened from the filesystem, so there is no console API to reach.' };
      notify();
      return Promise.resolve(state);
    }
    if (!state.probing) {
      state.probing = request('/api/capabilities', { timeoutMs: 2500, abortable: false }).then(function (caps) {
        state.mode = MODE.LIVE;
        state.capabilities = caps;
        readAuth(caps);
        state.probedAt = now();
        health.lastOkAt = now();
        notify();
        return state;
      }, function (err) {
        state.mode = MODE.SAMPLE;
        state.probeError = err;
        state.probedAt = now();
        notify();
        return state;
      });
    }
    return state.probing;
  };

  A.read = function (path, opts) {
    return A.probe().then(function () { return readNow(path, opts); });
  };

  function readNow(path, opts) {
    opts = opts || {};
    var ttl = opts.ttlMs === undefined ? 15000 : opts.ttlMs;

    if (state.mode === MODE.SAMPLE) {
      return Promise.resolve({
        ok: false, data: null, mode: MODE.SAMPLE, at: now(),
        error: { reason: 'sample-mode', message: 'The console is running on bundled sample data.' }
      });
    }

    if (state.signedOut) {
      return Promise.resolve({
        ok: false, data: null, mode: MODE.LIVE, at: now(), stale: false,
        error: { reason: 'unauthenticated', message: 'Sign in to read this from the console API.' }
      });
    }

    var hit = cached[path];
    if (hit && now() - hit.at < ttl) return Promise.resolve(hit.envelope);
    var ik = routeGeneration() + '|' + path;
    if (inflight[ik]) return inflight[ik];

    var p = request(path, opts).then(function (data) {
      var envelope = {
        ok: data && data.ok !== false, data: data, mode: MODE.LIVE, at: now(),
        stale: !!(data && data.stale),
        error: data && data.ok === false ? { reason: data.reason, message: data.message } : null
      };
      cached[path] = { at: now(), envelope: envelope };
      delete inflight[ik];
      health.reads += 1;
      health.lastOkAt = now();
      notify();
      return envelope;
    }, function (err) {
      delete inflight[ik];
      if (err && err.reason === 'cancelled' && hit) return hit.envelope;
      if (!(err && err.reason === 'cancelled')) {
        health.failures += 1;
        health.lastFailAt = now();
        health.lastError = err || null;
        notify();
      }
      if (hit) {
        var stale = {};
        for (var k in hit.envelope) if (Object.prototype.hasOwnProperty.call(hit.envelope, k)) stale[k] = hit.envelope[k];
        stale.stale = true;
        stale.error = err;
        return stale;
      }
      return { ok: false, data: null, mode: MODE.LIVE, at: now(), stale: false, error: err };
    });

    inflight[ik] = p;
    return p;
  }

  var STREAM = {
    OFF: 'off',
    OPENING: 'opening',
    OPEN: 'open',
    RETRYING: 'retrying',
    CLOSED: 'closed'
  };

  var CONNECTING = 0;
  var MAX_OPEN_STREAMS = 4;
  var MAX_OPENING_ATTEMPTS = 4;
  var BACKOFF_MIN_MS = 1000;
  var BACKOFF_MAX_MS = 30000;
  var streams = {};

  function streamKey(path, topics) { return path + '|' + topics.join(','); }

  function streamUrl(rec) {
    var sep = rec.path.indexOf('?') === -1 ? '?' : '&';
    var url = state.base + rec.path + sep + 'topics=' + encodeURIComponent(rec.topics.join(','));
    if (rec.lastEventId) url += '&lastEventId=' + encodeURIComponent(rec.lastEventId);
    return url;
  }

  function heldStreamCount() {
    var n = 0;
    Object.keys(streams).forEach(function (k) { if (!streams[k].closed) n += 1; });
    return n;
  }

  function tellSubs(rec, fn) {
    rec.subs.slice().forEach(function (sub) {
      try { fn(sub); } catch (e) { if (window.console) window.console.warn('stream handler failed', e); }
    });
  }

  function setStreamState(rec, next, info) {
    rec.state = next;
    rec.stateAt = now();
    rec.history.push({ at: rec.stateAt, state: next, attempt: rec.attempts });
    if (rec.history.length > 60) rec.history.splice(0, rec.history.length - 60);
    tellSubs(rec, function (sub) { if (sub.onState) sub.onState(next, info || {}); });
  }

  var jitterEnabled = true;

  A.setJitter = function (on) { jitterEnabled = !!on; };
  A.jitterEnabled = function () { return jitterEnabled; };

  function backoffFor(attempts) {
    var steps = Math.max(0, attempts - 1);
    var raw = BACKOFF_MIN_MS * Math.pow(2, Math.min(steps, 12));
    var capped = Math.min(BACKOFF_MAX_MS, raw);
    if (!jitterEnabled) return capped;
    return Math.round(capped / 2 + Math.random() * (capped / 2));
  }

  A.backoffFor = backoffFor;

  function detachStream(rec) {
    var es = rec.es;
    if (!es) return;
    rec.es = null;
    rec.listeners.forEach(function (pair) {
      try { es.removeEventListener(pair[0], pair[1]); } catch (e) {}
    });
    rec.listeners = [];
    try { es.close(); } catch (e) {}
  }

  function teardownStream(rec) {
    rec.closed = true;
    if (rec.timer) { window.clearTimeout(rec.timer); rec.timer = null; }
    detachStream(rec);
    if (streams[rec.key] === rec) delete streams[rec.key];
    rec.state = STREAM.CLOSED;
  }

  function attachEvent(rec, es, name) {
    var fn = function (ev) {
      if (rec.es !== es) return;
      if (ev.lastEventId) rec.lastEventId = ev.lastEventId;
      var payload = null;
      if (ev.data !== undefined && ev.data !== null && ev.data !== '') {
        try { payload = JSON.parse(ev.data); } catch (e) { rec.malformed += 1; return; }
      }
      rec.received += 1;
      tellSubs(rec, function (sub) {
        var handler = sub.on && sub.on[name];
        if (handler) handler(payload, ev.lastEventId || null);
      });
    };
    es.addEventListener(name, fn);
    rec.listeners.push([name, fn]);
  }

  function giveUpStream(rec, message) {
    var subs = rec.subs.slice();
    teardownStream(rec);
    rec.subs = [];
    subs.forEach(function (sub) {
      if (!sub.onUnavailable) return;
      try {
        sub.onUnavailable({
          reason: 'stream-refused',
          message: message + ' The console tried ' + MAX_OPENING_ATTEMPTS + ' times without the stream ' +
            'ever opening, so it has stopped rather than reconnecting at you forever. Nothing below it is ' +
            'a reading.'
        });
      } catch (e) { if (window.console) window.console.warn('stream handler failed', e); }
    });
  }

  function scheduleRetry(rec, message) {
    if (rec.closed) return;
    if (!rec.everOpened && rec.attempts >= MAX_OPENING_ATTEMPTS) {
      giveUpStream(rec, message || 'The live stream could not be opened.');
      return;
    }
    var delay = backoffFor(rec.attempts);
    setStreamState(rec, STREAM.RETRYING, {
      inMs: delay,
      attempt: rec.attempts,
      resumeFrom: rec.lastEventId || null,
      message: message || 'The live stream was interrupted.'
    });
    rec.timer = window.setTimeout(function () {
      rec.timer = null;
      openStream(rec);
    }, delay);
  }

  function openStream(rec) {
    if (rec.closed || rec.es) return;
    rec.attempts += 1;
    setStreamState(rec, STREAM.OPENING, { attempt: rec.attempts, resumeFrom: rec.lastEventId || null });

    var es;
    try {
      es = new window.EventSource(streamUrl(rec), { withCredentials: true });
    } catch (e) {
      scheduleRetry(rec, 'This browser refused to open the stream.');
      return;
    }
    rec.es = es;

    var onOpen = function () {
      if (rec.es !== es) return;
      rec.attempts = 0;
      rec.everOpened = true;
      rec.openedAt = now();
      setStreamState(rec, STREAM.OPEN, { resumedFrom: rec.lastEventId || null });
    };
    es.addEventListener('open', onOpen);
    rec.listeners.push(['open', onOpen]);

    var onError = function () {
      if (rec.es !== es) return;
      var wasOpen = rec.state === STREAM.OPEN;
      var browserWillReconnect = es.readyState === CONNECTING;

      if (browserWillReconnect) {
        rec.attempts += 1;
        if (!rec.everOpened && rec.attempts >= MAX_OPENING_ATTEMPTS) {
          giveUpStream(rec, 'The live stream could not be opened.');
          return;
        }
        setStreamState(rec, STREAM.RETRYING, {
          byBrowser: true,
          inMs: null,
          attempt: rec.attempts,
          resumeFrom: rec.lastEventId || null,
          message: wasOpen
            ? 'The live stream dropped. The browser is reconnecting on its own and sends the id of the last line ' +
              'it saw, so the gap is replayed rather than skipped.'
            : 'The live stream has not opened yet. The browser is still trying.'
        });
        return;
      }

      detachStream(rec);
      scheduleRetry(rec, wasOpen
        ? 'The console API closed the live stream.'
        : 'The live stream could not be opened.');
    };
    es.addEventListener('error', onError);
    rec.listeners.push(['error', onError]);

    Object.keys(rec.names).forEach(function (name) { attachEvent(rec, es, name); });
  }

  function registerNames(rec, sub) {
    Object.keys(sub.on || {}).forEach(function (name) {
      if (rec.names[name]) return;
      rec.names[name] = true;
      if (rec.es) attachEvent(rec, rec.es, name);
    });
  }

  function streamBlockedBy(key) {
    if (state.mode === MODE.SAMPLE) {
      return {
        reason: 'sample-mode',
        message: 'The console is running on bundled sample data, so nothing is streaming.'
      };
    }
    if (state.signedOut) {
      return {
        reason: 'unauthenticated',
        message: 'Sign in to follow this from the console API.'
      };
    }
    if (typeof window.EventSource !== 'function') {
      return {
        reason: 'no-eventsource',
        message: 'This browser cannot open a live stream, so this panel has no source to follow.'
      };
    }
    if (!streams[key] && heldStreamCount() >= MAX_OPEN_STREAMS) {
      return {
        reason: 'too-many-streams',
        message: 'The console already holds ' + MAX_OPEN_STREAMS + ' live streams. A browser allows only a ' +
          'handful per origin, and the rest of the console would queue behind a sixth.'
      };
    }
    return null;
  }

  A.subscribe = function (path, topics, handlers) {
    handlers = handlers || {};
    topics = (topics || []).map(String);

    var cancelled = false;
    var rec = null;
    var sub = {
      on: handlers.on || {},
      onState: handlers.onState || null,
      onUnavailable: handlers.onUnavailable || null
    };

    function close() {
      if (cancelled) return;
      cancelled = true;
      if (!rec) return;
      var at = rec.subs.indexOf(sub);
      if (at !== -1) rec.subs.splice(at, 1);
      if (!rec.subs.length) teardownStream(rec);
      rec = null;
    }

    if (typeof A.onLeave === 'function') A.onLeave(close);

    A.probe().then(function () {
      if (cancelled) return;
      var key = streamKey(path, topics);
      var blocked = streamBlockedBy(key);
      if (blocked) {
        if (sub.onUnavailable) sub.onUnavailable(blocked);
        return;
      }
      rec = streams[key];
      if (!rec) {
        rec = streams[key] = {
          key: key, path: path, topics: topics,
          es: null, listeners: [], names: {}, subs: [],
          state: STREAM.OFF, stateAt: now(), history: [],
          attempts: 0, received: 0, malformed: 0, everOpened: false,
          lastEventId: null, openedAt: null, timer: null, closed: false
        };
        rec.subs.push(sub);
        registerNames(rec, sub);
        openStream(rec);
        return;
      }
      rec.subs.push(sub);
      registerNames(rec, sub);
      if (sub.onState) sub.onState(rec.state, { attempt: rec.attempts, resumeFrom: rec.lastEventId || null });
    });

    return close;
  };

  A.STREAM = STREAM;

  A.streamSnapshot = function () {
    return Object.keys(streams).map(function (k) {
      var rec = streams[k];
      return {
        key: rec.key, state: rec.state, attempts: rec.attempts,
        subscribers: rec.subs.length, received: rec.received,
        malformed: rec.malformed, lastEventId: rec.lastEventId,
        openedAt: rec.openedAt, stateAt: rec.stateAt
      };
    });
  };

  A.seriesValues = function (payload) {
    if (payload && payload.series && payload.series.length && payload.series[0].points) {
      return payload.series[0].points.map(function (point) {
        var v = point && point.value;
        var n = v === null || v === undefined ? NaN : Number(v);
        return isFinite(n) ? n : null;
      });
    }
    var matrix = payload && payload.data && payload.data.result ? payload.data
      : (payload && payload.result ? payload : null);
    var first = matrix && matrix.result && matrix.result[0];
    if (!first || !first.values) return [];
    return first.values.map(function (point) {
      var n = Number(point[1]);
      return isFinite(n) ? n : null;
    });
  };

  function authRequest(path, body) {
    if (typeof window.fetch !== 'function') {
      return Promise.reject({ reason: 'no-fetch', message: 'This browser cannot reach the console API.' });
    }
    return window.fetch(state.base + path, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'x-argus-console': '1' },
      cache: 'no-store',
      credentials: 'same-origin',
      body: JSON.stringify(body || {})
    }).then(function (res) {
      if (res.status === 204 || res.status === 200) return { ok: true, status: res.status };
      return res.json().then(function (data) {
        return Promise.reject({
          reason: (data && data.error) || ('http-' + res.status),
          status: res.status,
          retryAfter: Number(res.headers.get('retry-after')) || null,
          message: (data && data.message) || ('The console API answered ' + res.status + '.')
        });
      }, function () {
        return Promise.reject({
          reason: 'http-' + res.status, status: res.status,
          message: 'The console API answered ' + res.status + '.'
        });
      });
    }, function () {
      return Promise.reject({ reason: 'unreachable', message: 'The console API is not reachable.' });
    });
  }

  function reprobe() {
    state.probedAt = null;
    state.probing = null;
    state.probeError = null;
    cached = {};
    return A.probe();
  }

  A.signIn = function (subject, password) {
    return authRequest('/api/auth/login', { subject: String(subject || ''), password: String(password || '') })
      .then(function () {
        state.signedOut = false;
        return reprobe();
      }).then(function () {
        if (state.signedOut) {
          return Promise.reject({ reason: 'unauthenticated', message: 'The console API did not keep the session. Check that cookies are allowed for this origin.' });
        }
        return state.auth;
      });
  };

  A.signOut = function () {
    return authRequest('/api/auth/logout').then(function () { return null; }, function () { return null; }).then(function () {
      Object.keys(streams).forEach(function (k) { teardownStream(streams[k]); });
      markSignedOut();
      return reprobe();
    });
  };

  A.useSample = function (why) {
    state.mode = MODE.SAMPLE;
    state.signedOut = false;
    state.probeError = { reason: why || 'chosen', message: 'Bundled sample data, chosen instead of signing in. Nothing here has been measured.' };
    cached = {};
    notify();
  };

  A.auth = function () { return state.auth; };
  A.reprobe = reprobe;
  A.storeMode = function () { return state.mode; };
  A.capabilities = function () { return state.capabilities; };
  A.storeState = function () { return state; };
  A.forget = function (path) { if (path) delete cached[path]; else cached = {}; };
  A.MODE = MODE;
})();
