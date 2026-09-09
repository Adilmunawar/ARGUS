/* ML and geospatial: Dagster assets, model runs, Ray Serve endpoints, imagery.
 *
 * Classic script, no modules, ES5 only, no network. Nodes are built through
 * ui.el; asset names and model run names come from a pipeline definition that
 * somebody outside this codebase edits, so they are never treated as markup.
 */
(function () {
  'use strict';

  var A = window.ARGUS, ui = A.ui, el = ui.el, fmt = ui.fmt;

  var STATE_TONE = { fresh: 'ok', stale: 'warn', failed: 'bad' };

  /* ------------------------------------------------------------ helpers --- */

  /**
   * Everything that would have to re-run after this asset, transitively.
   *
   * This was a fixpoint relaxation: an outer loop that rescanned every pipeline
   * and every one of its upstreams until nothing changed, which for a chain --
   * and asset graphs are mostly chains -- is O(assets squared x upstreams).
   * It is called once per failed asset when rendering the failure banner.
   *
   * A reverse adjacency map built once, then one breadth-first walk, is
   * O(assets + edges) and gives the same answer. The map is rebuilt only when
   * the pipeline collection is replaced.
   */
  var reverseEdges = null, reverseFor = null;
  function downstreamMap() {
    var d = A.data;
    if (reverseFor === d.pipelines && reverseEdges) return reverseEdges;
    reverseFor = d.pipelines;
    reverseEdges = Object.create(null);
    d.pipelines.forEach(function (p) {
      (p.upstream || []).forEach(function (u) {
        (reverseEdges[u] = reverseEdges[u] || []).push(p.asset);
      });
    });
    return reverseEdges;
  }

  function downstreamOf(asset) {
    var edges = downstreamMap();
    var seen = Object.create(null);
    var queue = [asset], out = [];
    seen[asset] = true;
    while (queue.length) {
      var next = edges[queue.shift()] || [];
      for (var i = 0; i < next.length; i++) {
        if (seen[next[i]]) continue;
        seen[next[i]] = true;
        out.push(next[i]);
        queue.push(next[i]);
      }
    }
    return out;
  }

  /* ---------------------------------------------------------- pipelines --- */

  function pipelinesTab() {
    var d = A.data;

    var nodes = d.pipelines.map(function (p) {
      return { id: p.asset, label: p.asset, kind: p.state };
    });
    var edges = [];
    d.pipelines.forEach(function (p) {
      p.upstream.forEach(function (u) { edges.push([u, p.asset]); });
    });

    var failed = d.pipelines.filter(function (p) { return p.state === 'failed'; });

    var cols = [
      { key: 'asset', label: 'Asset', render: function (p) { return el('span.mono', { text: p.asset }); } },
      {
        key: 'state', label: 'State', status: true,
        sort: function (p) { return ['failed', 'stale', 'fresh'].indexOf(p.state); },
        render: function (p) { return ui.pill(p.state, STATE_TONE[p.state] || 'idle'); }
      },
      { key: 'lastRun', label: 'Last run', sort: function (p) { return p.lastRun.getTime(); }, render: function (p) { return fmt.time(p.lastRun); } },
      { key: 'durationS', label: 'Duration', align: 'right', render: function (p) { return fmt.dur(p.durationS); } },
      { key: 'sla', label: 'SLA', align: 'right', render: function (p) { return fmt.num(p.sla) + ' h'; } },
      {
        key: 'materialise', label: 'Actions', sortable: false,
        render: function (p) {
          return ui.btn('Materialise ' + p.asset, {
            variant: 'ghost',
            title: 'Queue a Dagster materialisation of ' + p.asset,
            onClick: function () {
              var down = downstreamOf(p.asset);
              A.flash('info', 'Materialising ' + p.asset,
                down.length
                  ? 'Dagster will re-run ' + down.join(', ') + ' once it succeeds.'
                  : 'Nothing downstream depends on it, so this is the only run queued.');
            }
          });
        }
      }
    ];

    return el('div.stack', [
      // The table below maps failed -> 'bad'. The banner said the same thing
      // in amber, so the worst state on the screen read as the milder one.
      failed.length ? el('div.callout.bad', [
        el('strong', { text: failed.map(function (p) { return p.asset; }).join(', ') + ' failed' }),
        el('p', {
          text: failed.map(function (p) {
            var down = downstreamOf(p.asset);
            return p.asset + ' last ran ' + fmt.ago(p.lastRun) + ' and failed after ' + fmt.dur(p.durationS) + '. '
              + (down.length
                ? 'Downstream: ' + down.join(', ') + ' cannot refresh until it succeeds.'
                : 'Nothing downstream re-runs, which makes this the last mile: the Mills dashboard keeps '
                  + 'serving the previous predictions, silently, until somebody looks at this row.');
          }).join(' ')
        })
      ]) : null,
      ui.card('Asset dependency graph',
        // Edges are [upstream, downstream], which is what the drawing needs and
        // the opposite of "depends on". The verb has to match the direction.
        ui.graph(nodes, edges, {
          label: 'Dagster asset graph, upstream assets on the left',
          verb: 'feeds'
        }), { flush: true }),
      ui.card('Assets', [
        ui.table(cols, d.pipelines, {
          caption: 'Dagster assets with freshness state, last run, duration and freshness SLA',
          empty: 'No asset is defined in this deployment.',
          sortKey: 'state', sortDir: 'asc'
        }),
        el('p.hint', {
          text: 'The graph shows shape, not health: it has no way to carry freshness. The table is the '
            + 'authoritative view of which assets are stale, and it is the one to read first.'
        })
      ])
    ]);
  }

  /* ------------------------------------------------------------- models --- */

  function promoteModel(m) {
    A.confirmDestructive({
      title: 'Promote ' + m.run,
      match: m.run,
      environment: A.state.env,
      confirmLabel: 'Promote ' + m.run,
      /* confirmDestructive otherwise states "This cannot be undone from the
         console", which directly contradicts the detail below it: promotion is
         the one action on this screen the code itself describes as reversible.
         The ladder is still right -- it repoints live serving -- but the
         sentence has to be true. */
      reversible: 'The previous run stays in the registry, so this can be undone by promoting it back.',
      detail: 'Promoting ' + m.run + ' repoints the Ray Serve endpoint at it. Every prediction served after '
        + 'the swap comes from this run, including requests already in flight behind the gateway. The '
        + 'previous run stays in the registry, so rolling back is another promotion rather than a rebuild.',
      blast: 'Serving ' + m.metric + ' ' + fmt.num(m.value, 3) + ', trained on '
        + fmt.num(m.rows) + ' rows ' + fmt.ago(m.trained) + '.',
      onConfirm: function () {
        A.flash('warn', m.run + ' promoted',
          'Ray Serve is draining the previous replica set. Watch p95 on the Endpoints tab for the next ten minutes.');
      }
    });
  }

  function modelsTab() {
    var d = A.data;

    var cols = [
      { key: 'run', label: 'Run', render: function (m) { return el('span.mono', { text: m.run }); } },
      { key: 'metric', label: 'Metric' },
      { key: 'value', label: 'Value', align: 'right', render: function (m) { return fmt.num(m.value, 3); } },
      { key: 'trained', label: 'Trained', sort: function (m) { return m.trained.getTime(); }, render: function (m) { return fmt.time(m.trained); } },
      { key: 'rows', label: 'Training rows', align: 'right', render: function (m) { return fmt.num(m.rows); } },
      {
        key: 'promoted', label: 'Promoted', status: true,
        sort: function (m) { return m.promoted ? 0 : 1; },
        render: function (m) { return m.promoted ? ui.pill('live', 'ok') : ui.pill('not promoted', 'idle'); }
      },
      {
        key: 'actions', label: 'Actions', sortable: false,
        render: function (m) {
          if (m.promoted) return el('span.muted', { text: 'serving' });
          return ui.btn('Promote ' + m.run, {
            variant: 'ghost',
            title: 'Repoint the Ray Serve endpoint at ' + m.run,
            onClick: function () { promoteModel(m); }
          });
        }
      }
    ];

    return el('div.stack', [
      ui.card('Model runs', ui.table(cols, d.models, {
        caption: 'Model runs with their headline metric, training set size and promotion state',
        empty: 'No model run has been registered.',
        sortKey: 'trained', sortDir: 'desc'
      }))
    ]);
  }

  /* ---------------------------------------------------------- endpoints --- */

  function canaryDialog(e) {
    A.dialog({
      title: 'Set canary for ' + e.name,
      body: function () {
        var out = el('output', { for: 'canary-pct', text: fmt.pct(e.canary, 0) });
        var input = el('input', {
          type: 'range', id: 'canary-pct', min: '0', max: '100', step: '5', value: String(e.canary),
          'aria-label': 'Percentage of traffic sent to the canary replica of ' + e.name,
          'aria-valuetext': fmt.pct(e.canary, 0),
          on: {
            input: function () {
              out.textContent = fmt.pct(Number(input.value), 0);
              input.setAttribute('aria-valuetext', fmt.pct(Number(input.value), 0));
            }
          }
        });
        return [
          el('p', { text: 'Traffic on ' + e.name + ' is currently ' + fmt.pct(e.canary, 0) + ' canary, backed by ' + e.backend + '.' }),
          el('div.formrow', [
            el('label.fieldlabel', { for: 'canary-pct', text: 'Canary share' }),
            input,
            out
          ]),
          el('p.hint', { text: 'Steps of five. Anything finer is noise at ' + fmt.num(e.rps, 1) + ' requests per second.' })
        ];
      },
      actions: function (close) {
        return [
          ui.btn('Cancel', { variant: 'ghost', onClick: close }),
          ui.btn('Set canary on ' + e.name, {
            variant: 'primary',
            onClick: function () {
              var v = Number(document.getElementById('canary-pct').value);
              close();
              A.flash('ok', 'Canary set on ' + e.name,
                fmt.pct(v, 0) + ' of traffic now reaches the canary replica.');
            }
          })
        ];
      }
    });
  }

  function endpointsTab() {
    var d = A.data;

    var cols = [
      { key: 'name', label: 'Endpoint', render: function (e) { return el('span.mono', { text: e.name }); } },
      { key: 'backend', label: 'Backend' },
      { key: 'p95', label: 'p95', align: 'right', render: function (e) { return fmt.ms(e.p95); } },
      { key: 'rps', label: 'Requests/s', align: 'right', render: function (e) { return fmt.num(e.rps, 1); } },
      {
        key: 'canary', label: 'Canary', align: 'right',
        render: function (e) {
          return el('div.col', [
            ui.bar(e.canary / 100, { label: fmt.pct(e.canary, 0) + ' of traffic on the canary replica of ' + e.name }),
            el('span.muted', { text: fmt.pct(e.canary, 0) })
          ]);
        }
      },
      { key: 'state', label: 'State', status: true, render: function (e) { return ui.pill(e.state, e.state === 'ok' ? 'ok' : 'warn'); } },
      {
        key: 'actions', label: 'Actions', sortable: false,
        render: function (e) {
          return ui.btn('Set canary on ' + e.name, {
            variant: 'ghost', onClick: function () { canaryDialog(e); }
          });
        }
      }
    ];

    return el('div.stack', [
      ui.card('Serving endpoints', ui.table(cols, d.endpoints, {
        caption: 'Ray Serve inference endpoints with latency, load and canary share',
        empty: 'No inference endpoint is deployed.',
        sortKey: 'name', sortDir: 'asc'
      }))
    ]);
  }

  /* ----------------------------------------------------------- imagery --- */

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function dateLabel(dt) {
    return dt.getUTCDate() + ' ' + MONTHS[dt.getUTCMonth()] + ' ' + dt.getUTCFullYear();
  }

  function imageryTab() {
    var d = A.data;
    var cards = [];
    var rows = [];

    for (var i = 0; i < 8; i++) {
      // Deterministic by index: the prototype has no scene catalogue, and a
      // random value here would change every screenshot and break the tests.
      var cover = 62 + ((i * 17 + 9) % 38);
      var scenes = 8 + ((i * 5 + 3) % 7);
      var end = new Date(d.now.getTime() - i * 14 * 86400000);
      var start = new Date(end.getTime() - 13 * 86400000);
      var tone = cover >= 90 ? 'ok' : cover >= 70 ? 'warn' : 'bad';
      var word = cover >= 90 ? 'complete' : cover >= 70 ? 'partial' : 'gaps';
      var label = dateLabel(start) + ' to ' + dateLabel(end);

      rows.push({ label: label, cover: cover, scenes: scenes, word: word, tone: tone });

      cards.push(ui.card(null, [
        el('div.muted', { text: label }),
        el('div.num', { text: fmt.pct(cover, 0) }),
        ui.pill(word, tone),
        el('div.hint', { text: fmt.num(scenes) + ' Sentinel-2 scenes' })
      ]));
    }

    var stacInput = el('input.field', {
      type: 'search', id: 'stac-q', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'collection=sentinel-2-l2a bbox=73.9,31.3,74.6,31.8'
    });

    var coverCols = [
      { key: 'label', label: 'Fortnight' },
      { key: 'cover', label: 'Coverage', align: 'right', render: function (r) { return fmt.pct(r.cover, 0); } },
      { key: 'scenes', label: 'Scenes', align: 'right', render: function (r) { return fmt.num(r.scenes); } },
      { key: 'word', label: 'State', status: true, render: function (r) { return ui.pill(r.word, r.tone); } }
    ];

    return el('div.stack', [
      ui.card('Cloud-free coverage, last eight fortnights', [
        el('div.grid.grid-4', cards),
        ui.table(coverCols, rows, {
          caption: 'Cloud-free Sentinel-2 coverage by fortnight, the text equivalent of the cards above',
          empty: 'No coverage has been computed.'
        })
      ]),
      ui.card('STAC search', [
        el('div.formrow', [
          el('label.fieldlabel', { for: 'stac-q', text: 'Query pgstac' }),
          stacInput
        ]),
        ui.btn('Search the catalogue', {
          variant: 'primary',
          onClick: function () {
            var q = stacInput.value.trim();
            // Deterministic from the query itself, so the same search always
            // reports the same count in a demo or a screenshot.
            /* The count was a function of the query LENGTH, so a narrower
               query claimed more items: the placeholder's own bbox query
               returned 1,270 against a whole-collection count of 120. It is
               derived from the mirror's actual coverage now, and a filtered
               query can only ever return a subset of it. */
            var whole = 0;
            for (var wi = 0; wi < 8; wi++) whole += 8 + ((wi * 5 + 3) % 7);
            var n = q ? Math.max(1, Math.round(whole * 0.18)) : whole;
            A.flash('info', 'STAC search returned ' + fmt.num(n) + ' items',
              q ? 'Query: ' + q : 'Empty query, so the whole sentinel-2-l2a collection was counted.');
          }
        }),
        el('p.hint', {
          text: 'pgstac holds the item metadata on pg-01. TiTiler reads the COGs out of argus-sentinel and '
            + 'serves the map tiles directly, so no tile is ever pre-rendered or cached to disk twice.'
        })
      ])
    ]);
  }

  /* -------------------------------------------------------------- screen --- */

  A.screen('ml', {
    title: 'ML & geospatial',
    crumb: 'ML & geospatial',
    render: function (mount, ctx) {
      var d = A.data;

      var tiles = el('div.tiles', d.gpu.cards.map(function (c) {
        return ui.statTile('GPU ' + c.id + ' utilisation', fmt.pct(c.util, 0), {
          note: c.model + ' · ' + fmt.num(c.memUsedGB) + ' of ' + fmt.num(c.memTotalGB)
            + ' GB · ' + fmt.num(c.tempC) + '°C · ' + c.user
        });
      }).concat([
        ui.statTile('Queued jobs', fmt.num(d.gpu.queue.length), {
          note: d.gpu.queue.length
            ? d.gpu.queue[0].job + ' waiting ' + fmt.dur(d.gpu.queue[0].waitingMin * 60) + ' for ' + d.gpu.queue[0].user
            : 'Nothing is waiting for a card'
        })
      ]));

      mount.appendChild(ui.pageHeader('ML & geospatial',
        'Dagster assets, model runs, inference endpoints and imagery coverage, all on ' + d.gpu.name + '.'));
      mount.appendChild(tiles);
      mount.appendChild(ui.tabs([
        { id: 'pipelines', label: 'Pipelines', render: pipelinesTab },
        { id: 'models', label: 'Models', render: modelsTab },
        { id: 'endpoints', label: 'Endpoints', render: endpointsTab },
        { id: 'imagery', label: 'Imagery', render: imageryTab }
      ], {
        label: 'ML and geospatial sections',
        /* The breadcrumb and the document title already name the segment
           (#/ops/cost read "Operations / cost" and titled itself "cost"),
           so the panel has to match it. identity and security have always
           read it; these three ignored it and opened tab zero. */
        initial: (ctx && ctx.rest && ctx.rest[0]) || null
      }));
    }
  });
})();
