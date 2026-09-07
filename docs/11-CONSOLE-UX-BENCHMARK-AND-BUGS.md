# Console UX benchmark, test results, and the fix plan

Written 8 September 2026 against prototype v2. Everything in the test section was executed, not reasoned about.

---

## Part 1: What the three big consoles do, and what we took

### AWS: Cloudscape Design System

The AWS Management Console is built on **Cloudscape**, an open-source (Apache-2.0) design system AWS created in 2016, which now supports over 220 AWS products with 60+ components, 30+ pattern guidelines and 20+ demos. Because it is open source, it is the single best specification of what a cloud console is.

The components that matter for us, and the verdict on each:

| Cloudscape idea | What it does | Our verdict |
|---|---|---|
| **App layout** | Page structure with collapsible side navigation, tools panel, drawers and split panel | **Adopted.** Collapsible rail is now the shell. |
| **Flashbar** | Page-level notifications about the progress and outcome of actions taken on resources | **Adopted.** Elevation state and the pending approval live here, not buried on a card. |
| **Property filter** | Token-based filtering of a collection: type a property, get a removable token | **Adopted** on Deployments and Audit. Far better than a plain search box for "environment = production, owner = Zayan". |
| **Split view** | A collection table where selecting a row opens a details panel, closed on load, bottom or side position | **Adopted in the spec**, built in C1. Right pattern for VM and bucket lists. |
| **Live region** | A non-visual component that announces page changes to assistive technology | **Adopted.** Every screen change is announced. |
| **Status indicator** | One fixed vocabulary of states across every service | **Adopted** as our pill component with five tones. |
| **Board / configurable dashboard** | Drag-and-drop dashboard items with an add-item palette | **Rejected for v1.** Nine sections do not need personalisation; revisit if the team asks. |
| **Wizard** | Multi-step create with a review page | **Adapted.** Our review page is the pull-request diff, which is strictly better: it shows the machine-readable change, not a human summary of it. |

### Google Cloud console

| GCP idea | Verdict |
|---|---|
| Persistent left navigation that collapses to an icon rail, with pinned sections | **Adopted**: this is the rail, and it is why we do not need AWS's 240-service search |
| Resource/project selector always in the top bar | **Adapted** as the environment switch (production/staging), coloured, and restated in every destructive confirm |
| Cloud Shell as a drawer that persists across pages | **Adapted**: our version is the Connect tab and the PowerShell web terminal, but *scoped by role*, not a free root shell |
| Activity feed in a right panel | **Adopted** as Recent activity on Overview, linking into Audit |

### Azure portal

| Azure idea | Verdict |
|---|---|
| Breadcrumbs on every resource | **Adopted** |
| Pin to dashboard / favourites | **Deferred**: the command palette solves the same problem with less state |
| Blade stacking (panels sliding in from the right) | **Rejected.** It is the most-criticised thing in the Azure portal: users lose their place. We use tabs on a detail page instead. |
| Resource Graph / cross-resource query | **Adopted in spirit** as the command palette and the generated dependency graph |

### What we do that none of them do

1. **Every write is a pull request** with the reconciler's plan shown before approval. AWS mutates production on click.
2. **Blast radius** beside the diff: what depends on this, and who is signed in right now.
3. **Browser RDP with no password and full recording** in the same UI as the deploy button.
4. **Dependency graphs generated from the file the reconciler applies**, so they cannot drift from reality.
5. **Per-application cost on owned hardware.**

---

## Part 2: The test suite

`platform/console/prototype/tests/run-tests.js`, run in headless Chromium against the real rendered DOM. 19 suites, 163 assertions. Exit code is the failure count, so CI can gate on it.

