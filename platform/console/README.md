# Argus Console

The operator interface for Argus. What exists is two parts that run together, recorded in [ADR-0035](../../docs/adr/ADR-0035-the-console-as-built.md):

<table>
  <tr><th>Path</th><th>What it is</th><th>State</th></tr>
  <tr><td><a href="prototype/"><code>prototype/</code></a></td><td>Fifteen screens in ES5 classic scripts with no build step and no runtime dependencies. Opens from <code>file://</code> with a bundled sample dataset, or runs in live mode when the API serves it.</td><td>Built and tested: four browser suites, see <a href="prototype/README.md">its README</a></td></tr>
  <tr><td><a href="server/"><code>server/</code></a></td><td>A Node API (Node 22 or later) that serves the prototype, signs operators in with server-side sessions, and exposes read-only routes over the compose stack and the GitOps tree.</td><td>Built and tested: <code>npm test</code> in <code>server/</code>. Settings, routes and roles are in <a href="server/README.md">the server README</a></td></tr>
  <tr><td><code>tools/</code></td><td><code>init-object-storage.js</code>, the one-shot that creates and checks the buckets and their object lock at stack boot.</td><td>Run by the compose stack</td></tr>
  <tr><td><code>src/</code></td><td><code>Argus.Console.Api/Program.cs</code>, <code>Argus.Console.Web/README.md</code> and <code>Argus.Reconciler/README.md</code>.</td><td>Placeholders for the target design in <a href="../../docs/05-CONTROL-PLANE.md">the control plane document</a>. Not built, not referenced by any build or test</td></tr>
</table>

## Running it

Sample mode, from the repository root: open `platform/console/prototype/index.html` in a browser (`start` on Windows, `open` on macOS, `xdg-open` on Linux).

Live mode without Docker: create an operator with `npm run hash-operator-password` in `server/`, point `ARGUS_AUTH_OPERATORS_FILE` at a file holding it, and run `npm start`. The [repository README](../../README.md#quick-start) has the exact commands.

Live mode against the whole stack: `node platform/compose/stack.js bootstrap` and then `node platform/compose/stack.js up --wait`, as described in [the compose README](../compose/README.md). The console is then on http://127.0.0.1:8787; sign in as `argus-admin` with the password in `platform/compose/secrets/console_operator_password`.

## What it does and does not do

Signed in, every screen is live. The API reads SeaweedFS, PostgreSQL, Garnet, NATS, OpenBao, Prometheus, Alertmanager, Loki, the container socket proxy, the GitOps specs and the runbooks, and checks each route against the operator's role (viewer, operator, security, admin). What this stack does not have is shown as "Not in this stack" rather than as a sample figure. The visual language is [the console design system](../../docs/13-CONSOLE-DESIGN-SYSTEM.md).

The console is read only. The API has no write routes besides sign-in and sign-out, so approving a deployment, granting access, rotating a secret, declaring a freeze or opening a remote session changes only the sample dataset in the browser. Those flows are the interaction design for the reconciler-backed write paths described in [docs/05](../../docs/05-CONTROL-PLANE.md) and [docs/10](../../docs/10-CONSOLE-DESIGN.md). The session drawer is simulated; Guacamole runs in the compose `connect` profile but the console does not broker sessions to it yet.

The audit trail is an in-memory ring on the API. The Audit screen's hash chain shows that rows were not altered between the API and the page; it is not a durable or tamper-proof store.

## Target design

The console is meant to end up behind AD FS, with AD groups mapped to console roles, hosted on the platform's scheduler, and writing only through pull requests that the GitOps reconciler applies. Until the reconciler exists there is nothing for a write path to call. See [ADR-0021](../../docs/adr/ADR-0021-control-surface.md), [ADR-0033](../../docs/adr/ADR-0033-console-is-primary-wac-retired-at-parity.md) and [ADR-0035](../../docs/adr/ADR-0035-the-console-as-built.md).
