(function () {
  'use strict';

  var A = window.ARGUS, ui = A.ui, el = ui.el, d = A.data;
  var fmt = ui.fmt;

  var ME = d.me.upn.split('@')[0];

  function mono(text) { return el('span.mono', { text: text }); }


  function named(label, suffix) { return [label, el('span.sr', { text: ' ' + suffix })]; }

  function chips(list, empty) {
    if (!list || !list.length) return el('span.muted', { text: empty || 'none' });
    return el('span.chips', list.map(function (t) { return el('span.chip', { text: t }); }));
  }

  var TOTP_TITLE =
    'TOTP codes are phishable: an attacker who proxies the sign-in page can relay the code in real time. It is accepted for Tier 2 accounts only; Tier 0 and Tier 1 require a FIDO2 security key.';

  function mfaPill(p) {
    if (p.mfa === 'FIDO2') {
      return ui.pill('FIDO2', 'ok', { title: 'Phishing-resistant: the key checks the origin, so a proxied sign-in page cannot use it.' });
    }
    return ui.pill(p.mfa, 'warn', { title: TOTP_TITLE });
  }

  function offboard(p) {
    A.confirmDestructive({
      title: 'Offboard ' + p.name,
      detail: 'Disabling the Active Directory account for ' + p.upn +
        ' revokes VPN, the console, Grafana, SQL Server, OpenBao and JupyterHub at once, because every one of them authenticates against that single account. Sessions in flight are killed at the next token refresh, and any standing group membership is removed.',
      match: p.upn,
      environment: A.state.env,
      blast: p.groups.length
        ? 'Removes membership of ' + p.groups.join(', ') + '.'
        : 'The account holds no standing group membership.',
      confirmLabel: 'Offboard ' + p.upn,
      onConfirm: function () {
        A.record('person.offboard', p.upn);
        A.flash('warn', 'Offboarding requested for ' + p.upn,
          'The prototype changes nothing. In production this disables the account, revokes active grants and writes the reason to the audit.');
      }
    });
  }

  function peopleTab() {
    var peopleTable = null;
    function peopleCard() {
      peopleTable = ui.table(cols, d.people, {
        id: 'identity.people', defaultHidden: ['groups'],
        caption: 'People with a console account, with tier, MFA method, last sign-in, group membership and whether they are elevated right now',
        sortKey: 'name',
        rowKey: function (r) { return r.upn; },
        emptyTitle: 'No people',
        empty: 'Nobody has a console account in this environment.'
      });
      return ui.card('People', peopleTable, {
        counter: total,
        description: 'MFA ' + fmt.pct((withMfa / total) * 100, 0) + ', ' + fmt.num(phishResistant) + ' on FIDO2 keys · ' +
          fmt.num(elevated.length) + ' elevated now · ' + (tier0.length ? fmt.num(tier0.length) + ' standing Tier 0' : 'no standing Tier 0'),
        actions: [ui.columnsButton(function () { return peopleTable; }, 'people'), ui.exportButton(function () { return peopleTable; }, 'people')]
      });
    }
    var total = d.people.length;
    var withMfa = d.people.filter(function (p) { return !!p.mfa; }).length;
    var phishResistant = d.people.filter(function (p) { return p.mfa === 'FIDO2'; }).length;
    var elevated = d.people.filter(function (p) { return p.elevated; });
    var tier0 = d.people.filter(function (p) { return p.tier === 0; });

    var cols = [
      { key: 'name', label: 'Name' },
      { key: 'upn', label: 'Sign-in name', render: function (r) { return mono(r.upn); } },
      {
        key: 'tier', label: 'Tier', align: 'right',
        render: function (r) { return 'Tier ' + r.tier; }
      },
      { key: 'mfa', label: 'MFA method', status: true, render: function (r) { return mfaPill(r); } },
      {
        key: 'lastSignIn', label: 'Last sign-in',
        sort: function (r) { return r.lastSignIn ? r.lastSignIn.getTime() : 0; },
        render: function (r) { return fmt.time(r.lastSignIn); }
      },
      {
        key: 'groups', label: 'Groups', sortable: false,
        render: function (r) { return chips(r.groups, 'no standing membership'); }
      },
      {
        key: 'elevated', label: 'Elevated now', status: true,
        render: function (r) {
          return r.elevated
            ? ui.status('warn', 'Elevated', {
              title: 'Holding privilege beyond their standing role right now' +
                (r.elevationExpires ? ', until ' + fmt.stamp(r.elevationExpires) : '') + '.'
            })
            : ui.status('idle', 'Standing role');
        }
      },
      {
        key: 'actions', label: 'Actions', sortable: false, status: true,
        render: function (r) {
          return ui.btn(named('Offboard', r.upn), {
            variant: 'danger',
            title: 'Offboard ' + r.upn,
            onClick: function () { offboard(r); }
          });
        }
      }
    ];

    return peopleCard();
  }

  function gmsaTab() {
    var cols = [
      { key: 'name', label: 'Account', width: '18%', render: function (r) { return mono(r.name); } },
      { key: 'hosts', label: 'Hosts', render: function (r) { return mono(r.hosts); } },
      {
        key: 'tier', label: 'Tier', align: 'right',
        render: function (r) { return 'Tier ' + r.tier; }
      },
      {
        key: 'sql', label: 'SQL databases', sortable: false,
        render: function (r) { return chips(r.sql, 'no SQL access'); }
      },
      {
        key: 's3', label: 'S3 grants', sortable: false,
        render: function (r) { return chips(r.s3, 'no bucket access'); }
      },
      {
        key: 'rotatedDays', label: 'Password age', align: 'right', status: true,
        render: function (r) {
          return r.rotatedDays > 30
            ? ui.status('warn', fmt.num(r.rotatedDays) + ' d', {
              title: 'Older than the 30-day gMSA rotation interval, which means Active Directory has not rotated this password on schedule.'
            })
            : ui.status('ok', fmt.num(r.rotatedDays) + ' d', { title: 'Within the 30-day gMSA rotation interval.' });
        }
      }
    ];

    return el('div.grid', [
      ui.card('Service accounts', ui.table(cols, d.gmsas, {
        caption: 'Group managed service accounts, with the hosts allowed to retrieve the password, tier, SQL database access, S3 bucket grants and password age',
        sortKey: 'name',
        rowKey: function (r) { return r.name; },
        emptyTitle: 'No service accounts'
      }), { counter: d.gmsas.length, description: 'Group managed service accounts. Passwords rotate every 30 days and are never shown.' }),
      ui.disclosure('Details', [
        el('p', { text: 'Active Directory generates a 240-character password for each account and releases it only to the hosts on its allow list. What an account can reach is the thing to review.' })
      ])
    ]);
  }

  var GRANT_TONE = { active: 'warn', expired: 'idle', requested: 'pending', denied: 'idle', revoked: 'idle' };
  var GRANT_TITLE = {
    active: 'Live standing privilege. Every minute this grant is open is a minute the blast radius of a stolen session is larger, which is why it is amber and not green.',
    expired: 'The grant has lapsed and the group membership has been removed.',
    requested: 'Waiting for an approver. Nothing is granted yet.',
    denied: 'An approver declined this request. Nothing was granted.',
    revoked: 'An approver ended this grant early. The membership has been removed.'
  };
  var GRANT_CLOSED_TEXT = {
    expired: 'The membership was removed automatically when the grant lapsed. Nothing to do.',
    denied: 'The request was declined and the requester was told. Nothing was granted.',
    revoked: 'The membership was removed by hand before the grant lapsed. The revocation is in the audit.'
  };

  var ELEVATION_GROUPS = [
    'Argus-Console-Operators',
    'Argus-Tier1-Operators',
    'Argus-Tier0-Admins',
    'Argus-Console-Approvers'
  ];

  function countdown(expires) {
    var node = el('span.mono', { text: '' });
    var mountedAt = Date.now();

    function paint() {
      var virtualNow = d.now.getTime() + (Date.now() - mountedAt);
      var left = Math.max(0, Math.round((expires.getTime() - virtualNow) / 1000));
      node.textContent = left > 0 ? fmt.dur(left) + ' left' : 'expired';
    }

    function tick() {
      if (!document.body.contains(node)) { window.clearInterval(timer); return; }
      paint();
    }

    paint();
    var timer = window.setInterval(tick, 1000);
    A.onLeave(function () { window.clearInterval(timer); });
    return node;
  }

  function setElevated(upn, on, until) {
    var who = d.personByUpn(upn);
    if (!who) return;
    who.elevated = !!on;
    who.elevationExpires = on ? until : null;
  }

  function approveGrant(g) {
    A.stepUp('Approving elevation for ' + g.principal + ' into ' + g.group + ' needs a second factor.', function () {
      g.state = 'active';
      g.approver = ME;
      g.granted = new Date(d.now.getTime());
      g.expires = new Date(d.now.getTime() + 2 * 3600000);
      setElevated(g.principal, true, g.expires);
      A.record('grant.approve', g.principal + ' to ' + g.group + ' for 2 h: ' + g.reason);
      A.flash('ok', 'Approved elevation for ' + g.principal,
        g.principal + ' now holds ' + g.group + ' for the requested window. The approval, your identity and the reason are written to the audit, and the membership is removed automatically at expiry.');
      A.replaceHash(A.href('identity', ['grants'], { id: g.id }));
      A.refresh();
    });
  }

  function denyGrant(g) {
    g.state = 'denied';
    g.approver = ME;
    var row = A.record('grant.deny', g.principal + ' to ' + g.group + ': ' + g.reason);
    var undo = A.undoable('Undo', function () {
      g.state = 'requested';
      g.approver = null;
      A.unrecord(row);
      A.flash('info', 'Denial undone', g.principal + ' is waiting for an approver again.', { timeout: 6000 });
      A.refresh();
    });
    A.flash('info', 'Denied elevation for ' + g.principal,
      'The request for ' + g.group + ' is closed. ' + g.principal +
      ' is told it was declined, and the decision is written to the audit.', { action: undo });
    A.replaceHash(A.href('identity', ['grants'], { id: g.id }));
    A.refresh();
  }

  function revokeGrant(g) {
    A.confirmDestructive({
      title: 'Revoke ' + g.group + ' from ' + g.principal,
      detail: 'Removing the group membership now ends the elevation early. Anything ' + g.principal +
        ' is part-way through with those rights fails at the next authorisation check, including an in-flight restore.',
      match: g.principal,
      environment: A.state.env,
      blast: 'Reason on record: ' + g.reason + '. Approved by ' + g.approver + '.',
      confirmLabel: 'Revoke ' + g.group,
      onConfirm: function () {
        g.state = 'revoked';
        g.expires = new Date(d.now.getTime());
        setElevated(g.principal, false, null);
        A.record('grant.revoke', g.group + ' from ' + g.principal);
        A.flash('warn', 'Revoked ' + g.group + ' from ' + g.principal,
          'The membership is removed and the revocation is written to the audit.');
        A.replaceHash(A.href('identity', ['grants'], { id: g.id }));
        A.refresh();
      }
    });
  }

  function requestElevationDialog() {
    A.dialog({
      title: 'Request elevation',
      body: function () {
        var groupSel = el('select.field', { id: 'req-group', 'aria-label': 'Group to elevate into' },
          ELEVATION_GROUPS.map(function (gname) { return el('option', { value: gname, text: gname }); }));

        var reason = el('input.field', {
          type: 'text', id: 'req-reason', autocomplete: 'off', spellcheck: 'false',
          placeholder: 'What are you about to do, and why now?',
          'aria-describedby': 'req-reason-help'
        });

        var hoursSel = el('select.field', { id: 'req-hours', 'aria-label': 'Duration of the elevation' }, [
          el('option', { value: '1', text: '1 hour' }),
          el('option', { value: '2', selected: true, text: '2 hours (default)' }),
          el('option', { value: '4', text: '4 hours (maximum)' })
        ]);

        requestElevationDialog._group = groupSel;
        requestElevationDialog._reason = reason;
        requestElevationDialog._hours = hoursSel;

        return el('div.stack', [
          el('p', {
            text: 'Elevation is time-boxed and recorded. Every action you take while elevated is attributed to this reason in the audit.'
          }),
          el('label.fieldlabel', { for: 'req-group', text: 'Group' }),
          groupSel,
          el('label.fieldlabel', { for: 'req-reason', text: 'Reason (required, recorded in the audit)' }),
          reason,
          el('p.hint', {
            id: 'req-reason-help',
            text: 'A reason an auditor can read six months from now. "Maintenance" is not one.'
          }),
          el('label.fieldlabel', { for: 'req-hours', text: 'Duration' }),
          hoursSel,
          el('p.hint', {
            text: 'Four hours is the maximum. Longer than four hours defeats the point of time-boxing, so the console does not offer it.'
          })
        ]);
      },
      actions: function (close) {
        var groupSel = requestElevationDialog._group;
        var reason = requestElevationDialog._reason;
        var hoursSel = requestElevationDialog._hours;

        var submit = ui.btn('Request elevation', {
          variant: 'primary',
          disabled: true,
          title: 'Give a reason first: it is written to the audit.'
        });
        submit.setDisabled(true);

        submit.addEventListener('click', function () {
          if (submit.isDisabled()) return;
          var text = reason.value.trim();
          if (!text) return;
          var group = groupSel.value;
          var hours = Number(hoursSel.value);
          close();
          A.requestElevation(group, text, hours, function () {
            A.announce('Elevated to ' + group + ' for ' + hours + ' hours');
          });
        });

        reason.addEventListener('input', function () {
          var ok = reason.value.trim().length > 0;
          submit.setDisabled(!ok);
          submit.classList.toggle('is-disabled', !ok);
          submit.setAttribute('aria-disabled', ok ? 'false' : 'true');
          if (ok) submit.removeAttribute('title');
          else submit.title = 'Give a reason first: it is written to the audit.';
        });

        return [ui.btn('Cancel', { variant: 'ghost', onClick: close }), submit];
      }
    });
  }

  function grantActions(g) {
    var isSelf = g.principal === ME;
    if (g.state === 'requested') {
      return el('div.row', [
        ui.btn(named('Approve', g.principal + ' into ' + g.group), {
          disabled: isSelf,
          title: isSelf
            ? 'You cannot approve your own elevation. Ask another approver.'
            : 'Approve ' + g.principal + ' into ' + g.group,
          onClick: function () { approveGrant(g); }
        }),
        ui.btn(named('Deny', g.principal + ' into ' + g.group), {
          title: 'Deny ' + g.principal + ' into ' + g.group,
          onClick: function () { denyGrant(g); }
        })
      ]);
    }
    if (g.state === 'active') {
      return ui.btn(named('Revoke', g.group + ' from ' + g.principal + ' now'), {
        variant: 'danger',
        title: 'Revoke ' + g.group + ' from ' + g.principal + ' now',
        onClick: function () { revokeGrant(g); }
      });
    }
    return el('span.muted', { text: '-', title: GRANT_CLOSED_TEXT[g.state] || 'Closed' });
  }

  function grantsTab() {
    var active = d.grants.filter(function (g) { return g.state === 'active'; });
    var requested = d.grants.filter(function (g) { return g.state === 'requested'; });
    var t = ui.table([
      { key: 'principal', label: 'Principal', render: function (g) { return mono(g.principal); } },
      { key: 'group', label: 'Group', render: function (g) { return mono(g.group); } },
      { key: 'state', label: 'Status', status: true, render: function (g) { return ui.status(GRANT_TONE[g.state] || 'idle', g.state.charAt(0).toUpperCase() + g.state.slice(1), { title: GRANT_TITLE[g.state] }); } },
      { key: 'reason', label: 'Reason' },
      { key: 'approver', label: 'Approver', render: function (g) { return g.approver ? mono(g.approver) : el('span.muted', { text: '-' }); } },
      {
        key: 'expires', label: 'Expires',
        sort: function (g) { return g.expires ? g.expires.getTime() : null; },
        render: function (g) { return g.state === 'active' && g.expires ? countdown(g.expires) : g.expires ? fmt.time(g.expires) : el('span.muted', { text: '-' }); }
      },
      { key: 'actions', label: 'Actions', sortable: false, status: true, render: grantActions }
    ], d.grants, {
      caption: 'Just-in-time access grants, with principal, group, state, reason, approver and expiry',
      rowKey: function (g) { return g.id; },
      emptyTitle: 'No grants'
    });
    return ui.card('Grants', t, {
      counter: d.grants.length,
      description: fmt.num(requested.length) + ' awaiting approval · ' + fmt.num(active.length) + ' active · at most 4 h each, with a named approver.'
    });
  }

    var READ_ACTORS = ['gmsa-orders$', 'gmsa-console$', 'reconciler', 'gmsa-ci$', 'gmsa-billing$'];

  function recentReads(s) {
    var n = Math.min(4, Math.max(2, s.leases));
    var out = [];
    for (var i = 0; i < n; i++) {
      out.push({
        actor: READ_ACTORS[(s.path.length + i) % READ_ACTORS.length],
        at: new Date(d.now.getTime() - (i + 1) * 17 * 60000),
        path: s.path
      });
    }
    return out;
  }

  function whoReadThis(s) {
    var reads = recentReads(s);
    A.dialog({
      title: 'Recent reads of ' + s.path,
      body: function () {
        return el('div.stack', [
          el('p', {
            text: 'Who authenticated to OpenBao and read this path. The console shows the reader, the time and the path, and never the value.'
          }),
          ui.table([
            { key: 'actor', label: 'Actor', render: function (r) { return mono(r.actor); } },
            {
              key: 'at', label: 'Read at',
              sort: function (r) { return r.at.getTime(); },
              render: function (r) { return fmt.time(r.at); }
            },
            { key: 'path', label: 'Path', render: function (r) { return mono(r.path); } }
          ], reads, {
            caption: 'Recent reads of ' + s.path + ', with the actor, the time of the read and the path',
            sortKey: 'at', sortDir: 'desc',
            empty: 'Nothing has read this path in the audit window.'
          }),
          el('p.hint', {
            text: fmt.num(s.reads24h) + ' reads in the last 24 hours in total. A read count that jumps without a deployment is worth a look.'
          })
        ]);
      }
    });
  }

  function rotateSecret(s) {
    A.stepUp('Rotating ' + s.path + ' needs a second factor.', function () {
      s.rotatedDays = 0;
      A.record('secret.rotate', s.path);
      A.replaceHash(A.href('identity', ['secrets'], { path: s.path }));
      A.refresh();
      A.flash('ok', 'Rotation started for ' + s.path,
        'A new version is written and the previous version stays readable until the ' +
        fmt.num(s.leases) + ' open leases renew. The value is never shown here.');
    });
  }

  function revokeLeases(s) {
    A.confirmDestructive({
      title: 'Revoke all leases on ' + s.path,
      detail: 'Revoking invalidates every credential issued from this path immediately. Any workload holding one fails its next call and has to re-authenticate to OpenBao, which for a database path means dropped connections rather than a graceful reconnect.',
      match: s.path,
      environment: A.state.env,
      blast: fmt.num(s.leases) + ' open leases are killed, and ' + fmt.num(s.reads24h) +
        ' reads in the last 24 hours suggests how many callers depend on this path.',
      confirmLabel: 'Revoke ' + fmt.num(s.leases) + ' leases',
      onConfirm: function () {
        var killed = s.leases;
        s.leases = 0;
        A.record('secret.revoke-leases', s.path + ' (' + fmt.num(killed) + ' leases)');
        A.replaceHash(A.href('identity', ['secrets'], { path: s.path }));
        A.refresh();
        A.flash('warn', 'Leases revoked on ' + s.path,
          'Workloads re-authenticate on their own retry loop. The revocation is written to the audit.');
      }
    });
  }

  function rotationPill(s) {
    if (s.rotatedDays > s.policyDays) {
      return ui.status('bad', fmt.num(s.rotatedDays) + ' d', {
        title: 'Overdue: the rotation policy is ' + s.policyDays + ' days and this version is ' +
          s.rotatedDays + ' days old.'
      });
    }
    var soon = Math.max(1, Math.round(s.policyDays * 0.1));
    if (s.rotatedDays > s.policyDays - soon) {
      return ui.status('warn', fmt.num(s.rotatedDays) + ' d', {
        title: 'Within ' + soon + (soon === 1 ? ' day' : ' days') + ' of the ' +
          s.policyDays + '-day rotation policy.'
      });
    }
    return ui.status('ok', fmt.num(s.rotatedDays) + ' d', {
      title: 'Inside the ' + s.policyDays + '-day rotation policy.'
    });
  }

  function secretsTab() {
    var overdue = d.secrets.filter(function (s) { return s.rotatedDays > s.policyDays; });
    var secretsTable = null;
    function secretsCard() {
      secretsTable = ui.table(cols, d.secrets, {
        caption: 'Secret paths in OpenBao, with active leases, rotation age against policy and reads in the last 24 hours. Values are never shown.',
        sortKey: 'path',
        rowKey: function (r) { return r.path; },
        emptyTitle: 'No secret paths',
        empty: 'No secret path is readable by your role.'
      });
      return ui.card('Secret paths', secretsTable, {
        counter: d.secrets.length,
        description: 'Paths and metadata only. The console never shows a secret value.',
        actions: [
          ui.btn('Request value', {
            disabled: true,
            title: 'Admin role only, with a written reason; it pages the security channel. You are signed in as ' + d.me.role + '.'
          }),
          ui.exportButton(function () { return secretsTable; }, 'secret paths')
        ]
      });
    }

    var cols = [
      { key: 'path', label: 'Path', render: function (r) { return mono(r.path); } },
      { key: 'leases', label: 'Active leases', align: 'right', render: function (r) { return fmt.num(r.leases); } },
      { key: 'rotatedDays', label: 'Rotation age', align: 'right', status: true, render: function (r) { return rotationPill(r); } },
      {
        key: 'policyDays', label: 'Policy', align: 'right',
        render: function (r) { return fmt.num(r.policyDays) + ' d'; }
      },
      { key: 'reads24h', label: 'Reads, 24 h', align: 'right', render: function (r) { return fmt.num(r.reads24h); } },
      {
        key: 'actions', label: 'Actions', align: 'right', sortable: false,
        render: function (r) {
          return ui.menu([
            { label: 'Who read this', onSelect: function () { whoReadThis(r); } },
            { label: 'Rotate', hint: 'second factor', onSelect: function () { rotateSecret(r); } },
            'divider',
            { label: 'Revoke leases', danger: true, onSelect: function () { revokeLeases(r); } }
          ], { label: 'Actions for ' + r.path });
        }
      }
    ];

    return el('div.grid', [
      overdue.length ? el('div.callout.warn', [
        el('strong', {
          text: fmt.num(overdue.length) + ' path' + (overdue.length === 1 ? ' is' : 's are') + ' past the rotation policy: ' +
            overdue.map(function (x) { return x.path; }).join(', ') + '.'
        })
      ]) : null,
      secretsCard()
    ]);
  }

    function isLive() { return A.storeMode() === A.MODE.LIVE; }

  function gate(sampleFn, liveFn) {
    return function () {
      var mode = A.storeMode();
      if (mode === A.MODE.LIVE) return liveFn();
      if (mode === A.MODE.SAMPLE) return sampleFn();
      var host = el('div');
      host.appendChild(ui.skeleton(3));
      A.whenProbed(function (m) {
        ui.clear(host);
        host.appendChild(m === A.MODE.LIVE ? liveFn() : sampleFn());
      });
      return host;
    };
  }

  function partBlock(part) {
    var p = part || {};
    var state = A.envelopeState({ ok: false, mode: 'live', error: { reason: p.reason || 'error', message: p.message } });
    return ui.stateBlock(state, { reason: p.reason || null, detail: p.message || '' });
  }

  function operatorsPanel(body, data) {
    var part = data.console || {};
    var me = (A.capabilities() || {}).auth || {};
    var ops = part.operators || [];
    if (!ops.length) {
      body.appendChild(ui.emptyState('No console operators are declared',
        part.required ? 'The console requires an operators file and none is loaded.' : 'No operators file is loaded, so sign-in is not required here.'));
    } else {
      body.appendChild(ui.table([
        {
          key: 'subject', label: 'Subject',
          render: function (r) {
            return el('span', [mono(r.subject), r.subject === me.subject ? ui.pill('you', 'info') : null]);
          }
        },
        { key: 'displayName', label: 'Display name' },
        { key: 'roles', label: 'Roles', sortable: false, render: function (r) { return chips(r.roles, 'no roles'); } },
        { key: 'source', label: 'Source', render: function (r) { return mono(r.source || ''); } }
      ], ops, {
        caption: 'Console operators with subject, display name and roles',
        sortKey: 'subject',
        rowKey: function (r) { return r.subject; },
        empty: 'No console operators.'
      }));
    }
    (part.problems || []).forEach(function (p) {
      body.appendChild(el('div.callout.warn', [el('strong', { text: 'Operators file problem' }), el('p', { text: String(p.message || p) })]));
    });
  }

  function pgPanel(body, data) {
    var part = data.postgres || {};
    if (part.ok === false) {
      body.appendChild(partBlock(part));
      return;
    }
    var roles = (part.roles || []).filter(function (r) { return !r.predefined; });
    body.appendChild(ui.table([
      { key: 'name', label: 'Role', render: function (r) { return mono(r.name); } },
      { key: 'canLogin', label: 'Login', status: true, render: function (r) { return ui.pill(r.canLogin ? 'login' : 'group', r.canLogin ? 'ok' : 'idle'); } },
      { key: 'superuser', label: 'Superuser', status: true, render: function (r) { return r.superuser ? ui.pill('superuser', 'bad') : ui.pill('no', 'idle'); } },
      { key: 'memberOf', label: 'Member of', sortable: false, render: function (r) { return chips(r.memberOf, 'none'); } },
      { key: 'sessions', label: 'Sessions', align: 'right', render: function (r) { return fmt.num(r.sessions); } }
    ], roles, { caption: 'PostgreSQL roles', sortKey: 'name', rowKey: function (r) { return r.name; }, empty: 'No roles.' }));
  }

  function objectStorePanel(body, data) {
    var part = data.objectStore || {};
    if (part.ok === false) {
      body.appendChild(partBlock(part));
    } else {
      body.appendChild(ui.table([
        { key: 'name', label: 'Identity', render: function (r) { return mono(r.name); } },
        { key: 'accessKeys', label: 'Access keys', sortable: false, render: function (r) { return chips(r.accessKeys, 'none'); } },
        { key: 'actions', label: 'Actions', sortable: false, render: function (r) { return chips(r.actions, 'none'); } }
      ], part.identities || [], { caption: 'Object store identities', sortKey: 'name', rowKey: function (r) { return r.name; }, empty: 'No identities.' }));
    }
  }

  function accountsTable(accounts) {
    return ui.table([
      { key: 'name', label: 'Account', render: function (r) { return mono(r.name); } },
      { key: 'kind', label: 'Kind' },
      { key: 'tier', label: 'Tier', align: 'right', render: function (r) { return 'Tier ' + r.tier; } },
      { key: 'hosts', label: 'Hosts', sortable: false, render: function (r) { return chips(r.hosts, 'no hosts'); } },
      { key: 'sql', label: 'SQL databases', sortable: false, render: function (r) { return chips(r.sql, 'no SQL access'); } },
      { key: 's3', label: 'S3 grants', sortable: false, render: function (r) { return chips(r.s3, 'no bucket access'); } },
      { key: 'codesign', label: 'Code signing', status: true, render: function (r) { return r.codesign ? ui.pill('codesign', 'warn') : ui.pill('no', 'idle'); } }
    ], accounts, {
      caption: 'Service accounts declared in the GitOps tree, with hosts, tier, SQL databases, S3 grants and code signing',
      sortKey: 'name',
      rowKey: function (r) { return r.name; },
      empty: 'No service accounts are declared.'
    });
  }

  function declaredAccountsPanel(body, data) {
    var part = data.serviceAccounts || {};
    if (part.ok === false) body.appendChild(partBlock(part));
    else body.appendChild(accountsTable(part.accounts || []));
  }

  function principalsLive() {
    var path = '/api/identity/principals';
    return el('div.grid', [
      A.livePanel('Console operators', path, operatorsPanel, { skeletonRows: 2 }),
      A.livePanel('PostgreSQL roles', path, pgPanel, { skeletonRows: 2 }),
      A.livePanel('Object store identities', path, objectStorePanel, { skeletonRows: 2 }),
      A.livePanel('Declared service accounts', path, declaredAccountsPanel, { skeletonRows: 2 }),
      A.notInStack('Active Directory',
        'does not exist here: identity is console operators, PostgreSQL roles, object store identities and declared service accounts.')
    ]);
  }

  function gmsaLive() {
    return el('div.grid', [
      el('div.callout.info', [
        el('strong', { text: 'Rotation age is not known.' }),
        ui.disclosure('Details', [el('p', { text: 'There is no directory to ask when a service account password was last rotated. What is shown is what the GitOps tree declares each account may reach.' })])
      ]),
      A.livePanel('Service accounts', '/api/gitops/service-accounts', function (body, data) {
        body.appendChild(accountsTable(data.accounts || []));
        var t = data.declaredAt ? new Date(data.declaredAt) : null;
        body.appendChild(el('p.hint', {
          text: (t && !isNaN(t.getTime()) ? 'Declared at ' + fmt.stamp(t) + '. ' : 'Declaration time unknown. ') +
            (data.source ? 'Source: ' + data.source + '.' : '')
        }));
      }, { skeletonRows: 3 })
    ]);
  }

  function grantsLive() {
    return el('div.grid', [
      A.notInStack('Just-in-time group membership',
        'needs a directory with groups and an approval workflow, and this stack has neither. There are no grants to approve, deny or revoke here.')
    ]);
  }

  function sealRender(body, data) {
    var seal = data.seal || {};
    if (data.configured === false || data.state === 'not-configured') {
      body.setAttribute('data-state', 'notConfigured');
      body.appendChild(ui.stateBlock('notConfigured', { reason: 'not-configured', detail: data.summary || 'This console has no OpenBao address.' }));
      return;
    }
    body.appendChild(el('div.tiles', [
      ui.statTile('Sealed', data.sealed === null || data.sealed === undefined ? 'unknown' : (data.sealed ? 'sealed' : 'unsealed'), { note: data.summary || '' }),
      ui.statTile('Seal type', seal.type || 'unknown', { note: seal.shares ? seal.threshold + ' of ' + seal.shares + ' shares' : '' }),
      ui.statTile('Version', data.version || 'unknown', { note: data.clusterName || '' })
    ]));
    if (data.sandbox && data.sandbox.verdict === true) {
      body.appendChild(el('div.callout.bad', { 'data-sandbox-seal': 'true' }, [
        el('strong', { text: 'This seal is 1-of-1: one key on this machine opens every secret.' }),
        el('p', [A.link('Unseal posture on Services', 'stack')])
      ]));
    }
    if (data.detail) body.appendChild(el('p', { text: data.detail }));
    if (data.reachable === false) {
      body.appendChild(ui.stateBlock('unreachable', { reason: 'unreachable', detail: data.message || '' }));
    }
  }

  function secretsLive() {
    return el('div.grid', [
      A.livePanel('OpenBao seal status', '/api/secrets/seal-status', sealRender, { skeletonRows: 2 }),
      A.notInStack('Secret lease counts and rotation ages',
        'are not read: the console holds no OpenBao token that may list paths or leases, so it shows seal status only and never a path, lease or secret value. There is nothing to rotate or revoke from here.')
    ]);
  }

  var CRUMB = { people: 'People', gmsas: 'Service accounts', grants: 'Access grants', secrets: 'Secrets' };

  function identityCrumbs(rest) {
    return rest.slice(0, 1).map(function (r) { return Object.prototype.hasOwnProperty.call(CRUMB, r) ? CRUMB[r] : r; });
  }

  A.screen('identity', {
    title: 'Identity and secrets',
    crumb: 'Identity and secrets',
    crumbs: identityCrumbs,
    liveCrumbs: function (rest) {
      var out = identityCrumbs(rest);
      if (rest[0] === 'people') out[0] = 'Principals';
      return out;
    },
    render: function (mount, ctx) {
      mount.appendChild(ui.pageHeader(
        'Identity and secrets',
        null,
        isLive() ? [] : [
          ui.btn('Request elevation', {
            variant: 'primary',
            onClick: requestElevationDialog
          })
        ]));

      var wanted = (ctx && ctx.params) || {};
      mount.appendChild(ui.tabs([
        { id: 'people', label: isLive() ? 'Principals' : 'People', render: gate(peopleTab, principalsLive) },
        { id: 'gmsas', label: 'Service accounts', render: gate(gmsaTab, gmsaLive) },
        { id: 'grants', label: 'Access grants', render: gate(grantsTab, grantsLive) },
        { id: 'secrets', label: 'Secrets', render: gate(secretsTab, secretsLive) }
      ], {
        label: 'Identity sections',
        initial: (ctx && ctx.rest && ctx.rest[0]) || null,
        href: function (id) { return A.href('identity', [id]); },
        onSelect: function (id) {
          if (id === 'grants' && wanted.id) ui.revealRow(mount, wanted.id, { label: 'Grant ' + wanted.id + ' is highlighted' });
          if (id === 'secrets' && wanted.path) ui.revealRow(mount, wanted.path, { label: wanted.path + ' is highlighted' });
        }
      }));
    }
  });
})();
