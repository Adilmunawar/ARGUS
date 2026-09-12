# Console stress testing, the performance findings, and the fix plan

Written 9 September 2026 against prototype v3, after a four-way parallel audit and a new measurement harness. Everything in Part 2 was measured, not reasoned about. Everything in Part 3 was reproduced in a browser before it was written down.

---

## Part 1: Why the existing suites could not answer "why is it slower"

The console already had two harnesses, and both are good at what they do:

| Harness | Asks | Blind to |
|---|---|---|
| `tests/run-tests.js` | 163 assertions: does the interface hold its properties? | anything that only appears at volume or over time |
| `tests/sandbox.js` | presses every control in nine environments | cost — it never looks at a clock or a counter |

Neither ever inflated the dataset, and neither read a performance counter. So a console that renders in 5 ms against 7 fixture rows and 500 ms against 5,000 real ones passes both suites identically. `tests/stress.js` is the third harness, and it exists to close exactly that gap.

### What it measures, and why those five numbers

"Slower" is not one thing. It decomposes into five, all read from the DevTools protocol rather than estimated:

- **`Nodes`** — live DOM nodes. Rising across navigations means the console is retaining screens it has left.
- **`JSEventListeners`** — registered listeners. Rising means teardown is missing something.
- **`JSHeapUsedSize`** after a forced collection — the only honest heap figure.
- **`RecalcStyleCount` / `LayoutCount`** — thrash, as distinct from work.
- **script time** — the console's own cost, bracketed precisely.

### One measurement trap worth recording

The first version of the harness timed a navigation by setting `location.hash` and waiting for a frame callback. Every route came back at ~31 ms — because assigning `location.hash` fires `hashchange` on a *later* task, so what was being measured was two frames at 60 Hz, not the console.

The fix is `history.replaceState` (which changes the hash without firing the event) followed by a synthetic `dispatchEvent`, which runs the shell's `render` synchronously on the caller's stack. Layout and style are charged separately from `LayoutDuration` and `RecalcStyleDuration`, because they are not on that stack. **A benchmark that returns the frame clock for every input looks precise and is worthless.**

A second trap, in the same spirit: measuring only the ten top-level routes made `security` look free — 3.9 ms at every multiplier — because its default tab is Posture, which reads a fixed 7×7 object and no row collection at all. Every table that would carry thousands of rows in production lives one segment deeper. The harness now names 28 views explicitly, and asserts that each one actually resolved to a heading rather than silently timing an error state.

### The suites

```
SCALE     render cost per view at 1x, 10x, 50x, 200x, and the scaling exponent
LEAK      a 200-navigation tour, sampling nodes, listeners and heap
SUSTAIN   one screen used hard: 40 sorts, 60 tab switches, without navigating
FLASH     one notification per navigation, across a working session
SOAK      dwelling on a screen that runs a timer
INTER     interaction latency at the largest multiplier
SEARCH    command-palette typing latency at 200x inventory
PLAYER    the session player: scrubber geometry, and repaint cost while scrubbing
SCROLL    frame timings down a 50x table, and the two CSS declarations that cost a frame
PAINT     style recalculations and layouts per render
PARA      the whole thing again in parallel contexts, on a busy machine
```

Budgets live in `BUDGET` at the top of the file and are asserted, not printed. Exit code is the failure count, so CI can gate on it.

---

## Part 2: What the numbers actually said

### Navigation does not leak. That was the surprise.

```
LEAK, 200 navigations across all ten routes:
  live DOM nodes          0 per navigation      (663 -> 663)
  registered listeners    0 per navigation      (29 -> 29)
  JS heap                 0.87 KB per navigation
```

The `A.onLeave` teardown hook works exactly as its comment claims. The obvious suspect is innocent, and ruling it out with a number is worth as much as finding a bug.

### Rendering is linear in the data. Also good.

Script milliseconds to build a screen:

| view | 1× | 10× | 50× | 200× | exponent |
|---|---|---|---|---|---|
| overview | 4.9 | 8.7 | 17.2 | 49.1 | 0.42 |
| apps | 7.6 | 28.6 | 120.5 | 471.7 | 0.78 |
| audit | 5.0 | 23.3 | 99.3 | 404.8 | 0.83 |
| security/alerts | 5.1 | 23.1 | 111.3 | 371.6 | 0.82 |
| identity/secrets | 7.6 | 28.9 | 119.4 | 538.9 | 0.80 |
| compute | 7.2 | 26.8 | 126.1 | 592.8 | 0.83 |

