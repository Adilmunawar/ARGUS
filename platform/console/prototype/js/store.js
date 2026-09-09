/* Argus Console: the data layer.
 *
 * Every screen until now read ARGUS.data directly -- a fixture object that is
 * always present, always complete and always instant. Real data is none of
 * those things, and a UI written against fixtures quietly assumes all three:
 * no loading state, no failure state, no staleness, no cancellation. Wiring a
 * real API into that shape means touching every screen. This is the seam that
 * makes it one place instead.
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

  A.storeMode = function () { return state.mode; };
  A.capabilities = function () { return state.capabilities; };
  A.storeState = function () { return state; };
  A.forget = function (path) { if (path) delete cached[path]; else cached = {}; };
  A.MODE = MODE;
})();
