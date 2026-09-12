/* Argus Console: the data layer.
 *
 * The seam between the screens and their data. Real data can be missing,
 * late, stale or failing, and this is the one place that models it, so
 * wiring a real API in touches one file rather than every screen.
 *
 * Two modes, decided once at boot by asking the API if it is there:
 *
 *   live    a server answered /api/health. Data comes from it, carries an age,
 *           and can fail. Failures are shown, never swallowed.
 *   sample  nothing answered. The console runs on the bundled fixtures and
 *           SAYS SO, prominently. A dashboard that shows invented numbers
 *           without saying they are invented is worse than one that shows
 *           nothing, because somebody will make a decision on them.
 *
 * The console must keep working from file:// with no server -- that is how the
 * three test harnesses open it, and how ADR-0027 requires it to run in an
 * egress-restricted network. So sample mode is a first-class state, not a
 * failure.
 */
(function () {
  'use strict';

  var A = (window.ARGUS = window.ARGUS || {});

  var MODE = { UNKNOWN: 'unknown', LIVE: 'live', SAMPLE: 'sample' };
  var state = {
    mode: MODE.UNKNOWN,
    base: '',
    capabilities: null,
    probedAt: null,
    probeError: null
  };

  /* An in-flight map, so six panels opening at once against a cold cache make
     one request rather than six. The server does this too; doing it here as
     well saves the round trips, which is what the operator actually feels. */
  var inflight = {};
  var cached = {};

  function now() { return Date.now(); }

  /**
   * fetch with a timeout and a typed failure.
   *
   * A dashboard that hangs is worse than one that says it cannot reach the
   * server, because the operator cannot tell the difference between "slow" and
   * "broken" and will wait for both.
   */
  function request(path, opts) {
    opts = opts || {};
    var timeoutMs = opts.timeoutMs || 10000;

    if (typeof window.fetch !== 'function') {
      return Promise.reject({ reason: 'no-fetch', message: 'This browser cannot reach the console API.' });
    }

    var controller = typeof window.AbortController === 'function' ? new window.AbortController() : null;
    var timer = window.setTimeout(function () { if (controller) controller.abort(); }, timeoutMs);

    return window.fetch(state.base + path, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller ? controller.signal : undefined
    }).then(function (res) {
      window.clearTimeout(timer);
      if (!res.ok) {
        return Promise.reject({
          reason: 'http-' + res.status,
          message: 'The console API answered ' + res.status + ' for ' + path + '.'
        });
      }
      return res.json();
    }, function (err) {
      window.clearTimeout(timer);
      var aborted = err && (err.name === 'AbortError');
      return Promise.reject({
        reason: aborted ? 'timeout' : 'unreachable',
        message: aborted
          ? 'The console API did not answer within ' + Math.round(timeoutMs / 1000) + ' seconds.'
          : 'The console API is not reachable. Is it running? `npm start` in platform/console/server.'
      });
    });
  }

  /**
   * Ask once, at boot, whether there is a server.
   *
   * Deliberately short: on file:// the fetch fails immediately, and the console
   * must not sit on a spinner for ten seconds before showing the fixtures it
   * already has in memory.
   */
  A.probe = function () {
    if (state.probedAt) return Promise.resolve(state);
    /* A file:// page has no origin to call. Probing anyway costs every harness
       a timeout on every boot and can never succeed. */
    if (window.location.protocol === 'file:') {
      state.mode = MODE.SAMPLE;
      state.probedAt = now();
      state.probeError = { reason: 'file-url', message: 'Opened from the filesystem, so there is no console API to reach.' };
      return Promise.resolve(state);
    }
    if (!state.probing) {
      state.probing = request('/api/capabilities', { timeoutMs: 2500 }).then(function (caps) {
        state.mode = MODE.LIVE;
        state.capabilities = caps;
        state.probedAt = now();
        return state;
      }, function (err) {
        state.mode = MODE.SAMPLE;
        state.probeError = err;
        state.probedAt = now();
        return state;
      });
    }
    return state.probing;
  };

  /**
   * Read a resource.
   *
   * Always resolves -- never rejects -- to an envelope the UI can render
   * without a try/catch at every call site:
   *
   *   { ok, data, error, at, stale, mode }
   *
   * `stale` is carried through from the server, which serves a previous value
   * when a fresh read fails. A number with an age attached is useful during an
   * incident; the same number pretending to be current is dangerous.
   */
  A.read = function (path, opts) {
    // Every read waits for the probe, so no caller has to sequence it by hand.
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

    var hit = cached[path];
    if (hit && now() - hit.at < ttl) return Promise.resolve(hit.envelope);
    if (inflight[path]) return inflight[path];

    var p = request(path, opts).then(function (data) {
      var envelope = {
        ok: data && data.ok !== false, data: data, mode: MODE.LIVE, at: now(),
        stale: !!(data && data.stale),
        error: data && data.ok === false ? { reason: data.reason, message: data.message } : null
      };
      cached[path] = { at: now(), envelope: envelope };
      delete inflight[path];
      return envelope;
    }, function (err) {
      delete inflight[path];
      // A previous value with an honest age beats an empty panel.
      if (hit) {
        var stale = {};
        for (var k in hit.envelope) if (Object.prototype.hasOwnProperty.call(hit.envelope, k)) stale[k] = hit.envelope[k];
        stale.stale = true;
        stale.error = err;
        return stale;
      }
      return { ok: false, data: null, mode: MODE.LIVE, at: now(), stale: false, error: err };
    });

    inflight[path] = p;
    return p;
  }

  var STREAM = {
    OFF: 'off',
    OPENING: 'opening',
    OPEN: 'open',
    RETRYING: 'retrying',
    CLOSED: 'closed'
  };

  var MAX_OPEN_STREAMS = 4;
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

  function openStreamCount() {
    var n = 0;
    Object.keys(streams).forEach(function (k) { if (streams[k].es) n += 1; });
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

  function backoffFor(attempts) {
    var steps = Math.max(0, attempts - 1);
    var raw = BACKOFF_MIN_MS * Math.pow(2, Math.min(steps, 12));
    return Math.min(BACKOFF_MAX_MS, raw);
  }

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

  function scheduleRetry(rec, message) {
    if (rec.closed) return;
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
      rec.openedAt = now();
      setStreamState(rec, STREAM.OPEN, { resumedFrom: rec.lastEventId || null });
    };
    es.addEventListener('open', onOpen);
    rec.listeners.push(['open', onOpen]);

    var onError = function () {
      if (rec.es !== es) return;
      var wasOpen = rec.state === STREAM.OPEN;
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
    if (typeof window.EventSource !== 'function') {
      return {
        reason: 'no-eventsource',
        message: 'This browser cannot open a live stream, so this panel has no source to follow.'
      };
    }
    if (!streams[key] && openStreamCount() >= MAX_OPEN_STREAMS) {
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
          attempts: 0, received: 0, malformed: 0,
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
    var matrix = payload && payload.data && payload.data.result ? payload.data
      : (payload && payload.result ? payload : null);
    var first = matrix && matrix.result && matrix.result[0];
    if (!first || !first.values) return [];
    return first.values.map(function (point) {
      var n = Number(point[1]);
      return isFinite(n) ? n : null;
    });
  };

  A.storeMode = function () { return state.mode; };
  A.capabilities = function () { return state.capabilities; };
  A.storeState = function () { return state; };
  A.forget = function (path) { if (path) delete cached[path]; else cached = {}; };
  A.MODE = MODE;
})();
