# Alertmanager configuration template

`alertmanager.yml.tmpl` is the committed source. It is **not** what Alertmanager reads.

`docker-compose.yml` mounts `./secrets/alertmanager.yml` at `/etc/alertmanager/alertmanager.yml`.
`bootstrap.ps1` renders this template into that path. `secrets/` is gitignored, so no credential
ever reaches the repository.

## Why a template and not env vars

Alertmanager v0.28.1 performs **no environment expansion of any kind**. There is no equivalent of
Loki's `-config.expand-env` or Prometheus's external-label expansion. A `${SMTP_PASSWORD}` left in
the file is treated as a literal password, `amtool check-config` passes, the stack boots green, and
the one delivery leg that must survive the console being down fails at send time against an
unresolvable host.

## Placeholder syntax

Placeholders are `@@NAME@@`. `bootstrap.ps1` resolves each one against a key of the same name in
`.env`, substitutes with a plain `String.Replace` — no escaping, no regex, no expression language —
and refuses to write the file if any placeholder has no value or any `@@` survives. `@@` was chosen
over `${...}` so that a failed substitution is visibly broken in the rendered file rather than being
mistaken for a shell variable that something else might expand later. It also keeps the CI grep for
`${` meaningful as an independent second gate.

Every placeholder here must have a matching key in `.env.example`, or `bootstrap.ps1` dies before
writing anything at all — including `.env` and every other secret. Adding a placeholder to this
template is therefore a change to `.env.example` as well.

## Placeholders

| Placeholder | `.env` key | Value |
| --- | --- | --- |
| `@@SMTP_SMARTHOST@@` | `SMTP_HOST` | `host:port` of the SMTP relay, port included |
| `@@SMTP_FROM@@` | `SMTP_FROM` | envelope and header From address; the smarthost must accept it |
| `@@ONCALL_EMAIL@@` | `ONCALL_EMAIL` | recipient for `severity: page` |
| `@@PLATFORM_EMAIL@@` | `PLATFORM_EMAIL` | recipient for `severity: ticket` |

`bootstrap.ps1` maps `@@SMTP_SMARTHOST@@` to either `SMTP_SMARTHOST` or `SMTP_HOST`; the rest
resolve by exact name.

## Why TLS is not required on the SMTP leg

`smtp_require_tls: false` is deliberate and is load-bearing for the smarthost this repository
actually ships.

`.env.example` sets `SMTP_HOST=mailpit:1025`, and `docker-compose.yml` runs Mailpit with
`MP_SMTP_AUTH_ALLOW_INSECURE` and no `MP_SMTP_TLS_CERT`. Mailpit only advertises STARTTLS when it is
given a certificate and key, so with `smtp_require_tls: true` Alertmanager refuses to hand over the
message — `does not advertise the STARTTLS extension` — and every page and ticket email fails at
send time while the whole stack stays green. The connection never leaves the `argus` bridge network
and no port is published, so there is nothing on the wire to protect.

If `SMTP_HOST` is repointed at a relay outside the compose network, set `smtp_require_tls: true`
here and re-render. That is the one edit this file needs to become externally safe.

## Verifying a render

```
docker run --rm -v "$PWD/platform/compose/secrets/alertmanager.yml:/c.yml:ro" \
  prom/alertmanager:v0.28.1 amtool check-config /c.yml
grep -n '@@' platform/compose/secrets/alertmanager.yml && exit 1
grep -n '\${' platform/compose/secrets/alertmanager.yml && exit 1
```

`amtool check-config` validates structure and does not resolve hostnames or attempt delivery, so
the two greps are the part that actually catches an unrendered template.

## Routing

`route` fans out by the `severity` label that every rule under `prometheus/rules/` sets, and that
`platform/gitops/apps/*/alerts.yaml` already uses.

- `debug` is dropped into the `argus-null` receiver. Prometheus also drops it in
  `alert_relabel_configs` before it is ever sent, so this route is the second of two gates.
- `page` goes to on-call email immediately, `group_wait: 10s`, repeating hourly.
- `ticket` goes to platform email, `group_wait: 2m`, repeating twice a day, muted during the
  `offhours` and `weekends` intervals so a non-urgent alert does not wake anyone. Muting defers
  rather than discards: a ticket that fires at 02:00 is delivered after 08:00.
- Anything that carries no `severity` at all lands on the root receiver, `argus-ticket`, rather
  than being silently dropped.

## Email is the only delivery leg

There is no webhook receiver in this config, and that is a decision rather than an omission.

The two webhook targets the design sketches assume do not exist in this repository:

- **The console.** `platform/console/server/src/index.js` has no `POST /api/alerts/webhook` route,
  and its read-only guard refuses every non-GET verb with HTTP 405 before routing is even
  consulted. Alertmanager never retries a 4xx.
- **Apprise.** No Apprise service appears anywhere in `docker-compose.yml`.

A receiver pointed at either one fails on every notification, which drives
`alertmanager_notifications_failed_total` up, which fires `ArgusAlertmanagerNotificationsFailing` at
`severity: page`, which is delivered through the same broken receiver. That loop is worse than no
webhook: it is a permanently red alerting path that also hides the real alerts inside it.

Mailpit is reachable, `alertmanager` already `depends_on` it being healthy, and its UI is published
on `127.0.0.1:8025`, so email is a leg that genuinely works end to end today.

To add the console back once it can accept the POST: give the console the route, exempt that one
path from the read-only guard, authenticate it with the `console_alert_token` bearer that
`docker-compose.yml` already mounts into this container, and add a `webhook_configs` entry to
`argus-ticket` reading its credential from `/run/secrets/console_alert_token`. Until then the
console reads `/api/v2/alerts` from Alertmanager over GET, which is what `ARGUS_ALERTMANAGER_URL` in
the console environment already implies.

## Time intervals

`time_intervals` is the 0.28 top-level key. The older `mute_time_intervals` top level is
deprecated; the per-route keys are still spelled `mute_time_intervals` and `active_time_intervals`.
Only the definition list was renamed, and getting that backwards is the usual 0.28 mistake.

`location: Asia/Karachi` matches the `TZ` the postgres and mailpit services are given.

## Inhibitions

The inhibit rules exist so one failure produces one page. A down target suppresses its own
downstream symptoms; `ArgusPostgresDown` suppresses every other Postgres alert on the same
instance; volume exhaustion suppresses the slot-pressure warnings it causes; an expired
certificate suppresses its own countdown alerts.

Alertmanager 0.28.**1** specifically is required: 0.28.0 silently dropped `equal:` labels through
its config encoder, which turns every rule here into an unconditional suppression.

## No notification templates

This config references no custom template file and mounts none. Alertmanager's built-in default
templates render both email bodies. Adding `templates: [/etc/alertmanager/templates/*.tmpl]` with
no such bind mount makes every notification fail at send time with a template-not-found error,
which looks exactly like a mail outage.