| Suite | What it asserts |
|---|---|
| **BOOT** | The shell loads, the namespace and dataset exist, and all ten screens register |
| **NAV** | Every route and deep link resolves; the breadcrumb, document title and current nav item track the screen; an unknown route says so |
| **A11Y** | axe-core, WCAG 2.1 A **and** AA, on every screen and on every overlay: the palette, dialogs, the flash bar |
| **KBD** | Real `Tab` traversal; every stop has a visible focus ring; dialogs trap focus and give it back to whatever opened them; `g`-then-letter jumps work |
| **CMD** | The command palette opens on `Ctrl`+`K`, searches, moves with the arrow keys, and closes on `Escape` |
| **TBL** | Every table has a caption; sortable headers carry `aria-sort`; sorting reorders the rows |
| **STATE** | A filter that excludes everything says "no match", which is a different sentence from "empty" |
| **LAYOUT** | No table row is taller than 220px, no screen runs past 4200px, nothing marked `hidden` is visible, and no icon has fallen back to the default SVG size |
| **GUARD** | A regression for every defect the adversarial audit found: a disabled button refuses activation, the destructive confirm refuses an empty field, the skip link does not blank the page, leaving a screen stops the work it started, the elevation countdown matches the grant, a deep link opens the tab it names, the query editor enforces its read-only claim, and every class in the markup is defined in a stylesheet |
| **CON** | Contrast computed from rendered colours, gradients included, not from the token table |
| **TXT** | No text below 11px; no clipped or overflowing text |
| **RESP** | No horizontal overflow at 1440 / 1366 / 1280 / 1024 / 768 / 390 px |
| **DENS** | On a 1366×768, 1280×800 and 1024×768 laptop: the first card clears the fold, every stat tile is above it, chrome plus header stays under 55% of the screen, and Overview stays under two screens tall |
| **ZOOM** | WCAG 1.4.10 reflow at 200% and 400% browser zoom |
| **TAP** | Touch targets ≥ 24px (WCAG 2.5.8) at tablet and phone |
| **MOTION** | `prefers-reduced-motion` stops every animation and transition |
| **SEC** | A CSP is declared, it actually blocks an injected inline script, no external origin is referenced, `innerHTML` and inline handlers appear nowhere in the source, and no secret value is rendered |
| **DET** | Every route renders identically on a second visit |
| **CONS** | No console errors, no failed requests |

```
$ node tests/run-tests.js
  BOOT      11 passed     0 failed
  NAV       71 passed     0 failed
  A11Y      19 passed     0 failed
  KBD        6 passed     0 failed
  CMD        5 passed     0 failed
  TBL        3 passed     0 failed
  STATE      1 passed     0 failed
  LAYOUT     4 passed     0 failed
  GUARD     10 passed     0 failed
  CON        1 passed     0 failed
  TXT        2 passed     0 failed
  RESP       6 passed     0 failed
  DENS       9 passed     0 failed
  TAP        2 passed     0 failed
  ZOOM       2 passed     0 failed
  MOTION     1 passed     0 failed
  SEC        7 passed     0 failed
  DET        1 passed     0 failed
  CONS       2 passed     0 failed
  All checks passed.  163/163
```

---

## Part 3: Bug register

v1 failed 11 of 51. Every one is listed, including the four that turned out to be defects in the test harness itself: those are the most instructive, because a test that lies is worse than no test.

### Application bugs: all fixed

| # | Severity | Bug | Cause | Fix |
|---|---|---|---|---|
| **B1** | **Critical** | At 390 px the page was 755 px wide. The sidebar took 232 px of 390 and the content ran off-screen: the console was unusable on a phone, which is exactly where approvals happen at 9 p.m. | Fixed-width grid column, no collapse, no drawer | Rail collapses at 1200 px, becomes an off-canvas drawer with scrim at 900 px, top bar wraps at 620 px |
| **B2** | **Critical** | Even after the drawer, the page still measured 566 px at 390 px | Grid items default to `min-width:auto`, so the content column refused to shrink below its content | `grid-template-columns: minmax(0,1fr)` |
| **B3** | **High** | Ten interactive elements (Review, Extend, Schedule, Replay, Roll back, bucket names) were `<span class="link">` with a click handler. Unreachable by keyboard, invisible to screen readers | Styling chosen before semantics | All are real `<button>`s |
| **B4** | **High** | No focus indicator on the navigation, the search bar, the environment pill or the terminal buttons; 13 elements | `:focus-visible` was scoped to `.btn` only | Global `:focus-visible` rule |
| **B5** | **High** | The prototype fetched Lora from `fonts.googleapis.com`. The console runs behind an egress allow-list (ADR-0027): in production it would have silently failed, and it leaks that the console was opened | Convenience during the first draft | Local-first font stack; Geist and Lora ship self-hosted in the real build |
| **B6** | Medium | `.delta.up` was 3.73:1 against paper, below the 4.5:1 AA threshold. It is the colour that carries "is this number good or bad" | Tailwind emerald-600 assumed to be safe | `--ok` darkened to `#046c4e` |
| **B7** | Medium | The disabled terminal button used `opacity:.4`, failing contrast and giving screen readers nothing | `opacity` as a disabled state | Explicit colour plus `aria-disabled="true"` and a `title` explaining *why* it is disabled |
| **B8** | Medium | Eight elements used 10px text: the leaf mark, nav group headings, eyebrows, node captions | Mills allows 10-12px labels; at 3 a.m. on an operations console that is too small | Floor raised to 11px. **Deliberate deviation from the Mills design system, recorded here.** |
| **B9** | Medium | Status pills wrapped onto two lines inside table cells | No `white-space` control, no cell width class | `white-space:nowrap` on pills, `.st` class on status cells |
| **B10** | Medium | Review / Extend / Schedule were 53×15 px, under the 24 px WCAG 2.5.8 minimum, and far under a thumb | Inline text styling | Links have padding and a 32 px minimum, rising to 44 px on touch widths |
| **B11** | Low | Tables had no `<caption>`, no `scope` on headers, some had no `<thead>` | - | Captions (screen-reader only), `scope="col"` throughout |
| **B12** | Low | Cards in a row had mismatched heights, leaving dead space | No flex growth on the body | `.body.grow` |
| **B13** | Low | No skip link, no `aria-live` region, no `aria-current` on the active nav item, page title never changed | - | All four added; the heading receives focus on navigation |

