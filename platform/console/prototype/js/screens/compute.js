(function () {
  'use strict';

  var A = window.ARGUS, ui = A.ui, el = ui.el, d = A.data, fmt = ui.fmt;

  function mono(text) { return el('code.mono', { text: String(text) }); }

  function named(label, suffix) { return [label, el('span.sr', { text: ' ' + suffix })]; }


  function setCounter(card, n) {
    var row = card.querySelector('.card-titlerow');
    if (!row) return;
    var c = row.querySelector('.card-counter');
    if (!c) { c = el('span.card-counter'); row.appendChild(c); }
    c.textContent = '(' + fmt.num(n) + ')';
  }

  function listCard(title, t, name, n, extra) {
    return ui.card(title, t, {
      counter: n,
      actions: [ui.columnsButton(function () { return t; }, name), ui.exportButton(function () { return t; }, name)].concat(extra || [])
    });
  }

  var siteIndex = null, siteIndexFor = null;
  function siteName(id) {
    if (siteIndexFor !== d.sites || !siteIndex) {
      siteIndexFor = d.sites;
      siteIndex = Object.create(null);
      d.sites.forEach(function (x) { siteIndex[x.id] = x.name; });
    }
    return siteIndex[id] || String(id);
  }

  function vmsOn(hostName) {
    return d.vms.filter(function (v) { return v.host === hostName; });
  }

  function statePill(state) {
    if (state === 'ok' || state === 'running' || state === 'up' || state === 'healthy') {
      return ui.status('ok', state === 'ok' ? 'Healthy' : state.charAt(0).toUpperCase() + state.slice(1));
    }
    if (state === 'warn') return ui.status('warn', 'Degraded');
    if (state === 'upgrading') return ui.status('pending', 'Upgrading');
    if (state === 'repairing') return ui.status('pending', 'Repairing');
    if (state === 'off') return ui.status('warn', 'Off');
    if (state === 'stopped') return ui.status('idle', 'Stopped');
    if (state === 'n/a') return ui.status('idle', 'Not applicable');
    return ui.status('idle', String(state));
  }

  function utilisation(label, pct) {
    return el('div.row', [
      ui.bar(pct / 100, { label: label + ' ' + fmt.pct(pct, 0), tone: pct >= 85 ? 'warn' : null }),
      el('span.num', { text: fmt.pct(pct, 0) })
    ]);
  }

  function checkpointAge(vm) {
    return (vm.checkpointAgeMin !== null && vm.checkpointAgeMin !== undefined)
      ? fmt.dur(vm.checkpointAgeMin * 60)
      : el('span.muted', { text: 'No replica' });
  }

  var CONNECT_MODES = [
    { proto: 'rdp', name: 'Desktop', protocol: 'RDP', what: 'Graphical desktop for consoles and installers.' },
    { proto: 'ssh', name: 'Shell', protocol: 'SSH', what: 'Interactive shell on the Linux guest.' },
    { proto: 'vnc', name: 'VM console', protocol: 'VNC', what: 'Hypervisor console, for a guest without network.' },
    { proto: 'powershell', name: 'PowerShell', protocol: 'JEA', what: 'Constrained endpoint, every command transcribed.' }
  ];

  function modeFor(proto) {
    return CONNECT_MODES.filter(function (m) { return m.proto === proto; })[0] ||
      { proto: proto, name: proto, protocol: proto.toUpperCase(), what: '' };
  }

  function hostsTab() {
    var cols = [
      { key: 'name', label: 'Name', render: function (r) { return A.link(r.name, 'compute', ['host', r.name]); } },
      { key: 'state', label: 'State', status: true, render: function (r) { return statePill(r.state); } },
      { key: 's2d', label: 'S2D health', status: true, render: function (r) { return statePill(r.s2d); } },
      { key: 'cpu', label: 'CPU', render: function (r) { return utilisation(r.name + ' CPU', r.cpu); } },
      { key: 'mem', label: 'Memory', render: function (r) { return utilisation(r.name + ' memory', r.mem); } },
      { key: 'vms', label: 'VMs', align: 'right',
        sort: function (r) { return vmsOn(r.name).length; },
        render: function (r) { return fmt.num(vmsOn(r.name).length); } },
      {
        key: 'patchAgeDays', label: 'Patch age', align: 'right',
        render: function (r) {
          return r.patchAgeDays > 30
            ? ui.status('warn', fmt.num(r.patchAgeDays) + ' d')
            : el('span', { text: fmt.num(r.patchAgeDays) + ' d' });
        }
      },
      { key: 'site', label: 'Site', render: function (r) { return siteName(r.site); } },
      { key: 'role', label: 'Role' },
      { key: 'wdac', label: 'WDAC mode' }
    ];
    var hostTable = ui.table(cols, d.hosts, {
      id: 'compute.hosts', defaultHidden: ['site', 'role', 'wdac'],
      caption: 'Physical hosts, with utilisation, patch age and storage health',
      sortKey: 'name',
      rowKey: function (r) { return r.name; },
      onRow: function (r) { A.go('compute', ['host', r.name]); }
    });
    return listCard('Hosts', hostTable, 'hosts', d.hosts.length);
  }

  function vmsTab() {
    var cols = [
      { key: 'name', label: 'Name', render: function (r) { return A.link(r.name, 'compute', ['vm', r.name]); } },
      { key: 'state', label: 'State', status: true, render: function (r) { return statePill(r.state); } },
      { key: 'host', label: 'Host', render: function (r) { return A.link(r.host, 'compute', ['host', r.host]); } },
      { key: 'os', label: 'OS' },
      {
        key: 'vcpu', label: 'vCPU / RAM', align: 'right',
        render: function (r) { return fmt.num(r.vcpu) + ' / ' + fmt.num(r.ram) + ' GB'; }
      },
      { key: 'ip', label: 'IP', render: function (r) { return mono(r.ip); } },
      { key: 'replica', label: 'Replica', status: true, render: function (r) { return statePill(r.replica); } },
      { key: 'role', label: 'Role' },
      {
        key: 'tags', label: 'Tags', sortable: false,
        csv: function (r) { var t = r.tags || {}; return Object.keys(t).map(function (k) { return k + ':' + t[k]; }).join(' '); },
        render: function (r) { return A.tagChips(r); }
      },
      { key: 'checkpointAgeMin', label: 'Checkpoint age', align: 'right', render: checkpointAge },
      {
        key: 'connect', label: 'Connect', sortable: false,
        csv: function (r) { return r.connect.join('; '); },
        render: function (r) {
          return el('div.row', r.connect.map(function (proto) {
            var mode = modeFor(proto);
            return ui.btn(named(mode.name, 'on ' + r.name + ' over ' + mode.protocol), {
              variant: 'link',
              title: 'Open a recorded ' + mode.protocol + ' session on ' + r.name,
              onClick: function () { A.connect(r, proto); }
            });
          }));
        }
      }
    ];
    var vmTable = ui.table(cols, d.vms, {
      id: 'compute.vms', defaultHidden: ['role', 'tags', 'checkpointAgeMin', 'connect'],
      caption: 'Virtual machines, with placement, replication state and the ways in to each',
      sortKey: 'name',
      rowKey: function (r) { return r.name; },
      onRow: function (r) { A.go('compute', ['vm', r.name]); }
    });
    return listCard('Virtual machines', vmTable, 'virtual machines', d.vms.length);
  }

  function fabricTab() {
    var t = ui.table([
      { key: 'name', label: 'Name', render: function (n) { return mono(n.name); } },
      { key: 'state', label: 'State', status: true, render: function (n) { return statePill(n.state); } },
      { key: 'ud', label: 'Upgrade domain', align: 'right', render: function (n) { return fmt.num(n.ud); } },
      { key: 'seed', label: 'Seed', sort: function (n) { return n.seed ? 0 : 1; }, render: function (n) { return n.seed ? ui.badge('Seed') : el('span.muted', { text: '-' }); } },
      { key: 'host', label: 'Host', render: function (n) { return A.link(n.host, 'compute', ['host', n.host]); } },
      {
        key: 'apps', label: 'Applications', sortable: false, csv: function (n) { return n.apps.join('; '); },
        render: function (n) { return el('div.chips', n.apps.map(function (app) { return el('span.chip', { text: app }); })); }
      }
    ], d.sfNodes, {
      caption: 'Service Fabric nodes with their upgrade domain, host and applications',
      sortKey: 'ud',
      rowKey: function (n) { return n.name; }
    });
    var domains = {};
    d.sfNodes.forEach(function (n) { domains[n.ud] = true; });
    return ui.card('Service Fabric nodes', t, {
      counter: d.sfNodes.length,
      description: fmt.num(Object.keys(domains).length) + ' upgrade domains; an upgrade takes down one domain at a time.',
      actions: [ui.exportButton(function () { return t; }, 'Service Fabric nodes')]
    });
  }

  function gpuTab() {
    var cards = ui.table([
      { key: 'id', label: 'Card', render: function (c) { return 'GPU ' + c.id; } },
      { key: 'model', label: 'Model' },
      { key: 'util', label: 'Utilisation', render: function (c) { return utilisation('GPU ' + c.id + ' utilisation', c.util); } },
      { key: 'memUsedGB', label: 'Memory', align: 'right', render: function (c) { return fmt.num(c.memUsedGB) + ' of ' + fmt.num(c.memTotalGB) + ' GB'; } },
      { key: 'tempC', label: 'Temperature', align: 'right', render: function (c) { return fmt.num(c.tempC) + ' °C'; } },
      { key: 'user', label: 'Current user' }
    ], d.gpu.cards, {
      caption: 'GPU cards on ' + d.gpu.name,
      sortKey: 'id',
      rowKey: function (c) { return String(c.id); }
    });

    var queue = ui.table([
      { key: 'job', label: 'Job', render: function (r) { return mono(r.job); } },
      { key: 'user', label: 'User' },
      { key: 'waitingMin', label: 'Waiting', align: 'right', render: function (r) { return fmt.dur(r.waitingMin * 60); } }
    ], d.gpu.queue, {
      caption: 'Jobs waiting for a card on ' + d.gpu.name,
      emptyTitle: 'No jobs waiting',
      sortKey: 'waitingMin', sortDir: 'desc'
    });

    return el('div.grid', [
      ui.card('Cards on ' + d.gpu.name, cards, { counter: d.gpu.cards.length }),
      ui.card('Queue', queue, { counter: d.gpu.queue.length })
    ]);
  }

  function renderList(mount, ctx) {
    mount.appendChild(ui.pageHeader('Compute'));

    mount.appendChild(ui.tabs([
      { id: 'hosts', label: 'Hosts', render: hostsTab },
      { id: 'vms', label: 'Virtual machines', render: vmsTab },
      { id: 'fabric', label: 'Service Fabric', render: fabricTab },
      { id: 'gpu', label: 'GPU', render: gpuTab }
    ], {
      label: 'Compute sections',
      initial: (ctx && ctx.rest && ctx.rest[0]) || null,
      href: function (id) { return A.href('compute', [id]); }
    }));
  }

  function patchNow(host, ctx) {
    A.confirmDestructive({
      title: 'Patch ' + host.name + ' now',
      match: host.name,
      confirmLabel: 'Patch ' + host.name,
      detail: 'Patching outside the Tuesday window drains ' + host.name + ', applies the cumulative update and reboots it. The virtual machines on it live-migrate first, so this is a few seconds of pause each rather than an outage.',
      blast: fmt.num(vmsOn(host.name).length) + ' virtual machines move to another host for about twenty minutes. ' + (host.s2d === 'repairing' ? 'Storage Spaces Direct is repairing on this host; a reboot now extends the repair.' : 'Storage is healthy.'),
      reversible: 'A failed update rolls back on reboot. The patch age resets only when the host reports the new build.',
      environment: ctx.env,
      onConfirm: function () {
        host.patchAgeDays = 0;
        host.uptimeDays = 0;
        A.record('host.patch', host.name + ' (' + ctx.env + ')');
        A.flash('ok', host.name + ' patched', 'Rebooted on the current cumulative update. The patch age is zero and the Advisor finding has cleared.');
        A.refresh();
      }
    });
  }

  function vmActions(vm, ctx) {
    var running = vm.state === 'running';
    function rec(action, target, text) {
      A.record(action, target + ' (' + ctx.env + ')');
      A.flash('ok', text[0], text[1]);
      A.refresh();
    }
    return ui.menu([
      { label: 'Connect', hint: 'recorded', onSelect: function () { A.go('compute', ['vm', vm.name, 'connect']); } },
      'divider',
      {
        label: running ? 'Stop' : 'Start', hint: running ? 'graceful' : 'on ' + vm.host,
        onSelect: function () {
          if (!running) {
            vm.state = 'running';
            rec('vm.start', vm.name, ['Started ' + vm.name, 'The guest is booting on ' + vm.host + '. Replication resumes once it is up.']);
            return;
          }
          A.confirmDestructive({
            title: 'Stop ' + vm.name, match: vm.name, confirmLabel: 'Stop ' + vm.name, environment: ctx.env,
            detail: 'A graceful shutdown through the guest. ' + vm.role + ' stops serving until it is started again.',
            blast: vm.zone + '. ' + (vm.replica === 'healthy' ? 'Replication pauses at the last checkpoint.' : 'No replica is affected.'),
            reversible: 'Start it again from the same menu.',
            onConfirm: function () {
              vm.state = 'stopped';
              rec('vm.stop', vm.name, ['Stopped ' + vm.name, 'The guest shut down cleanly. Start it from the Actions menu.']);
            }
          });
        }
      },
      {
        label: 'Restart', disabled: !running, title: running ? null : 'The machine is stopped; start it instead',
        onSelect: function () {
          A.confirmDestructive({
            title: 'Restart ' + vm.name, match: vm.name, confirmLabel: 'Restart ' + vm.name, environment: ctx.env,
            detail: 'A guest-initiated reboot. Anything in flight on ' + vm.name + ' is cut; connections re-establish when it is back.',
            blast: vm.role + ' in ' + vm.zone + ' is unavailable for about ninety seconds.',
            onConfirm: function () { rec('vm.restart', vm.name, ['Restarting ' + vm.name, 'Back in about ninety seconds. The restart is in the audit.']); }
          });
        }
      },
      {
        label: 'Resize', hint: vm.vcpu + ' vCPU / ' + vm.ram + ' GB',
        onSelect: function () {
          var cpu = el('select.field', { id: 'vm-vcpu' }, [2, 4, 8, 16, 32].map(function (n) { return el('option', { value: String(n), text: n + ' vCPU', selected: n === vm.vcpu ? true : null }); }));
          var ram = el('select.field', { id: 'vm-ram' }, [4, 8, 16, 32, 64, 128, 256].map(function (n) { return el('option', { value: String(n), text: n + ' GB', selected: n === vm.ram ? true : null }); }));
          A.dialog({
            title: 'Resize ' + vm.name,
            body: function () {
              return [
                el('p', { text: 'The new size goes into the declaration and the reconciler applies it at the next reboot of ' + vm.name + '. Memory can grow while running; vCPU changes need the reboot.' }),
                el('label.fieldlabel', { for: 'vm-vcpu', text: 'vCPU' }), cpu,
                el('label.fieldlabel', { for: 'vm-ram', text: 'Memory' }), ram,
                el('p.hint', { text: 'Host ' + vm.host + ' has ' + fmt.pct(100 - d.hosts.filter(function (h) { return h.name === vm.host; })[0].mem, 0) + ' of its memory free.' })
              ];
            },
            actions: function (close) {
              return [ui.btn('Cancel', { variant: 'ghost', onClick: close }), ui.btn('Open pull request', {
                variant: 'primary',
                onClick: function () {
                  var from = vm.vcpu + ' vCPU / ' + vm.ram + ' GB';
                  vm.vcpu = Number(cpu.value); vm.ram = Number(ram.value);
                  close();
                  rec('vm.resize', vm.name + ' from ' + from + ' to ' + vm.vcpu + ' vCPU / ' + vm.ram + ' GB', ['Resize opened for ' + vm.name, 'From ' + from + ' to ' + vm.vcpu + ' vCPU / ' + vm.ram + ' GB, applied at the next reboot.']);
                }
              })];
            }
          });
        }
      },
      'divider',
      {
        label: 'Take checkpoint', hint: 'now',
        onSelect: function () {
          vm.checkpointAgeMin = 0;
          rec('vm.checkpoint', vm.name, ['Checkpoint taken on ' + vm.name, 'Application-consistent, shipped to Site B next cycle.']);
        }
      },
      {
        label: vm.replica === 'off' ? 'Enable replica at Site B' : 'Replica is on', disabled: vm.replica !== 'off',
        title: vm.replica === 'off' ? null : 'Replication is already ' + vm.replica,
        onSelect: function () {
          vm.replica = 'healthy';
          vm.checkpointAgeMin = 0;
          rec('vm.protect', vm.name, ['Replication enabled for ' + vm.name, 'The initial copy to Site B is running. The Advisor finding for this machine has cleared.']);
        }
      },
      'divider',
      { label: 'Edit tags', onSelect: function () { A.tagEditor(vm, vm.name, function () { A.refresh(); }); } }
    ], { label: 'Actions for ' + vm.name, text: 'Actions' });
  }

  function confirmDrain(host, ctx) {
    A.confirmDestructive({
      title: 'Drain ' + host.name,
      detail: 'Every virtual machine on ' + host.name + ' is live-migrated to another host in the cluster, and ' + host.name + ' stops accepting new placements. The host itself stays up.',
      match: host.name,
      environment: ctx.env,
      blast: fmt.num(vmsOn(host.name).length) + ' virtual machines move to another host. Each one pauses for a few seconds as memory is handed over.',
      confirmLabel: 'Drain ' + host.name,
      onConfirm: function () {
        A.record('host.drain', host.name + ' (' + ctx.env + ')');
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
      blast: fmt.num(vmsOn(host.name).length) + ' virtual machines lose all network access except the SIEM and the update mirror. Anything depending on them fails until the quarantine is lifted, and security is paged whether or not this was intended.',
      confirmLabel: 'Quarantine ' + host.name,
      onConfirm: function () {
        A.record('host.quarantine', host.name + ' (' + ctx.env + ')');
        A.flash('bad', 'Quarantine requested for ' + host.name,
          'Security has been paged and the request is recorded in the audit. This prototype has changed no VLAN.');
      }
    });
  }

  function activityFor(name) {
    var rows = d.audit.filter(function (r) { return String(r.target).indexOf(name) !== -1; });
    return ui.card('Activity', ui.table([
      { key: 'at', label: 'Time', sort: function (r) { return r.at.getTime(); }, render: function (r) { return fmt.time(r.at); } },
      { key: 'action', label: 'Event', render: function (r) { return mono(r.action); } },
      { key: 'actor', label: 'Operator', render: function (r) { return A.personName(r.actor); } },
      { key: 'target', label: 'Resource' }
    ], rows, {
      caption: 'Audit events that name ' + name,
      sortKey: 'at', sortDir: 'desc',
      emptyTitle: 'No activity',
      empty: 'No audit event names ' + name + '.',
      rowKey: function (r) { return String(r.at.getTime()) + r.action; }
    }), { counter: rows.length, footer: [A.link('View audit log', 'audit')] });
  }

  function renderHost(mount, ctx) {
    var name = ctx.rest[1];
    var host = d.hosts.filter(function (h) { return h.name === name; })[0];
    if (!host) {
      mount.appendChild(ui.notFound('host', name, 'compute/hosts', 'All hosts'));
      return;
    }

    mount.appendChild(ui.pageHeader(host.name, null, [
      ui.menu([
        { label: 'Drain', hint: 'live-migrate VMs', title: 'Live-migrate every virtual machine off ' + host.name, onSelect: function () { confirmDrain(host, ctx); } },
        'divider',
        { label: 'Quarantine', danger: true, title: 'Move the VM adapters on ' + host.name + ' to VLAN 90 and page security', onSelect: function () { confirmQuarantine(host, ctx); } }
      ], { label: 'Actions for ' + host.name, text: 'Actions' }),
      ui.btn(named('Patch now', host.name), {
        variant: host.patchAgeDays > 30 ? 'primary' : 'normal',
        title: 'Drain, patch and reboot ' + host.name + ' outside the Tuesday window',
        onClick: function () { patchNow(host, ctx); }
      })
    ], { status: statePill(host.state) }));

    var placed = vmsOn(host.name);

    function details() {
      return el('div.grid', [
        ui.card('Details', ui.dl([
          ['Site', siteName(host.site)],
          ['Role', host.role],
          ['State', statePill(host.state)],
          ['S2D health', statePill(host.s2d)],
          ['CPU', utilisation(host.name + ' CPU', host.cpu)],
          ['Memory', utilisation(host.name + ' memory', host.mem)],
          ['Virtual machines', fmt.num(placed.length)],
          ['Uptime', fmt.num(host.uptimeDays) + ' days'],
          ['Patch age', host.patchAgeDays > 30 ? ui.status('warn', fmt.num(host.patchAgeDays) + ' days') : fmt.num(host.patchAgeDays) + ' days'],
          ['WDAC mode', host.wdac]
        ])),
        ui.card('Virtual machines', ui.table([
          { key: 'name', label: 'Name', render: function (r) { return A.link(r.name, 'compute', ['vm', r.name]); } },
          { key: 'state', label: 'State', status: true, render: function (r) { return statePill(r.state); } },
          { key: 'role', label: 'Role' },
          { key: 'os', label: 'OS' },
          { key: 'ip', label: 'IP', render: function (r) { return mono(r.ip); } },
          { key: 'replica', label: 'Replica', status: true, render: function (r) { return statePill(r.replica); } }
        ], placed, {
          caption: 'Virtual machines currently placed on ' + host.name,
          emptyTitle: 'No virtual machines',
          empty: 'Nothing is placed on this host.',
          sortKey: 'name',
          rowKey: function (r) { return r.name; },
          onRow: function (r) { A.go('compute', ['vm', r.name]); }
        }), { counter: placed.length })
      ]);
    }

    mount.appendChild(ui.tabs([
      { id: 'details', label: 'Details', render: details },
      { id: 'activity', label: 'Activity', render: function () { return activityFor(host.name); } }
    ], {
      label: 'Sections of ' + host.name,
      initial: (ctx && ctx.rest && ctx.rest[2]) || null,
      href: function (id) { return A.href('compute', ['host', host.name, id]); }
    }));
  }

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

    var cols = [
      { key: 'label', label: 'Metric' },
      {
        key: 'trend', label: 'Last 24 hours', sortable: false,
        render: function (m) {
          return ui.sparkline(m.values, {
            label: m.label + ' on ' + vm.name + ' over 24 hours, from ' +
              fmt.num(m.min, 1) + m.unit + ' to ' + fmt.num(m.max, 1) + m.unit +
              ', now ' + fmt.num(m.latest, 1) + m.unit
          });
        }
      },
      { key: 'latest', label: 'Now', align: 'right', render: function (r) { return fmt.num(r.latest, 1) + r.unit; } },
      { key: 'mean', label: 'Mean', align: 'right', render: function (r) { return fmt.num(r.mean, 1) + r.unit; } },
      { key: 'min', label: 'Low', align: 'right', render: function (r) { return fmt.num(r.min, 1) + r.unit; } },
      { key: 'max', label: 'High', align: 'right', render: function (r) { return fmt.num(r.max, 1) + r.unit; } }
    ];

    return ui.card('Metrics', ui.table(cols, metrics, {
      caption: 'Performance of ' + vm.name + ' over 24 hours: trend, current, mean, low and high',
      rowKey: function (m) { return m.label; }
    }), { description: 'Last 24 hours, one sample an hour.' });
  }

  function replicaTab(vm) {
    var unprotected = vm.replica === 'off';
    return el('div.grid', [
      ui.card('Replication', ui.dl([
        ['Replica health', statePill(vm.replica)],
        ['Checkpoint age', (vm.checkpointAgeMin !== null && vm.checkpointAgeMin !== undefined)
          ? fmt.dur(vm.checkpointAgeMin * 60)
          : el('span.muted', { text: 'No checkpoint' })],
        ['Replica site', unprotected || vm.replica === 'n/a' ? el('span.muted', { text: 'None' }) : siteName('b')],
        ['Primary host', A.link(vm.host, 'compute', ['host', vm.host])],
        ['Zone', vm.zone]
      ])),
      unprotected ? el('div.callout.warn', [
        el('strong', { text: 'Not protected.' }),
        el('p', { text: 'No warm copy at Site B. If the host is lost, ' + vm.name + ' is recovered from backup only.' })
      ]) : null
    ]);
  }

  function connectCard(vm, mode) {
    var available = vm.connect.indexOf(mode.proto) !== -1;
    var reason = vm.name + ' does not offer ' + mode.protocol + '.';
    return el('div.connectcard', [
      el('h3', { text: mode.name + ' · ' + mode.protocol }),
      el('p.muted', { text: mode.what }),
      ui.btn(named('Connect', 'to ' + vm.name + ' with ' + mode.name + ' over ' + mode.protocol), {
        variant: available ? 'primary' : 'normal',
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
    return el('div.grid', [
      ui.card('Connect', el('div.connectgrid', CONNECT_MODES.map(function (mode) { return connectCard(vm, mode); })), {
        description: 'Every session is recorded and uses a one-time credential.'
      }),
      ui.disclosure('Details', [
        el('ol', [
          el('li', { text: 'Your role and the tier of ' + vm.name + ' are checked.' }),
          el('li', { text: 'Without the right group, the console asks you to elevate, with a reason and a time box.' }),
          el('li', { text: 'OpenBao issues a one-time credential. It is never shown.' }),
          el('li', { text: 'The session is recorded to argus-sessions, write-once for 400 days.' }),
          el('li', { text: 'Clipboard and file transfer follow your role: paste in only, no file transfer, for an operator.' }),
          el('li', { text: 'The credential is revoked at expiry and the recording sealed.' })
        ])
      ])
    ]);
  }

  function detailsTab(vm) {
    return el('div.grid', [
      ui.card('Details', ui.dl([
        ['State', statePill(vm.state)],
        ['Host', A.link(vm.host, 'compute', ['host', vm.host])],
        ['Site', siteName(vm.site)],
        ['Operating system', vm.os],
        ['Role', vm.role],
        ['vCPU', fmt.num(vm.vcpu)],
        ['Memory', fmt.num(vm.ram) + ' GB'],
        ['IP address', mono(vm.ip)],
        ['Network zone', vm.zone],
        ['Replica health', statePill(vm.replica)],
        ['Checkpoint age', checkpointAge(vm)],
        ['Ways in', vm.connect.map(function (p) { return modeFor(p).name; }).join(', ')]
      ])),
      ui.card('Tags', A.tagChips(vm), {
        actions: [ui.btn('Edit tags', { onClick: function () { A.tagEditor(vm, vm.name, function () { A.refresh(); }); } })]
      })
    ]);
  }

  function renderVm(mount, ctx) {
    var name = ctx.rest[1];
    var vm = d.vmByName(name);
    if (!vm) {
      mount.appendChild(ui.notFound('virtual machine', name, 'compute/vms', 'All virtual machines'));
      return;
    }

    mount.appendChild(ui.pageHeader(vm.name, null, [
      vmActions(vm, ctx),
      ui.btn(named('Connect', 'to ' + vm.name), {
        variant: 'primary',
        title: 'Open a recorded session on ' + vm.name,
        onClick: function () { A.go('compute', ['vm', vm.name, 'connect']); }
      })
    ], { status: statePill(vm.state) }));

    mount.appendChild(ui.tabs([
      { id: 'details', label: 'Details', render: function () { return detailsTab(vm); } },
      { id: 'performance', label: 'Monitoring', render: function () { return performanceTab(vm); } },
      { id: 'replica', label: 'Replication', render: function () { return replicaTab(vm); } },
      { id: 'connect', label: 'Connect', render: function () { return connectTab(vm); } },
      { id: 'activity', label: 'Activity', render: function () { return activityFor(vm.name); } }
    ], {
      label: 'Sections of ' + vm.name,
      initial: (ctx && ctx.rest && ctx.rest[2]) || null,
      href: function (id) { return A.href('compute', ['vm', vm.name, id]); }
    }));
  }

  function decide(fn) {
    var m = A.storeMode();
    if (m === A.MODE.LIVE || m === A.MODE.SAMPLE) { fn(m); return; }
    A.whenProbed(fn);
  }

  function exitOf(c) {
    if (c && typeof c.exitCode === 'number') return c.exitCode;
    var m = /Exited \((-?\d+)\)/i.exec((c && c.status) || '');
    return m ? Number(m[1]) : null;
  }

  function containerStatus(state, code) {
    var s = String(state || 'unknown');
    if (s === 'running') return ui.status('ok', 'Running');
    if (s === 'exited' || s === 'dead') {
      if (code === 0) return ui.status('idle', 'Completed', { title: 'Exited with code 0: a one-shot container that finished its job.' });
      return ui.status('bad', 'Exited' + (code === null || code === undefined ? '' : ' (' + code + ')'));
    }
    if (s === 'restarting') return ui.status('warn', 'Restarting');
    if (s === 'paused') return ui.status('warn', 'Paused');
    if (s === 'created') return ui.status('pending', 'Created');
    return ui.status('idle', s.charAt(0).toUpperCase() + s.slice(1));
  }

  function shortImage(img) {
    var t = String(img || '');
    var m = /^(.*?)(@?)sha256:([0-9a-f]{12})[0-9a-f]{52}$/i.exec(t);
    if (m) return (m[1] ? m[1] + (m[2] || '@') : '') + 'sha256:' + m[3];
    return t;
  }

  function imageNode(img) {
    if (!img) return el('span.muted', { text: '-' });
    return el('span.mono', { text: shortImage(img), title: img, style: { display: 'inline-block', 'max-width': '42ch', 'white-space': 'nowrap', overflow: 'hidden', 'text-overflow': 'ellipsis', 'vertical-align': 'top', 'overflow-wrap': 'normal' } });
  }

  function nameLink(text, route, rest) {
    var a = A.link(text, route, rest);
    a.setAttribute('title', text);
    a.style.whiteSpace = 'nowrap';
    a.style.overflow = 'hidden';
    a.style.textOverflow = 'ellipsis';
    a.style.maxWidth = '30ch';
    a.style.verticalAlign = 'top';
    a.style.display = 'inline-block';
    return a;
  }

  function healthPill(health) {
    if (health === 'healthy') return ui.pill('Healthy', 'ok');
    if (health === 'unhealthy') return ui.pill('Unhealthy', 'bad');
    if (health === 'starting') return ui.pill('Starting', 'pending');
    return el('span.muted', { text: 'No health check' });
  }

  function hostRows(h) {
    return [{ hostname: h.hostname, platform: h.platform + ' ' + h.release + ' (' + h.arch + ')', cores: h.cpu ? h.cpu.cores : null, uptimeSeconds: h.uptimeSeconds }];
  }

  function uptimeOf(startedAt, running) {
    if (!running || !startedAt) return null;
    var t = Date.parse(startedAt);
    return isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null;
  }

  function nameOf(c) { return (c.names && c.names[0]) || c.id; }

  function liveHostsTab() {
    return el('div.grid', [
      A.livePanel('Hosts', '/api/host', function (body, h) {
        body.appendChild(ui.table([
          { key: 'hostname', label: 'Name', render: function (r) { return A.link(r.hostname, 'compute', ['host', r.hostname]); } },
          { key: 'platform', label: 'Platform' },
          { key: 'cores', label: 'Cores', align: 'right', render: function (r) { return r.cores === null ? '-' : fmt.num(r.cores); } },
          { key: 'uptimeSeconds', label: 'Up since boot', align: 'right', render: function (r) { return fmt.dur(r.uptimeSeconds); } }
        ], hostRows(h), {
          caption: 'The hosts this stack runs on',
          sortKey: 'hostname',
          rowKey: function (r) { return r.hostname; },
          onRow: function (r) { A.go('compute', ['host', r.hostname]); }
        }));
      }, { ttlMs: 10000, card: { counter: 1, footer: [A.link('View CPU, memory and volumes on System', 'system')] } }),
      A.notInStack('Patch age, WDAC mode, Storage Spaces Direct and other cluster hosts',
        'have no source here: this stack is one host running containers.')
    ]);
  }

  function renderContainers(card) {
    return function (body, data) {
      var rows = data.containers || [];
      setCounter(card(), data.count === undefined ? rows.length : data.count);
      var cols = [
        { key: 'name', label: 'Name', sort: nameOf, render: function (c) { return nameLink(nameOf(c), 'compute', ['vm', nameOf(c)]); } },
        {
          key: 'state', label: 'State', status: true,
          sort: function (c) { var code = exitOf(c); return c.state === 'running' ? 0 : (c.state === 'exited' && code === 0) ? 2 : 1; },
          render: function (c) { return containerStatus(c.state, exitOf(c)); }
        },
        { key: 'health', label: 'Health', status: true, render: function (c) { return healthPill(c.health); } },
        { key: 'image', label: 'Image', csv: function (c) { return c.image || ''; }, render: function (c) { return imageNode(c.image); } },
        {
          key: 'restartCount', label: 'Restarts', align: 'right',
          sort: function (c) { return c.restartCount === null || c.restartCount === undefined ? null : c.restartCount; },
          render: function (c) {
            if (c.restartCount === null || c.restartCount === undefined) {
              return el('span.muted', { text: 'Unknown', title: c.detailUnavailable ? c.detailUnavailable.message : null });
            }
            return el('span.num', { text: fmt.num(c.restartCount) });
          }
        },
        {
          key: 'uptime', label: 'Up for', align: 'right',
          sort: function (c) { return uptimeOf(c.startedAt, c.state === 'running'); },
          render: function (c) { var up = uptimeOf(c.startedAt, c.state === 'running'); return up === null ? '-' : fmt.dur(up); }
        }
      ];
      body.appendChild(ui.table(cols, rows, {
        caption: 'Containers on this host, with image, state, health, restart count and time up',
        sortKey: 'name',
        emptyTitle: 'No containers',
        empty: 'The Docker proxy lists no container.',
        rowKey: nameOf,
        onRow: function (c) { A.go('compute', ['vm', nameOf(c)]); }
      }));
    };
  }

  function liveInstancesTab() {
    var card = null;
    card = A.livePanel('Containers', '/api/containers/summary', renderContainers(function () { return card; }), { ttlMs: 10000, skeletonRows: 5 });
    return card;
  }

  function liveFabricTab() {
    return A.notInStack('Service Fabric nodes and upgrade domains',
      'do not exist here: this stack is containers on one host with no Service Fabric cluster.');
  }

  function liveGpuTab() {
    return A.notInStack('GPU cards and their queue',
      'have no source here: no node in this stack has a GPU.');
  }

  function renderListLive(box, ctx) {
    box.appendChild(ui.pageHeader('Compute'));
    box.appendChild(ui.tabs([
      { id: 'hosts', label: 'Hosts', render: liveHostsTab },
      { id: 'vms', label: 'Instances', render: liveInstancesTab },
      { id: 'fabric', label: 'Service Fabric', render: liveFabricTab },
      { id: 'gpu', label: 'GPU', render: liveGpuTab }
    ], {
      label: 'Compute sections',
      initial: (ctx && ctx.rest && ctx.rest[0]) || null,
      href: function (id) { return A.href('compute', [id]); }
    }));
  }

  function liveHostDetail(mount, ctx) {
    var name = ctx.rest[1];
    mount.appendChild(ui.pageHeader(name));
    var panel = A.livePanel('Details', '/api/host', function (body, h) {
      if (String(h.hostname).toLowerCase() !== String(name).toLowerCase()) {
        ui.clear(mount);
        mount.appendChild(ui.notFound('host', name, 'compute/hosts', 'All hosts'));
        return;
      }
      body.appendChild(ui.dl([
        ['Name', mono(h.hostname)],
        ['Platform', h.platform + ' ' + h.release + ' (' + h.arch + ')'],
        ['CPU', (h.cpu ? h.cpu.model + ', ' + fmt.num(h.cpu.cores) + ' cores' : '-')],
        ['Booted', h.bootedAt ? fmt.stamp(new Date(h.bootedAt)) : '-']
      ]));
    }, { ttlMs: 10000, card: { footer: [A.link('View CPU, memory and volumes on System', 'system')] } });
    mount.appendChild(el('div.grid', [
      panel,
      A.notInStack('Drain, patch, quarantine and Storage Spaces Direct',
        'have no source or action here: this stack has no Hyper-V cluster, patching service or network quarantine.')
    ]));
  }

  function stampOf(iso) {
    var t = iso ? Date.parse(iso) : NaN;
    return isFinite(t) && t > 0 ? fmt.stamp(new Date(t)) : '-';
  }

  function setHeadStatus(head, node) {
    var title = head.querySelector('.pagehead-title');
    if (!title) return;
    var old = title.querySelector('.pagehead-status');
    if (old) old.remove();
    title.appendChild(el('span.pagehead-status', node));
  }

  function liveVm(mount, ctx) {
    var name = ctx.rest[1];
    var head = ui.pageHeader(name);
    mount.appendChild(head);
    function gone() {
      ui.clear(mount);
      mount.appendChild(ui.notFound('container', name, 'compute/vms', 'All instances'));
    }
    var inspect = A.livePanel('Details', '/api/containers/inspect?id=' + encodeURIComponent(name), function (body, c) {
      var st = c.state || {};
      var up = uptimeOf(st.startedAt, st.running);
      setHeadStatus(head, containerStatus(st.status, typeof st.exitCode === 'number' ? st.exitCode : null));
      body.appendChild(ui.dl([
        ['State', containerStatus(st.status, typeof st.exitCode === 'number' ? st.exitCode : null)],
        ['Health', st.health ? healthPill(st.health) : el('span.muted', { text: 'No health check' })],
        ['Restarts', st.restartCount === null || st.restartCount === undefined ? '-' : fmt.num(st.restartCount)],
        ['Up for', up === null ? 'Not running' : fmt.dur(up)],
        ['Id', mono(c.id || '-')],
        ['Image', mono(c.image || '-')],
        ['Started', stampOf(st.startedAt)],
        ['Finished', st.running ? '-' : stampOf(st.finishedAt)],
        ['Exit code', st.running || st.exitCode === null || st.exitCode === undefined ? '-' : String(st.exitCode)],
        ['Restart policy', c.restartPolicy || '-'],
        ['Memory limit', c.memoryLimitBytes ? fmt.bytes(c.memoryLimitBytes) : 'None set'],
        ['Environment', fmt.num(c.environmentWithheld) + (c.environmentWithheld === 1 ? ' variable' : ' variables') + ', withheld']
      ]));
    }, { ttlMs: 10000, on: { notFound: gone } });
    var usage = A.livePanel('Resource use', '/api/containers/stats?id=' + encodeURIComponent(name), function (body, s) {
      var memRatio = s.memoryUsedBytes !== null && s.memoryLimitBytes ? s.memoryUsedBytes / s.memoryLimitBytes : null;
      body.appendChild(ui.dl([
        ['CPU, of one core', s.cpuRatio === null || s.cpuRatio === undefined ? '-' : fmt.ratioPct(s.cpuRatio, 1)],
        ['Memory', fmt.bytes(s.memoryUsedBytes) + (memRatio === null ? '' : ' (' + fmt.ratioPct(memRatio, 0) + ' of ' + fmt.bytes(s.memoryLimitBytes) + ')')],
        ['Processes', s.pids === null || s.pids === undefined ? '-' : fmt.num(s.pids)]
      ]));
    }, { ttlMs: 5000, on: { notFound: function () {} } });
    mount.appendChild(el('div.grid', [
      inspect, usage,
      A.notInStack('Connect sessions, replication and checkpoints',
        'have no source here: a container has no RDP, SSH or VNC console in this stack.')
    ]));
  }

  var CRUMB_WORD = {
    hosts: 'Hosts', vms: 'Virtual machines', fabric: 'Service Fabric', gpu: 'GPU',
    details: 'Details', performance: 'Monitoring', replica: 'Replication', connect: 'Connect', activity: 'Activity'
  };

  function crumbWord(s) {
    return Object.prototype.hasOwnProperty.call(CRUMB_WORD, s) ? CRUMB_WORD[s] : s.charAt(0).toUpperCase() + s.slice(1);
  }

  function computeCrumbs(rest, live) {
    var tab = rest[2] ? [crumbWord(rest[2])] : [];
    if (rest[0] === 'vm' && rest[1]) {
      var name = tab.length ? { label: rest[1], href: A.href('compute', ['vm', rest[1]]) } : rest[1];
      return [{ label: live ? 'Instances' : 'Virtual machines', href: A.href('compute', ['vms']) }, name].concat(tab);
    }
    if (rest[0] === 'host' && rest[1]) {
      var host = tab.length ? { label: rest[1], href: A.href('compute', ['host', rest[1]]) } : rest[1];
      return [{ label: 'Hosts', href: A.href('compute', ['hosts']) }, host].concat(tab);
    }
    var out = rest.map(crumbWord);
    if (live && rest[0] === 'vms' && rest.length === 1) out[0] = 'Instances';
    return out;
  }

  A.screen('compute', {
    title: 'Compute',
    crumb: 'Compute',
    crumbs: function (rest) { return computeCrumbs(rest, false); },
    liveCrumbs: function (rest) { return computeCrumbs(rest, true); },
    render: function (mount, ctx) {
      var rest = ctx.rest || [];
      var box = el('div');
      mount.appendChild(box);
      if (rest[0] === 'host' && rest[1]) { decide(function (m) { (m === A.MODE.LIVE ? liveHostDetail : renderHost)(box, ctx); }); return; }
      if (rest[0] === 'vm' && rest[1]) { decide(function (m) { (m === A.MODE.LIVE ? liveVm : renderVm)(box, ctx); }); return; }
      var TABS = ['hosts', 'vms', 'fabric', 'gpu'];
      if (rest.length && TABS.indexOf(rest[0]) === -1) {
        box.appendChild(ui.notFound('compute section', rest.join('/'), 'compute', 'Compute'));
        return;
      }
      decide(function (m) { (m === A.MODE.LIVE ? renderListLive : renderList)(box, ctx); });
    }
  });
})();
