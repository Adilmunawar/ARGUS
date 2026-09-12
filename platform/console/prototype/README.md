# Console prototype

A working prototype of the Argus Console. Open `index.html` in any browser. No build, no server, no network.

```
index.html            the shell: navigation, top bar, session drawer
assets/app.css        design tokens and the shell chrome
assets/components.css every component the screens are built from
js/data.js            the demonstration dataset
js/ui.js              the component library
js/app.js             routing, command palette, dialogs, focus, elevation
js/screens/*.js       one file per section
tests/run-tests.js    the automated suite
```

Classic scripts, not modules, because ES modules are blocked by CORS on `file://` and the console has to open from a memory stick during a site failure. Everything is ES5, so it runs in whatever browser is on the machine you can reach.

## Running the tests

```bash
npm ci
npx playwright install chromium
node platform/console/prototype/tests/run-tests.js
```

The exit code is the number of failures, so CI can gate on it.

Seventeen suites in headless Chromium against the real rendered DOM: the shell boots and every screen registers; every route and deep link resolves; axe-core WCAG 2.1 A/AA on every screen and on every overlay; real `Tab` traversal with focus-ring, focus-trap and focus-restoration checks; the command palette; table captions and `aria-sort`; the empty, no-match and error states; contrast computed from rendered pixels; a text-size floor; six viewport widths; laptop density; WCAG 1.4.10 reflow at 200% and 400% zoom; touch targets; reduced motion; a security pass over the source; determinism; and console errors.

The security suite reads the source rather than the DOM, because the property that matters is that `innerHTML` appears nowhere at all, not that a particular render happened to be safe.

## What it demonstrates

Thirteen screens across twelve sidebar sections, and the interaction rules from `docs/10-CONSOLE-DESIGN.md`:

- **Every write is a pull request.** Buttons say *Propose*, and the response shows the reconciler's plan and the blast radius before anything is applied. The two exceptions that run live, quarantine and revoke, both page security.
- **Recorded, credential-less browser RDP.** The Connect tab requests elevation, states that OpenBao issues a one-time credential the operator never sees, and opens a session in a drawer that survives navigation.
- **Just-in-time elevation** with a reason, an approver, a maximum of four hours, and a countdown in the shell that you cannot miss.
- **A command palette** (`Ctrl`/`Cmd` + `K`) over every resource, screen and action, plus `g`-then-letter jumps and `/` to filter.
- **Compound audit filtering.** CloudTrail allows one attribute at a time; this allows several at once, which is the most-complained-about limitation in the product it replaces.

## What it is not

Static. There is no API, no authentication, no reconciler, no Guacamole, no database. Every number is invented, though the shape of the data follows `docs/02-APPLICATION-INFRASTRUCTURE-MAP.md` so the screens stay honest when a real API replaces the fixture.

These tests prove the interface is sound. They prove nothing about the platform, which remains as `docs/09-VALIDATION-STATUS.md` describes it.

## What to judge it on

Is this the screen you want at 9 a.m., and is the Connect flow one you would trust for `sql-01`? Mark it up and the design document changes before the build starts.
