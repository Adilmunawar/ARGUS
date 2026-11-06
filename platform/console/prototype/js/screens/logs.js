(function () {
  'use strict';

  var A = window.ARGUS, ui = A.ui, el = ui.el, fmt = ui.fmt;

  var LEVELS = ui.LOG_LEVELS;
  var LEVEL_LABEL = ui.LOG_LEVEL_LABEL;
  var BUFFERS = [200, 500, 2000];
  var DEFAULT_BUFFER = 500;
  var KEEP = 2000;
  var ANNOUNCE_GAP_MS = 4000;

  var SAMPLE_LINES = 180;
  var SAMPLE_APPS = 6;

  var STREAM_LABELS = ['service_name', 'service', 'job', 'container', 'app'];
  var MAX_STREAM_NAMES = 200;

  var RANGES = [
    { key: '15m', label: '15 min', words: 'the last 15 minutes' },
    { key: '1h', label: '1 h', words: 'the last hour' },
    { key: '6h', label: '6 h', words: 'the last 6 hours' },
    { key: '24h', label: '24 h', words: 'the last 24 hours' }
  ];
  var DEFAULT_RANGE = '1h';
  var QUERY_MAX_CHARS = 2048;

  var CONSOLE_STREAM = /^(argus-)?console$/;
  var POLLING_LINE = /(^|\s)(GET|HEAD) \/api\/\S* [23]\d\d \d+ms\s*$/;

  function isPolling(line) {
    return !!line && CONSOLE_STREAM.test(line.stream) && POLLING_LINE.test(line.text);
  }

  function rangeOf(key) {
    for (var i = 0; i < RANGES.length; i++) if (RANGES[i].key === key) return RANGES[i];
    return rangeOf(DEFAULT_RANGE);
  }

  function quoteLabelValue(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function selectorFor(label, value) {
    if (!value || value === 'all') return '{' + label + '=~".+"}';
    return '{' + label + '="' + quoteLabelValue(value) + '"}';
  }

  function sampleTexts(app) {
    return [
      'GET /api/' + app.name + '/summary 200 in ' + app.p95 + ' ms',
      'cache lookup ' + app.name + ':summary hit',
      'reconciled ' + app.name + ' desired state, no change',
      'POST /api/' + app.name + '/ingest 202 accepted, 41 records',
      'upstream ' + ((app.depends && app.depends.databases && app.depends.databases[0]) || 'postgres') + ' answered in 9 ms',
      'slow query over 500 ms on ' + app.name + ', plan cached',
      'retrying publish to ' + ((app.depends && app.depends.queues && app.depends.queues[0]) || 'argus.ingest') + ' after a timeout',
      'health probe ok, ' + app.instances + ' instances serving'
    ];
  }

  function sampleBuffer() {
    var d = A.data;
    var apps = (d.apps || []).slice(0, SAMPLE_APPS);
    if (!apps.length) return [];
    var out = [];
    var seed = 7;
    for (var i = 0; i < SAMPLE_LINES; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      var roll = seed / 2147483648;
      var app = apps[i % apps.length];
      var texts = sampleTexts(app);
      var text = texts[Math.floor(roll * texts.length) % texts.length];
      var level = 'info';
      if (/slow query/.test(text) || /retrying/.test(text)) level = 'warn';
      else if (/cache lookup|reconciled/.test(text)) level = 'debug';
      if (app.health !== 'ok' && i % 23 === 0) level = 'error';
      out.push({
        at: new Date(d.now.getTime() - (SAMPLE_LINES - i) * 4000),
        level: level,
        stream: app.name,
        text: text
      });
    }
    return out;
  }

  function sampleStreams(lines) {
    var seen = [], out = [];
    lines.forEach(function (l) { if (seen.indexOf(l.stream) === -1) { seen.push(l.stream); out.push(l.stream); } });
    return out.sort();
  }

  function toDate(raw) {
    if (raw === null || raw === undefined) return new Date();
    if (raw instanceof Date) return raw;
    if (typeof raw === 'number') return new Date(raw);
    var s = String(raw);
    if (/^\d{16,}$/.test(s)) return new Date(Number(s.slice(0, s.length - 6)));
    if (/^\d+$/.test(s)) return new Date(Number(s));
    var parsed = Date.parse(s);
    return isFinite(parsed) ? new Date(parsed) : new Date();
  }

  function decodeLine(payload) {
    if (!payload || typeof payload !== 'object') return null;
    var labels = payload.labels && typeof payload.labels === 'object' ? payload.labels : {};
    var stream = payload.stream || labels.service_name || labels.service || labels.job ||
      labels.container || labels.app || 'unlabelled';
    var text = payload.line !== undefined ? payload.line : payload.text;
    if (text === undefined || text === null) return null;
    return {
      at: toDate(payload.atNs !== undefined ? payload.atNs : payload.at),
      level: ui.logLevel(payload.level || labels.detected_level || labels.level || labels.severity),
      stream: String(stream),
      text: String(text)
    };
  }


  A.screen('logs', {
    title: 'Logs',
    crumb: 'Logs',
    render: function (mount, ctx) {
      var params = (ctx && ctx.params) || {};
      var rest = (ctx && ctx.rest) || [];

      var host = el('div');
      var refresh = ui.btn('Refresh', {
        onClick: function () {
          A.forget();
          paint();
          if (A.storeMode() !== A.MODE.LIVE) {
            A.flash('info', 'There is nothing to re-read',
              'The console API is not answering, so this screen has no stream to reconnect to.');
          }
        }
      });

      mount.appendChild(ui.pageHeader('Logs', 'Tail or query the platform logs held in Loki.', [refresh]));
      mount.appendChild(host);

      var gen = 0;
      var live = true;
      var teardown = null;

      function drop() {
        if (!teardown) return;
        var fn = teardown;
        teardown = null;
        fn();
      }

      A.onLeave(function () { live = false; drop(); });

      function notFound(name) {
        if (!live) return;
        drop();
        ui.clear(mount);
        mount.appendChild(ui.notFound('log stream', name, 'logs', 'All log streams'));
      }

      function paint() {
        gen += 1;
        var mine = gen;
        drop();
        ui.clear(host);
        A.probe().then(function () {
          if (!(live && mine === gen)) return;
          var stillMine = function () { return live && mine === gen; };
          teardown = A.scopeLeaveHooks(function () {
            build(host, refresh, rest, params, stillMine, function (name) { if (stillMine()) notFound(name); });
          });
        });
      }

      paint();
    }
  });

  function build(host, refresh, rest, params, stillMine, notFound) {
    var mode = A.storeMode();
    var isLive = mode === A.MODE.LIVE;
    var S = A.STREAM || {};

    refresh.title = isLive
      ? 'Drop the stream and open it again from the newest line.'
      : 'There is no console API to stream from. Nothing on this screen came from one.';

    var state = {
      mode: params.mode === 'query' ? 'query' : 'follow',
      range: rangeOf(params.range).key,
      stream: rest[0] || params.stream || 'all',
      level: params.level || 'all',
      text: params.q || '',
      showPolling: params.polling === '1',
      cap: DEFAULT_BUFFER,
      received: 0,
      dropped: 0,
      gaps: 0,
      shown: 0,
      following: true,
      streams: [],
      connection: S.OFF || 'off',
      connectionNote: '',
      beats: [],
      lastAnnounceAt: 0
    };
    var requested = state.stream;

    var buffer = [];
    var streamLabel = null;
    var closeStream = null;
    var queryGen = 0;

    var streamSel = el('select.field', { id: 'log-stream' }, [el('option', { value: 'all', text: 'All streams' })]);
    var levelSel = el('select.field', { id: 'log-level' }, [el('option', { value: 'all', text: 'All levels' })].concat(
      LEVELS.map(function (l) { return el('option', { value: l, text: LEVEL_LABEL[l] }); })));
    var capSel = el('select.field', { id: 'log-buffer' }, BUFFERS.map(function (n) {
      return el('option', { value: String(n), text: fmt.num(n) + ' lines' });
    }));
    var textInput = el('input.field', {
      id: 'log-filter', type: 'search', value: state.text,
      placeholder: 'Find text in a line', autocomplete: 'off', spellcheck: 'false'
    });

    levelSel.value = LEVELS.indexOf(state.level) === -1 ? 'all' : state.level;
    capSel.value = String(state.cap);

    var followBtn = ui.btn('Following the tail', {
      title: 'The view scrolls with the newest line. Scrolling up releases it.'
    });
    followBtn.setAttribute('aria-pressed', 'true');

    var jumpBtn = ui.btn('Jump to the newest line', {
      variant: 'link',
      onClick: function () { view.follow(true); }
    });
    jumpBtn.hidden = true;

    function announceLatest() {
      var line = view.latest();
      var sentence = line
        ? fmt.stamp(line.at) + ', ' + line.stream + ', ' + line.level + ': ' + line.text
        : 'No line is in the buffer.';
      A.announce(sentence);
      echo.textContent = 'Announced: ' + sentence;
      echo.hidden = false;
    }

    function clearView() {
      buffer.length = 0;
      state.shown = 0;
      view.say('Cleared. Lines that arrive from here on will appear below.');
      paintStatus();
      A.announce('Log view cleared.');
    }

    var moreMenu = ui.menu([
      { label: 'Announce the latest line', hint: 'screen reader', onSelect: announceLatest },
      { label: 'Clear the view', onSelect: clearView }
    ], { label: 'More log actions' });

    var pollingBtn = ui.btn('Show console polling', {
      variant: 'link',
      title: 'The console API logs every read it serves. Those lines are hidden unless this is pressed.',
      onClick: function () {
        state.showPolling = !state.showPolling;
        pollingBtn.setAttribute('aria-pressed', state.showPolling ? 'true' : 'false');
        rememberParams();
        repaintFiltered();
      }
    });
    pollingBtn.id = 'log-polling';
    pollingBtn.setAttribute('aria-pressed', state.showPolling ? 'true' : 'false');

    var counters = el('p.logstat');
    var echo = el('p.logstat', { hidden: true });

    var view = ui.logView({
      cap: state.cap,
      label: 'Log lines, newest at the bottom. This region is not announced automatically.',
      onFollow: function (on) {
        state.following = on;
        followBtn.textContent = on ? 'Following the tail' : 'Tail released';
        followBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        jumpBtn.hidden = on;
      },
      onFlush: function (count) { state.shown = count; paintStatus(); }
    });

    followBtn.addEventListener('click', function () { view.follow(!view.following()); });

    function matches(line) {
      if (!state.showPolling && isPolling(line)) return false;
      if (state.stream !== 'all' && line.stream !== state.stream) return false;
      if (state.level !== 'all' && line.level !== state.level) return false;
      if (state.text) {
        var needle = state.text.toLowerCase();
        if (line.text.toLowerCase().indexOf(needle) === -1 &&
            line.stream.toLowerCase().indexOf(needle) === -1) return false;
      }
      return true;
    }

    function repaintFiltered() {
      view.reset();
      var keep = [];
      for (var i = 0; i < buffer.length; i++) if (matches(buffer[i])) keep.push(buffer[i]);
      if (!keep.length) {
        view.say(buffer.length
          ? 'No line in the buffer matches this filter.'
          : (state.mode === 'query' ? 'No line is shown for this range yet.' : 'No line has arrived yet.'));
        state.shown = 0;
        paintStatus();
        return;
      }
      view.appendMany(keep.slice(-state.cap));
    }

    function noteStream(name) {
      if (state.streams.indexOf(name) === -1 && state.streams.length < MAX_STREAM_NAMES) {
        state.streams.push(name);
        return true;
      }
      return false;
    }

    function take(line) {
      if (!line) return;
      state.received += 1;
      buffer.push(line);
      if (buffer.length > KEEP) buffer.splice(0, buffer.length - KEEP);
      if (noteStream(line.stream)) paintStreamOptions();
      if (matches(line)) view.append(line);
      else paintStatus();
    }

    function paintStreamOptions() {
      var wanted = state.stream;
      ui.clear(streamSel);
      streamSel.appendChild(el('option', { value: 'all', text: 'All streams' }));
      state.streams.slice().sort().forEach(function (name) {
        streamSel.appendChild(el('option', { value: name, text: name }));
      });
      streamSel.value = state.streams.indexOf(wanted) === -1 ? 'all' : wanted;
      state.stream = streamSel.value;
    }

    function connectionWord() {
      if (state.mode === 'query') return 'showing a range';
      if (state.connection === S.OPEN) return 'streaming';
      if (state.connection === S.OPENING) return 'connecting';
      if (state.connection === S.RETRYING) return 'reconnecting';
      if (state.connection === S.CLOSED) return 'closed';
      return isLive ? 'not connected' : 'not streaming';
    }

    function pollingHidden() {
      if (state.showPolling) return 0;
      var n = 0;
      for (var i = 0; i < buffer.length; i++) if (isPolling(buffer[i])) n += 1;
      return n;
    }

    function paintStatus() {
      var parts = [];
      var word = connectionWord();
      parts.push(word.charAt(0).toUpperCase() + word.slice(1) + '.');
      parts.push(fmt.num(state.shown) + ' of ' + fmt.num(buffer.length) + ' buffered lines shown, ' +
        fmt.num(state.cap) + ' kept in the view.');
      var hidden = pollingHidden();
      if (hidden) parts.push(fmt.num(hidden) + ' of the console\'s own polling line' + (hidden === 1 ? ' is' : 's are') + ' hidden.');
      if (isLive && state.mode === 'follow') parts.push(fmt.num(state.received) + ' received this session.');
      if (state.dropped) {
        parts.push(fmt.num(state.dropped) + ' line' + (state.dropped === 1 ? '' : 's') +
          ' were dropped by the server because this browser could not keep up.');
      }
      if (state.gaps) {
        parts.push(state.gaps + ' resume' + (state.gaps === 1 ? '' : 's') +
          ' could not replay every missed line.');
      }
      if (state.connectionNote && state.mode === 'follow') parts.push(state.connectionNote);
      counters.textContent = parts.join(' ');
      if (resultCounter) resultCounter.textContent = '(' + fmt.num(state.shown) + ')';
    }

    function announceThrottled(message) {
      var at = Date.now();
      if (at - state.lastAnnounceAt < ANNOUNCE_GAP_MS) return;
      state.lastAnnounceAt = at;
      A.announce(message);
    }

    function paramsNow() {
      return {
        mode: state.mode === 'query' ? 'query' : null,
        range: state.mode === 'query' && state.range !== DEFAULT_RANGE ? state.range : null,
        query: state.mode === 'query' && queryInput.value.trim() ? queryInput.value.trim() : null,
        polling: state.showPolling ? '1' : null
      };
    }

    function rememberParams() {
      if (A.replaceHash) A.replaceHash(A.href('logs', rest, paramsNow()));
    }

    streamSel.addEventListener('change', function () {
      state.stream = streamSel.value;
      repaintFiltered();
      A.announce('Showing ' + (state.stream === 'all' ? 'every stream' : state.stream) + '.');
    });
    levelSel.addEventListener('change', function () {
      state.level = levelSel.value;
      repaintFiltered();
    });
    capSel.addEventListener('change', function () {
      state.cap = Number(capSel.value) || DEFAULT_BUFFER;
      view.setCap(state.cap);
      repaintFiltered();
    });
    textInput.addEventListener('input', function () {
      state.text = textInput.value.trim();
      repaintFiltered();
    });

    var followModeBtn = ui.btn('Live tail', { variant: 'ghost', onClick: function () { setMode('follow', true); } });
    var queryModeBtn = ui.btn('Time range', { variant: 'ghost', onClick: function () { setMode('query', true); } });
    followModeBtn.setAttribute('data-log-mode', 'follow');
    queryModeBtn.setAttribute('data-log-mode', 'query');
    var modeBar = el('div.rangebar', { role: 'group', 'aria-label': 'What the view shows' }, [followModeBtn, queryModeBtn]);

    var rangeSel = el('select.field', { id: 'log-range' }, RANGES.map(function (r) {
      return el('option', { value: r.key, text: 'Last ' + r.label });
    }));
    rangeSel.value = state.range;
    var queryInput = el('input.field.mono', {
      id: 'log-query', type: 'text', value: params.query || '', maxlength: String(QUERY_MAX_CHARS),
      placeholder: '{service_name="console"} |= "error"', autocomplete: 'off', spellcheck: 'false'
    });
    var runBtn = ui.btn('Run query', { variant: 'primary', onClick: function () { runQuery(); } });
    queryInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); runQuery(); } });
    rangeSel.addEventListener('change', function () { state.range = rangeSel.value; runQuery(); });

    function field(id, label, control, grow) {
      return el('div.col', { style: grow ? { flex: '1 1 260px', 'min-width': '0' } : { flex: '0 0 auto' } }, [
        el('label.fieldlabel', { for: id, text: label }), control
      ]);
    }
    [queryInput, textInput].forEach(function (n) { n.style.setProperty('width', '100%'); n.style.setProperty('flex', '0 0 auto'); });

    var queryBar = el('div.logbar', { 'data-log-querybar': '' }, [
      field('log-range', 'Time range', rangeSel),
      field('log-query', 'LogQL query', queryInput, true),
      runBtn
    ]);
    var queryState = el('div.livepanel', { 'data-path': '/api/logs/query' });

    var controls = el('div.logbar', [
      field('log-stream', 'Stream', streamSel),
      field('log-level', 'Severity', levelSel),
      field('log-filter', 'Contains', textInput, true),
      field('log-buffer', 'Limit', capSel)
    ]);

    var sourceSlot = el('div');
    var resultActions = [followBtn, jumpBtn, pollingBtn, moreMenu];
    var resultsCard = ui.card('Log entries', [sourceSlot, queryState, view.node], {
      counter: 0,
      actions: resultActions,
      footer: [counters, echo]
    });
    var resultCounter = resultsCard.querySelector('.card-counter');
    var queryCard = ui.card('Query', [
      queryBar, controls,
      ui.disclosure('Details', [
        el('p', {
          text: 'Live tail opens one multiplexed stream for every topic this screen subscribes to. Time range ' +
            'asks Loki once for the newest lines in the window, up to the limit, with the LogQL you give it.'
        }),
        el('p', {
          text: 'A successful GET of an /api/ path logged by the console stream is the console polling itself, ' +
            'and is hidden unless Show console polling is pressed. Failed reads stay visible.'
        })
      ])
    ], { actions: [modeBar] });
    var tailWrap = el('div.grid', { 'data-log-view': '' }, [queryCard, resultsCard]);
    host.appendChild(tailWrap);

    var healthBody = el('div');
    var healthCard = ui.card('Connection', healthBody, { description: 'This browser tab\'s own stream to the console API.' });
    healthCard.style.setProperty('margin-top', 'var(--s-l)');
    if (isLive) host.appendChild(healthCard);

    function paintHealth() {
      ui.clear(healthBody);

      if (!isLive) return;

      var beats = state.beats;
      var u = ui.uptimeOf(beats, { windowMs: null });
      var incidents = ui.incidentsOf(beats);
      healthBody.appendChild(ui.dl([
        ['Status', ui.pill(connectionWord(), state.connection === S.OPEN ? 'ok'
          : state.connection === S.RETRYING ? 'warn' : 'idle')],
        ['Recent attempts', ui.heartbeatBar(beats, {
          slots: 30, width: 180, height: 20,
          name: 'The log stream',
          label: ui.heartbeatSentence(beats, { name: 'The log stream' })
        })],
        ['Opened', u.ratio === null ? '-' : fmt.num(u.up) + ' of ' + fmt.num(u.counted)],
        ['Interrupted', u.ratio === null ? '-' : fmt.num(u.down)]
      ]));
      var details = [el('p.hint', {
        text: 'The history of this browser tab\'s own connection, not of the log pipeline. It is discarded when ' +
          'you leave the screen' + (u.coveredMs ? ' and covers ' + fmt.dur(u.coveredMs / 1000) : '') + '.'
      })];
      incidents.slice(-6).reverse().forEach(function (inc) {
        details.push(el('p.hint', {
          text: (inc.at ? fmt.stamp(new Date(inc.at)) + ': ' : '') + 'went from ' + inc.fromWord + ' to ' + inc.toWord +
            (inc.heldMs !== null ? ' after ' + fmt.dur(inc.heldMs / 1000) : '') + '.'
        }));
      });
      healthBody.appendChild(ui.disclosure('Details', details));
    }

    function recordBeat(status, note) {
      state.beats.push({ at: Date.now(), status: status, msg: note || null });
      if (state.beats.length > 200) state.beats.splice(0, state.beats.length - 200);
      paintHealth();
    }

    function defaultQuery() {
      return selectorFor(streamLabel || STREAM_LABELS[0], state.stream);
    }

    function queryBlock(st, opts) {
      ui.clear(queryState);
      queryState.setAttribute('data-state', st);
      if (opts && opts.reason) queryState.setAttribute('data-reason', opts.reason);
      else queryState.removeAttribute('data-reason');
      queryState.appendChild(ui.stateBlock(st, opts || {}));
    }

    function runQuery() {
      if (state.mode !== 'query') return;
      var range = rangeOf(rangeSel.value);
      state.range = range.key;
      if (!queryInput.value.trim()) queryInput.value = defaultQuery();
      var q = queryInput.value.trim();
      rememberParams();
      queryGen += 1;
      var token = queryGen;

      if (!isLive) {
        queryBlock('sample', { detail: 'A range query reads Loki through the console API, so it does not run on sample data.' });
        buffer.length = 0;
        view.say('No range query runs on sample data.');
        paintStatus();
        return;
      }
      if (q.length > QUERY_MAX_CHARS) {
        queryBlock('failed', { reason: 'too-long', detail: 'A log query is at most ' + fmt.num(QUERY_MAX_CHARS) + ' characters.' });
        return;
      }

      ui.clear(queryState);
      queryState.setAttribute('data-state', 'loading');
      queryState.removeAttribute('data-reason');
      queryState.appendChild(ui.skeleton(1));
      var path = '/api/logs/query?query=' + encodeURIComponent(q) + '&since=' + encodeURIComponent(range.key) +
        '&limit=' + state.cap + '&direction=backward';

      A.read(path, { ttlMs: 0, timeoutMs: 30000 }).then(null, function (err) {
        return { ok: false, data: null, mode: A.MODE.LIVE, at: Date.now(), error: err || {} };
      }).then(function (env) {
        if (!stillMine() || token !== queryGen || state.mode !== 'query') return;
        var st = A.envelopeState(env);
        var e = env.error || {};
        if (st !== 'ok' && st !== 'stale') {
          queryBlock(st, { reason: e.reason, detail: e.message || '', retry: ui.TRANSIENT[st] && e.reason !== 'invalid-request' ? runQuery : null });
          buffer.length = 0;
          view.say('No line: the query did not answer.');
          paintStatus();
          return;
        }
        var d = env.data || {};
        if (d.resultType && d.resultType !== 'streams') {
          queryBlock('failed', {
            reason: 'not-a-log-query',
            detail: 'Loki answered with a ' + d.resultType + ' result. This view shows log lines, so give it a ' +
              'log selector such as {service_name="console"}.'
          });
          buffer.length = 0;
          view.say('No line: that is a metric query.');
          paintStatus();
          return;
        }
        var lines = (Array.isArray(d.lines) ? d.lines : []).map(decodeLine).filter(Boolean);
        lines.sort(function (a, b) { return a.at.getTime() - b.at.getTime(); });
        buffer.length = 0;
        var added = false;
        lines.forEach(function (l) { buffer.push(l); if (noteStream(l.stream)) added = true; });
        if (added) paintStreamOptions();

        ui.clear(queryState);
        queryState.setAttribute('data-state', st);
        queryState.removeAttribute('data-reason');
        if (st === 'stale') queryState.appendChild(ui.stateBlock('stale', { reason: e.reason, detail: e.message || '' }));
        var capped = lines.length >= state.cap;
        queryState.appendChild(el('p', {
          'data-lines': String(lines.length),
          text: fmt.num(lines.length) + ' line' + (lines.length === 1 ? '' : 's') + ' from ' + range.words +
            (capped ? ', the newest ' + fmt.num(state.cap) + ' only. Raise the buffer or narrow the query for more' : '') + '.'
        }));
        (Array.isArray(d.warnings) ? d.warnings : []).forEach(function (w) {
          queryState.appendChild(el('p.hint', { text: 'Loki warned: ' + String(w) }));
        });
        var at = new Date(env.at || Date.now());
        queryState.appendChild(el('p.readstamp', { 'data-read-at': at.toISOString(), text: 'Read ' + fmt.clock(at) }));
        repaintFiltered();
        view.follow(true);
        A.announce(fmt.num(lines.length) + ' log lines from ' + range.words + '.');
      });
    }

    function stopFollow() {
      if (closeStream) { closeStream(); closeStream = null; }
      if (replayStop) replayStop();
      state.connection = S.CLOSED || 'closed';
    }

    function startFollow() {
      buffer.length = 0;
      state.received = 0;
      if (!isLive) { loadSample(); return; }
      view.say('Waiting for the first line.');
      paintStatus();
      if (streamLabel && !capabilityRefusal()) open(streamLabel);
    }

    function setMode(next, byUser) {
      if (byUser && next === state.mode) {
        if (next === 'query') { runQuery(); return; }
        state.connectionNote = isLive ? 'Already following the live tail.' : 'Already showing the bundled sample.';
        view.follow(true);
        paintStatus();
        A.announce(state.connectionNote);
        return;
      }
      state.mode = next;
      followModeBtn.setAttribute('aria-pressed', next === 'follow' ? 'true' : 'false');
      queryModeBtn.setAttribute('aria-pressed', next === 'query' ? 'true' : 'false');
      tailWrap.setAttribute('data-log-mode', next);
      queryBar.hidden = next !== 'query';
      queryState.hidden = next !== 'query';
      sourceSlot.hidden = next !== 'follow';
      followBtn.hidden = next !== 'follow';
      if (replayBtn) replayBtn.hidden = next !== 'follow';
      if (!byUser) return;
      rememberParams();
      if (next === 'query') {
        stopFollow();
        paintHealth();
        runQuery();
      } else {
        queryGen += 1;
        ui.clear(queryState);
        startFollow();
        paintHealth();
      }
    }

    var replayBtn = null;
    var replayStop = null;
    var sample = null;

    function loadSample() {
      sample = sample || sampleBuffer();
      state.streams = sampleStreams(sample);
      paintStreamOptions();
      view.reset();
      sample.forEach(function (line) {
        buffer.push(line);
        if (matches(line)) view.append(line);
      });
      view.flushNow();
      if (!view.count()) view.say('The bundled dataset has no application to derive a line from.');
      paintStatus();
    }

    setMode(state.mode, false);

    if (!isLive) {
      sourceSlot.appendChild(ui.stateBlock('sample', {
        detail: 'These lines are a bundled sample, not a tail. Run the console API with ARGUS_LOKI_URL set to tail Loki.'
      }));

      sample = sampleBuffer();
      var sampleNames = sampleStreams(sample);
      if (requested !== 'all' && sampleNames.indexOf(requested) === -1) { notFound(requested); return; }

      if (state.mode === 'follow') loadSample();
      else { state.streams = sampleNames; paintStreamOptions(); runQuery(); }
      paintHealth();

      var replayTimer = null;
      var replayAt = 0;
      replayStop = function () {
        if (!replayTimer) return;
        window.clearInterval(replayTimer);
        replayTimer = null;
        replayBtn.textContent = 'Replay the bundled sample';
        replayBtn.setAttribute('aria-pressed', 'false');
      };
      replayBtn = ui.btn('Replay the bundled sample', {
        variant: 'link',
        title: 'Appends the bundled lines again, one every two seconds, to exercise the append path.',
        onClick: function () {
          if (replayTimer) {
            replayStop();
            A.announce('Replay stopped.');
            return;
          }
          replayBtn.textContent = 'Stop the replay';
          replayBtn.setAttribute('aria-pressed', 'true');
          A.announce('Replaying the bundled sample, one line every two seconds. This is not a live tail.');
          replayTimer = window.setInterval(function () {
            if (!stillMine() || !document.body.contains(view.node)) {
              window.clearInterval(replayTimer);
              replayTimer = null;
              return;
            }
            var seed = sample[replayAt % sample.length];
            replayAt += 1;
            take({
              at: new Date(A.data.now.getTime() + replayAt * 2000),
              level: seed.level,
              stream: seed.stream,
              text: seed.text
            });
          }, 2000);
        }
      });
      replayBtn.setAttribute('aria-pressed', 'false');
      replayBtn.hidden = state.mode !== 'follow';
      moreMenu.parentNode.insertBefore(replayBtn, moreMenu);
      A.onLeave(function () {
        if (replayTimer) { window.clearInterval(replayTimer); replayTimer = null; }
        view.stop();
      });
      return;
    }

    A.onLeave(function () {
      view.stop();
      if (closeStream) { closeStream(); closeStream = null; }
    });

    function refuse(message, st, reason) {
      state.connectionNote = '';
      if (state.mode === 'follow') view.say('Nothing is streaming.');
      paintStatus();
      ui.clear(sourceSlot);
      sourceSlot.appendChild(ui.stateBlock(st || 'failed', {
        reason: reason,
        detail: message + ' Nothing below is a reading.'
      }));
    }

    function capabilityRefusal() {
      var caps = A.capabilities();
      if (!caps) {
        return { st: 'failed', reason: 'no-capabilities', message: 'The console API has not said what it can stream, so this screen has not asked it for a tail.' };
      }
      if (caps.auth && caps.auth.authenticated === false) {
        return { st: 'signedOut', reason: 'unauthenticated', message: 'You are not signed in, so the console API will refuse a log stream.' };
      }
      if (!caps.streams || !caps.streams.logs) {
        return {
          st: 'notConfigured', reason: 'not-configured',
          message: 'Loki is not configured on the console API, so there is no log pipeline to tail. Set ' +
            'ARGUS_LOKI_URL and restart the API.'
        };
      }
      return null;
    }

    if (state.mode === 'follow') view.say('Waiting for the first line.');
    paintStatus();
    paintHealth();

    function open(label) {
      if (closeStream) { closeStream(); closeStream = null; }
      var selector = selectorFor(label, state.stream);
      var topics = state.stream === 'all' ? [] : [state.stream];

      closeStream = A.subscribe(
        '/api/logs/stream?query=' + encodeURIComponent(selector) + '&limit=' + DEFAULT_BUFFER,
        topics,
        {
          on: {
            line: function (payload) {
              if (!stillMine() || state.mode !== 'follow') return;
              take(decodeLine(payload));
            },
            dropped: function (payload) {
              if (!stillMine()) return;
              state.dropped += (payload && Number(payload.lines)) || 1;
              paintStatus();
              announceThrottled('The server dropped lines because this browser could not keep up.');
            },
            gap: function (payload) {
              if (!stillMine()) return;
              state.gaps += 1;
              state.connectionNote = payload && payload.message
                ? String(payload.message)
                : 'Some lines from the gap could not be replayed.';
              paintStatus();
            },
            unavailable: function (payload) {
              if (!stillMine()) return;
              state.connectionNote = payload && payload.message
                ? String(payload.message)
                : 'The log pipeline is not answering the console API.';
              paintStatus();
            },
            note: function (payload) {
              if (!stillMine()) return;
              state.connectionNote = payload && payload.message ? String(payload.message) : '';
              paintStatus();
            }
          },
          onState: function (next, info) {
            if (!stillMine()) return;
            state.connection = next;
            if (next === S.OPEN) {
              state.connectionNote = info && info.resumedFrom
                ? 'Resumed from event ' + info.resumedFrom + '.'
                : '';
              recordBeat(ui.BEAT.UP);
              announceThrottled('The log stream is connected.');
            } else if (next === S.RETRYING) {
              state.connectionNote = (info && info.message ? info.message + ' ' : '') +
                'Reconnecting in ' + Math.round((info && info.inMs ? info.inMs : 0) / 1000) + ' s, attempt ' +
                fmt.num(info && info.attempt ? info.attempt : 1) + '.';
              recordBeat(ui.BEAT.DOWN, info && info.message);
              announceThrottled('The log stream was interrupted and is reconnecting.');
            } else if (next === S.OPENING) {
              state.connectionNote = 'Opening the stream.';
              recordBeat(ui.BEAT.PENDING);
            }
            paintStatus();
            paintHealth();
          },
          onUnavailable: function (why) {
            if (!stillMine()) return;
            closeStream = null;
            state.connection = S.CLOSED;
            var w = why || {};
            refuse(w.message || 'The console API refused the stream.',
              A.envelopeState({ ok: false, mode: A.MODE.LIVE, error: w }), w.reason);
            paintHealth();
          }
        });
    }

    function loadStreamNames(label) {
      return A.read('/api/logs/label-values?name=' + encodeURIComponent(label), { ttlMs: 30000 }).then(function (env) {
        if (!stillMine()) return null;
        if (!env.ok) return null;
        var payload = env.data || {};
        var values = Array.isArray(payload.values) ? payload.values.filter(function (v) { return typeof v === 'string'; }) : null;
        (values || []).forEach(noteStream);
        paintStreamOptions();
        return values;
      }, function () { return null; });
    }

    var refusal = capabilityRefusal();
    if (refusal) refuse(refusal.message, refusal.st, refusal.reason);
    if (refusal && refusal.st === 'signedOut') {
      if (state.mode === 'query') runQuery();
      return;
    }

    A.read('/api/logs/labels', { ttlMs: 30000 }).then(function (env) {
      if (!stillMine()) return;

      if (!env.ok) {
        if (!refusal) {
          var e = env.error || {};
          refuse('The console API could not list Loki\'s labels: ' + (e.message || 'it gave no reason.') +
            ' Without a label this screen has no selector to tail, so it has opened nothing.',
            A.envelopeState(env), e.reason);
        }
        if (state.mode === 'query') runQuery();
        return;
      }

      var labelNames = Array.isArray((env.data || {}).labels) ? env.data.labels : [];
      var label = null;
      for (var i = 0; i < STREAM_LABELS.length; i++) {
        if (labelNames.indexOf(STREAM_LABELS[i]) !== -1) { label = STREAM_LABELS[i]; break; }
      }

      if (!label) {
        if (!refusal) {
          refuse('Loki holds ' + fmt.num(labelNames.length) + ' labels and none of them is one this screen ' +
            'recognises as naming a stream (' + STREAM_LABELS.join(', ') + '). It will not guess a ' +
            'selector, so it has opened nothing.', 'notConfigured', 'no-stream-label');
        }
        if (state.mode === 'query') runQuery();
        return;
      }

      streamLabel = label;
      loadStreamNames(label).then(function (values) {
        if (!stillMine()) return;
        if (requested !== 'all' && values && values.indexOf(requested) === -1) { notFound(requested); return; }
        if (state.mode === 'query') runQuery();
        else if (!refusal) open(label);
      });
    });
  }
})();
