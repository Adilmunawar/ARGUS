/* Argus Console: Compute.
 *
 * Hosts, virtual machines, the Service Fabric cluster and the GPU node, plus
 * the two detail views an operator reaches from them. The Connect tab is the
 * point of the screen: connecting to a machine is the most dangerous thing this
 * console offers, so it says out loud what will happen before it happens.
 *
 * Classic script, no modules, no build step, no network (ADR-0027). Every node
 * is built through ui.el; nothing here ever touches innerHTML.
 */
(function () {
  'use strict';

  var A = window.ARGUS, ui = A.ui, el = ui.el, d = A.data, fmt = ui.fmt;

  /* index.html loads the screen files before app.js, so A.screen does not exist
   * yet when this file is evaluated. Queue the registration and flush it the
   * moment app.js installs the real registry. */
  function registerScreen(id, def) {
    if (typeof A.screen === 'function') { A.screen(id, def); return; }
    var q = (A._screenQueue = A._screenQueue || []);
    q.push([id, def]);
    if (q.length > 1) return;
    Object.defineProperty(A, 'screen', {
      configurable: true,
      get: function () { return undefined; },
      set: function (fn) {
        Object.defineProperty(A, 'screen', { value: fn, writable: true, configurable: true, enumerable: true });
        while (q.length) { var p = q.shift(); fn(p[0], p[1]); }
      }
    });
  }

  /* ------------------------------------------------------------- shared --- */

  function mono(text) { return el('code.mono', { text: String(text) }); }

  function named(label, suffix) { return [label, el('span.sr', { text: ' ' + suffix })]; }

  function siteName(id) {
    var s = d.sites.filter(function (x) { return x.id === id; })[0];
    return s ? s.name : String(id);
  }

  function statePill(state) {
    if (state === 'ok' || state === 'running' || state === 'up' || state === 'healthy') {
      return ui.pill(state === 'ok' ? 'Healthy' : state.charAt(0).toUpperCase() + state.slice(1), 'ok');
    }
    if (state === 'warn') return ui.pill('Degraded', 'warn');
    if (state === 'upgrading') return ui.pill('Upgrading', 'warn');
    if (state === 'repairing') return ui.pill('Repairing', 'warn');
    if (state === 'off') return ui.pill('Off', 'warn');
    if (state === 'n/a') return ui.pill('Not applicable', 'idle');
    return ui.pill(String(state), 'idle');
  }

  function utilisation(label, pct) {
    return el('div.row', [
      ui.bar(pct / 100, { label: label + ' ' + fmt.pct(pct, 0), tone: pct >= 85 ? 'warn' : null }),
      el('span.num', { text: fmt.pct(pct, 0) })
    ]);
  }

  var CONNECT_MODES = [
    {
      proto: 'rdp', name: 'Desktop', protocol: 'RDP',
      what: 'A full graphical desktop, for management consoles and installers that have no command line.'
    },
    {
      proto: 'ssh', name: 'Shell', protocol: 'SSH',
      what: 'An interactive shell on the Linux guest, for logs, services and package state.'
    },
    {
      proto: 'vnc', name: 'VM console', protocol: 'VNC',
      what: 'The hypervisor console, for a guest that has lost its network or is stuck at boot.'
    },
    {
      proto: 'powershell', name: 'PowerShell', protocol: 'JEA',
      what: 'A constrained endpoint: only the cmdlets your role is allowed to run, and every command transcribed.'
    }
  ];

  function modeFor(proto) {
    return CONNECT_MODES.filter(function (m) { return m.proto === proto; })[0] ||
      { proto: proto, name: proto, protocol: proto.toUpperCase(), what: '' };
  }

  /* --------------------------------------------------------- hosts table --- */

  function hostsTab() {
    var cols = [
      { key: 'name', label: 'Name', render: function (r) { return A.link(r.name, 'compute', ['host', r.name]); } },
      { key: 'site', label: 'Site', render: function (r) { return siteName(r.site); } },
      { key: 'role', label: 'Role' },
      { key: 'cpu', label: 'CPU', render: function (r) { return utilisation(r.name + ' CPU', r.cpu); } },
      { key: 'mem', label: 'Memory', render: function (r) { return utilisation(r.name + ' memory', r.mem); } },
      { key: 'vms', label: 'VMs', align: 'right', render: function (r) { return fmt.num(r.vms); } },
      {
        key: 'patchAgeDays', label: 'Patch age', align: 'right',
        render: function (r) {
          // Over 30 days is outside the patch window, so it stops being a
          // number in a column and becomes something to act on.
          return r.patchAgeDays > 30
            ? ui.pill(fmt.num(r.patchAgeDays) + ' d', 'warn')
            : el('span', { text: fmt.num(r.patchAgeDays) + ' d' });
        }
      },
      { key: 'wdac', label: 'WDAC mode' },
      { key: 's2d', label: 'S2D health', status: true, render: function (r) { return statePill(r.s2d); } },
      { key: 'state', label: 'State', status: true, render: function (r) { return statePill(r.state); } }
    ];
    return ui.table(cols, d.hosts, {
      caption: 'Physical hosts, with utilisation, patch age and storage health',
      sortKey: 'name',
      rowKey: function (r) { return r.name; },
      onRow: function (r) { A.go('compute', ['host', r.name]); }
    });
  }

  /* ----------------------------------------------------------- vms table --- */

  function vmsTab() {
    var cols = [
      { key: 'name', label: 'Name', render: function (r) { return A.link(r.name, 'compute', ['vm', r.name]); } },
      { key: 'host', label: 'Host', render: function (r) { return A.link(r.host, 'compute', ['host', r.host]); } },
      { key: 'os', label: 'OS' },
      { key: 'role', label: 'Role' },
      {
        key: 'vcpu', label: 'vCPU / RAM', align: 'right',
        render: function (r) { return fmt.num(r.vcpu) + ' / ' + fmt.num(r.ram) + ' GB'; }
      },
      { key: 'ip', label: 'IP', render: function (r) { return mono(r.ip); } },
      { key: 'state', label: 'State', status: true, render: function (r) { return statePill(r.state); } },
      { key: 'replica', label: 'Replica', status: true, render: function (r) { return statePill(r.replica); } },
      {
        key: 'checkpointAgeMin', label: 'Checkpoint age', align: 'right',
        render: function (r) {
          return r.checkpointAgeMin
            ? fmt.dur(r.checkpointAgeMin * 60)
            : el('span.muted', { text: 'no replica' });
        }
      },
      {
        label: 'Connect', sortable: false,
        render: function (r) {
          return el('div.row', r.connect.map(function (proto) {
            var mode = modeFor(proto);
            return ui.btn(named(mode.name, 'on ' + r.name + ' over ' + mode.protocol), {
              variant: 'ghost',
              title: 'Open a recorded ' + mode.protocol + ' session on ' + r.name,
              onClick: function () { A.connect(r, proto); }
            });
          }));
        }
      }
    ];
    // No row click here: the row carries its own buttons, and a row that
    // navigates under a button is how operators open the wrong machine.
    return ui.table(cols, d.vms, {
      caption: 'Virtual machines, with placement, replication state and the ways in to each',
      sortKey: 'name',
      rowKey: function (r) { return r.name; }
    });
  }

  /* -------------------------------------------------------------- fabric --- */

  function fabricTab() {
    var grid = el('div.nodegrid', d.sfNodes.map(function (n) {
      return el('div.nodecard', [
        el('h3', { text: n.name }),
        el('div.row', [
          statePill(n.state),
          n.seed ? ui.pill('seed', 'info') : null,
          el('span.muted', { text: 'UD ' + n.ud })
        ]),
        el('div.muted', { text: 'on ' + n.host }),
        el('div.nodecard-apps', { role: 'list', 'aria-label': 'Applications on ' + n.name },
          n.apps.map(function (app) {
            return el('span.chip', { role: 'listitem', text: app });
          }))
      ]);
    }));

    return ui.card('Service Fabric nodes', [
      el('p.hint', { text: 'An upgrade domain is the unit the cluster takes down at a time. Nodes are spread across five domains, so an upgrade or a reboot touches roughly a fifth of the cluster and the health policy can stop the rollout before it reaches the rest.' }),
      grid
    ]);
  }

  /* ----------------------------------------------------------------- gpu --- */

  function gpuTab() {
    var cards = el('div.grid.grid-2', d.gpu.cards.map(function (c) {
      return el('div.gpucard', [
        el('h3', { text: 'GPU ' + c.id + ' · ' + c.model }),
        ui.dl([
          ['Utilisation', utilisation('GPU ' + c.id + ' utilisation', c.util)],
          ['Memory', fmt.num(c.memUsedGB) + ' GB of ' + fmt.num(c.memTotalGB) + ' GB'],
          ['Temperature', fmt.num(c.tempC) + ' °C'],
          ['Current user', c.user]
        ])
      ]);
    }));

    var queueCols = [
      { key: 'job', label: 'Job' },
      { key: 'user', label: 'User' },
      {
        key: 'waitingMin', label: 'Waiting', align: 'right',
        render: function (r) { return fmt.dur(r.waitingMin * 60); }
      }
    ];

    return el('div.stack', [
      ui.card('Cards on ' + d.gpu.name, cards),
      ui.card('Queue', ui.table(queueCols, d.gpu.queue, {
        caption: 'Jobs waiting for a card on ' + d.gpu.name,
        empty: 'Nothing is waiting for a card.',
        sortKey: 'waitingMin', sortDir: 'desc'
      }), { flush: true })
    ]);
  }

  /* ---------------------------------------------------------------- list --- */

  function renderList(mount) {
    mount.appendChild(ui.pageHeader(
      'Compute',
      'The hosts underneath everything, the machines on them, the fabric they run, and the one node with cards in it.'));

    mount.appendChild(ui.tabs([
      { id: 'hosts', label: 'Hosts', render: hostsTab },
      { id: 'vms', label: 'Virtual machines', render: vmsTab },
      { id: 'fabric', label: 'Service Fabric', render: fabricTab },
      { id: 'gpu', label: 'GPU', render: gpuTab }
    ], { label: 'Compute sections' }));
  }

  /* --------------------------------------------------------- host detail --- */

  function confirmDrain(host, ctx) {
    A.confirmDestructive({
      title: 'Drain ' + host.name,
      detail: 'Every virtual machine on ' + host.name + ' is live-migrated to another host in the cluster, and ' + host.name + ' stops accepting new placements. The host itself stays up.',
      match: host.name,
      environment: ctx.env,
      blast: fmt.num(host.vms) + ' virtual machines move to another host. Each one pauses for a few seconds as memory is handed over.',
      confirmLabel: 'Drain ' + host.name,
      onConfirm: function () {
        A.flash('warn', 'Drain requested for ' + host.name,
          'Queued for review. This prototype has migrated nothing.');
      }
    });
  }

  function confirmQuarantine(host, ctx) {
    A.confirmDestructive({
      title: 'Quarantine ' + host.name,
      detail: 'Quarantine moves the network adapters of every virtual machine on ' + host.name + ' to VLAN 90, which can reach only the SIEM and the update mirror, and pages the security on-call immediately. The workloads keep running, but they lose every other route off the host, including to each other.',
      match: host.name,
      environment: ctx.env,
      blast: fmt.num(host.vms) + ' virtual machines lose all network access except the SIEM and the update mirror. Anything depending on them fails until the quarantine is lifted, and security is paged whether or not this was intended.',
      confirmLabel: 'Quarantine ' + host.name,
      onConfirm: function () {
        A.flash('bad', 'Quarantine requested for ' + host.name,
          'Security has been paged and the request is recorded in the audit. This prototype has changed no VLAN.');
      }
    });
  }

  function renderHost(mount, ctx) {
    var name = ctx.rest[1];
    var host = d.hosts.filter(function (h) { return h.name === name; })[0];
    if (!host) {
      mount.appendChild(ui.errorState(
        'No such host',
        'No host on this platform is called "' + name + '". It may have been decommissioned, or the link may come from an older runbook.',
        function () { A.go('compute'); }));
      return;
    }

    mount.appendChild(ui.pageHeader(
      host.name,
      host.role + ' · ' + siteName(host.site),
      [
        ui.btn(named('Drain', host.name), {
          variant: 'ghost',
          title: 'Live-migrate every virtual machine off ' + host.name,
          onClick: function () { confirmDrain(host, ctx); }
        }),
        ui.btn(named('Quarantine', host.name), {
          variant: 'danger',
          title: 'Move the VM adapters on ' + host.name + ' to VLAN 90 and page security',
          onClick: function () { confirmQuarantine(host, ctx); }
        })
      ]));

    mount.appendChild(el('div.tiles', [
      ui.statTile('CPU', fmt.pct(host.cpu, 0)),
      ui.statTile('Memory', fmt.pct(host.mem, 0)),
      ui.statTile('Virtual machines', fmt.num(host.vms)),
      ui.statTile('Uptime', fmt.num(host.uptimeDays), { unit: 'days' }),
      ui.statTile('Patch age', fmt.num(host.patchAgeDays), {
        unit: 'days',
        note: host.patchAgeDays > 30 ? 'outside the 30 day window' : 'within the 30 day window'
      })
    ]));

    var placed = d.vms.filter(function (v) { return v.host === host.name; });

    mount.appendChild(el('div.stack', [
      ui.card('Host', ui.dl([
        ['Name', mono(host.name)],
        ['Site', siteName(host.site)],
        ['Role', host.role],
        ['CPU', utilisation(host.name + ' CPU', host.cpu)],
        ['Memory', utilisation(host.name + ' memory', host.mem)],
        ['Virtual machines', fmt.num(host.vms)],
        ['Uptime', fmt.num(host.uptimeDays) + ' days'],
        ['Patch age', fmt.num(host.patchAgeDays) + ' days'],
        ['WDAC mode', host.wdac],
        ['S2D health', statePill(host.s2d)],
        ['State', statePill(host.state)]
      ])),
      ui.card('Virtual machines placed here', ui.table([
        { key: 'name', label: 'Name', render: function (r) { return A.link(r.name, 'compute', ['vm', r.name]); } },
        { key: 'role', label: 'Role' },
        { key: 'os', label: 'OS' },
        { key: 'ip', label: 'IP', render: function (r) { return mono(r.ip); } },
        { key: 'state', label: 'State', status: true, render: function (r) { return statePill(r.state); } },
        { key: 'replica', label: 'Replica', status: true, render: function (r) { return statePill(r.replica); } }
      ], placed, {
        caption: 'Virtual machines currently placed on ' + host.name,
        empty: 'No virtual machines are placed on this host.',
        sortKey: 'name',
        rowKey: function (r) { return r.name; },
        onRow: function (r) { A.go('compute', ['vm', r.name]); }
      }), { flush: true })
    ]));
  }

  /* ----------------------------------------------------------- vm detail --- */

  /** A stable seed per machine, so the performance series is identical on every
   *  run. The tests compare rendered output, so Math.random would be a bug. */
  function seedFor(name) {
    var s = 0;
    for (var i = 0; i < name.length; i++) s = (s * 31 + name.charCodeAt(i)) % 100003;
    return s + 1;
  }

  function vmSeries(vm) {
    var seed = seedFor(vm.name);
    var series = A.time.series;
    return [
      { label: 'CPU', unit: '%', values: series(24, 28 + vm.vcpu, 18, seed) },
      { label: 'Memory', unit: '%', values: series(24, 54, 16, seed + 7) },
      { label: 'Disk', unit: ' IOPS', values: series(24, 420, 260, seed + 13) },
      { label: 'Network', unit: ' Mbit/s', values: series(24, 96, 58, seed + 29) }
    ];
  }

  function stats(values) {
    var min = Math.min.apply(null, values), max = Math.max.apply(null, values);
    var sum = values.reduce(function (a, b) { return a + b; }, 0);
    return { latest: values[values.length - 1], min: min, max: max, mean: sum / values.length };
  }

  function performanceTab(vm) {
    var metrics = vmSeries(vm).map(function (m) {
      var s = stats(m.values);
      return {
        label: m.label, unit: m.unit, values: m.values,
        latest: s.latest, min: s.min, max: s.max, mean: s.mean
      };
    });

    var charts = el('div.stack', metrics.map(function (m) {
      return el('div.row', [
        el('span', { text: m.label }),
        ui.sparkline(m.values, {
          label: m.label + ' on ' + vm.name + ' over 24 hours, from ' +
            fmt.num(m.min, 1) + m.unit + ' to ' + fmt.num(m.max, 1) + m.unit +
            ', now ' + fmt.num(m.latest, 1) + m.unit
        }),
        el('span.num', { text: fmt.num(m.latest, 1) + m.unit })
      ]);
    }));

    // The sparklines are the shape; the table is the data. Both, always.
    var cols = [
      { key: 'label', label: 'Metric' },
      { key: 'latest', label: 'Now', align: 'right', render: function (r) { return fmt.num(r.latest, 1) + r.unit; } },
      { key: 'mean', label: 'Mean, 24 h', align: 'right', render: function (r) { return fmt.num(r.mean, 1) + r.unit; } },
      { key: 'min', label: 'Low', align: 'right', render: function (r) { return fmt.num(r.min, 1) + r.unit; } },
      { key: 'max', label: 'High', align: 'right', render: function (r) { return fmt.num(r.max, 1) + r.unit; } }
    ];

    return el('div.stack', [
      ui.card('Last 24 hours', charts),
      ui.card('Values', ui.table(cols, metrics, {
        caption: 'Performance of ' + vm.name + ' over 24 hours: current, mean, low and high',
        sortKey: 'label'
      }), { flush: true })
    ]);
  }

  function replicaTab(vm) {
    var unprotected = vm.replica === 'off';
    return el('div.stack', [
      unprotected ? el('div.callout.warn', [
        el('strong', { text: 'This machine is not protected.' }),
        el('p', { text: vm.name + ' has Hyper-V Replica switched off, so there is no warm copy at Site B. If the host or the site is lost, this machine is recovered from backup only, at whatever the backup age happens to be, and the failover runbook will skip it.' })
      ]) : null,
      ui.card('Replication', ui.dl([
        ['Replica health', statePill(vm.replica)],
        ['Checkpoint age', vm.checkpointAgeMin
          ? fmt.dur(vm.checkpointAgeMin * 60)
          : el('span.muted', { text: 'no checkpoint, replication is off' })],
        ['Replica site', unprotected || vm.replica === 'n/a' ? el('span.muted', { text: 'none' }) : siteName('b')],
        ['Primary host', A.link(vm.host, 'compute', ['host', vm.host])],
        ['Zone', vm.zone]
      ]))
    ]);
  }

  function connectCard(vm, mode) {
    var available = vm.connect.indexOf(mode.proto) !== -1;
    var reason = vm.name + ' does not offer ' + mode.name + ' over ' + mode.protocol +
      '. Its role and operating system do not expose that protocol, so the gateway has no route for it.';
    return el('div.connectcard', [
      el('h3', { text: mode.name + ' · ' + mode.protocol }),
      el('p.muted', { text: mode.what }),
      ui.btn(named('Connect', 'to ' + vm.name + ' with ' + mode.name + ' over ' + mode.protocol), {
        variant: available ? 'primary' : 'ghost',
        disabled: !available,
        title: available
          ? 'Open a recorded ' + mode.protocol + ' session on ' + vm.name
          : reason,
        onClick: function () { A.connect(vm, mode.proto); }
      }),
      available ? null : el('p.hint', { text: reason })
    ]);
  }

  function connectTab(vm) {
    return el('div.stack', [
      el('div.callout.info', [
        el('strong', { text: 'What happens when you connect' }),
        el('ol', [
          el('li', { text: 'Your role and the tier of ' + vm.name + ' are checked.' }),
          el('li', { text: 'If you do not already hold the right group, the console asks you to elevate, with a reason and a time box.' }),
          el('li', { text: 'OpenBao issues a one-time credential for this session. You never see it, and it is never shown on screen.' }),
          el('li', { text: 'The session is recorded to argus-sessions, which is write-once for 400 days.' }),
          el('li', { text: 'Clipboard and file transfer are gated by your role: paste in only, no file transfer, for an operator.' }),
          el('li', { text: 'The credential is revoked at expiry, and the recording is sealed.' })
        ])
      ]),
      el('div.connectgrid', CONNECT_MODES.map(function (mode) { return connectCard(vm, mode); }))
    ]);
  }

  function overviewTab(vm) {
    return ui.card('Machine', ui.dl([
      ['Name', mono(vm.name)],
      ['Host', A.link(vm.host, 'compute', ['host', vm.host])],
      ['Site', siteName(vm.site)],
      ['Operating system', vm.os],
      ['Role', vm.role],
      ['vCPU', fmt.num(vm.vcpu)],
      ['Memory', fmt.num(vm.ram) + ' GB'],
      ['IP address', mono(vm.ip)],
      ['Network zone', vm.zone],
      ['State', statePill(vm.state)],
      ['Replica health', statePill(vm.replica)],
      ['Checkpoint age', vm.checkpointAgeMin
        ? fmt.dur(vm.checkpointAgeMin * 60)
        : el('span.muted', { text: 'no replica' })],
      ['Ways in', vm.connect.map(function (p) { return modeFor(p).name; }).join(', ')]
    ]));
  }

  function renderVm(mount, ctx) {
    var name = ctx.rest[1];
    var vm = d.vmByName(name);
    if (!vm) {
      mount.appendChild(ui.errorState(
        'No such virtual machine',
        'No machine on this platform is called "' + name + '". It may have been renamed or deleted, or the link may come from an older runbook.',
        function () { A.go('compute'); }));
      return;
    }

    mount.appendChild(ui.pageHeader(
      vm.name,
      vm.role + ' · ' + vm.os + ' · ' + vm.ip));

    mount.appendChild(el('div.tiles', [
      ui.statTile('State', vm.state === 'running' ? 'Running' : vm.state),
      ui.statTile('vCPU', fmt.num(vm.vcpu)),
      ui.statTile('Memory', fmt.num(vm.ram), { unit: 'GB' }),
      ui.statTile('Host', vm.host, { note: siteName(vm.site) }),
      ui.statTile('Replica', vm.replica === 'off' ? 'Off' : (vm.replica === 'n/a' ? 'Not applicable' : 'Healthy'), {
        note: vm.checkpointAgeMin ? 'checkpoint ' + fmt.dur(vm.checkpointAgeMin * 60) + ' old' : 'no checkpoint'
      })
    ]));

    mount.appendChild(ui.tabs([
      { id: 'overview', label: 'Overview', render: function () { return overviewTab(vm); } },
      { id: 'performance', label: 'Performance', render: function () { return performanceTab(vm); } },
      { id: 'replica', label: 'Replica', render: function () { return replicaTab(vm); } },
      { id: 'connect', label: 'Connect', render: function () { return connectTab(vm); } }
    ], { label: 'Sections of ' + vm.name }));
  }

  /* ----------------------------------------------------------- register --- */

  registerScreen('compute', {
    title: 'Compute',
    crumb: 'Compute',
    render: function (mount, ctx) {
      var rest = ctx.rest || [];
      if (rest[0] === 'host' && rest[1]) { renderHost(mount, ctx); return; }
      if (rest[0] === 'vm' && rest[1]) { renderVm(mount, ctx); return; }
      if (rest.length) {
        mount.appendChild(ui.errorState(
          'That compute link is not valid',
          'A compute link is either /compute/host/<name> or /compute/vm/<name>.',
          function () { A.go('compute'); }));
        return;
      }
      renderList(mount);
    }
  });
})();
