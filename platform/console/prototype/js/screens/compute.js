(function () {
  'use strict';

  var A = window.ARGUS, ui = A.ui, el = ui.el, d = A.data, fmt = ui.fmt;

  function mono(text) { return el('code.mono', { text: String(text) }); }

  function named(label, suffix) { return [label, el('span.sr', { text: ' ' + suffix })]; }

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
      return ui.pill(state === 'ok' ? 'Healthy' : state.charAt(0).toUpperCase() + state.slice(1), 'ok');
    }
    if (state === 'warn') return ui.pill('Degraded', 'warn');
    if (state === 'upgrading') return ui.pill('Upgrading', 'warn');
    if (state === 'repairing') return ui.pill('Repairing', 'warn');
    if (state === 'off') return ui.pill('Off', 'warn');
    if (state === 'stopped') return ui.pill('Stopped', 'bad');
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

  function hostsTab() {
    var cols = [
      { key: 'name', label: 'Name', render: function (r) { return A.link(r.name, 'compute', ['host', r.name]); } },
      { key: 'site', label: 'Site', render: function (r) { return siteName(r.site); } },
      { key: 'role', label: 'Role' },
      { key: 'cpu', label: 'CPU', render: function (r) { return utilisation(r.name + ' CPU', r.cpu); } },
      { key: 'mem', label: 'Memory', render: function (r) { return utilisation(r.name + ' memory', r.mem); } },
      { key: 'vms', label: 'VMs', align: 'right',
        sort: function (r) { return vmsOn(r.name).length; },
        render: function (r) { return fmt.num(vmsOn(r.name).length); } },
      {
        key: 'patchAgeDays', label: 'Patch age', align: 'right',
        render: function (r) {
          return r.patchAgeDays > 30
            ? ui.pill(fmt.num(r.patchAgeDays) + ' d', 'warn')
            : el('span', { text: fmt.num(r.patchAgeDays) + ' d' });
        }
      },
      { key: 'wdac', label: 'WDAC mode' },
      { key: 's2d', label: 'S2D health', status: true, render: function (r) { return statePill(r.s2d); } },
      { key: 'state', label: 'State', status: true, render: function (r) { return statePill(r.state); } }
    ];
    var hostTable = ui.table(cols, d.hosts, {
      caption: 'Physical hosts, with utilisation, patch age and storage health',
      sortKey: 'name',
      rowKey: function (r) { return r.name; },
      onRow: function (r) { A.go('compute', ['host', r.name]); }
    });
    return el('div.stack', [el('div.row', [el('span.spacer'), ui.exportButton(hostTable, 'hosts')]), hostTable]);
  }

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
        key: 'tags', label: 'Tags', sortable: false,
        csv: function (r) { var t = r.tags || {}; return Object.keys(t).map(function (k) { return k + ':' + t[k]; }).join(' '); },
        render: function (r) { return A.tagChips(r); }
      },
      {
        key: 'checkpointAgeMin', label: 'Checkpoint age', align: 'right',
        render: function (r) {
          return (r.checkpointAgeMin !== null && r.checkpointAgeMin !== undefined)
            ? fmt.dur(r.checkpointAgeMin * 60)
            : el('span.muted', { text: 'no replica' });
        }
      },
      {
        label: 'Connect', sortable: false,
        csv: function (r) { return r.connect.join('; '); },
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
    var vmTable = ui.table(cols, d.vms, {
      caption: 'Virtual machines, with placement, replication state and the ways in to each',
      sortKey: 'name',
      rowKey: function (r) { return r.name; }
    });
    return el('div.stack', [el('div.row', [el('span.spacer'), ui.exportButton(vmTable, 'virtual machines')]), vmTable]);
  }

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

  function renderList(mount, ctx) {
    mount.appendChild(ui.pageHeader(
      'Compute',
      'The hosts underneath everything, the machines on them, the fabric they run, and the one node with cards in it.'));

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
    ], { label: 'Actions for ' + vm.name });
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

  function renderHost(mount, ctx) {
    var name = ctx.rest[1];
    var host = d.hosts.filter(function (h) { return h.name === name; })[0];
    if (!host) {
      mount.appendChild(ui.notFound('host', name, 'compute/hosts', 'All hosts'));
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
        ui.btn(named('Patch now', host.name), {
          variant: host.patchAgeDays > 30 ? 'primary' : 'ghost',
          title: 'Drain, patch and reboot ' + host.name + ' outside the Tuesday window',
          onClick: function () { patchNow(host, ctx); }
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
      ui.statTile('Virtual machines', fmt.num(vmsOn(host.name).length), {
        note: 'placed on this host'
      }),
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
        ['Virtual machines', fmt.num(vmsOn(host.name).length)],
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
        ['Checkpoint age', (vm.checkpointAgeMin !== null && vm.checkpointAgeMin !== undefined)
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
      ['Checkpoint age', (vm.checkpointAgeMin !== null && vm.checkpointAgeMin !== undefined)
        ? fmt.dur(vm.checkpointAgeMin * 60)
        : el('span.muted', { text: 'no replica' })],
      ['Ways in', vm.connect.map(function (p) { return modeFor(p).name; }).join(', ')],
      ['Tags', A.tagChips(vm)]
    ]));
  }

  function renderVm(mount, ctx) {
    var name = ctx.rest[1];
    var vm = d.vmByName(name);
    if (!vm) {
      mount.appendChild(ui.notFound('virtual machine', name, 'compute/vms', 'All virtual machines'));
      return;
    }

    mount.appendChild(ui.pageHeader(
      vm.name,
      vm.role + ' · ' + vm.os + ' · ' + vm.ip,
      [vmActions(vm, ctx)]));

    mount.appendChild(el('div.tiles', [
      ui.statTile('State', vm.state === 'running' ? 'Running' : vm.state.charAt(0).toUpperCase() + vm.state.slice(1)),
      ui.statTile('vCPU', fmt.num(vm.vcpu)),
      ui.statTile('Memory', fmt.num(vm.ram), { unit: 'GB' }),
      ui.statTile('Host', vm.host, { note: siteName(vm.site) }),
      ui.statTile('Replica', vm.replica === 'off' ? 'Off' : (vm.replica === 'n/a' ? 'Not applicable' : 'Healthy'), {
        note: (vm.checkpointAgeMin !== null && vm.checkpointAgeMin !== undefined) ? 'checkpoint ' + fmt.dur(vm.checkpointAgeMin * 60) + ' old' : 'no checkpoint'
      })
    ]));

    mount.appendChild(ui.tabs([
      { id: 'overview', label: 'Overview', render: function () { return overviewTab(vm); } },
      { id: 'performance', label: 'Performance', render: function () { return performanceTab(vm); } },
      { id: 'replica', label: 'Replica', render: function () { return replicaTab(vm); } },
      { id: 'connect', label: 'Connect', render: function () { return connectTab(vm); } }
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

  function containerTone(state) {
    if (state === 'running') return 'ok';
    if (state === 'restarting' || state === 'paused' || state === 'created') return 'warn';
    if (state === 'exited' || state === 'dead') return 'bad';
    return 'idle';
  }

  function healthPill(health) {
    if (health === 'healthy') return ui.pill('Healthy', 'ok');
    if (health === 'unhealthy') return ui.pill('Unhealthy', 'bad');
    if (health === 'starting') return ui.pill('Starting', 'warn');
    return el('span.muted', { text: 'no health check' });
  }

  function systemLink(text) {
    return el('p.hint', [text + ' ', A.link('Open the System screen', 'system', null, null, 'rlink')]);
  }

  function hostRows(h) {
    return [{ hostname: h.hostname, platform: h.platform + ' ' + h.release + ' (' + h.arch + ')', cores: h.cpu ? h.cpu.cores : null, uptimeSeconds: h.uptimeSeconds }];
  }

  function liveHostsTab() {
    return el('div.stack', [
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
        body.appendChild(systemLink('One host. Its CPU, memory, volumes and history are on the System screen.'));
      }, { ttlMs: 10000 }),
      A.notInStack('Per-host patch age, WDAC mode and Storage Spaces Direct health, and the other hosts of a cluster,',
        'have no source here. This stack is one host running containers: no Hyper-V, no Storage Spaces Direct and no patching service.')
    ]);
  }

  function uptimeOf(startedAt, running) {
    if (!running || !startedAt) return null;
    var t = Date.parse(startedAt);
    return isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null;
  }

  function nameOf(c) { return (c.names && c.names[0]) || c.id; }

  function renderContainers(body, data) {
    var rows = data.containers || [];
    var cols = [
      { key: 'name', label: 'Name', sort: nameOf, render: function (c) { return A.link(nameOf(c), 'compute', ['vm', nameOf(c)]); } },
      { key: 'image', label: 'Image', render: function (c) { return mono(c.image || '-'); } },
      { key: 'state', label: 'State', status: true, render: function (c) { return ui.pill(c.state, containerTone(c.state)); } },
      { key: 'health', label: 'Health', status: true, render: function (c) { return healthPill(c.health); } },
      {
        key: 'restartCount', label: 'Restarts', align: 'right',
        sort: function (c) { return c.restartCount === null || c.restartCount === undefined ? null : c.restartCount; },
        render: function (c) {
          if (c.restartCount === null || c.restartCount === undefined) {
            return el('span.muted', { text: 'unknown', title: c.detailUnavailable ? c.detailUnavailable.message : null });
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
    body.appendChild(el('p.hint', {
      text: fmt.num(data.count) + ' containers, ' + fmt.num(data.running) + ' running. Restarts count since each container was created.'
    }));
    body.appendChild(ui.table(cols, rows, {
      caption: 'Containers on this host, with image, state, health, restart count and time up',
      sortKey: 'name',
      empty: 'The Docker proxy answered and lists no container.',
      rowKey: nameOf,
      onRow: function (c) { A.go('compute', ['vm', nameOf(c)]); }
    }));
  }

  function liveInstancesTab() {
    return A.livePanel('Containers', '/api/containers/summary', renderContainers, { ttlMs: 10000, skeletonRows: 5 });
  }

  function liveFabricTab() {
    return ui.card('Service Fabric nodes', A.notInStack('Service Fabric nodes and upgrade domains',
      'do not exist here. This stack is containers on one host with no Service Fabric cluster, so no node, seed or upgrade domain can be listed.'));
  }

  function liveGpuTab() {
    return ui.card('GPU', A.notInStack('GPU cards and the queue for them',
      'have no source here. No node in this stack has a GPU, so no utilisation, temperature or waiting job is shown.'));
  }

  function renderListLive(box, ctx) {
    box.appendChild(ui.pageHeader('Compute', 'The hosts and the containers running on them, read live.'));
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
    mount.appendChild(ui.pageHeader(name, 'A host this stack runs on.'));
    var panel = A.livePanel('Host', '/api/host', function (body, h) {
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
      body.appendChild(systemLink('CPU, memory, volumes, network interfaces and their history for this host are on the System screen.'));
    }, { ttlMs: 10000 });
    mount.appendChild(el('div.stack', [
      panel,
      A.notInStack('Drain, patch now, quarantine and Storage Spaces Direct health for this host',
        'have no source or action here. This stack has no Hyper-V cluster to drain, no patching service and no network quarantine.')
    ]));
  }

  function liveVm(mount, ctx) {
    var name = ctx.rest[1];
    mount.appendChild(ui.pageHeader(name, 'A container on this stack, read from the Docker socket proxy.'));
    function gone() {
      ui.clear(mount);
      mount.appendChild(ui.notFound('container', name, 'compute/vms', 'All instances'));
    }
    var inspect = A.livePanel('Container', '/api/containers/inspect?id=' + encodeURIComponent(name), function (body, c) {
      var st = c.state || {};
      var up = uptimeOf(st.startedAt, st.running);
      body.appendChild(el('div.tiles', [
        ui.statTile('State', st.status || 'unknown'),
        ui.statTile('Health', st.health || 'none'),
        ui.statTile('Restarts', st.restartCount === null || st.restartCount === undefined ? '-' : fmt.num(st.restartCount), { note: 'since it was created' }),
        ui.statTile('Up for', up === null ? '-' : fmt.dur(up), { note: up === null ? 'not running' : 'since it last started' })
      ]));
      body.appendChild(ui.dl([
        ['Name', mono(c.name || name)],
        ['Id', mono(c.id || '-')],
        ['Image', mono(c.image || '-')],
        ['Started', st.startedAt || '-'],
        ['Finished', st.finishedAt || '-'],
        ['Exit code', st.exitCode === null || st.exitCode === undefined ? '-' : String(st.exitCode)],
        ['Restart policy', c.restartPolicy || '-'],
        ['Memory limit', c.memoryLimitBytes ? fmt.bytes(c.memoryLimitBytes) : 'none set'],
        ['Environment', fmt.num(c.environmentWithheld) + ' variables, withheld by the console']
      ]));
    }, { ttlMs: 10000, on: { notFound: gone } });
    var usage = A.livePanel('Resource use, now', '/api/containers/stats?id=' + encodeURIComponent(name), function (body, s) {
      var memRatio = s.memoryUsedBytes !== null && s.memoryLimitBytes ? s.memoryUsedBytes / s.memoryLimitBytes : null;
      body.appendChild(el('div.tiles', [
        ui.statTile('CPU', s.cpuRatio === null || s.cpuRatio === undefined ? '-' : fmt.ratioPct(s.cpuRatio, 1), { note: 'now, one Docker stats read, of one core' }),
        ui.statTile('Memory', fmt.bytes(s.memoryUsedBytes), { note: 'now' + (memRatio === null ? '' : ', ' + fmt.ratioPct(memRatio, 0) + ' of ' + fmt.bytes(s.memoryLimitBytes)) }),
        ui.statTile('Processes', s.pids === null || s.pids === undefined ? '-' : fmt.num(s.pids), { note: 'now' })
      ]));
    }, { ttlMs: 5000, on: { notFound: function () {} } });
    mount.appendChild(el('div.stack', [
      inspect, usage,
      A.notInStack('Recorded connect sessions, replication and checkpoints for this instance',
        'have no source here. A container has no RDP, SSH or VNC console in this stack, and nothing replicates or checkpoints it.')
    ]));
  }

  function computeCrumbs(rest) {
    if (rest[0] === 'vm' && rest[1]) return ['Virtual machines', rest[1]].concat(rest[2] ? [rest[2].charAt(0).toUpperCase() + rest[2].slice(1)] : []);
    if (rest[0] === 'host' && rest[1]) return ['Hosts', rest[1]];
    return rest.map(function (s) { return s.charAt(0).toUpperCase() + s.slice(1); });
  }

  A.screen('compute', {
    title: 'Compute',
    crumb: 'Compute',
    crumbs: computeCrumbs,
    liveCrumbs: computeCrumbs,
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
