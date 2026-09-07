# Console prototype

`index.html`: a static, clickable prototype of the Argus Console. Open it in any browser; no build, no server, no data, no network.

## Running the tests

```bash
node tests/run-tests.js          # exit code = number of failures
SHOTS=/tmp/shots node tests/run-tests.js
```

Ten suites, 65 assertions, in headless Chromium against the real rendered DOM: axe-core WCAG 2.1 A/AA on every screen, real `Tab` traversal for focus indicators, contrast computed from rendered colours (gradients included), responsive checks at six widths, a density suite for small laptops, touch-target sizes, reduced-motion, and console errors. Screenshots are written for each width.

Current: **65/65 passing**. Findings and the fix plan are in `docs/11-CONSOLE-UX-BENCHMARK-AND-BUGS.md`.

## What it shows

Nine screens: Overview, Applications (Mills, with the generated dependency graph), Deployments (reconciler plan diff and blast radius), Compute → sql-01 → recorded desktop session, Data, Security → recorded sessions, Identity, Operations, Audit.

Patterns are borrowed deliberately: app layout and flashbar and property filter from AWS Cloudscape, the collapsible rail from Google Cloud, breadcrumbs from Azure. Tokens, type and components come from the Mills dashboard `DESIGN.md`, with one recorded deviation: the minimum font size is 11px, not 10px, because this is an operations console read under pressure.

## What to judge it on

Is this the screen you want at 9 a.m., and is the Connect flow one you would trust for `sql-01`? Mark it up and the design document changes before the build starts.
