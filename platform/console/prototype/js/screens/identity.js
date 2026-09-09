/* Argus Console: Identity and secrets.
 *
 * People, the service accounts nobody holds a password for, the time-boxed
 * access grants that are the only route to privilege, and the secret paths.
 *
 * The one rule this screen exists to enforce: a secret value is never rendered
 * anywhere in the console, not in a table, not in a dialog, not in a tooltip.
 * The console shows paths and metadata; values are read from OpenBao by the
 * workload that needs them, never proxied through an operator browser.
 *
 * Nothing is built from an HTML string: group names, reasons and secret paths
 * all come from outside the product.
 *
 * Classic script, no modules, ES5 only (ADR-0027).
 */
(function () {
  'use strict';

  var A = window.ARGUS, ui = A.ui, el = ui.el, d = A.data;
  var fmt = ui.fmt;

  // The signed-in principal, in the short form the grant records use.
  var ME = d.me.upn.split('@')[0];

  /* ---------------------------------------------------------- helpers --- */

  function mono(text) { return el('span.mono', { text: text }); }

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

  /* -------------------------------------------------------- people tab --- */

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
        A.flash('warn', 'Offboarding requested for ' + p.upn,
          'The prototype changes nothing. In production this disables the account, revokes active grants and writes the reason to the audit.');
      }
    });
  }

  function peopleTab() {
    var total = d.people.length;
    var withMfa = d.people.filter(function (p) { return !!p.mfa; }).length;
    var phishResistant = d.people.filter(function (p) { return p.mfa === 'FIDO2'; }).length;
    var elevated = d.people.filter(function (p) { return p.elevated; });
    var tier0 = d.people.filter(function (p) { return p.tier === 0; });

    var cols = [
      { key: 'name', label: 'Name', width: '18%' },
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
            ? ui.pill('elevated', 'bad', {
              title: 'Holding privilege beyond their standing role right now' +
                (r.elevationExpires ? ', until ' + fmt.stamp(r.elevationExpires) : '') + '.'
            })
            : ui.pill('standing role', 'idle');
        }
      },
      {
        label: 'Actions', sortable: false, status: true,
        render: function (r) {
          return ui.btn('Offboard ' + r.upn, {
            variant: 'danger',
            onClick: function () { offboard(r); }
          });
        }
      }
    ];

    return el('div.stack', [
      el('div.tiles', [
        ui.statTile('People', fmt.num(total), { note: 'With a console account' }),
        ui.statTile('MFA coverage', fmt.pct((withMfa / total) * 100, 0), {
          note: phishResistant + ' of ' + total + ' on a phishing-resistant FIDO2 key'
        }),
        ui.statTile('Elevated now', fmt.num(elevated.length), {
          note: elevated.length ? elevated.map(function (p) { return p.upn; }).join(', ') : 'Nobody holds extra privilege'
        }),
        ui.statTile('Tier 0 holders', fmt.num(tier0.length), {
          note: tier0.length ? tier0.map(function (p) { return p.upn; }).join(', ')
            : 'No standing Tier 0: it is reached only through a time-boxed grant'
        })
      ]),
      ui.card('People', ui.table(cols, d.people, {
        caption: 'People with a console account, with tier, MFA method, last sign-in, group membership and whether they are elevated right now',
        sortKey: 'name',
        empty: 'No people have a console account in this environment.'
      }), { flush: true })
    ]);
  }

  /* ----------------------------------------------- service accounts tab --- */

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
            ? ui.pill(fmt.num(r.rotatedDays) + ' d', 'warn', {
              title: 'Older than the 30-day gMSA rotation interval, which means Active Directory has not rotated this password on schedule.'
            })
            : ui.pill(fmt.num(r.rotatedDays) + ' d', 'ok', { title: 'Within the 30-day gMSA rotation interval.' });
        }
      }
    ];

    return el('div.stack', [
      el('div.callout.info', [
        el('strong', { text: 'No human ever knows a gMSA password.' }),
        el('p', {
          text: 'Active Directory generates a 240-character password for each group managed service account and rotates it every 30 days. It is never typed, never stored in a vault, never pasted into a runbook, and cannot be shown here, because the domain controller only releases it to the hosts on the account allow list. Compromising one of these accounts means compromising a host, not stealing a string.'
        }),
        el('p', {
          text: 'The grants below are therefore the whole story: what an account can reach is the only thing worth reviewing, since there is no password to rotate by hand.'
        })
      ]),
      ui.card('Service accounts', ui.table(cols, d.gmsas, {
        caption: 'Group managed service accounts, with the hosts allowed to retrieve the password, tier, SQL database access, S3 bucket grants and password age',
        sortKey: 'name',
        empty: 'No service accounts are defined.'
      }), { flush: true })
    ]);
  }

  /* ------------------------------------------------- access grants tab --- */

  var GRANT_TONE = { active: 'warn', expired: 'idle', requested: 'info' };
  var GRANT_TITLE = {
    active: 'Live standing privilege. Every minute this grant is open is a minute the blast radius of a stolen session is larger, which is why it is amber and not green.',
    expired: 'The grant has lapsed and the group membership has been removed.',
    requested: 'Waiting for an approver. Nothing is granted yet.'
  };

  var ELEVATION_GROUPS = [
    'Argus-Console-Operators',
    'Argus-Tier1-Operators',
    'Argus-Tier0-Admins',
    'Argus-Console-Approvers'
  ];

  /**
   * A ticking countdown anchored to the fixed demo clock, so the first paint is
   * deterministic and the display still moves. The interval removes itself once
   * the node leaves the document, because screens are replaced on navigation.
   */
  function countdown(expires) {
    var node = el('span.mono', { text: '' });
    var mountedAt = Date.now();

    function paint() {
      var virtualNow = d.now.getTime() + (Date.now() - mountedAt);
      var left = Math.max(0, Math.round((expires.getTime() - virtualNow) / 1000));
      node.textContent = left > 0 ? fmt.dur(left) + ' left' : 'expired';
    }

    function tick() {
      // The detach check belongs to the interval, not to the first paint. The
      // first paint used to run this same guard while the node was still
      // unmounted -- it is returned to the caller and appended afterwards --
      // so it always bailed out and the cell sat empty for a whole second
      // before the first interval filled it in.
      if (!document.body.contains(node)) { window.clearInterval(timer); return; }
      paint();
    }

    paint();
    var timer = window.setInterval(tick, 1000);
    A.onLeave(function () { window.clearInterval(timer); });
    return node;
  }

  function approveGrant(g) {
    A.stepUp('Approving elevation for ' + g.principal + ' into ' + g.group + ' needs a second factor.', function () {
      A.flash('ok', 'Approved elevation for ' + g.principal,
        g.principal + ' now holds ' + g.group + ' for the requested window. The approval, your identity and the reason are written to the audit, and the membership is removed automatically at expiry.');
    });
  }

  function denyGrant(g) {
    A.flash('info', 'Denied elevation for ' + g.principal,
      'The request for ' + g.group + ' is closed. ' + g.principal +
      ' is told it was declined, and the decision is written to the audit.');
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
        A.flash('warn', 'Revoked ' + g.group + ' from ' + g.principal,
          'The membership is removed and the revocation is written to the audit.');
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

        // Held on the dialog options object so the actions builder can reach them.
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

        // No onClick here: ui.btn captures opts.disabled at construction, so the
        // listener is attached separately and reads the live disabled state,
        // which is the same pattern confirmDestructive uses.
        var submit = ui.btn('Request elevation', {
          variant: 'primary',
          disabled: true,
          title: 'Give a reason first: it is written to the audit.'
        });
        // aria-disabled via setDisabled, never the native property: a natively
        // disabled button leaves the focus trap's FOCUSABLE list and takes its
        // title -- the only statement of why it is unavailable -- out of reach
        // of assistive technology. That is defect B7, reintroduced here alone.
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

  function grantCard(g) {
    var isSelf = g.principal === ME;
    var body = [
      el('div.row', [
        el('strong', { text: g.principal }),
        el('span.muted', { text: 'into' }),
        mono(g.group),
        ui.pill(g.state, GRANT_TONE[g.state] || 'idle', { title: GRANT_TITLE[g.state] })
      ]),
      ui.dl([
        ['Reason', g.reason],
        ['Approver', g.approver ? mono(g.approver) : el('span.muted', { text: 'not yet approved' })],
        ['Granted', g.granted ? fmt.time(g.granted) : el('span.muted', { text: 'not yet granted' })],
        ['Expires', g.expires ? fmt.time(g.expires) : el('span.muted', { text: 'not yet granted' })]
      ])
    ];

    if (g.state === 'requested') {
      body.push(el('div.row', [
        ui.btn('Approve ' + g.principal + ' into ' + g.group, {
          variant: 'primary',
          disabled: isSelf,
          title: isSelf
            ? 'You cannot approve your own elevation. Separation of duties means a second person has to agree, so ask another approver.'
            : null,
          onClick: function () { approveGrant(g); }
        }),
        ui.btn('Deny ' + g.principal + ' into ' + g.group, {
          variant: 'ghost',
          onClick: function () { denyGrant(g); }
        })
      ]));
    } else if (g.state === 'active') {
      body.push(el('div.row', [
        el('span.muted', { text: 'Time remaining:' }),
        countdown(g.expires),
        ui.btn('Revoke ' + g.group + ' from ' + g.principal + ' now', {
          variant: 'danger',
          onClick: function () { revokeGrant(g); }
        })
      ]));
    } else {
      body.push(el('p.hint', {
        text: 'The membership was removed automatically when the grant lapsed. Nothing to do.'
      }));
    }

    // The same data-key a table row carries, so ui.revealRow can find the card
    // a deep link names -- Overview links straight to "#/identity/grants?id=g-442".
    return el('div.grantcard', { data: { key: g.id } }, body);
  }

  function grantsTab() {
    var active = d.grants.filter(function (g) { return g.state === 'active'; });
    var requested = d.grants.filter(function (g) { return g.state === 'requested'; });

    return el('div.stack', [
      el('div.tiles', [
        ui.statTile('Awaiting approval', fmt.num(requested.length), { note: 'Nothing is granted until an approver agrees' }),
        ui.statTile('Active grants', fmt.num(active.length), { note: 'Standing privilege live right now' }),
        ui.statTile('Maximum duration', '4', { unit: 'h', note: 'Longer defeats time-boxing' })
      ]),
      el('div.callout.info', [
        el('strong', { text: 'Nobody holds standing privilege here.' }),
        el('p', {
          text: 'Every route to Tier 0 and Tier 1 is a time-boxed grant with a named approver and a written reason, and every grant expires on its own. An active grant is shown in amber rather than green on purpose: it is privilege that is live right now, not a healthy state.'
        })
      ]),
      ui.card('Grants', el('div.stack', d.grants.map(grantCard)), { flush: false })
    ]);
  }

  /* ------------------------------------------------------- secrets tab --- */

  var READ_ACTORS = ['gmsa-mills$', 'gmsa-console$', 'reconciler', 'gmsa-ci$', 'gmsa-loan$'];

  /** Recent reads derived from the path, so the list is stable between runs. */
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
        A.flash('warn', 'Leases revoked on ' + s.path,
          'Workloads re-authenticate on their own retry loop. The revocation is written to the audit.');
      }
    });
  }

  function rotationPill(s) {
    if (s.rotatedDays > s.policyDays) {
      return ui.pill(fmt.num(s.rotatedDays) + ' d', 'bad', {
        title: 'Overdue: the rotation policy is ' + s.policyDays + ' days and this version is ' +
          s.rotatedDays + ' days old.'
      });
    }
    // Proportional, not a fixed ten days. `rotatedDays > policyDays - 10` is
    // `0 > -9` for a one-day policy, so the two dynamic credentials that
    // rotate correctly every single day were the only rows flagged amber.
    var soon = Math.max(1, Math.round(s.policyDays * 0.1));
    if (s.rotatedDays > s.policyDays - soon) {
      return ui.pill(fmt.num(s.rotatedDays) + ' d', 'warn', {
        title: 'Within ' + soon + (soon === 1 ? ' day' : ' days') + ' of the ' +
          s.policyDays + '-day rotation policy.'
      });
    }
    return ui.pill(fmt.num(s.rotatedDays) + ' d', 'ok', {
      title: 'Inside the ' + s.policyDays + '-day rotation policy.'
    });
  }

  function secretsTab() {
    var overdue = d.secrets.filter(function (s) { return s.rotatedDays > s.policyDays; });

    var cols = [
      { key: 'path', label: 'Path', width: '22%', render: function (r) { return mono(r.path); } },
      { key: 'leases', label: 'Active leases', align: 'right', render: function (r) { return fmt.num(r.leases); } },
      { key: 'rotatedDays', label: 'Rotation age', align: 'right', status: true, render: function (r) { return rotationPill(r); } },
      {
        key: 'policyDays', label: 'Policy', align: 'right',
        render: function (r) { return fmt.num(r.policyDays) + ' d'; }
      },
      { key: 'reads24h', label: 'Reads, 24 h', align: 'right', render: function (r) { return fmt.num(r.reads24h); } },
      {
        label: 'Actions', sortable: false, status: true,
        render: function (r) {
          return el('div.row', [
            ui.btn('Rotate ' + r.path, { variant: 'ghost', onClick: function () { rotateSecret(r); } }),
            ui.btn('Revoke leases on ' + r.path, { variant: 'danger', onClick: function () { revokeLeases(r); } }),
            ui.btn('Who read ' + r.path, { variant: 'ghost', onClick: function () { whoReadThis(r); } })
          ]);
        }
      }
    ];

    return el('div.stack', [
      el('div.callout.info', [
        el('strong', { text: 'The console shows paths and metadata only. It never shows a secret value.' }),
        el('p', {
          text: 'A value is never proxied through this console, never held in the page, and never written to a log or a screenshot. Workloads read their own secrets directly from OpenBao using their machine identity, so an operator browser is never on the path a secret travels.'
        }),
        el('p', {
          text: 'A separate Request value action exists for the Admin role only. It requires a written reason, shows the value exactly once, and pages the security channel as it does so, because the only safe way to read a secret by hand is one that somebody else notices.'
        }),
        el('div.row', [
          ui.btn('Request value (Admin only)', {
            variant: 'ghost',
            disabled: true,
            title: 'Unavailable to your role. You are signed in as ' + d.me.role +
              '; reading a secret value requires the Admin role, a written reason, and it pages the security channel. Request elevation on the Access grants tab if you genuinely need it.'
          }),
          el('span.hint', { text: 'You are signed in as ' + d.me.role + '.' })
        ])
      ]),
      overdue.length ? el('div.callout.warn', [
        el('strong', {
          text: overdue.length + ' path' + (overdue.length === 1 ? ' is' : 's are') + ' past the rotation policy: ' +
            overdue.map(function (s) { return s.path; }).join(', ') + '.'
        }),
        el('p', {
          text: 'A secret older than its policy has been valid for longer than anyone agreed it should be, which widens the window in which a copy taken months ago still works.'
        })
      ]) : null,
      ui.card('Secret paths', ui.table(cols, d.secrets, {
        caption: 'Secret paths in OpenBao, with active leases, rotation age against policy and reads in the last 24 hours. Values are never shown.',
        sortKey: 'path',
        rowKey: function (r) { return r.path; },
        empty: 'No secret paths are readable by your role.'
      }), { flush: true })
    ]);
  }

  /* ------------------------------------------------------------- screen --- */

  A.screen('identity', {
    title: 'Identity & secrets',
    crumb: 'Identity & secrets',
    render: function (mount, ctx) {
      mount.appendChild(ui.pageHeader(
        'Identity & secrets',
        'Who can reach what, for how long, and on whose approval.',
        [
          ui.btn('Request elevation', {
            variant: 'primary',
            onClick: requestElevationDialog
          })
        ]));

      /* Overview and the Config tab both build links that name a row --
         "?id=g-442", "?path=kv/mills/jwt-signing-key" -- and until now the
         right tab opened and the row was left for the operator to find. */
      var wanted = (ctx && ctx.params) || {};
      mount.appendChild(ui.tabs([
        { id: 'people', label: 'People', render: peopleTab },
        { id: 'gmsas', label: 'Service accounts', render: gmsaTab },
        { id: 'grants', label: 'Access grants', render: grantsTab },
        { id: 'secrets', label: 'Secrets', render: secretsTab }
      ], {
        label: 'Identity sections',
        initial: (ctx && ctx.rest && ctx.rest[0]) || null,
        onSelect: function (id) {
          if (id === 'grants' && wanted.id) ui.revealRow(mount, wanted.id, { label: 'Grant ' + wanted.id + ' is highlighted' });
          if (id === 'secrets' && wanted.path) ui.revealRow(mount, wanted.path, { label: wanted.path + ' is highlighted' });
        }
      }));
    }
  });
})();
