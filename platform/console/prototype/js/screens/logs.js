/* Argus Console: Logs.
 *
 * A tail, not a table. The rules that make a streaming list survive a real
 * throughput are all structural, and every one of them is load-bearing:
 *
 *  - THE APPEND PATH NEVER RE-RENDERS. New lines are queued and flushed once
 *    per animation frame into a single document fragment. A burst of nine
 *    hundred lines becomes one appendChild, not nine hundred re-paints of the
 *    whole list.
 *  - THE BUFFER IS BOUNDED. The oldest node is removed as the newest arrives,
 *    so the DOM holds a fixed number of lines whatever the stream does.
 *  - FOLLOW YIELDS TO THE OPERATOR. Scrolling up releases the tail; the stream
 *    keeps arriving but the viewport stops moving, because a log that jumps
 *    while somebody is reading it is unusable.
 *  - THE REGION IS aria-live="off". A streaming log on a live region reads
 *    every line at a screen-reader user and makes the rest of the console
 *    unreachable. The operator asks for the latest line instead, and the
 *    console echoes what it announced so the request is visible.
 *
 * And the honesty rule the rest of the console holds to: when the API is not
 * answering, this screen says nothing is streaming and labels the bundled
 * buffer as bundled. It never presents a replay as a live tail.
 */