Every exponent is below 1. Nothing in the default render path is quadratic; the sub-linear figures are fixed overhead dominating at 1×. At 200× the dataset — roughly 1,400 audit rows, 1,200 alerts — the worst screen costs ~590 ms of script plus ~136 ms of layout. That is slow, but it is *honestly* slow: linear work on a lot of rows, not an accident.

### Three things that genuinely degrade

**1. Notifications are never cleared. Measured: one kept per navigation, forever.**

```
FLASH, 60 navigations each raising one notification:
  1.0 kept per navigation; 60 still on screen after 60
  677 live nodes added
```

`render()` clears the mount and the breadcrumb on every navigation and never touches the flash host, and 38 of the 41 `A.flash` call sites omit the optional timeout. Every confirmation an operator triggers stays on screen for the life of the tab, above every screen, each one a bordered box-shadowed node pushing the content down. This is the single clearest answer to "why does it get slower and more cluttered the longer I leave it open", and it is one line to fix.

**2. Tab switches retain nothing. This one was a bug in the harness, and it is the most instructive entry here.**

The first version of SUSTAIN reported 34,644 retained nodes on `identity/grants` and 39,412 with 2,961 listeners on `security/posture`. It survived a forced collection, it survived five, and it dropped only when the route changed — every check I could think of said "real leak", and the plan called for restructuring tab teardown around it.

It was measuring two different screens. Sixty alternating clicks finish on the *second* tab, so the "after" reading was taken with Security's Alerts panel — 1,200 rows at 50× — sitting on screen, and the harness reported the size of that panel as retention. Ending the loop where it began gives the true figure:

```
security/posture, 60 tab switches at 50x, both readings on the same panel:
  baseline (Posture)           621 nodes,  87 listeners
  peak    (Alerts on screen) 10,332 nodes, 798 listeners
  settled back on Posture      621 nodes,  87 listeners   <- 0 retained
```

**A harness that compares two different states and calls the difference a leak is worse than no harness**, because it sends you refactoring something that was already correct. The same trap was live in two other places once it was known to look for it: the FLASH suite ended its tour on a different route than it started, counting the difference between two screens as notification growth, and the SOAK suite sampled without collecting in between, so a countdown rewriting its own text once a second read as 4 nodes per second of growth while the same run's post-collection figure said zero retained. All three now begin and end in the same state.

The teardown work the false finding prompted was kept, because it is correct on its own terms — a panel that starts a timer should stop it when it is replaced, and `ui.tabs` now scopes and drains exactly what its panel registered. But it fixed a real-if-small thing, not the large thing the number claimed.

**3. Changing the timezone costs a full navigation, and closes the dialog it was changed in.**

```
INTER at 200x:  switching timezone   476.7 ms   (budget 220)
```

`A.setTimezone` calls `render()`, which calls `A.dismissOverlays()` — so flipping one radio in the preferences dialog rebuilds the entire screen, dismisses the panel the operator is standing in, yanks focus to the page heading and scrolls to the top. Its two siblings in the same dialog, `setTheme` and `setDensity`, each change one attribute and cost nothing.

### Under contention the numbers hold

Three consoles driven at once stayed error-free, and no view drifted beyond 6× of itself. The figures above are not an artefact of an idle machine.

---

## Part 3: The audit findings

Four audits ran in parallel over the shell, the screens, the performance profile, and the accessibility and security claims. Each finding below was reproduced in a browser.

### Critical — the console is broken for a real operator

| # | Finding | Where |
|---|---|---|
| **C1** | With the rail collapsed, **all ten navigation buttons have no accessible name**. The icons are `aria-hidden` and `display:none` on `.lbl` removes the label from the accessibility tree. This is live at any viewport ≤1200px — including the 1024 and 768 widths the suite itself tests — and for anyone who has ever pressed Collapse, since the choice persists. | `app.css:118,161` |
| **C2** | **The mobile navigation drawer cannot be tapped.** `.scrim` is `z-index:100`, `.side` is `95`, both in the root stacking context, so the scrim paints over the drawer. Every tap lands on the scrim and closes it. Keyboard still works, which is why no suite caught it: the NAV tests navigate by assigning `location.hash`. | `app.css:167`, `components.css:280` |
| **C3** | **A deployment can never be rejected.** `ui.btn` captures `disabled` as a boolean at construction; the reject dialog mutates `opts.disabled` afterwards, which nothing reads. The button flips its class and `aria-disabled` to look enabled, then swallows the click. | `deploys.js:288` |
| **C4** | **A waiver can never be added**, for two independent reasons: the dialog calls `getElementById` for fields that are not in the document yet, so no listener is ever attached; and the submit is inert by the same mechanism as C3. | `security.js:435` |

