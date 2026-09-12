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

Placeholders are `@@NAME@@`. PowerShell substitutes them with a plain `String.Replace` — no
escaping, no regex, no expression language. `@@` was chosen over `${...}` so that a failed
substitution is visibly broken in the rendered file rather than being mistaken for a shell
variable that something else might expand later. It also keeps the CI grep for `${` meaningful as
an independent second gate.

## Placeholders

| Placeholder | Value | Notes |
| --- | --- | --- |
| `@@SMTP_FROM@@` | envelope and header From address | must be one the smarthost will accept |
| `@@SMTP_SMARTHOST@@` | `host:port` of the SMTP relay | port included; `smtp.example.net:587` |
| `@@SMTP_HELLO@@` | hostname sent in EHLO | many relays reject `localhost` |
| `@@SMTP_USERNAME@@` | SMTP auth user | |
| `@@SMTP_PASSWORD@@` | SMTP auth password | the only secret rendered inline; everything else is a file reference |
| `@@ONCALL_EMAIL@@` | recipient for `severity: page` | |
| `@@PLATFORM_EMAIL@@` | recipient for `severity: ticket` | |
| `@@CONSOLE_ALERT_WEBHOOK@@` | full URL of the console alert sink | see the note below before setting this |
| `@@APPRISE_WEBHOOK@@` | full URL of the Apprise fan-out endpoint | reaches WhatsApp, Telegram and SMS |

The bearer token for the console webhook is **not** a placeholder. It is read at send time from
`/run/secrets/console_alert_token`, which `docker-compose.yml` already mounts into the alertmanager
container and `bootstrap.ps1` already writes. Rotating it is a file write plus a container restart,
with no re-render.

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
- `page` goes to on-call email and Apprise immediately, `group_wait: 10s`, repeating hourly.
- `ticket` goes to platform email, `group_wait: 2m`, repeating twice a day, muted during the
  `offhours` interval so a non-urgent alert does not wake anyone.
- Everything that is not `debug` also reaches the console, unconditionally, so the web UI holds the
  complete picture regardless of what was paged or muted.

`continue: true` on the `page` and `ticket` routes is what lets an alert fall through to the
console route below them. Removing it silently stops the console from seeing anything.

## Time intervals

`time_intervals` is the 0.28 top-level key. The older `mute_time_intervals` top level is
deprecated; the per-route keys are still spelled `mute_time_intervals` and `active_time_intervals`.
Only the definition list was renamed, and getting that backwards is the usual 0.28 mistake.

`location: Asia/Karachi` matches the `TZ` the postgres service is given.

## Inhibitions

The inhibit rules exist so one failure produces one page. A down target suppresses its own
downstream symptoms; `ArgusPostgresDown` suppresses every other Postgres alert on the same
instance; volume exhaustion suppresses the slot-pressure warnings it causes; an expired
certificate suppresses its own countdown alerts.

Alertmanager 0.28.**1** specifically is required: 0.28.0 silently dropped `equal:` labels through
its config encoder, which turns every rule here into an unconditional suppression.

## The console webhook will 405 until the console accepts it

`platform/console/server/src/index.js` refuses every non-GET verb with HTTP 405 unless
`ARGUS_ALLOW_WRITES` is set, and Alertmanager never retries a 4xx. A webhook pointed at the console
today therefore fails silently and permanently.

Resolve it one of three ways before rendering:

1. Add `POST /api/alerts/webhook` to the console's route table, exempt that one path from the
   read-only guard, and authenticate it with the `console_alert_token` bearer. Then set
   `@@CONSOLE_ALERT_WEBHOOK@@` to `http://console:8787/api/alerts/webhook`. The compose file already
   mounts `console_alert_token` into alertmanager, which only makes sense for this option.
2. Point `@@CONSOLE_ALERT_WEBHOOK@@` at Apprise and let the console read `/api/v2/alerts` from
   Alertmanager over GET, which is what `ARGUS_ALERTMANAGER_URL` in the console environment
   already implies.
3. Render with the email receivers only until option 1 lands.

## No notification templates

This config references no custom template file and mounts none. Alertmanager's built-in default
templates render both email bodies. Adding `templates: [/etc/alertmanager/templates/*.tmpl]` with
no such bind mount makes every notification fail at send time with a template-not-found error,
which looks exactly like a mail outage.