(function () {
  'use strict';

  var A = window.ARGUS, ui = A.ui, el = ui.el, fmt = ui.fmt;

  function registerScreen(id, def) {
    if (typeof A.screen === 'function') { A.screen(id, def); return; }
    document.addEventListener('DOMContentLoaded', function () { A.screen(id, def); });
  }

  var LEVELS = ui.LOG_LEVELS;
  var LEVEL_LABEL = ui.LOG_LEVEL_LABEL;
  var BUFFERS = [200, 500, 2000];
  var DEFAULT_BUFFER = 500;
  var KEEP = 2000;
  var ANNOUNCE_GAP_MS = 4000;

  /* ------------------------------------------------------- the sample buffer --- */

  /*
   * The bundled buffer.
   *
   * Derived from the fixture applications so it reads like this estate rather
   * than like lorem ipsum, and generated from a fixed seed so the same screen
   * twice produces the same text. It is capped independently of the dataset,
   * because the stress harness inflates the fixtures fifty-fold and a log view
   * is not the place to find out.
   */
  var SAMPLE_LINES = 180;
  var SAMPLE_APPS = 6;

  function sampleTexts(app) {
    return [
      'GET /api/' + app.name + '/summary 200 in ' + app.p95 + ' ms',
      'cache lookup ' + app.name + ':summary hit',
      'reconciled ' + app.name + ' desired state, no change',
      'POST /api/' + app.name + '/ingest 202 accepted, 41 records',
      'upstream ' + (app.depends && app.depends.databases ? app.depends.databases[0] : 'postgres') + ' answered in 9 ms',
      'slow query over 500 ms on ' + app.name + ', plan cached',
      'retrying publish to ' + (app.depends && app.depends.queues ? app.depends.queues[0] : 'argus.ingest') + ' after a timeout',
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

  /* ------------------------------------------------------------ live decoding --- */

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

  /* ------------------------------------------------------------------ screen --- */

  registerScreen('logs', {
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

      mount.appendChild(ui.pageHeader(
        'Logs',
        'One multiplexed stream per screen, appended without re-rendering the list, bounded at the ' +
          'buffer size you choose. The tail yields the moment you scroll up.',
        [refresh]));
      mount.appendChild(host);

      var gen = 0;
      var live = true;
      A.onLeave(function () { live = false; });

      function paint() {
        gen += 1;
        var mine = gen;
        ui.clear(host);
        A.probe().then(function () {
          if (live && mine === gen) build(host, refresh, rest, params, function () { return live && mine === gen; });
        });
      }

      paint();
    }
  });

  function build(host, refresh, rest, params, stillMine) {
    var mode = A.storeMode();
    var isLive = mode === A.MODE.LIVE;

    refresh.title = isLive
      ? 'Drop the stream and open it again from the newest line.'
      : 'There is no console API to stream from. Nothing on this screen came from one.';

    var state = {
      stream: rest[0] || params.stream || 'all',
      level: params.level || 'all',
      text: params.q || '',
      cap: DEFAULT_BUFFER,
      received: 0,
      dropped: 0,
      gaps: 0,
      shown: 0,
      following: true,
      streams: [],
      connection: A.STREAM ? A.STREAM.OFF : 'off',
      connectionNote: '',
      beats: [],
      lastAnnounceAt: 0
    };

    var buffer = [];

    /* ------------------------------------------------------------- controls */

    var streamSel = el('select.field', { id: 'log-stream' }, [el('option', { value: 'all', text: 'All streams' })]);
    var levelSel = el('select.field', { id: 'log-level' }, [el('option', { value: 'all', text: 'All levels' })].concat(
      LEVELS.map(function (l) { return el('option', { value: l, text: LEVEL_LABEL[l] }); })));
    var capSel = el('select.field', { id: 'log-buffer' }, BUFFERS.map(function (n) {
      return el('option', { value: String(n), text: fmt.num(n) + ' lines' });
    }));
    var textInput = el('input.field', {
      id: 'log-filter', type: 'search', value: state.text,
      placeholder: 'Contains...', autocomplete: 'off', spellcheck: 'false'
    });

    levelSel.value = LEVELS.indexOf(state.level) === -1 ? 'all' : state.level;
    capSel.value = String(state.cap);

    var followBtn = ui.btn('Following the tail', {
      title: 'The view scrolls with the newest line. Scrolling up releases it.'
    });
    followBtn.setAttribute('aria-pressed', 'true');

    var jumpBtn = ui.btn('Jump to the newest line', {
      variant: 'ghost',
      onClick: function () { view.follow(true); }
    });
    jumpBtn.hidden = true;

    var announceBtn = ui.btn('Announce the latest line', {
      onClick: function () {
        var line = view.latest();
        var sentence = line
          ? fmt.stamp(line.at) + ', ' + line.stream + ', ' + line.level + ': ' + line.text
          : 'No line is in the buffer.';
        A.announce(sentence);
        echo.textContent = 'Announced: ' + sentence;
      }
    });

    var clearBtn = ui.btn('Clear the view', {
      variant: 'ghost',
      onClick: function () {
        buffer.length = 0;
        state.shown = 0;
        view.say('Cleared. Lines that arrive from here on will appear below.');
        paintStatus();
        A.announce('Log view cleared.');
      }
    });

    var counters = el('p.logstat');
    var echo = el('p.logstat');

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
      if (state.stream !== 'all' && line.stream !== state.stream) return false;
      if (state.level !== 'all' && line.level !== state.level) return false;
      if (state.text) {
        var needle = state.text.toLowerCase();
        if (line.text.toLowerCase().indexOf(needle) === -1 &&
            line.stream.toLowerCase().indexOf(needle) === -1) return false;
      }
      return true;
    }

    /* A filter change is an operator action, not a stream event, so this is the
       one path that rebuilds the list -- once, from the buffer that was kept. */
    function repaintFiltered() {
      view.reset();
      var keep = [];
      for (var i = 0; i < buffer.length; i++) if (matches(buffer[i])) keep.push(buffer[i]);
      if (!keep.length) {
        view.say(buffer.length
          ? 'No line in the buffer matches this filter.'
          : 'No line has arrived yet.');
        state.shown = 0;
        paintStatus();
        return;
      }
      view.appendMany(keep.slice(-state.cap));
    }

    function take(line) {
      if (!line) return;
      state.received += 1;
      buffer.push(line);
      if (buffer.length > KEEP) buffer.splice(0, buffer.length - KEEP);
      if (state.streams.indexOf(line.stream) === -1) {
        state.streams.push(line.stream);
        paintStreamOptions();
      }
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
      var S = A.STREAM || {};
      if (state.connection === S.OPEN) return 'streaming';
      if (state.connection === S.OPENING) return 'connecting';
      if (state.connection === S.RETRYING) return 'reconnecting';
      if (state.connection === S.CLOSED) return 'closed';
      return isLive ? 'not connected' : 'not streaming';
    }

    function paintStatus() {
      var parts = [];
      parts.push(connectionWord().charAt(0).toUpperCase() + connectionWord().slice(1) + '.');
      parts.push(fmt.num(state.shown) + ' of ' + fmt.num(buffer.length) + ' buffered lines shown, ' +
        fmt.num(state.cap) + ' kept in the view.');
      if (isLive) parts.push(fmt.num(state.received) + ' received this session.');
      if (state.dropped) {
        parts.push(fmt.num(state.dropped) + ' line' + (state.dropped === 1 ? '' : 's') +
          ' were dropped by the server because this browser could not keep up.');
      }
      if (state.gaps) {
        parts.push(state.gaps + ' resume' + (state.gaps === 1 ? '' : 's') +
          ' could not replay every missed line.');
      }
      if (state.connectionNote) parts.push(state.connectionNote);
      counters.textContent = parts.join(' ');
    }

    function announceThrottled(message) {
      var at = Date.now();
      if (at - state.lastAnnounceAt < ANNOUNCE_GAP_MS) return;
      state.lastAnnounceAt = at;
      A.announce(message);
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

    var controls = el('div.logbar', [
      el('label.fieldlabel', { for: 'log-stream', text: 'Stream' }), streamSel,
      el('label.fieldlabel', { for: 'log-level', text: 'Level' }), levelSel,
      el('label.fieldlabel', { for: 'log-filter', text: 'Filter' }), textInput,
      el('label.fieldlabel', { for: 'log-buffer', text: 'Buffer' }), capSel,
      followBtn, jumpBtn, announceBtn, clearBtn
    ]);

    /* --------------------------------------------------------------- panels */

    var sourceSlot = el('div');
    host.appendChild(sourceSlot);
    host.appendChild(ui.card('Tail', [controls, view.node, counters, echo]));

    var healthBody = el('div');
    host.appendChild(ui.card('Stream health', healthBody));

    function paintHealth() {
      ui.clear(healthBody);

      if (!isLive) {
        healthBody.appendChild(ui.emptyState(
          'No stream has been opened',
          'The console API is not answering, so there is no connection to record. This panel shows the ' +
            'result of every connection attempt once there is one.'));
        return;
      }

      var beats = state.beats;
      var u = ui.uptimeOf(beats, { windowMs: null });
      healthBody.appendChild(el('div.hbrow', [
        el('span.hbrow-name', { text: 'Log stream' }),
        ui.heartbeatBar(beats, {
          slots: 50,
          name: 'The log stream',
          label: ui.heartbeatSentence(beats, { name: 'The log stream' })
        }),
        ui.pill(connectionWord(), state.connection === (A.STREAM || {}).OPEN ? 'ok'
          : state.connection === (A.STREAM || {}).RETRYING ? 'warn' : 'idle')
      ]));

      healthBody.appendChild(el('div.hbscale', [
        el('span', { text: 'oldest attempt' }),
        el('span', { text: 'newest attempt' })
      ]));

      if (u.ratio === null) {
        healthBody.appendChild(el('p.hint', {
          text: 'No connection attempt has completed yet, so there is no figure to give. ' +
            'This panel will not compute one from an empty history.'
        }));
      } else {
        healthBody.appendChild(ui.dl([
          ['Attempts recorded', fmt.num(u.counted)],
          ['Opened', fmt.num(u.up)],
          ['Interrupted', fmt.num(u.down)],
          ['Share opened', fmt.pct(u.ratio * 100, 1)],
          ['History covers', u.coveredMs ? fmt.dur(u.coveredMs / 1000) : 'a single sample']
        ]));
        healthBody.appendChild(el('p.hint', {
          text: 'This is the history of this browser tab\'s own connection, not of the log pipeline. ' +
            'It is discarded when you leave the screen, so no figure here is offered for a window ' +
            'longer than it covers.'
        }));
      }

      var incidents = ui.incidentsOf(beats);
      if (incidents.length) {
        healthBody.appendChild(el('div.sectiontitle', { text: 'Interruptions' }));
        healthBody.appendChild(el('div.stack', incidents.slice(-6).reverse().map(function (inc) {
          return el('div.row', [
            el('span', {
              text: 'Went from ' + inc.fromWord + ' to ' + inc.toWord +
                (inc.heldMs !== null ? ' after ' + fmt.dur(inc.heldMs / 1000) : '') + '.'
            }),
            el('span.num', { text: inc.at ? fmt.stamp(new Date(inc.at)) : '-' })
          ]);
        })));
      }
    }

    function recordBeat(status, note) {
      state.beats.push({ at: Date.now(), status: status, msg: note || null });
      if (state.beats.length > 200) state.beats.splice(0, state.beats.length - 200);
      paintHealth();
    }

    /* ------------------------------------------------------------ the source */

    if (!isLive) {
      sourceSlot.appendChild(el('div.callout.warn', [
        el('strong', { text: 'Nothing is streaming: the console API is not answering.' }),
        el('p', {
          text: 'The buffer below is the bundled sample, not a tail. Start the API with `npm start` in ' +
            'platform/console/server, with ARGUS_LOKI_URL pointing at the deployed Loki, and reload to ' +
            'follow the real thing.'
        })
      ]));

      var sample = sampleBuffer();
      state.streams = sampleStreams(sample);
      paintStreamOptions();
      sample.forEach(function (line) {
        buffer.push(line);
        if (matches(line)) view.append(line);
      });
      view.flushNow();
      if (!view.count()) view.say('The bundled dataset has no application to derive a line from.');
      paintStatus();
      paintHealth();

      var replayTimer = null;
      var replayAt = 0;
      var replayBtn = ui.btn('Replay the bundled sample', {
        title: 'Appends the bundled lines again, one every two seconds, to exercise the append path.',
        onClick: function () {
          if (replayTimer) {
            window.clearInterval(replayTimer);
            replayTimer = null;
            replayBtn.textContent = 'Replay the bundled sample';
            replayBtn.setAttribute('aria-pressed', 'false');
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
      controls.appendChild(replayBtn);
      A.onLeave(function () {
        if (replayTimer) { window.clearInterval(replayTimer); replayTimer = null; }
        view.stop();
      });
      return;
    }

    A.onLeave(function () { view.stop(); });

    sourceSlot.appendChild(el('div.callout.info', [
      el('strong', { text: 'Live tail.' }),
      el('p', {
        text: 'One multiplexed stream carries every topic this screen subscribes to, because a browser ' +
          'allows six connections per origin and a stream that never completes holds one of them for as ' +
          'long as it is open.'
      })
    ]));

    view.say('Waiting for the first line.');
    paintStatus();
    paintHealth();

    A.read('/api/logs/labels', { ttlMs: 30000 }).then(function (env) {
      if (!stillMine()) return;
      if (!env.ok || !env.data) return;
      var names = env.data.streams || env.data.values || env.data.labels;
      if (!Array.isArray(names)) return;
      names.forEach(function (n) {
        if (typeof n === 'string' && state.streams.indexOf(n) === -1) state.streams.push(n);
      });
      paintStreamOptions();
    });

    var topics = state.stream === 'all' ? [] : [state.stream];

    A.subscribe('/api/logs/stream?limit=' + DEFAULT_BUFFER, topics, {
      on: {
        line: function (payload) {
          if (!stillMine()) return;
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
        note: function (payload) {
          if (!stillMine()) return;
          state.connectionNote = payload && payload.message ? String(payload.message) : '';
          paintStatus();
        }
      },
      onState: function (next, info) {
        if (!stillMine()) return;
        var S = A.STREAM;
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
        state.connectionNote = why.message;
        view.say(why.message);
        paintStatus();
        ui.clear(sourceSlot);
        sourceSlot.appendChild(el('div.callout.warn', [
          el('strong', { text: 'This screen could not open a live stream.' }),
          el('p', { text: why.message }),
          el('p', { text: 'Nothing below is a reading. No line is being invented to fill the gap.' })
        ]));
      }
    });
  }
})();
