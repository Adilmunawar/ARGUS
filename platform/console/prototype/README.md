# Console prototype

A working prototype of the Argus Console. Open `index.html` in any browser (`start index.html` on Windows, `open` on macOS, `xdg-open` on Linux): no build, no server, no network. Opened that way it runs on the bundled sample dataset; served by the console API in `../server` it reads the live stack. [ADR-0035](../../../docs/adr/ADR-0035-the-console-as-built.md) records why it is built this way.

```
index.html            the shell: navigation, top bar, session drawer
assets/app.css        design tokens and the shell chrome
assets/components.css every component the screens are built from
js/data.js            the demonstration dataset
js/store.js           the read path: probe, cache, abort, and the live event streams
js/ui.js              the component library
js/app.js             routing, command palette, dialogs, focus, elevation
js/screens/*.js       one file per section
tests/run-tests.js    the property suite
tests/live.js         the live suite: the prototype served by the console API over http
tests/live-screens/   one module of live checks per screen wired to the API
tests/sandbox.js      the same console across nine viewport, theme and density environments
tests/stress.js       the performance and retention budgets
```

The prototype uses classic scripts, not modules, because ES modules are blocked by CORS on `file://` and the console has to open from a memory stick during a site failure. Everything is ES5, so it runs in whatever browser is on the machine you can reach.

## Running the tests

From the repository root:

```bash
npm ci
npx playwright install chromium
npm test                 # property suite, 423 assertions
npm run test:live        # live suite, 386 checks; needs npm ci in platform/console/server
npm run test:sandbox     # nine environments, 125 checks
npm run test:stress      # performance and retention budgets
```

Each exits with the number of failures, so CI gates on it. CI runs all four on every push.

Every suite runs in headless Chromium against the real rendered DOM. The property suite covers:

* the shell booting and every screen registering;
* every route and deep link resolving;
* axe core WCAG 2.1 and 2.2 A/AA on every screen and every overlay, with the 2.2 target size rule explicitly enabled because axe ships it disabled;
* a second pass over all fifteen routes in a Windows High Contrast context, where colour contrast is meaningless and is replaced by a check that the five status tones stay distinguishable by border and glyph;
* real `Tab` traversal with focus ring, focus trap and focus restoration checks;
* the command palette, table captions and `aria-sort`;
* a windowed table holding its scroll position and its focused row across a repaint;
* the loading, empty, error, stale and partial states a panel reaches when it reads a live API;
* the retry ladder and its jitter, and the abort signal a screen hands to its reads and loses when it leaves;
* contrast computed from rendered pixels, a text size floor, six viewport widths and laptop density;
* WCAG 1.4.10 reflow at 200% and 400% zoom, and touch targets;
* reduced motion, including the view transition pseudo elements a universal selector cannot reach;
* a security pass over the source, determinism, and console errors.

The security suite reads the source rather than the DOM, because the property that matters is that `innerHTML` appears nowhere at all, not that a particular render happened to be safe.

## Running it against the real stack

Served by the console API, the same files run in live mode. The API answers only to a signed-in operator, so the console opens with a sign-in dialog, and the operator pill, the audit actor and the data source pill all follow the session the API holds. A read that comes back 401, because the session idled out, brings the dialog back; signing out ends the session and clears the cookie.

```bash
node platform/compose/stack.js bootstrap
node platform/compose/stack.js up --wait
```

Then open http://127.0.0.1:8787 and sign in as `argus-admin`, with the password in `platform/compose/secrets/console_operator_password` ([the compose README](../../compose/README.md) has the details). Without Docker, start the API alone with an operator file, as the [repository README](../../../README.md#quick-start) shows. The live suite proves this path on every push without the stack: it starts the API with a temporary operator and drives the sign-in, the fifteen screens, a reload, an expired session and a sign-out through headless Chromium over http:

```bash
node platform/console/prototype/tests/live.js
```

## What it demonstrates

Every screen in the sidebar, and the interaction rules from [the console design](../../../docs/10-CONSOLE-DESIGN.md):

* **Every write is a pull request.** Buttons say *Propose*, and the response shows the reconciler's plan and the blast radius before anything is applied. In sample mode the plan and the pull request are simulated; there is no reconciler.
* **Recorded, credential free browser RDP, as a design.** The Connect tab requests elevation, states that OpenBao would issue a one time credential the operator never sees, and opens a simulated session in a drawer that survives navigation. No remote session is made.
* **Just in time elevation** with a reason, an approver, a maximum of four hours, and a countdown in the shell that you cannot miss.
* **A command palette** (`Ctrl`/`Cmd` + `K`) over every resource, screen and action, plus `g` then letter jumps and `/` to filter.
* **Compound audit filtering.** CloudTrail allows one attribute at a time; this allows several at once, which is the most complained about limitation in the product it replaces.

## What it is not

There is no reconciler, no Guacamole brokering and no write path. Served by the API and signed in, all fifteen screens read a real source, the stack or the GitOps tree, and mark what this stack does not have as "Not in this stack"; no sample figure is shown in live mode. Opened from the filesystem, eleven screens run on the sample dataset, shaped by [the application infrastructure map](../../../docs/02-APPLICATION-INFRASTRUCTURE-MAP.md), and four (Data, Object storage, Services, System) have no fixtures and say there is nothing to read. Three of the four suites exercise that file:// state; the live suite is the one that starts the API.

The console is read only. Actions (approve, grant, rotate, freeze, silence, incidents, tags, Undo) exist in sample mode and change only the dataset in the browser; the API has no write routes besides sign-in and sign-out.

The visual language is specified in [the console design system](../../../docs/13-CONSOLE-DESIGN-SYSTEM.md).

These tests prove the interface is sound. They prove nothing about the platform, which remains as [the validation status](../../../docs/09-VALIDATION-STATUS.md) describes it.

## What to judge it on

Is this the screen you want at 9 a.m., and is the Connect flow one you would trust for `sql-01`? Mark it up and the design document changes before the build starts.