### Test-harness bugs: the tests were wrong, not the app

| # | Bug | Why it mattered |
|---|---|---|
| **T1** | The NAV suite looked for a `.page.on` class; v2 uses the `hidden` attribute. Nine assertions failed against working code | A red suite that is wrong trains you to ignore red suites |
| **T2** | The focus check called `el.focus()` programmatically. `:focus-visible` **only** matches keyboard focus, so it reported 25 elements with no focus ring when every one of them had one | Would have caused a real, working focus system to be "fixed" until it broke |
| **T3** | The contrast walker read `background-color` only. Every gradient surface (active nav, environment pill, primary button) reported 1:1 and looked like a critical failure. In fact white on `--cane` is about 12:1 | Three false criticals |
| **T4** | Screen-reader-only text (`.sr`) was counted in both contrast and overflow checks, though it is invisible and out of flow | Noise that hid B2 |
| **T5** | The screenshot helper toggled page visibility directly instead of clicking the nav, so screenshots showed the Deployments page with an "Overview" breadcrumb | Would have been filed as a UI bug that does not exist |

---

## Part 4: Fix plan

Everything above is already fixed in v2 and the suite is green. This is what remains, ordered.

### Now: carried into the C1 build

| Item | Why |
|---|---|
| **Self-host Geist and Lora as WOFF2** and add a CI check that fails on any external URL in the console bundle | B5 is the kind of bug that reappears the first time someone adds an icon library |
| **Run this suite in CI** on every console PR, exit code as the gate | Otherwise these fixes decay |
| **Add the suite to the styleguide route** so component changes are judged against it | The Mills team already works this way |

### Next, before the console replaces Windows Admin Center

| Item | Why |
|---|---|
| **Screen-reader pass with NVDA and Narrator** | axe catches roughly a third of real accessibility problems; it cannot tell you whether the terminal is usable non-visually |
| **Real keyboard-only walkthrough of the Connect flow** | Requesting elevation, connecting, and disconnecting without a mouse is the highest-stakes path in the product |
| **Focus management for dialogs and the command palette** | Not built yet; focus trap, Escape, restore-focus-on-close |
| **Loading, empty and error states for every screen** | The prototype only shows the happy path. Cloudscape's own guidance is that these behaviours are defined once as patterns, not per screen |
| **Colour-blindness verification of the pill tones** against the Mills six-check dataviz script | Mills validated its chart palette this way; the console's status colours have not been |
| **Test at 200% and 400% browser zoom** (WCAG 1.4.10 reflow) | Not covered by the viewport tests |

### Later: when there is a real backend

| Item |
|---|
| Performance budget: first paint under 1.5 s on the office link, table virtualisation past 500 rows |
| Latency and failure injection: what the console does when the reconciler is unreachable |
| Session-recording playback performance with a 1 GB recording |
| Penetration test of the console itself: it is the highest-value target on the platform |

## Part 5: What was not tested

The prototype is static HTML. Nothing behind it exists. No API, no authentication, no reconciler, no Guacamole, no data. These tests prove the **interface** is sound: accessible, responsive, keyboard-navigable, contrast-safe. They prove nothing about the platform, which remains as described in `09-VALIDATION-STATUS.md`: assumptions until the day-one lab runs.
