(function () {
  'use strict';

  var A = window.ARGUS, ui = A.ui, el = ui.el, fmt = ui.fmt;

  var ROUTE = 'storage';
  var BUCKETS = '/api/storage/buckets';
  var PRINCIPALS = '/api/identity/principals';
  var CONSOLE_IDENTITY = 'argus-console';

  function bytes(n) {
    if (n === null || n === undefined || n === '' || !isFinite(Number(n))) return null;
    return fmt.bytes(n);
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

  function unknownCell(label, reason) {
    return el('span', [
      ui.pill(label || 'unknown', 'idle', reason ? { title: reason } : null),
      reason ? el('span.sr', { text: ' ' + reason }) : null
    ]);
  }

  function details(list) {
    var nodes = (list || []).filter(Boolean).map(function (t) {
      return typeof t === 'string' ? el('p', { text: t }) : t;
    });
    return nodes.length ? ui.disclosure('Details', nodes) : document.createDocumentFragment();
  }

  function verdict(text) { return el('p', { text: text }); }

  var SIZE_NOTE =
    'On disk is summed from volume metadata rather than by listing objects, so it includes volume overhead and ' +
    'space still held by deleted or superseded versions. Browse a bucket and press Calculate for a counted total.';

  var NEEDLE_NOTE =
    'Needles are not objects. The filer splits every file at 4 MB and stores each version of a versioned object ' +
    'separately, so a 1 GB backup is about 256 needles. "Not counted" means the volume servers report no needle ' +
    'count, which is not the same as an empty bucket: a volume can report zero files where a listing finds objects.';

  var RECLAIM_NOTE =
    'Reclaimable is disk still held by deleted or superseded needles. It returns only when the volume is compacted.';

  var LIFECYCLE_NOTE =
    'SeaweedFS applies Expiration.Days as a filer TTL path rule stamped on each needle at write time. Objects ' +
    'written before the rule existed carry no TTL and never expire, so a declared retention does not bound a ' +
    'bucket that was already filling.';

  var SHIELD_NOTE =
    'The lock verdict comes from one attempted delete of one locked object version, in one probe bucket, at boot. ' +
    'It is not read from each bucket\'s configuration: it is the whole store\'s answer, shown per row. Object Lock ' +
    'is implemented in the S3 gateway alone, so it says nothing about a delete that reaches the filer directly; ' +
    'the Immutability panel carries that separately.';

  function forbiddenDetail(bucket, e) {
    if (e && e.reason === 'role') return e.message || 'This needs a higher console role than this session holds.';
    return 'The console\'s S3 identity holds Read and List only on the buckets declared for it, and it has no List ' +
      'grant on ' + (bucket || 'this bucket') + '. Browsing it needs that grant added to the console identity in ' +
      'the object store configuration.';
  }

  function forbiddenFor(bucket) {
    return function (body, env) {
      var e = (env && env.error) || {};
      body.appendChild(ui.stateBlock('forbidden', { reason: e.reason, detail: forbiddenDetail(bucket, e) }));
    };
  }

  function shieldTone(v) {
    if (v === 'enforced') return 'ok';
    if (v === 'not-enforced') return 'bad';
    return 'idle';
  }

  function shieldLabel(v) {
    if (v === 'enforced') return 'enforced';
    if (v === 'not-enforced') return 'NOT enforced';
    return v ? String(v) : 'not proven';
  }

  var alive = true;
  var generation = 0;

  function guard() {
    var mine = generation;
    return function () { return alive && mine === generation; };
  }

  function canReadPrincipals() {
    var caps = A.capabilities() || {};
    var auth = caps.auth || {};
    var roles = Array.isArray(auth.roles) ? auth.roles : [];
    return auth.tier === 'security' || auth.tier === 'admin' ||
      roles.indexOf('security') !== -1 || roles.indexOf('admin') !== -1;
  }

  function listableFrom(env) {
    if (!env || !env.ok || !env.data) return null;
    var store = env.data.objectStore;
    if (!store || store.ok === false || !Array.isArray(store.identities)) return null;
    var id = null;
    store.identities.forEach(function (i) {
      if (id || !i) return;
      if (i.name === CONSOLE_IDENTITY || (i.accessKeys || []).indexOf(CONSOLE_IDENTITY) !== -1) id = i;
    });
    if (!id) return null;
    var all = false;
    var set = {};
    (id.actions || []).forEach(function (a) {
      a = String(a);
      if (a === 'Admin' || a === 'List') all = true;
      var m = /^List:(.+)$/.exec(a);
      if (m) set[m[1]] = true;
    });
    return function (name) { return all || set[name] === true; };
  }

  function listable() {
    if (!canReadPrincipals()) return Promise.resolve(null);
    return A.read(PRINCIPALS, { ttlMs: 60000 }).then(listableFrom, function () { return null; });
  }

  function renderHealth(body, d) {
    var caps = A.capabilities() || {};
    var s3 = d.s3 || {};
    var comps = d.components || [];
    var up = comps.filter(function (c) { return c.reachable; }).length;

    body.appendChild(verdict(s3.signedCallOk
      ? 'A signed S3 call was accepted and ' + fmt.num(up) + ' of ' + fmt.num(comps.length) + ' components answered.'
      : 'The object store refused a signed S3 call' + (s3.reason ? ' (' + s3.reason + ')' : '') + '. ' + (s3.message || '')));

    body.appendChild(el('div.tiles', [
      ui.statTile('Signed S3 call', s3.signedCallOk ? 'accepted' : 'refused', { note: 'ListObjectsV2, now' }),
      ui.statTile('Writable volumes', d.writable ? 'yes' : 'no', {
        note: d.writable ? 'At least one collection' : 'Writes will fail'
      }),
      ui.statTile('Free volume slots',
        d.freeVolumes === null || d.freeVolumes === undefined ? 'unknown' : fmt.num(d.freeVolumes),
        { note: d.freeVolumes === null || d.freeVolumes === undefined ? 'Topology not reported' : 'Still allocatable' })
    ]));

    if (d.topologyReachable === false) {
      body.appendChild(el('div.callout.warn', [
        el('strong', { text: 'Not every volume server answered, so sizes and capacity are floors rather than totals.' })
      ]));
    }

    body.appendChild(ui.table([
      { key: 'name', label: 'Component', render: function (c) { return el('code.mono', { text: c.name }); } },
      {
        key: 'reachable', label: 'State', status: true,
        render: function (c) { return c.reachable ? ui.pill('reachable', 'ok') : ui.pill('unreachable', 'bad'); }
      },
      { key: 'version', label: 'Version', render: function (c) { return c.version ? el('span.mono', { text: c.version }) : el('span.muted', { text: 'not reported' }); } },
      { key: 'latencyMs', label: 'Latency', align: 'right', render: function (c) { return fmt.ms(c.latencyMs); } },
      {
        key: 'error', label: 'Detail',
        render: function (c) { return el('span.muted', { text: c.error || '-' }); }
      }
    ], comps, {
      caption: 'Object store components, whether each answered, and how long it took',
      rowKey: function (c) { return c.name; },
      empty: 'The console did not probe any component.'
    }));

    body.appendChild(details([
      'Every component can answer a liveness probe while the signed call fails; only the signed call proves the ' +
        'gateway loaded its identities and accepted this console\'s signature.',
      d.writable && !caps.writesAllowed ? 'This console is read-only and will not write to any volume.' : null,
      d.topologyReachable === false ? 'The unreachable volume servers are listed in the Capacity table.' : null
    ]));
  }

  function renderCapacity(body, d) {
    var totals = d.totals;
    var slots = d.slots || {};
    var slotBytes = (slots.free !== null && slots.free !== undefined && slots.volumeSizeMB)
      ? slots.free * slots.volumeSizeMB * 1048576
      : null;

    var line;
    if (d.binding === 'volume-slots') line = 'The volume-slot ceiling binds, not the disk: about ' + bytesOr(d.available) + ' can be written before writes fail.';
    else if (d.binding === 'disk') line = 'The disk binds, not the volume slots: about ' + bytesOr(d.available) + ' can be written before writes fail.';
    else line = 'Which ceiling binds is unknown, so no room figure is given.';
    if (d.partial) line += ' The totals are partial.';
    body.appendChild(verdict(line));

    body.appendChild(el('div.tiles', [
      ui.statTile('Free on disk', totals ? bytesOr(totals.freeBytes) : 'unknown', {
        note: totals ? bytesOr(totals.usedBytes) + ' used of ' + bytesOr(totals.allBytes) : 'No volume server answered'
      }),
      ui.statTile('Free volume slots',
        slots.free === null || slots.free === undefined ? 'unknown' : fmt.num(slots.free),
        {
          note: slots.max === null || slots.max === undefined
            ? 'Ceiling not reported'
            : 'of ' + fmt.num(slots.max) + ', each ' + fmt.num(slots.volumeSizeMB) + ' MB'
        }),
      ui.statTile('Room before writes fail',
        d.available === null || d.available === undefined ? 'unknown' : bytesOr(d.available),
        { note: d.binding === 'volume-slots' ? 'Slots bind' : d.binding === 'disk' ? 'Disk binds' : 'Binding unknown' })
    ]));

    body.appendChild(ui.table([
      { key: 'url', label: 'Volume server', render: function (n) { return el('code.mono', { text: n.url }); } },
      {
        key: 'ok', label: 'State', status: true,
        render: function (n) { return n.ok ? ui.pill('answered', 'ok') : ui.pill('unreachable', 'bad', { title: n.error || 'No reason was given.' }); }
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
        render: function (n) { return n.slotsFree === null || n.slotsFree === undefined ? unknownCell() : fmt.num(n.slotsFree); }
      },
      { key: 'usedBytes', label: 'Used', align: 'right', render: function (n) { return n.ok ? bytesOr(n.usedBytes) : unknownCell(); } },
      { key: 'freeBytes', label: 'Free', align: 'right', render: function (n) { return n.ok ? bytesOr(n.freeBytes) : unknownCell(); } },
      { key: 'allBytes', label: 'Disk', align: 'right', render: function (n) { return n.ok ? bytesOr(n.allBytes) : unknownCell(); } }
    ], d.nodes || [], {
      caption: 'Volume servers, their volume slots and their disk',
      sortKey: 'url',
      rowKey: function (n) { return n.url; },
      empty: 'The master reported no volume server.'
    }));

    var notes = [];
    if (d.binding === 'volume-slots' && slotBytes !== null && totals) {
      notes.push(fmt.num(slots.free) + ' free slots of ' + fmt.num(slots.volumeSizeMB) + ' MB each is ' + bytesOr(slotBytes) +
        ', while the disk still has ' + bytesOr(totals.freeBytes) + ' free. Past the slot ceiling, writes fail with ' +
        '"no writable volumes" and the disk graph shows nothing wrong. Raise -max on the volume server, or add one.');
    } else if (d.binding === 'disk' && totals) {
      notes.push(bytesOr(totals.freeBytes) + ' free on disk' +
        (slotBytes !== null ? ', against ' + bytesOr(slotBytes) + ' of unallocated volume slots' : '') + '.');
    } else if (d.binding !== 'volume-slots' && d.binding !== 'disk') {
      notes.push((totals ? '' : 'No volume server answered, so there are no free bytes to compare. ') +
        (slotBytes === null ? 'The master did not report free slots, so there is no slot ceiling to compare. ' : '') +
        'Both numbers are needed to say which limit is closer, so neither is guessed at.');
    }
    if (d.partial) notes.push('At least one volume server did not answer. Its capacity is not counted and is not assumed to be zero.');
    notes.push('Measured on ' + (d.scope || 'an unnamed scope') + '. An unknown cell is a server that did not answer or did not report that figure.');
    body.appendChild(details(notes));
  }

  function renderLocks(body, d) {
    if (!d.determined) {
      body.appendChild(ui.stateBlock('notConfigured', {
        reason: 'not-determined',
        detail: 'Immutability has not been proven on this stack. ' + (d.message || 'No lock probe result is available.')
      }));
      return;
    }

    body.appendChild(el('div.row', [
      ui.pill('Object lock: ' + shieldLabel(d.verdict), shieldTone(d.verdict)),
      el('span.muted', { text: 'probed ' + (stamp(d.probedAt) || 'at an unrecorded time') })
    ]));

    body.appendChild(verdict(d.filerBypass === 'closed'
      ? 'The filer path was probed and refused the delete too.'
      : 'Object lock lives in the S3 gateway. The filer path is ' + (d.filerBypass || 'unknown') + '.'));

    if (d.missingLock && d.missingLock.length) {
      body.appendChild(el('div.callout.bad', [
        el('strong', { text: 'Declared as locked, but no lock was recorded: ' + d.missingLock.join(', ') + '.' }),
        el('p', { text: 'Object lock can only be turned on when a bucket is created, so the bucket has to be recreated with locking enabled and its contents copied across.' })
      ]));
    }

    if (d.devOverrides) {
      body.appendChild(el('div.callout.info', [
        el('strong', {
          text: 'Development overrides: ' + d.devOverrides.mode + ' for ' + fmt.num(d.devOverrides.days) +
            ' day' + (d.devOverrides.days === 1 ? '' : 's') + (d.profile ? ' under the "' + d.profile + '" profile' : '') +
            ', not what buckets.yaml declares.'
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
            ui.pill(shieldLabel(b.enforced), shieldTone(b.enforced)),
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

    body.appendChild(details([
      d.detail || 'The probe recorded no detail.',
      d.filerBypassDetail || 'This run recorded nothing about the filer path.',
      d.defaultRetentionDetail || 'This run recorded nothing about whether the bucket default reaches real objects.',
      'Bucket default retention stamped on write: ' + (d.defaultRetentionStamped || 'unknown') + '.',
      'Scope: ' + (d.scope || 'unknown') + '. ' + SHIELD_NOTE,
      d.devOverrides
        ? 'The declared value is in the Declared column, and it is what a production apply would use. A GOVERNANCE ' +
          'lock can be lifted by a privileged caller; COMPLIANCE cannot.'
        : null
    ]));
  }

  function sizeCell(b) {
    if (b.unknownSize) return unknownCell();
    var v = bytes(b.diskBytes);
    return v === null ? unknownCell() : el('span', { text: 'approx. ' + v });
  }

  function reclaimableCell(b) {
    if (b.unknownSize || b.reclaimableBytes === null || b.reclaimableBytes === undefined) return unknownCell();
    return el('span', { text: bytesOr(b.reclaimableBytes) });
  }

  function countCell(b) {
    if (b.unknownSize) return unknownCell();
    if (!b.needles) return unknownCell('not counted');
    var live = (b.liveNeedles === null || b.liveNeedles === undefined) ? null : b.liveNeedles;
    return el('span', [
      el('span', { text: fmt.num(b.needles) }),
      live === null ? null : el('span.muted', { text: ' (' + fmt.num(live) + ' live)' })
    ]);
  }

  function lockCell(b) {
    if (!b.lock) {
      return b.lockDeclared
        ? ui.pill('declared, not applied', 'bad')
        : el('span.muted', { text: 'none' });
    }
    return ui.pill(b.lock + ' ' + fmt.num(b.lockDays) + ' d - ' + shieldLabel(b.lockEnforced), shieldTone(b.lockEnforced));
  }

  function bucketName(b, can) {
    if (can && !can(b.name)) {
      return el('div', [
        el('code.mono', { text: b.name }),
        el('div.muted', { text: 'not listable by the console' })
      ]);
    }
    return A.link(b.name, ROUTE, null, { bucket: b.name }, 'rlink');
  }

  function renderBuckets(can) {
    return function (body, d) {
      var list = d.buckets || [];
      var drift = d.drift || {};
      var missing = drift.declaredButMissing || [];
      var extra = drift.existsButUndeclared || [];
      var verified = !(d.inventorySource && d.inventorySource.indexOf('storage-init') !== 0);

      var line = fmt.num(list.length) + ' bucket' + (list.length === 1 ? '' : 's') +
        (verified ? '' : ', from the declared list rather than a verified inventory') +
        (d.topologyOk === false ? '; no size could be measured' : '') + '.';
      body.appendChild(verdict(line));

      if (d.declaredError) {
        body.appendChild(el('div.callout.warn', [el('strong', { text: 'The declared bucket file could not be read: ' + d.declaredError })]));
      }
      if (missing.length) {
        body.appendChild(el('div.callout.bad', [el('strong', { text: 'Declared but missing: ' + missing.join(', ') + '.' })]));
      }
      if (extra.length) {
        body.appendChild(el('div.callout.warn', [el('strong', { text: 'Exists but undeclared: ' + extra.join(', ') + '.' })]));
      }

      body.appendChild(ui.table([
        { key: 'name', label: 'Bucket', render: function (b) { return bucketName(b, can); } },
        { key: 'diskBytes', label: 'On disk', align: 'right', render: sizeCell, sort: function (b) { return b.unknownSize ? null : b.diskBytes; } },
        { key: 'reclaimableBytes', label: 'Reclaimable', align: 'right', render: reclaimableCell, sort: function (b) { return b.unknownSize ? null : b.reclaimableBytes; } },
        { key: 'needles', label: 'Needles', align: 'right', render: countCell, sort: function (b) { return b.needles || null; } },
        {
          key: 'versioning', label: 'Versioning',
          render: function (b) {
            if (b.versioning === null || b.versioning === undefined) return unknownCell();
            return b.versioning ? ui.pill('on', 'info') : el('span.muted', { text: 'off' });
          }
        },
        { key: 'lock', label: 'Object lock', status: true, render: lockCell },
        { key: 'replication', label: 'Replication', render: function (b) { return el('span.muted', { text: b.replication || 'not configured' }); } },
        { key: 'owner', label: 'Owner', render: function (b) { return b.owner ? el('code.mono', { text: b.owner }) : el('span.muted', { text: 'not declared' }); } },
        {
          key: 'lifecycleDays', label: 'Lifecycle', align: 'right',
          render: function (b) { return b.lifecycleDays ? fmt.num(b.lifecycleDays) + ' d, from the rule onward' : el('span.muted', { text: 'none' }); }
        },
        {
          key: 'backup', label: 'Backup',
          render: function (b) { return b.backup ? b.backup.tool + ' ' + b.backup.schedule : el('span.muted', { text: 'none declared' }); }
        }
      ], list, {
        caption: 'Buckets in the object store, with size, lock state and declared intent',
        sortKey: 'name',
        rowKey: function (b) { return b.name; },
        empty: 'No bucket was found and none is declared.'
      }));

      var notes = [];
      if (!verified) {
        notes.push('storage-init has not recorded an inventory on this stack, so these names come from ' + d.inventorySource +
          '. A bucket here may not exist, and a bucket that exists may be missing.' + (d.inventoryError ? ' ' + d.inventoryError : ''));
      }
      if (d.topologyOk === false) notes.push((d.topologyError || 'The volume servers could not be read.') + ' Sizes read unknown rather than zero.');
      if (missing.length) notes.push('Declared but missing: buckets.yaml declares these and the store does not have them. Anything writing to them is failing right now.');
      if (extra.length) notes.push('Exists but undeclared: nothing declares their owner, lifecycle or lock, and an apply will not recreate them.');
      notes.push(SIZE_NOTE);
      notes.push('Needle counts come from ' + (d.countsFrom || 'the master\'s volume metadata') + ', never a listing. ' + NEEDLE_NOTE);
      notes.push(RECLAIM_NOTE);
      if (list.some(function (b) { return b.lifecycleDays; })) {
        notes.push('A lifecycle rule here bounds what is written after it, not what is already there. ' + LIFECYCLE_NOTE);
      }
      notes.push(SHIELD_NOTE);
      notes.push('Backups are declared in buckets.yaml and not verified by this console. Bucket list from ' + (d.inventorySource || 'an unnamed source') + '.');
      if (can) notes.push('A bucket marked "not listable by the console" has no List grant on the console\'s S3 identity, so it is not linked for browsing.');
      body.appendChild(details(notes));
    };
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

    if (!prefix) nav.appendChild(el('b', { text: bucket }));
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
          if (r.kind === 'folder') return unknownCell('not counted');
          return bytesOr(r.sizeBytes);
        }
      },
      { key: 'modifiedAt', label: 'Last modified', render: function (r) { return r.kind === 'folder' ? el('span.muted', { text: '-' }) : stampCell(r.modifiedAt); } },
      {
        key: 'storageClass', label: 'Class',
        render: function (r) { return el('span.muted', { text: r.storageClass || '-' }); }
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

  function notOk(state) { return state !== 'ok' && state !== 'stale'; }

  function calculatePanel(bucket, prefix) {
    var out = el('div');
    var path = '/api/storage/prefix-size?bucket=' + encodeURIComponent(bucket) +
      (prefix ? '&prefix=' + encodeURIComponent(prefix) : '');

    var button = ui.btn('Calculate size of this prefix', { variant: 'ghost', onClick: run });

    function run() {
      button.setDisabled(true);
      var current = guard();
      ui.clear(out);
      out.appendChild(ui.skeleton(1));
      A.read(path, { ttlMs: 0, timeoutMs: 30000 }).then(function (env) {
        if (!current()) return;
        button.setDisabled(false);
        ui.clear(out);
        var state = A.envelopeState(env);
        var e = env.error || {};
        if (notOk(state)) {
          out.appendChild(ui.stateBlock(state, {
            reason: e.reason,
            detail: state === 'forbidden' ? forbiddenDetail(bucket, e) : e.message,
            retry: ui.TRANSIENT[state] ? run : null
          }));
          return;
        }
        var d = env.data || {};
        var size = bytesOr(d.sizeBytes);
        var text = d.complete
          ? size + ' in ' + fmt.num(d.objectCount) + ' object' + (d.objectCount === 1 ? '' : 's')
          : 'at least ' + size + ' in at least ' + fmt.num(d.objectCount) + ' objects';
        out.appendChild(el('div.row', [
          el('strong', { text: text }),
          el('span.muted', { text: 'walked ' + fmt.num(d.keysScanned) + ' keys in ' + fmt.ms(d.elapsedMs) })
        ]));
        if (!d.complete) {
          out.appendChild(el('p.hint', {
            text: d.note || ('The walk stopped at its budget of ' + fmt.num(d.budgetKeys) + ' keys or ' +
              fmt.ms(d.budgetMs) + '. This is a lower bound, not the total.')
          }));
        }
        if (A.announce) A.announce(text);
      });
    }

    return el('div.stack', [
      el('div.row', [button, el('span.hint', { text: 'Reads every key under this prefix, one walk at a time across the console.' })]),
      out
    ]);
  }

  function renderListing(bucket, prefix, selectedKey) {
    return function (host, data) {
      if (data.keyRepair && data.keyRepair.applied) {
        host.appendChild(el('div.callout.info', [
          el('strong', { text: 'The names below were repaired before they were shown.' }),
          el('p', {
            text: (data.keyRepair.reason || 'This server returns corrupted keys when listing a versioned bucket.') +
              ' Another S3 client will report the uncorrected names. ' + fmt.num(data.keyRepair.keysScanned) +
              ' keys were read to assemble this level.'
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
          fmt.num(objectCount) + ' object' + (objectCount === 1 ? '' : 's') + ' at this level.'
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
                footer.appendChild(el('span.muted', { text: (env.error && env.error.message) || 'The next page could not be read.' }));
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
          el('strong', { text: 'This level is incomplete: the listing stopped after ' + fmt.num(data.pageSize) + ' keys with no cursor. Narrow the prefix.' })
        ]));
      }
    };
  }

  function previewPath(bucket, key) {
    return '/api/storage/preview?bucket=' + encodeURIComponent(bucket) + '&key=' + encodeURIComponent(key);
  }

  var TEXT_PREVIEW_CHARS = 20000;
  var IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
  var PREVIEW_REFUSAL = {
    413: 'The object is larger than the console\'s 5 MB preview cap.',
    415: 'That file type is not on the preview allowlist. The allowlist decides the type, so an uploaded HTML file cannot be served back as script into this origin.'
  };

  function looksLikeImage(key) {
    var lower = String(key).toLowerCase();
    for (var i = 0; i < IMAGE_EXT.length; i++) {
      if (lower.length >= IMAGE_EXT[i].length && lower.lastIndexOf(IMAGE_EXT[i]) === lower.length - IMAGE_EXT[i].length) return true;
    }
    return false;
  }

  function previewError(host, bucket, status, message, retry) {
    var reason = status ? 'http-' + status : 'unreachable';
    var state = A.envelopeState({ ok: false, mode: 'live', error: { reason: reason, status: status } });
    host.appendChild(ui.stateBlock(state, {
      reason: reason,
      detail: state === 'forbidden' ? forbiddenDetail(bucket) : (PREVIEW_REFUSAL[status] || message || 'The console API could not be reached.'),
      retry: ui.TRANSIENT[state] ? retry : null
    }));
  }

  function loadPreview(host, bucket, key) {
    var current = guard();
    var url = previewPath(bucket, key);
    var again = function () { loadPreview(host, bucket, key); };

    ui.clear(host);
    host.appendChild(ui.skeleton(2));

    function failed(status, message) {
      if (!current()) return;
      ui.clear(host);
      previewError(host, bucket, status, message, again);
    }

    if (looksLikeImage(key)) {
      var img = el('img', { alt: 'Preview of ' + key, style: { 'max-width': '100%', 'border-radius': '12px' } });
      img.addEventListener('load', function () {
        if (!current()) return;
        ui.clear(host);
        host.appendChild(img);
      });
      img.addEventListener('error', function () {
        if (!current()) return;
        window.fetch(url, { cache: 'no-store', credentials: 'same-origin' }).then(function (res) {
          return res.json().then(function (body) { return { status: res.status, body: body }; },
            function () { return { status: res.status, body: null }; });
        }).then(function (r) { failed(r.status, r.body && r.body.message); }, function () { failed(0, null); });
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
      if (r.kind === 'error') { failed(r.status, r.message); return; }
      ui.clear(host);

      if (r.kind === 'image') {
        host.appendChild(el('img', { alt: 'Preview of ' + key, src: url, style: { 'max-width': '100%', 'border-radius': '12px' } }));
        return;
      }
      if (r.kind === 'pdf') {
        host.appendChild(el('p', { text: 'This is a PDF. The console cannot embed one: its content policy blocks frames and objects.' }));
        host.appendChild(el('a.rlink', { href: url, target: '_blank', rel: 'noopener noreferrer', text: 'Open the PDF in a new tab' }));
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
    }, function () { failed(0, null); });
  }

  function renderObject(bucket) {
    return function (body, d) {
      body.appendChild(el('p.mono', { text: d.key, style: { 'word-break': 'break-all' } }));

      var retentionValue;
      if (!d.lockReadable) retentionValue = unknownCell('could not be read');
      else if (d.retention) {
        retentionValue = el('span', [
          ui.pill(d.retention.mode || 'retained', 'info'),
          el('span', { text: ' until ' + (stamp(d.retention.until) || 'an unrecorded date') })
        ]);
      } else retentionValue = el('span.muted', { text: 'none' });

      var holdValue;
      if (d.legalHold === true) holdValue = ui.pill('ON', 'warn');
      else if (d.legalHold === false) holdValue = el('span.muted', { text: 'off' });
      else holdValue = unknownCell('not reported');

      body.appendChild(ui.dl([
        ['Size', bytes(d.sizeBytes) || unknownCell()],
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

      var previewHost = el('div');
      body.appendChild(el('div.row', [
        ui.btn('Preview this object', { variant: 'ghost', onClick: function () { loadPreview(previewHost, bucket, d.key); } }),
        ui.btn('Delete object', { variant: 'danger', disabled: true, title: reason })
      ]));
      body.appendChild(previewHost);
      body.appendChild(details([
        'Delete: ' + reason,
        'Preview covers images, text, CSV, JSON and PDF only, capped at 5 MB, typed by an allowlist rather than by the object.',
        d.lockReadable ? null : 'The retention call did not answer for this object, so the console cannot say whether one is set.',
        d.legalHold === true ? 'A legal hold blocks deletion until it is explicitly released, whatever the retention says.' : null,
        d.legalHold === true || d.legalHold === false ? null
          : 'The legal-hold call returned nothing. An object with no hold and a server without legal-hold support look identical from here.'
      ]));
    };
  }

  function bucketSummary(bucket) {
    return A.livePanel(bucket, BUCKETS, function (host, d) {
      var row = null;
      (d.buckets || []).forEach(function (b) { if (!row && b.name === bucket) row = b; });

      if (!row) {
        host.appendChild(verdict('Not in the console\'s inventory: neither storage-init nor buckets.yaml records it.'));
        return;
      }
      host.appendChild(el('div.row', [
        el('span', ['Size: ', sizeCell(row)]),
        el('span', ['Needles: ', countCell(row)]),
        el('span', ['Lock: ', lockCell(row)]),
        el('span.muted', { text: 'Replication: ' + (row.replication || 'not configured') })
      ]));
    }, { skeletonRows: 2, actions: [A.link('All buckets', ROUTE, null, null, 'rlink')] });
  }

  function objectsPanel(bucket, prefix, key, can) {
    var path = objectsPath(bucket, prefix, null);
    var listing;
    if (can && !can(bucket)) {
      listing = el('div.livepanel', { 'data-state': 'forbidden', 'data-reason': 'no-list-grant', 'data-path': path }, [
        ui.stateBlock('forbidden', { reason: 'no-list-grant', detail: forbiddenDetail(bucket) })
      ]);
      return ui.card('Objects', listing);
    }
    return A.livePanel('Objects', path, renderListing(bucket, prefix, key), {
      timeoutMs: 30000, skeletonRows: 5, on: { forbidden: forbiddenFor(bucket) }
    });
  }

  function paintBrowser(mount, bucket, prefix, key, can) {
    mount.appendChild(bucketSummary(bucket));

    var nav = el('div.stack', [breadcrumb(bucket, prefix), calculatePanel(bucket, prefix)]);
    var listCard = objectsPanel(bucket, prefix, key, can);
    var listBody = listCard.querySelector('.card-body');
    if (listBody) listBody.insertBefore(nav, listBody.firstChild);

    if (!key) { mount.appendChild(listCard); return; }

    var detailCard = A.livePanel('Object',
      '/api/storage/object?bucket=' + encodeURIComponent(bucket) + '&key=' + encodeURIComponent(key),
      renderObject(bucket),
      {
        skeletonRows: 4,
        on: { forbidden: forbiddenFor(bucket) },
        actions: [A.link('Close', ROUTE, null, { bucket: bucket, prefix: prefix }, 'rlink')]
      });
    mount.appendChild(el('div.splitview', [listCard, detailCard]));
  }

  function absentFrom(env, bucket) {
    if (A.envelopeState(env) !== 'ok' || !env.data) return false;
    return !(env.data.buckets || []).some(function (b) { return b.name === bucket; });
  }

  function buildBrowser(mount, refresh, bucket, prefix, key) {
    var holder = el('div', [ui.skeleton(4)]);
    mount.appendChild(holder);
    var current = guard();

    listable().then(function (can) {
      var reads = [A.read(BUCKETS)];
      var grantless = !!(can && !can(bucket));
      if (!grantless) reads.push(A.read(objectsPath(bucket, prefix, null), { timeoutMs: 30000 }));
      return Promise.all(reads).then(function (r) {
        if (!current()) return;
        ui.clear(holder);
        var listState = r[1] ? A.envelopeState(r[1]) : 'forbidden';
        var roleDenied = !!(r[1] && r[1].error && r[1].error.reason === 'role');
        if (absentFrom(r[0], bucket) && !roleDenied && (listState === 'notFound' || listState === 'forbidden')) {
          holder.appendChild(ui.notFound('bucket', bucket, ROUTE, 'All buckets'));
          return;
        }
        holder.appendChild(ui.pageHeader('Object storage', 'One bucket, read from the object store.', [refresh]));
        paintBrowser(holder, bucket, prefix, key, can);
      });
    }).then(null, function (err) {
      if (!current()) return;
      ui.clear(holder);
      holder.appendChild(ui.pageHeader('Object storage', 'One bucket, read from the object store.', [refresh]));
      holder.appendChild(ui.stateBlock('failed', { reason: 'render', detail: String(err && err.message ? err.message : err) }));
    });
  }

  var OVERVIEW_DESC = 'What exists, how much room is left before writes fail, and whether immutability is enforced.';

  function buildOverview(mount) {
    var holder = el('div', [ui.skeleton(4)]);
    mount.appendChild(holder);
    var current = guard();
    listable().then(function (can) {
      if (!current()) return;
      ui.clear(holder);
      holder.appendChild(A.livePanel('Buckets', BUCKETS, renderBuckets(can), { skeletonRows: 5 }));
      holder.appendChild(el('div.grid.grid-2', [
        A.livePanel('Capacity', '/api/storage/capacity', renderCapacity, { ttlMs: 10000 }),
        A.livePanel('Immutability', '/api/storage/lock-status', renderLocks, {})
      ]));
      holder.appendChild(A.livePanel('Service health', '/api/storage/health', renderHealth, { ttlMs: 10000 }));
    });
  }

  function build(mount, params, refresh) {
    if (A.storeMode() !== A.MODE.LIVE) {
      if (params.bucket) mount.appendChild(ui.pageHeader('Object storage', OVERVIEW_DESC, [refresh]));
      mount.appendChild(ui.stateBlock('sample', {
        reason: 'sample-mode',
        detail: 'The object store is a service this project runs itself and there are no fixtures for it. Open the ' +
          'console the console API serves and sign in to read it.'
      }));
      return;
    }
    if (params.bucket) buildBrowser(mount, refresh, params.bucket, params.prefix || '', params.key || null);
    else buildOverview(mount);
  }

  function rebuild(body, params, refresh) {
    generation += 1;
    ui.clear(body);
    body.appendChild(ui.skeleton(3));
    var current = guard();
    A.probe().then(function () {
      if (!current()) return;
      ui.clear(body);
      build(body, params, refresh);
    });
  }

  A.screen(ROUTE, {
    title: 'Object storage',
    crumb: 'Object storage',
    render: function (mount, ctx) {
      alive = true;
      A.onLeave(function () { alive = false; });

      var params = (ctx && ctx.params) || A.state.params || {};
      var body = el('div', { style: { 'overflow-wrap': 'anywhere', 'min-width': '0' } });
      var refresh = ui.btn('Refresh', {
        onClick: function () {
          A.forget();
          rebuild(body, params, refresh);
          if (A.storeMode() !== A.MODE.LIVE) {
            A.flash('info', 'There is nothing to re-read',
              'The console API is not answering, so this screen has no source to refresh from.');
          }
        }
      });

      if (!params.bucket) mount.appendChild(ui.pageHeader('Object storage', OVERVIEW_DESC, [refresh]));
      mount.appendChild(body);
      rebuild(body, params, refresh);
    }
  });
})();
