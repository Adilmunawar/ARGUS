(function () {
  'use strict';

  var A = window.ARGUS, ui = A.ui, el = ui.el, fmt = ui.fmt;

  var ROUTE = 'storage';

  function registerScreen(id, def) {
    if (typeof A.screen === 'function') { A.screen(id, def); return; }
    document.addEventListener('DOMContentLoaded', function () { A.screen(id, def); });
  }

  function bytes(n) {
    if (n === null || n === undefined || isNaN(n)) return null;
    var abs = Math.abs(n);
    if (abs < 1024) return fmt.num(n) + ' B';
    if (abs < 1048576) return fmt.num(n / 1024, 1) + ' KB';
    if (abs < 1073741824) return fmt.num(n / 1048576, 1) + ' MB';
    if (abs < 1099511627776) return fmt.num(n / 1073741824, 1) + ' GB';
    return fmt.num(n / 1099511627776, 2) + ' TB';
  }

  function bytesOr(n) {
    var v = bytes(n);
    return v === null ? 'unknown' : v;
  }

  function stamp(iso) {
    if (!iso) return null;
    var t = Date.parse(iso);
    if (isNaN(t)) return String(iso);
    return new Date(t).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  }

  function stampCell(iso) {
    var s = stamp(iso);
    return s === null ? el('span.muted', { text: 'not reported' }) : el('span.mono', { text: s });
  }

  function unknownCell(reason, label) {
    var text = reason || 'The server gave no reason.';
    return el('span', [
      ui.pill(label || 'unknown', 'idle', { title: text }),
      el('span.sr', { text: ' ' + text })
    ]);
  }

  var APPROX_SIZE_TITLE =
    'Summed from volume metadata rather than by listing objects, so it includes volume overhead and space ' +
    'still held by deleted or superseded versions. Browse the bucket and press Calculate for a counted total.';

  var ZERO_COUNT_TITLE =
    'The volume servers report no needle count for this bucket. That is not the same as the bucket being empty: ' +
    'on this cluster a volume can report a file count of zero even where a listing finds objects. Browse the ' +
    'bucket, or press Calculate on a prefix, for a counted number of objects.';
  var NEEDLE_COUNT_TITLE =
    'Needles, not objects. The filer splits every file at 4 MB and stores each version of a versioned object ' +
    'separately, so a 1 GB backup is about 256 needles. Press Calculate on a prefix for a counted object number.';

  var LIFECYCLE_TITLE =
    'SeaweedFS applies Expiration.Days as a filer TTL path rule stamped on each needle at write time. Objects ' +
    'written before this rule existed carry no TTL and will never expire, so a declared retention does not ' +
    'retroactively bound a bucket that was already filling.';

  var SHIELD_TITLE =
    'This verdict comes from one attempted delete of one locked object version, in one probe bucket, at boot ' +
    '-- not from reading this bucket\'s configuration. It is the whole store\'s answer, shown per row. Object ' +
    'Lock is implemented in the S3 gateway alone, so it says nothing about a delete that reaches the filer ' +
    'directly; the Immutability panel carries that separately.';

  function shieldTone(verdict) {
    if (verdict === 'enforced') return 'ok';
    if (verdict === 'not-enforced') return 'bad';
    return 'idle';
  }

  function shieldLabel(verdict) {
    if (verdict === 'enforced') return 'enforced';
    if (verdict === 'not-enforced') return 'NOT enforced';
    return verdict ? String(verdict) : 'not proven';
  }

  function reasonHint(reason) {
    if (reason === 'http-400') return 'The console API rejected the bucket, prefix or key as malformed before it asked the store.';
    if (reason === 'http-403') {
      return 'The object store refused the request. The console holds per-bucket grants from buckets.yaml and no ' +
        'store-wide grant, so a bucket that is not declared there is invisible to it. A rejected signature and a ' +
        'drifted clock look the same from here; `docker compose logs console` carries the exact reason.';
    }
    if (reason === 'http-404') return 'The object store says no such bucket or key. If it was listed a moment ago, it has been removed since.';
    if (reason === 'http-413') return 'The object is larger than the console\'s 5 MB preview cap.';
    if (reason === 'http-415') return 'That file type is not on the preview allowlist. The allowlist decides the type, so an uploaded HTML file cannot be served back as script into this origin.';
    if (reason === 'http-429') return 'Another prefix calculation is already running. They are serialised on purpose: this is the one operation here that reads every key under a prefix, and two at once double the load on the store.';
    if (reason === 'http-500') return 'The console API failed internally and deliberately did not put the detail in the response. It is in `docker compose logs console`.';
    if (reason === 'http-503') return 'The console API could not reach the object store. Check `docker compose ps` in platform/compose.';
    if (reason === 'http-504') return 'The object store did not answer the console in time. It may be compacting, or the volume servers may be unreachable from the console container.';
    if (reason === 'unreachable') return 'Nothing answered at all, so this is the console API itself rather than the object store behind it.';
    if (reason === 'timeout') return 'The console API was reached but did not finish in time. That is a slow answer, not a missing one, so retrying is reasonable.';
    if (reason === 'cancelled') return 'The console abandoned this request when it left the screen that asked for it. Nothing is wrong with the server.';
    return null;
  }

  var alive = true;
  var generation = 0;

  function guard() {
    var mine = generation;
    return function () { return alive && mine === generation; };
  }

  function sampleState() {
    return ui.emptyState(
      'Not available on sample data',
      'This screen reads the object store through the console API. Start it with `npm start` in ' +
      'platform/console/server, or bring the stack up with `docker compose up -d` in platform/compose, and reload.');
  }

  function staleBanner(env) {
    var why = env.error && env.error.message ? env.error.message : '';
    if (why && !/[.!?]$/.test(why)) why += '.';
    return el('div.callout.warn', [
      el('strong', { text: 'Showing the last value that could be read.' }),
      el('p', {
        text: 'A fresh read failed' + (why ? ': ' + why : '.') +
          ' The figures below were read at ' + stamp(new Date(env.at).toISOString()) + '.'
      })
    ]);
  }

  function failureState(env, path, retry) {
    var e = env.error || {};
    var hint = reasonHint(e.reason);
    return ui.errorState(
      'This could not be read',
      (e.message || 'The request failed.') + (hint ? ' ' + hint : ''),
      function () { A.forget(path); retry(); });
  }

  function loadInto(host, path, opts, render) {
    opts = opts || {};
    var current = guard();
    var rerun = function () { loadInto(host, path, opts, render); };

    ui.clear(host);
    host.appendChild(ui.skeleton(opts.skeletonRows || 3));

    A.read(path, opts).then(function (env) {
      if (!current()) return;
      ui.clear(host);

      if (env.mode === A.MODE.SAMPLE) { host.appendChild(sampleState()); if (opts.onSettled) opts.onSettled(false); return; }
      if (!env.ok) { host.appendChild(failureState(env, path, rerun)); if (opts.onSettled) opts.onSettled(false); return; }
      if (env.stale) host.appendChild(staleBanner(env));

      render(host, env.data, env);
      if (opts.onSettled) opts.onSettled(true);
    });
  }

  function panel(title, path, opts, render) {
    var body = el('div');
    var card = ui.card(title, body, { actions: opts && opts.actions });
    loadInto(body, path, opts, render);
    return card;
  }

  function renderHealth(body, d) {
    var caps = A.capabilities() || {};

    body.appendChild(el('div.tiles', [
      ui.statTile('Signed S3 call', d.s3 && d.s3.signedCallOk ? 'accepted' : 'refused', {
        note: d.s3 && d.s3.signedCallOk
          ? 'A real signed ListObjectsV2 against a granted bucket. Every component can be up while this fails.'
          : (d.s3 && d.s3.message) || 'No reason was given.'
      }),
      ui.statTile('Writable volumes',
        d.writable ? 'yes' : 'no',
        {
          note: d.writable
            ? 'The master has a writable volume for at least one collection.' +
              (caps.writesAllowed ? '' : ' This console is read-only and will not write to any of them.')
            : 'The master has no writable volume. Writes will fail until a volume is allocated or a slot is freed.'
        }),
      ui.statTile('Free volume slots',
        d.freeVolumes === null || d.freeVolumes === undefined ? 'unknown' : fmt.num(d.freeVolumes),
        {
          note: d.freeVolumes === null || d.freeVolumes === undefined
            ? 'The master did not report the topology, so this is not a zero.'
            : 'Slots the master can still allocate a volume into.'
        })
    ]));

    if (d.s3 && !d.s3.signedCallOk) {
      body.appendChild(el('div.callout.bad', [
        el('strong', { text: 'The object store refused a signed call' + (d.s3.reason ? ' (' + d.s3.reason + ')' : '') + '.' }),
        el('p', { text: d.s3.message || 'No reason was given.' })
      ]));
    }

    if (d.topologyReachable === false) {
      body.appendChild(el('div.callout.warn', [
        el('strong', { text: 'Not every volume server answered this console.' }),
        el('p', {
          text: 'Sizes and capacity below are computed only from the servers that did, so they are floors rather ' +
            'than totals. The unreachable ones are listed in the table.'
        })
      ]));
    }

    body.appendChild(ui.table([
      { key: 'name', label: 'Component', render: function (c) { return el('code.mono', { text: c.name }); } },
      {
        key: 'reachable', label: 'State', status: true,
        render: function (c) {
          return c.reachable
            ? ui.pill('reachable', 'ok')
            : ui.pill('unreachable', 'bad', { title: c.error || 'No reason was given.' });
        }
      },
      { key: 'version', label: 'Version', render: function (c) { return c.version ? el('span.mono', { text: c.version }) : el('span.muted', { text: 'not reported' }); } },
      {
        key: 'latencyMs', label: 'Latency', align: 'right',
        render: function (c) { return fmt.ms(c.latencyMs); }
      },
      {
        key: 'error', label: 'Detail',
        render: function (c) { return c.error ? el('span.muted', { text: c.error }) : el('span.muted', { text: '-' }); }
      }
    ], d.components || [], {
      caption: 'Object store components, whether each answered, and how long it took',
      rowKey: function (c) { return c.name; },
      empty: 'The console did not probe any component.'
    }));

    body.appendChild(el('p.hint', { text: 'Probed at ' + stamp(d.at) + '.' }));
  }

  function renderCapacity(body, d) {
    var totals = d.totals;
    var slots = d.slots || {};
    var slotBytes = (slots.free !== null && slots.free !== undefined && slots.volumeSizeMB)
      ? slots.free * slots.volumeSizeMB * 1048576
      : null;

    body.appendChild(el('div.tiles', [
      ui.statTile('Free on disk', totals ? bytesOr(totals.freeBytes) : 'unknown', {
        note: totals
          ? bytesOr(totals.usedBytes) + ' used of ' + bytesOr(totals.allBytes)
          : 'No volume server answered, so there is no disk figure to show.'
      }),
      ui.statTile('Free volume slots',
        slots.free === null || slots.free === undefined ? 'unknown' : fmt.num(slots.free),
        {
          note: slots.max === null || slots.max === undefined
            ? 'The master did not report the slot ceiling.'
            : 'of ' + fmt.num(slots.max) + ', each ' + fmt.num(slots.volumeSizeMB) + ' MB'
        }),
      ui.statTile('Room before writes fail',
        d.available === null || d.available === undefined ? 'unknown' : bytesOr(d.available),
        {
          note: d.binding === 'volume-slots' ? 'The volume-slot ceiling is what binds.'
            : d.binding === 'disk' ? 'The disk is what binds.'
              : 'Which ceiling binds could not be worked out.'
        })
    ]));

    if (d.binding === 'volume-slots' && slotBytes !== null && totals) {
      body.appendChild(el('div.callout.warn', [
        el('strong', { text: 'The volume-slot ceiling binds, not the disk.' }),
        el('p', {
          text: fmt.num(slots.free) + ' free slots x ' + fmt.num(slots.volumeSizeMB) + ' MB is ' + bytesOr(slotBytes) +
            ', while the disk still has ' + bytesOr(totals.freeBytes) + ' free. Past the slot ceiling, writes fail ' +
            'with "no writable volumes" and the disk graph shows nothing wrong. Raise -max on the volume server, ' +
            'or add one.'
        })
      ]));
    } else if (d.binding === 'disk' && totals) {
      body.appendChild(el('div.callout.info', [
        el('strong', { text: 'The disk binds, not the volume slots.' }),
        el('p', {
          text: bytesOr(totals.freeBytes) + ' free on disk' +
            (slotBytes !== null ? ', against ' + bytesOr(slotBytes) + ' of unallocated volume slots' : '') + '.'
        })
      ]));
    } else if (d.binding !== 'volume-slots' && d.binding !== 'disk') {
      body.appendChild(el('div.callout.warn', [
        el('strong', { text: 'Which ceiling binds is unknown.' }),
        el('p', {
          text: (totals ? '' : 'No volume server answered, so there are no free bytes to compare. ') +
            (slotBytes === null ? 'The master did not report free slots, so there is no slot ceiling to compare. ' : '') +
            'Both numbers are needed to say which limit is closer, so neither is guessed at.'
        })
      ]));
    }

    if (d.partial) {
      body.appendChild(el('div.callout.warn', [
        el('strong', { text: 'These totals are partial.' }),
        el('p', { text: 'At least one volume server did not answer. Its capacity is not counted below and is not assumed to be zero.' })
      ]));
    }

    body.appendChild(ui.table([
      { key: 'url', label: 'Volume server', render: function (n) { return el('code.mono', { text: n.url }); } },
      {
        key: 'ok', label: 'State', status: true,
        render: function (n) {
          return n.ok ? ui.pill('answered', 'ok') : ui.pill('unreachable', 'bad', { title: n.error || 'No reason was given.' });
        }
      },
      { key: 'dataCenter', label: 'Site', render: function (n) { return (n.dataCenter || '-') + ' / ' + (n.rack || '-'); } },
      {
        key: 'volumes', label: 'Volumes', align: 'right',
        render: function (n) {
          if (n.maxVolumes === null || n.maxVolumes === undefined) return fmt.num(n.volumes);
          return fmt.num(n.volumes) + ' of ' + fmt.num(n.maxVolumes);
        }
      },
      {
        key: 'slotsFree', label: 'Free slots', align: 'right',
        render: function (n) { return n.slotsFree === null || n.slotsFree === undefined ? unknownCell('The master did not report this node\'s slot ceiling.') : fmt.num(n.slotsFree); }
      },
      {
        key: 'usedBytes', label: 'Used', align: 'right',
        render: function (n) { return n.ok ? bytes(n.usedBytes) : unknownCell(n.error || 'This volume server did not answer.'); }
      },
      {
        key: 'freeBytes', label: 'Free', align: 'right',
        render: function (n) { return n.ok ? bytes(n.freeBytes) : unknownCell(n.error || 'This volume server did not answer.'); }
      },
      {
        key: 'allBytes', label: 'Disk', align: 'right',
        render: function (n) { return n.ok ? bytes(n.allBytes) : unknownCell(n.error || 'This volume server did not answer.'); }
      }
    ], d.nodes || [], {
      caption: 'Volume servers, their volume slots and their disk',
      sortKey: 'url',
      rowKey: function (n) { return n.url; },
      empty: 'The master reported no volume server.'
    }));

    body.appendChild(el('p.hint', { text: 'Measured on ' + (d.scope || 'an unnamed scope') + '. Read at ' + stamp(d.at) + '.' }));
  }

  function renderLocks(body, d) {
    if (!d.determined) {
      body.appendChild(el('div.callout.warn', [
        el('strong', { text: 'Immutability has not been proven on this stack.' }),
        el('p', { text: d.message || 'No lock probe result is available.' })
      ]));
      return;
    }

    var tone = shieldTone(d.verdict);
    body.appendChild(el('div.row', [
      ui.pill('Object lock: ' + shieldLabel(d.verdict), tone, { title: SHIELD_TITLE }),
      el('span.muted', { text: 'probed ' + (stamp(d.probedAt) || 'at an unrecorded time') })
    ]));

    body.appendChild(el('p', { text: d.detail || 'The probe recorded no detail.' }));

    body.appendChild(el('div.callout.' + (d.filerBypass === 'closed' ? 'info' : 'warn'), [
      el('strong', {
        text: d.filerBypass === 'closed'
          ? 'The filer path was probed and refused the delete too.'
          : 'Object lock lives in the S3 gateway. The filer path is ' + (d.filerBypass || 'unknown') + '.'
      }),
      el('p', { text: d.filerBypassDetail || 'This run recorded nothing about the filer path.' }),
      el('p', { text: d.defaultRetentionDetail || 'This run recorded nothing about whether the bucket default reaches real objects.' }),
      el('p.hint', { text: 'Bucket default retention stamped on write: ' + (d.defaultRetentionStamped || 'unknown') + '.' })
    ]));

    body.appendChild(el('p.hint', {
      text: 'Scope: ' + (d.scope || 'unknown') + '. ' + SHIELD_TITLE
    }));

    if (d.devOverrides) {
      body.appendChild(el('div.callout.info', [
        el('strong', { text: 'Lock settings here are development overrides.' }),
        el('p', {
          text: 'This stack applied ' + d.devOverrides.mode + ' for ' + fmt.num(d.devOverrides.days) +
            ' day' + (d.devOverrides.days === 1 ? '' : 's') + (d.profile ? ' under the "' + d.profile + '" profile' : '') +
            ', not what buckets.yaml declares. The declared value is in the Declared column, and it is what a ' +
            'production apply would use. A GOVERNANCE lock can be lifted by a privileged caller; COMPLIANCE cannot.'
        })
      ]));
    }

    if (d.missingLock && d.missingLock.length) {
      body.appendChild(el('div.callout.bad', [
        el('strong', { text: 'Declared as locked, but no lock was recorded: ' + d.missingLock.join(', ') }),
        el('p', {
          text: 'Object lock can only be turned on when a bucket is created, so this cannot be repaired in place. ' +
            'The bucket has to be recreated with locking enabled and its contents copied across.'
        })
      ]));
    }

    if (d.problems && d.problems.length) {
      body.appendChild(el('div.callout.warn', [
        el('strong', { text: 'storage-init recorded ' + fmt.num(d.problems.length) + ' problem' + (d.problems.length === 1 ? '' : 's') + '.' }),
        el('ul.treelist', d.problems.map(function (p) {
          return el('li.treelist-item', { text: typeof p === 'string' ? p : JSON.stringify(p) });
        }))
      ]));
    }

    body.appendChild(ui.table([
      { key: 'name', label: 'Bucket', render: function (b) { return el('code.mono', { text: b.name }); } },
      {
        key: 'mode', label: 'Applied',
        render: function (b) { return b.mode + ' for ' + fmt.num(b.days) + ' day' + (b.days === 1 ? '' : 's'); }
      },
      {
        key: 'declared', label: 'Declared',
        render: function (b) { return b.declared ? el('span.mono', { text: b.declared }) : el('span.muted', { text: 'not declared' }); }
      },
      {
        key: 'enforced', label: 'Enforcement', status: true,
        render: function (b) {
          return el('span', [
            ui.pill(shieldLabel(b.enforced), shieldTone(b.enforced), { title: SHIELD_TITLE }),
            b.probeError ? el('span.muted', { text: ' ' + b.probeError }) : null
          ]);
        }
      }
    ], d.buckets || [], {
      caption: 'Buckets with object lock applied, and whether enforcement was proven',
      sortKey: 'name',
      rowKey: function (b) { return b.name; },
      empty: 'No bucket on this stack has object lock applied.'
    }));
  }

  function sizeCell(b) {
    if (b.unknownSize) return unknownCell(b.unknownSizeReason || 'The volume topology reported no size for this bucket.');
    var v = bytes(b.diskBytes);
    if (v === null) return unknownCell('The volume servers did not report a footprint for this bucket.');
    return el('span', { title: APPROX_SIZE_TITLE }, [el('span', { text: 'approx. ' + v })]);
  }

  function reclaimableCell(b) {
    if (b.unknownSize) return unknownCell(b.unknownSizeReason || 'The volume topology reported nothing for this bucket.');
    if (b.reclaimableBytes === null || b.reclaimableBytes === undefined) {
      return unknownCell('The volume servers did not report a deleted-byte count for this bucket.');
    }
    return el('span', {
      title: 'Space still held on disk by deleted or superseded needles. It returns only when the volume is ' +
        'compacted, so live is ' + bytesOr(b.liveBytes) + ' of the ' + bytesOr(b.diskBytes) + ' footprint.'
    }, [el('span', { text: bytesOr(b.reclaimableBytes) })]);
  }

  function countCell(b) {
    if (b.unknownSize) return unknownCell(b.unknownSizeReason || 'The volume topology reported nothing for this bucket.');
    if (b.needles === null || b.needles === undefined) {
      return unknownCell(b.objectsReason || ZERO_COUNT_TITLE, 'not counted');
    }
    if (!b.needles) return unknownCell(ZERO_COUNT_TITLE, 'not counted');
    var live = (b.liveNeedles === null || b.liveNeedles === undefined) ? null : b.liveNeedles;
    return el('span', { title: NEEDLE_COUNT_TITLE }, [
      el('span', { text: fmt.num(b.needles) }),
      live === null ? null : el('span.muted', { text: ' (' + fmt.num(live) + ' live)' })
    ]);
  }

  function lockCell(b) {
    if (!b.lock) {
      return b.lockDeclared
        ? ui.pill('declared, not applied', 'bad', { title: 'buckets.yaml declares ' + b.lockDeclared + ' but no lock was recorded on this bucket.' })
        : el('span.muted', { text: 'none' });
    }
    var label = b.lock + ' ' + fmt.num(b.lockDays) + ' d';
    var title = SHIELD_TITLE + (b.lockDeclared ? ' Declared: ' + b.lockDeclared + '.' : '');
    return el('span', [
      ui.pill(label + ' - ' + shieldLabel(b.lockEnforced), shieldTone(b.lockEnforced), { title: title }),
      el('span.sr', { text: ' ' + title })
    ]);
  }

  function renderBuckets(body, d) {
    if (d.declaredError) {
      body.appendChild(el('div.callout.warn', [
        el('strong', { text: 'The declared bucket file could not be read.' }),
        el('p', { text: d.declaredError })
      ]));
    }

    if (d.inventorySource && d.inventorySource.indexOf('storage-init') !== 0) {
      body.appendChild(el('div.callout.warn', [
        el('strong', { text: 'This is the declared bucket list, not a verified one.' }),
        el('p', {
          text: 'storage-init has not recorded an inventory on this stack, so these names come from ' +
            d.inventorySource + '. A bucket here may not exist, and a bucket that exists may be missing.' +
            (d.inventoryError ? ' ' + d.inventoryError : '')
        })
      ]));
    }

    if (!d.topologyOk) {
      body.appendChild(el('div.callout.warn', [
        el('strong', { text: 'No size could be measured for any bucket.' }),
        el('p', { text: (d.topologyError || 'The volume servers could not be read.') + ' Sizes below read unknown rather than zero.' })
      ]));
    }

    var drift = d.drift || {};
    if (drift.declaredButMissing && drift.declaredButMissing.length) {
      body.appendChild(el('div.callout.bad', [
        el('strong', { text: 'Declared but missing: ' + drift.declaredButMissing.join(', ') }),
        el('p', { text: 'buckets.yaml declares these and the store does not have them. Anything writing to them is failing right now.' })
      ]));
    }
    if (drift.existsButUndeclared && drift.existsButUndeclared.length) {
      body.appendChild(el('div.callout.warn', [
        el('strong', { text: 'Exists but undeclared: ' + drift.existsButUndeclared.join(', ') }),
        el('p', { text: 'These are in the store and not in buckets.yaml, so nothing declares their owner, lifecycle or lock. They will not be recreated by an apply.' })
      ]));
    }

    body.appendChild(ui.table([
      {
        key: 'name', label: 'Bucket',
        render: function (b) { return A.link(b.name, ROUTE, null, { bucket: b.name }, 'rlink'); }
      },
      { key: 'diskBytes', label: 'On disk', align: 'right', render: sizeCell, sort: function (b) { return b.unknownSize ? null : b.diskBytes; } },
      { key: 'reclaimableBytes', label: 'Reclaimable', align: 'right', render: reclaimableCell, sort: function (b) { return b.unknownSize ? null : b.reclaimableBytes; } },
      { key: 'needles', label: 'Needles', align: 'right', render: countCell, sort: function (b) { return b.needles || null; } },
      {
        key: 'versioning', label: 'Versioning',
        render: function (b) {
          if (b.versioning === null || b.versioning === undefined) return unknownCell('Neither the store record nor buckets.yaml says whether versioning is on.');
          return b.versioning ? ui.pill('on', 'info') : el('span.muted', { text: 'off' });
        }
      },
      { key: 'lock', label: 'Object lock', status: true, render: lockCell },
      {
        key: 'replication', label: 'Replication',
        render: function (b) { return el('span.muted', { text: b.replication || 'not configured' }); }
      },
      { key: 'owner', label: 'Owner', render: function (b) { return b.owner ? el('code.mono', { text: b.owner }) : el('span.muted', { text: 'not declared' }); } },
      {
        key: 'lifecycleDays', label: 'Lifecycle', align: 'right',
        render: function (b) {
          if (!b.lifecycleDays) return el('span.muted', { text: 'none' });
          return el('span', { title: LIFECYCLE_TITLE }, [el('span', { text: fmt.num(b.lifecycleDays) + ' d, from the rule onward' })]);
        }
      },
      {
        key: 'backup', label: 'Backup',
        render: function (b) {
          if (!b.backup) return el('span.muted', { text: 'none declared' });
          return el('span', { title: 'Declared in buckets.yaml, not verified by this console.' },
            [b.backup.tool + ' ' + b.backup.schedule]);
        }
      }
    ], d.buckets || [], {
      caption: 'Buckets in the object store, with size, lock state and declared intent',
      sortKey: 'name',
      rowKey: function (b) { return b.name; },
      empty: 'No bucket was found and none is declared.'
    }));

    if ((d.buckets || []).some(function (b) { return b.lifecycleDays; })) {
      body.appendChild(el('div.callout.warn', [
        el('strong', { text: 'A lifecycle rule here bounds what is written after it, not what is already there.' }),
        el('p', { text: LIFECYCLE_TITLE })
      ]));
    }

    body.appendChild(el('p.hint', {
      text: 'Bucket list from ' + (d.inventorySource || 'an unnamed source') + '. Counts are needles from ' +
        (d.countsFrom || 'the master\'s volume metadata') + ', never a listing: the filer splits at 4 MB and keeps ' +
        'every version, so needles exceed objects. Reclaimable is disk still held by deleted needles until the ' +
        'volume is compacted. A green lock means one delete probe was refused, once, against one bucket. ' +
        'Read at ' + stamp(d.at) + '.'
    }));
  }

  function objectsPath(bucket, prefix, cursor) {
    var p = '/api/storage/objects?bucket=' + encodeURIComponent(bucket);
    if (prefix) p += '&prefix=' + encodeURIComponent(prefix);
    if (cursor) p += '&cursor=' + encodeURIComponent(cursor);
    return p;
  }

  function breadcrumb(bucket, prefix) {
    var nav = el('nav.crumbs', { 'aria-label': 'Object path' });
    nav.appendChild(A.link('All buckets', ROUTE, null, null, 'crumb-link'));
    nav.appendChild(el('span.sep', { 'aria-hidden': 'true', text: '/' }));

    var atRoot = !prefix;
    if (atRoot) nav.appendChild(el('b', { text: bucket }));
    else nav.appendChild(A.link(bucket, ROUTE, null, { bucket: bucket }, 'crumb-link'));

    if (prefix) {
      var parts = prefix.split('/');
      var walked = '';
      for (var i = 0; i < parts.length; i++) {
        if (i === parts.length - 1 && parts[i] === '') break;
        walked += parts[i] + '/';
        nav.appendChild(el('span.sep', { 'aria-hidden': 'true', text: '/' }));
        var label = parts[i] === '' ? '(empty)' : parts[i];
        if (walked === prefix) nav.appendChild(el('b', { text: label }));
        else nav.appendChild(A.link(label, ROUTE, null, { bucket: bucket, prefix: walked }, 'crumb-link'));
      }
    }
    return nav;
  }

  function listRows(bucket, prefix, data) {
    var rows = [];
    (data.folders || []).forEach(function (f) {
      rows.push({ kind: 'folder', id: f, prefix: f, name: f.slice(prefix.length), sizeBytes: null, modifiedAt: null });
    });
    (data.objects || []).forEach(function (o) {
      rows.push({
        kind: 'object', id: o.key, key: o.key, name: o.key.slice(prefix.length),
        sizeBytes: o.sizeBytes, modifiedAt: o.modifiedAt, etag: o.etag, storageClass: o.storageClass
      });
    });
    return rows;
  }

  function listingTable(bucket, prefix, rows, selectedKey) {
    return ui.table([
      {
        key: 'name', label: 'Name',
        sort: function (r) { return (r.kind === 'folder' ? 'A ' : 'B ') + r.name; },
        render: function (r) {
          if (r.kind === 'folder') {
            return el('span', [
              A.link(r.name, ROUTE, null, { bucket: bucket, prefix: r.prefix }, 'rlink'),
              el('span.muted', { text: '  folder' })
            ]);
          }
          return el('span', [
            A.link(r.name, ROUTE, null, { bucket: bucket, prefix: prefix, key: r.key }, 'rlink'),
            r.key === selectedKey ? el('span.muted', { text: '  shown' }) : null
          ]);
        }
      },
      {
        key: 'sizeBytes', label: 'Size', align: 'right',
        render: function (r) {
          if (r.kind === 'folder') {
            return unknownCell('S3 has no directory size. Press Calculate below after opening this folder to walk it.', 'not counted');
          }
          return bytes(r.diskBytes);
        }
      },
      { key: 'modifiedAt', label: 'Last modified', render: function (r) { return r.kind === 'folder' ? el('span.muted', { text: '-' }) : stampCell(r.modifiedAt); } },
      {
        key: 'storageClass', label: 'Class',
        render: function (r) { return r.storageClass ? el('span.muted', { text: r.storageClass }) : el('span.muted', { text: '-' }); }
      }
    ], rows, {
      caption: 'Folders and objects under ' + bucket + '/' + prefix,
      sortKey: 'name',
      rowKey: function (r) { return r.id; },
      empty: 'Nothing is stored under this prefix.',
      onRow: function (r) {
        if (r.kind === 'folder') A.go(ROUTE, null, { bucket: bucket, prefix: r.prefix });
        else A.go(ROUTE, null, { bucket: bucket, prefix: prefix, key: r.key });
      }
    });
  }

  function calculatePanel(bucket, prefix) {
    var out = el('div');
    var path = '/api/storage/prefix-size?bucket=' + encodeURIComponent(bucket) +
      (prefix ? '&prefix=' + encodeURIComponent(prefix) : '');

    var button = ui.btn('Calculate size of this prefix', {
      variant: 'ghost',
      onClick: function () {
        button.setDisabled(true);
        loadInto(out, path, {
          ttlMs: 0,
          timeoutMs: 30000,
          skeletonRows: 1,
          onSettled: function () { button.setDisabled(false); }
        }, function (host, d) {
          var size = bytesOr(d.sizeBytes);
          var text = d.complete
            ? size + ' in ' + fmt.num(d.objectCount) + ' object' + (d.objectCount === 1 ? '' : 's')
            : 'at least ' + size + ' in at least ' + fmt.num(d.objectCount) + ' objects';
          host.appendChild(el('div.row', [
            el('strong', { text: text }),
            el('span.muted', {
              text: 'walked ' + fmt.num(d.keysScanned) + ' keys in ' + fmt.ms(d.elapsedMs)
            })
          ]));
          if (!d.complete) {
            host.appendChild(el('p.hint', {
              text: d.note || ('The walk stopped at its budget of ' + fmt.num(d.budgetKeys) + ' keys or ' +
                fmt.ms(d.budgetMs) + '. This is a lower bound, not the total.')
            }));
          }
          if (A.announce) A.announce(text);
        });
      }
    });

    return el('div.stack', [el('div.row', [button, el('span.hint', { text: 'Reads every key under this prefix. Budgeted, and serialised across the whole console.' })]), out]);
  }

  function renderListing(host, bucket, prefix, selectedKey, data) {
    if (data.keyRepair && data.keyRepair.applied) {
      host.appendChild(el('div.callout.info', [
        el('strong', { text: 'The names below were repaired before they were shown.' }),
        el('p', { text: data.keyRepair.reason || 'This server returns corrupted keys when listing a versioned bucket.' }),
        el('p', {
          text: 'Another S3 client listing this bucket will report the uncorrected names. ' +
            fmt.num(data.keyRepair.keysScanned) + ' keys were read to assemble this level.'
        })
      ]));
    }

    var rows = listRows(bucket, prefix, data);
    var table = listingTable(bucket, prefix, rows, selectedKey);
    host.appendChild(table);

    var footer = el('div.row');
    host.appendChild(footer);

    var folderCount = (data.folders || []).length;
    var objectCount = (data.objects || []).length;
    footer.appendChild(el('span.hint', {
      text: fmt.num(folderCount) + ' folder' + (folderCount === 1 ? '' : 's') + ' and ' +
        fmt.num(objectCount) + ' object' + (objectCount === 1 ? '' : 's') +
        ' at this level, read at ' + stamp(data.at) + '.'
    }));

    if (data.cursor) {
      var cursor = data.cursor;
      var more = ui.btn('Load the next page', {
        variant: 'ghost',
        onClick: function () {
          more.setDisabled(true);
          var current = guard();
          A.read(objectsPath(bucket, prefix, cursor), { timeoutMs: 30000 }).then(function (env) {
            if (!current()) return;
            if (!env.ok) {
              more.setDisabled(false);
              footer.appendChild(el('span.muted', {
                text: (env.error && env.error.message) || 'The next page could not be read.'
              }));
              return;
            }
            var next = listRows(bucket, prefix, env.data);
            rows = rows.concat(next);
            table.setRows(rows);
            cursor = env.data.cursor;
            if (!cursor) more.parentNode.removeChild(more);
            else more.setDisabled(false);
            if (A.announce) A.announce(fmt.num(next.length) + ' more entries loaded');
          });
        }
      });
      footer.appendChild(more);
    } else if (data.truncated) {
      host.appendChild(el('div.callout.warn', [
        el('strong', { text: 'This level is incomplete.' }),
        el('p', {
          text: 'The listing stopped after ' + fmt.num(data.pageSize) + ' keys and the server returned no cursor to ' +
            'continue from, so there are objects here that are not shown. Narrow the prefix to see them.'
        })
      ]));
    }
  }

  function previewPath(bucket, key) {
    return '/api/storage/preview?bucket=' + encodeURIComponent(bucket) + '&key=' + encodeURIComponent(key);
  }

  var TEXT_PREVIEW_CHARS = 20000;
  var IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];

  function looksLikeImage(key) {
    var lower = String(key).toLowerCase();
    for (var i = 0; i < IMAGE_EXT.length; i++) {
      if (lower.length >= IMAGE_EXT[i].length && lower.lastIndexOf(IMAGE_EXT[i]) === lower.length - IMAGE_EXT[i].length) return true;
    }
    return false;
  }

  function previewError(host, status, message) {
    host.appendChild(ui.errorState(
      'This object could not be previewed',
      message || reasonHint('http-' + status) || ('The console API answered ' + status + '.')));
  }

  function loadPreview(host, bucket, key) {
    var current = guard();
    var url = previewPath(bucket, key);

    ui.clear(host);
    host.appendChild(ui.skeleton(2));

    if (looksLikeImage(key)) {
      var img = el('img', { alt: 'Preview of ' + key, style: { 'max-width': '100%', 'border-radius': '12px' } });
      img.addEventListener('load', function () {
        if (!current()) return;
        ui.clear(host);
        host.appendChild(img);
        host.appendChild(el('p.hint', { text: 'Served by the console from the object store, with the type taken from the allowlist rather than from the object.' }));
      });
      img.addEventListener('error', function () {
        if (!current()) return;
        window.fetch(url, { cache: 'no-store', credentials: 'same-origin' }).then(function (res) {
          return res.json().then(function (body) { return { status: res.status, body: body }; },
            function () { return { status: res.status, body: null }; });
        }).then(function (r) {
          if (!current()) return;
          ui.clear(host);
          previewError(host, r.status, r.body && r.body.message);
        }, function () {
          if (!current()) return;
          ui.clear(host);
          host.appendChild(ui.errorState('This object could not be previewed', 'The console API could not be reached.'));
        });
      });
      img.src = url;
      return;
    }

    window.fetch(url, { cache: 'no-store', credentials: 'same-origin' }).then(function (res) {
      var type = res.headers.get('content-type') || '';
      if (!res.ok) {
        return res.json().then(function (body) { return { kind: 'error', status: res.status, message: body && body.message }; },
          function () { return { kind: 'error', status: res.status, message: null }; });
      }
      if (type.indexOf('image/') === 0) return { kind: 'image' };
      if (type.indexOf('application/pdf') === 0) return { kind: 'pdf' };
      return res.text().then(function (text) { return { kind: 'text', text: text, type: type }; });
    }).then(function (r) {
      if (!current()) return;
      ui.clear(host);

      if (r.kind === 'error') { previewError(host, r.status, r.message); return; }

      if (r.kind === 'image') {
        var img2 = el('img', { alt: 'Preview of ' + key, src: url, style: { 'max-width': '100%', 'border-radius': '12px' } });
        host.appendChild(img2);
        return;
      }

      if (r.kind === 'pdf') {
        host.appendChild(el('p', { text: 'This is a PDF. The console cannot embed one: its content policy blocks frames and objects.' }));
        host.appendChild(el('a.rlink', {
          href: url, target: '_blank', rel: 'noopener noreferrer',
          text: 'Open the PDF in a new tab'
        }));
        return;
      }

      var text = r.text;
      var shown = text.length > TEXT_PREVIEW_CHARS ? text.slice(0, TEXT_PREVIEW_CHARS) : text;
      host.appendChild(el('div.logview', el('div.logline', { text: shown })));
      host.appendChild(el('p.hint', {
        text: text.length > TEXT_PREVIEW_CHARS
          ? 'Showing the first ' + fmt.num(TEXT_PREVIEW_CHARS) + ' of ' + fmt.num(text.length) + ' characters, served as ' + r.type + '.'
          : fmt.num(text.length) + ' characters, served as ' + r.type + '.'
      }));
    }, function () {
      if (!current()) return;
      ui.clear(host);
      host.appendChild(ui.errorState('This object could not be previewed', 'The console API could not be reached.'));
    });
  }

  function renderObject(body, bucket, d) {
    body.appendChild(el('p.mono', { text: d.key, style: { 'word-break': 'break-all' } }));

    var retentionValue;
    if (!d.lockReadable) {
      retentionValue = unknownCell('The retention call did not answer for this object, so the console cannot say whether one is set.', 'could not be read');
    } else if (d.retention) {
      retentionValue = el('span', [
        ui.pill(d.retention.mode || 'retained', 'info'),
        el('span', { text: ' until ' + (stamp(d.retention.until) || 'an unrecorded date') })
      ]);
    } else {
      retentionValue = el('span.muted', { text: 'none' });
    }

    var holdValue;
    if (d.legalHold === true) holdValue = ui.pill('ON', 'warn', { title: 'A legal hold blocks deletion until it is explicitly released, whatever the retention says.' });
    else if (d.legalHold === false) holdValue = el('span.muted', { text: 'off' });
    else holdValue = unknownCell('The legal-hold call returned nothing. An object with no hold and a server without legal-hold support look identical from here.', 'not reported');

    body.appendChild(ui.dl([
      ['Size', bytes(d.sizeBytes) || unknownCell('The object store did not report a length.')],
      ['Last modified', stampCell(d.modifiedAt)],
      ['Content type', d.contentType ? el('code.mono', { text: d.contentType }) : el('span.muted', { text: 'not reported' })],
      ['ETag', d.etag ? el('code.mono', { text: d.etag }) : el('span.muted', { text: 'not reported' })],
      ['Version', d.versionId ? el('code.mono', { text: d.versionId }) : el('span.muted', { text: 'this bucket is not versioned' })],
      ['Retention', retentionValue],
      ['Legal hold', holdValue]
    ]));

    var reason = d.deletableReason ||
      (d.deletable
        ? 'This object is not locked, but the console exposes no delete route: every object-store endpoint it ' +
          'serves is a GET. Deleting is done by a tool holding a write grant, not from this screen.'
        : 'The console gave no reason, so this stays disabled.');

    body.appendChild(el('div.sectiontitle', { text: 'Actions' }));
    body.appendChild(el('div.row', [ui.btn('Delete object', { variant: 'danger', disabled: true, title: reason })]));
    body.appendChild(el('p.hint', { text: reason }));

    body.appendChild(el('div.sectiontitle', { text: 'Preview' }));
    var previewHost = el('div');
    var previewBtn = ui.btn('Preview this object', {
      variant: 'ghost',
      onClick: function () { loadPreview(previewHost, bucket, d.key); }
    });
    body.appendChild(el('div.row', [previewBtn, el('span.hint', { text: 'Images, text, CSV, JSON and PDF only, capped at 5 MB, typed by an allowlist rather than by the object.' })]));
    body.appendChild(previewHost);

    body.appendChild(el('p.hint', { text: 'Read at ' + stamp(d.at) + '.' }));
  }

  function bucketSummary(bucket) {
    var body = el('div');
    var card = ui.card(bucket, body, {
      actions: [A.link('All buckets', ROUTE, null, null, 'rlink')]
    });

    loadInto(body, '/api/storage/buckets', { skeletonRows: 2 }, function (host, d) {
      var row = null;
      var list = d.buckets || [];
      for (var i = 0; i < list.length; i++) if (list[i].name === bucket) { row = list[i]; break; }

      if (!row) {
        host.appendChild(el('div.callout.warn', [
          el('strong', { text: 'This bucket is not in the console\'s inventory.' }),
          el('p', {
            text: 'It is neither recorded by storage-init nor declared in buckets.yaml. Browsing may still work if ' +
              'the console holds a grant for it, and it will fail with 403 if it does not.'
          })
        ]));
        return;
      }

      host.appendChild(el('div.row', [
        el('span', ['Size: ', sizeCell(row)]),
        el('span', ['Needles: ', countCell(row)]),
        el('span', ['Lock: ', lockCell(row)]),
        el('span.muted', { text: 'Replication: ' + (row.replication || 'not configured') })
      ]));
    });

    return card;
  }

  function buildBrowser(mount, bucket, prefix, key) {
    mount.appendChild(bucketSummary(bucket));

    var listBody = el('div');
    var listCard = ui.card('Objects', el('div.stack', [
      breadcrumb(bucket, prefix),
      calculatePanel(bucket, prefix),
      listBody
    ]));

    loadInto(listBody, objectsPath(bucket, prefix, null), {
      timeoutMs: 30000,
      skeletonRows: 5
    }, function (host, d) {
      renderListing(host, bucket, prefix, key, d);
    });

    if (!key) {
      mount.appendChild(listCard);
      return;
    }

    var detailBody = el('div');
    var detailCard = ui.card('Object', detailBody, {
      actions: [A.link('Close', ROUTE, null, { bucket: bucket, prefix: prefix }, 'rlink')]
    });
    loadInto(detailBody, '/api/storage/object?bucket=' + encodeURIComponent(bucket) + '&key=' + encodeURIComponent(key),
      { skeletonRows: 4 },
      function (host, d) { renderObject(host, bucket, d); });

    mount.appendChild(el('div.splitview', [listCard, detailCard]));
  }

  function buildOverview(mount) {
    mount.appendChild(panel('Buckets', '/api/storage/buckets', { skeletonRows: 5 }, renderBuckets));
    mount.appendChild(el('div.grid.grid-2', [
      panel('Capacity', '/api/storage/capacity', { ttlMs: 10000 }, renderCapacity),
      panel('Immutability', '/api/storage/lock-status', {}, renderLocks)
    ]));
    mount.appendChild(panel('Service health', '/api/storage/health', { ttlMs: 10000 }, renderHealth));
  }

  function build(mount, params) {
    var mode = A.storeMode();

    if (mode !== A.MODE.LIVE) {
      mount.appendChild(el('div.callout.warn', [
        el('strong', { text: 'The console API is not running, so this screen has nothing to read.' }),
        el('p', {
          text: 'The object store is a service this project runs itself, and there are no fixtures for it: showing ' +
            'invented buckets here would be worse than showing none. Start the API with `npm start` in ' +
            'platform/console/server, or bring the stack up with `docker compose up -d` in platform/compose, and reload.'
        })
      ]));
      return;
    }

    if (params.bucket) buildBrowser(mount, params.bucket, params.prefix || '', params.key || null);
    else buildOverview(mount);
  }

  function rebuild(body, params) {
    generation += 1;
    ui.clear(body);
    body.appendChild(ui.skeleton(3));
    var current = guard();
    A.probe().then(function () {
      if (!current()) return;
      ui.clear(body);
      build(body, params);
    });
  }

  registerScreen(ROUTE, {
    title: 'Object storage',
    crumb: 'Object storage',
    render: function (mount, ctx) {
      alive = true;
      A.onLeave(function () { alive = false; });

      var params = (ctx && ctx.params) || A.state.params || {};
      var bucket = params.bucket || null;

      var body = el('div');

      mount.appendChild(ui.pageHeader(
        'Object storage',
        bucket
          ? 'Browsing ' + bucket + '. Names, sizes and lock state come from the object store, never from a fixture.'
          : 'The S3 replacement: what exists, how much room is left before writes fail, and whether immutability is ' +
            'actually enforced. Nothing on this screen is a fixture.',
        [ui.btn('Refresh', {
          onClick: function () {
            A.forget();
            rebuild(body, params);
            if (A.storeMode() !== A.MODE.LIVE) {
              A.flash('info', 'There is nothing to re-read',
                'The console API is not answering, so this screen has no source to refresh from.');
            }
          }
        })]));

      mount.appendChild(body);
      rebuild(body, params);
    }
  });
})();