### High

| # | Finding | Where |
|---|---|---|
| **H1** | One `Escape` closes a dialog *and* kills the recorded session, because the focus trap calls `preventDefault` but not `stopPropagation`. Precisely the failure the drawer exists to prevent. | `app.js:141,933` |
| **H2** | A nested dialog inherits the *outer* dialog's opener, so closing it strands focus on a control behind the still-open modal. Focus then escapes the trap entirely and the first dialog cannot be closed by keyboard. | `app.js:165` |
| **H3** | The elevation banner is a `role="status"` whose countdown rewrites its own text every second — a screen reader re-reads the whole banner once a second for the final minute of every grant. The file header specifically warns against this. | `app.js:635,643` |
| **H4** | Applications ignores `params.tab`, so its own row menu links ("Logs", "Deploy history") all land on Overview. | `apps.js:751` |
| **H5** | The session scrubber is a 16px control, and its keystroke markers are positioned against the page rather than the track, so they point nowhere. | `security.js:533`, `components.css:411` |

### Medium

| # | Finding | Where |
|---|---|---|
| **M1** | `fmt.dur` renders **"1 h 60 min"** — `Math.floor` for hours, `Math.round` for minutes. Live on the elevation countdown for ~30 seconds of every grant. | `ui.js:98` |
| **M2** | Descending sort is `ascending.reverse()`, so rows with no value float to the top instead of sinking. | `ui.js:268` |
| **M3** | `SEVERITY_RANK[x] \|\| 9` — `critical` is rank `0`, and `0 \|\| 9` is `9`, so **critical sorts below low**. The tile reports the wrong worst severity and the critical alert lists under the high one. | `overview.js:26` |
| **M4** | The posture grid paints not-applicable cells as red failures, contradicting its own footnote and the dialog behind the cell. `ui.heatgrid` already renders `null` as n/a; the callback never consults `isApplicable`. | `security.js:181` |
| **M5** | A critical alert renders in the `warn` (amber) callout on Overview, and a failed pipeline likewise on ML, while the same facts are red in the tables below. | `overview.js:87`, `ml.js:75` |
| **M6** | Three live text sizes below the 11px floor the console set for itself, and the TXT suite structurally cannot see any of them: it scopes to `#main *` (missing the rail and the palette) and skips on `!n.offsetParent`, which is `undefined` on every SVG element. | `app.css:110`, `components.css:195,308` |
| **M7** | The touch block's comment says 44px; every value in it is 30px, and it *shrinks* `.btn` and `.heatcell` by 2px from their desktop size. | `components.css:427` |
| **M8** | Callouts carry severity in colour alone — no glyph, no role — unlike every pill in the console. | `components.css:248` |
| **M9** | `role="link"` on `<tr>` replaces the implicit `row` role, so those rows are no longer rows of their table and their cells lose header association. | `ui.js:286` |
| **M10** | Freshly rotated credentials are flagged amber: a fixed 10-day window applied to a 1-day policy makes `0 > -9` true. | `identity.js:489` |
| **M11** | The log Live/Paused toggle changes its label, its `aria-pressed` and announces "Log view is live" — and does nothing. `live` is assigned and never read. | `apps.js:475` |
| **M12** | A danger "Fail over" action is offered for PostgreSQL databases directly above the screen's own text explaining they have no replica to fail over to. | `data.js:618` |
| **M13** | The host page's VM tile contradicts the table beneath it (hv-01: tile 7, table 4) and the same stale number is quoted as the blast radius when draining a host. | `compute.js:303` |
| **M14** | `requestElevationDialog` sets `submit.disabled = true` natively, dropping the button from the tab order and hiding the `title` that is the only explanation of why it is unavailable — reintroducing B7. | `identity.js:312` |

### Performance findings, by expected impact

| # | Finding | Complexity | Hurts at |
|---|---|---|---|
| **P1** | Flash bar never cleared (measured above) | unbounded | ~15 notifications |
| ~~P2~~ | ~~Tab switches retain panels~~ — withdrawn, this was a harness defect (see Part 2) | — | — |
| **P3** | `setTimezone` full re-render (measured above) | = a navigation | any large screen |
| **P4** | Session player: `keys.indexOf(k)` inside a loop over `keys`, repainted at up to 60 Hz while scrubbing | O(K²) per repaint | K ≈ 300 keystrokes |
| **P5** | Table sort recomputes the sort key 2·n log n times and calls `localeCompare` per comparison | heavy constant | n ≈ 500 rows |
| **P6** | `appByName` / `personName` are `.filter()[0]` linear scans called once per row | O(D × (A+P)) | D ≈ 500 |
| **P7** | Command palette rescores and fully sorts the entire inventory on every keystroke | O(N log N) per key | N ≈ 5,000 |
| **P8** | `ui.graph` layering has no convergence check; its text alternative is `.filter()[0]` per edge | O(N×E) | N ≈ 200 |
| **P9** | `ml.downstreamOf` is a fixpoint relaxation, called per failed asset | O(F × P² × U) | P ≈ 200 |
| **P10** | `background-attachment: fixed` on a radial gradient, plus `backdrop-filter: blur(10px)` on the sticky top bar — two per-frame costs stacked on the same region | per scroll frame | always |
| **P11** | Filter tokens rebuild the whole table, which also **silently resets the operator's chosen sort** | O(subtree) | n ≈ 500 |
| **P12** | Two listeners per row, re-created on every paint, where one delegated listener would do | O(n) churn | n ≈ 2,000 |

---

## Part 4: The fix plan

Ordered by what an operator loses if it is not fixed.

**Stage 1 — the console is broken.** C1, C2, C3, C4. A navigation with no accessible names, a drawer that cannot be tapped, and two actions that can never be completed.

**Stage 2 — it lies or loses work.** H1, H2, H4, M2, M3, M4, M5, M11, M12, M13, and the audit CSV's ordering claim. Every one of these makes the console assert something untrue.

**Stage 3 — it degrades.** P1 and P3 first, because those are measured and each is small. Then P5, P6, P10, which together carry most of the cost at volume.

**Stage 4 — accessibility debt.** H3, H5, M1, M6, M7, M8, M9, M10, M14.

**Stage 5 — headroom.** P4, P7, P8, P9, P11, P12. None of these hurt at today's fixture scale; all of them will at production scale.

**Stage 6 — close the blind spots that let these through.** The TXT suite's `#main`-only scope and its `offsetParent` skip; a NAV suite that clicks rather than assigning `location.hash`; the stress harness in CI with its budgets as the gate.

---

## Part 5: What was done, and what the numbers say now

Stages 1 to 4 are implemented. The suites: 231/231 property checks, 122/122 sandbox checks across nine environments, and 168/168 stress budgets.

The four critical defects are fixed and each was verified by driving the browser, because none of them was visible to the suites that were already passing: the collapsed rail keeps its accessible names (clipped, not `display:none`), the mobile drawer sits above its own scrim and navigates on tap, a deployment can be rejected, and a waiver can be added.

What the performance work bought, script milliseconds to build a screen at 200× the dataset:

| view | before | after |
|---|---|---|
| identity/secrets | 538.9 | 350.1 |
| compute | 592.8 | 438.6 |
| apps | 471.7 | 360.4 |
| audit | 404.8 | 351.2 |
| data/queues | 381.3 | 274.6 |
| security/alerts | 371.6 | 319.2 |

Roughly a quarter to a third off the worst screens, from four changes: one cached `Intl.Collator` and one `Intl.NumberFormat` per shape instead of one per call; decorate-sort-undecorate, so a sort key is computed once per row rather than twice per comparison; `Object`-backed indexes behind `appByName`, `vmByName` and a new `personByUpn` in place of `.filter(...)[0]`; and dropping `background-attachment: fixed` and the sticky `backdrop-filter`, which were two per-frame costs stacked on the same strip of screen.

Descending sort now negates the comparator instead of reversing the list, so rows with no value stay at the bottom in both directions rather than floating to the top of a "largest first" sort — a correctness fix that came out of the same rewrite.

Notifications now expire on a schedule keyed to severity and the bar holds at most five, and cancelling a notification cancels its timer, so a dismissed one is released immediately rather than being held by a pending closure for up to half a minute.

## Part 6: Stage 5 and the rest, and what they measure at

Stage 5 is implemented, and each item now has a suite defending it rather than an argument.

| Was | Now | Measured |
|---|---|---|
| Session player repainted with `keys.indexOf(k)` inside a loop over `keys`, at up to 60 Hz while scrubbing | binary search for the playhead, index walk for the log, one attach | scrubber repaint **0.8 ms worst** over 41 positions |
| Palette concatenated, lowercased twice and fully sorted the entire inventory per keystroke | haystack precomputed per open, bounded top-40 insertion, one attach | keystroke **4.6 ms worst at 200×** inventory, and later keys cheaper than early ones |
| `ui.graph` always ran one layering pass per node, and its text alternative scanned `nodes` twice per edge | relax until depths settle; one index | — |
| `ml.downstreamOf` was a fixpoint relaxation called per failed asset | reverse adjacency map, one BFS | — |
| Two listeners per row, re-created on every paint | one delegated pair on the tbody | — |
| Rows appended one at a time into a live tbody | built in a fragment, attached once | — |
| A filter token rebuilt the whole table **and silently reset the operator's sort** | `setRows` keeps the instance, the thead and the sort | — |
| Runbook transcript read `scrollHeight` after every appended line, and grew without bound | capped at 500 lines, scrolled without reading layout | — |

Alongside them, the accessibility debt from Stage 4 is closed: the scrubber markers were positioned against the page rather than the track and are now **0 of 6 outside a 1,114 px track**; the playhead had no sizing rule at all and rendered ~16 px, now **24 px** and 44 on touch; the drawer's height and the space reserved for it are one expression instead of two that disagreed below 565 px of viewport; the elevation countdown no longer re-announces the whole banner every second inside a `role="status"`; a menu's Tab returns focus to its trigger instead of the skip link at the top of the page; closing the mobile drawer hands focus back to the burger; the rail button states the action it will actually perform on boot, not only after a click; and the not-found screen now clears the breadcrumb, moves focus and announces itself like any other screen.

Three deep-link parameters the console has always emitted are finally consumed: `#/security/alerts?id=`, `#/identity/grants?id=` and `#/identity/secrets?path=` now mark, reveal and announce the row they name, instead of opening the right tab and leaving the operator to find it.

And the falsy-zero family is gone: a checkpoint taken within the last minute no longer reads as "no replica", `ratioPct(null)` reports missing rather than a confident `0.0%`, and a zero-weight timeline segment no longer renders full width.

## Part 7: The colour-blind verification, which had been outstanding since v2

`11-CONSOLE-UX-BENCHMARK-AND-BUGS.md` has carried "colour-blindness verification of the pill tones" as an open item. It is now done, computed rather than eyeballed, against the console's own status tokens:

```
status ink, light  (--ok #046c4e, --warn #92400e, --bad #991b1b, --info #075985, idle #4c5a52)
  worst adjacent pair   bad <-> warn    deltaE 2.9 deutan · 4.0 tritan · 6.7 normal vision
  contrast vs surface   all five >= 3:1
status ink, dark
  worst adjacent pair   bad <-> warn    deltaE 6.6 deutan
```

**The two states that matter most in an operations console are close to indistinguishable by hue.** A deuteranopic delta-E of 2.9 is not a near miss; the threshold for "tell these apart at a glance" is around 8, and 15 for normal vision.

That is not a reason to repaint the palette — it is the reason the console's own rule exists. "Colour is never the only signal. Every status pill carries a glyph" is load-bearing, not decorative, and the right response to this measurement is to find every place that was breaking it. Two were left after the earlier passes:

- **Callouts** carried severity in background and border alone. They now carry the same geometric glyph vocabulary the pills use.
- **Toned bars** — the utilisation bar over 85%, and cache memory pressure — put "this has crossed a threshold" in hue alone. The number beside the bar says 87%; nothing said 87% was over the line, and the accessible label did not mention the tone either. A toned fill now carries a diagonal texture and names its threshold in the label.

The heat grid was already safe (every cell carries its score as text, and not-applicable carries a hatch), as were the plan diff (`.sr` "changes from"/"to" plus a line-through) and the rollout progress bar (a real `progressbar` with `aria-valuetext`).

One related gap closed at the same time: there was no `scroll-padding-top` anywhere, so the 46px sticky top bar could cover a control the browser had just scrolled focus to. Chromium's own sequential-focus behaviour happened to keep it clear, which meant WCAG 2.4.11 was being held by the browser rather than by the stylesheet. It is now stated.

## Part 8: What is still not tested

The prototype remains static HTML with no backend, so none of this says anything about the platform. Specific to the measurements above:

- Real browser zoom at 200% and 400%, as opposed to viewport emulation.
- A screen-reader pass with NVDA and Narrator. Several findings here (H3, M8, M9) are about what an assistive technology *says*, and only a real one can settle it.
- Firefox and Safari. Sticky-header focus obscuring came out clean in Chromium, but it is held by browser behaviour rather than by anything in the stylesheets — there is no `scroll-padding-top` anywhere.
