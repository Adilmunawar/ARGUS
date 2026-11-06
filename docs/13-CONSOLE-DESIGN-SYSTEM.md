# Console design system

The visual language of the Argus Console. It replaces the earlier dark green, serif, document-style look with the conventions operators already know from the major cloud consoles: a white, dense, data-first interface where colour is reserved for actions and status.

The values come from the published design tokens of AWS Cloudscape (`@cloudscape-design/design-tokens` 3.0.117, Apache-2.0), read from the package, and from the long-standing conventions of the Google Cloud console. Argus uses its own name, mark and icons, and no AWS or Google branding.

## Principles

1. **White and grey carry the interface; blue carries action; red, green and amber carry status.** Nothing else is coloured.
2. **Status is never colour alone.** Every status is an icon plus a word.
3. **Data first.** A screen leads with the numbers and the list, not with paragraphs. Explanations sit behind a Details disclosure or in a help panel.
4. **One layout for the whole console.** Top bar, side navigation, breadcrumbs, flash area, page header, content. No screen invents its own chrome.
5. **One primary action per page header.** Other actions are normal or link buttons.
6. **Sentence case everywhere.** No exclamation marks, no "please", no ellipses, no ampersands.
7. **Every number says when it was read.** The "Read HH:MMZ" stamp stays.

## Tokens

Defined once as CSS custom properties in `assets/app.css`. Light is the default; dark applies with `prefers-color-scheme: dark` or the theme preference.

### Colour

| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg-page` | `#f9f9fb` | `#0f141a` | Page behind containers |
| `--bg-container` | `#ffffff` | `#161d26` | Containers, tables, modals, inputs |
| `--bg-topnav` | `#0f141a` | `#0f141a` | Top bar |
| `--bg-subtle` | `#f6f6f9` | `#1b232d` | Table header, shaded cells, code |
| `--bg-hover` | `#f3f3f7` | `#1b232d` | Row and item hover |
| `--bg-selected` | `#f0fbff` | `#001129` | Selected row, active nav item |
| `--border` | `#c6c6cd` | `#424650` | Dividers, container outline |
| `--border-subtle` | `#ebebf0` | `#232b37` | Row dividers |
| `--border-control` | `#8c8c94` | `#656871` | Inputs, checkboxes |
| `--text` | `#0f141a` | `#dedee3` | Body and headings |
| `--text-secondary` | `#424650` | `#c6c6cd` | Descriptions, column headers |
| `--text-muted` | `#656871` | `#a4a4ad` | Counters, labels, breadcrumbs current |
| `--text-on-dark` | `#f9f9fa` | `#f9f9fa` | Top bar text |
| `--accent` | `#006ce0` | `#42b4ff` | Links, primary button, focus, selection |
| `--accent-hover` | `#002b66` | `#75cfff` | Hover of the above |
| `--on-accent` | `#ffffff` | `#0f141a` | Text on primary button |
| `--success` | `#00802f` | `#2bb534` | Success text and icon |
| `--error` | `#db0000` | `#ff7a7a` | Error text and icon |
| `--warning` | `#855900` | `#fbd332` | Warning text and icon |
| `--info` | `#006ce0` | `#42b4ff` | Info text and icon |
| `--inactive` | `#656871` | `#a4a4ad` | Stopped, unknown, pending text and icon |
| `--success-bg` | `#effff1` | `#001401` | Success alert background |
| `--error-bg` | `#fff5f5` | `#1f0000` | Error alert background |
| `--warning-bg` | `#fffef0` | `#191100` | Warning alert background |
| `--info-bg` | `#f0fbff` | `#001129` | Info alert background |

### Type

- Family: `"Open Sans", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Roboto, Arial, sans-serif`. No web font is downloaded; the console uses whichever of these is installed.
- Monospace: `Monaco, Menlo, Consolas, "Courier New", monospace`, only for identifiers, IPs, hashes, timestamps in tables, code and logs.

| Role | Size / line height | Weight |
|---|---|---|
| Page title (h1) | 24 / 30 | 700 |
| Container title (h2) | 18 / 22 | 700 |
| Section title (h3) | 16 / 20 | 700 |
| Sub-section (h4) | 14 / 18 | 700 |
| Body | 14 / 20 | 400 |
| Small (descriptions, help, constraints) | 12 / 16 | 400 |
| Key figure on a dashboard | 32 / 40 | 300 |
| Counter "(12)" beside a title | same as title | 400, `--text-muted` |

Never below 12px. Column headers are 14px 700 `--text-secondary`.

### Space

4px base. `--s-xxs 4`, `--s-xs 8`, `--s-s 12`, `--s-m 16`, `--s-l 20`, `--s-xl 24`, `--s-xxl 32`, `--s-xxxl 40`. Comfortable is the default; compact (the density preference) moves `--s-s` to 8, `--s-m` to 12, `--s-l` to 16 and control height from 32 to 28.

### Shape

- Radius: buttons 20 (pill), containers and modals 16, inputs, dropdowns and menus 8, alerts 12, badges 4.
- Borders: 1px for layout and dividers; 2px for buttons and alerts.
- Shadows only on things that float: dropdowns, menus, modals, the sticky table header and flashes. Containers have a 1px `--border-subtle` outline and a faint shadow `0 1px 2px rgba(15,20,26,.06)`.
- Focus: 2px `--accent` outline with 2px offset, radius matching the element.

## Layout

```
┌───────────────────────────────── top bar (48px, --bg-topnav) ──────────────────────────────┐
│ ◉ Argus   [ Search resources, screens and actions   Ctrl K ]     Sandbox · Live  ? ⚙ 🔔 AO │
├──────────────┬──────────────────────────────────────────────────────────────────────────────┤
│ side nav     │ Breadcrumbs: Argus / Compute / Instances                                     │
│ 240px, white │ flash area                                                                   │
│              │ Page title (24/30)  (counter)                     [Normal] [Normal] [Primary]│
│ Group label  │ One-line description (14, secondary)                                         │
│  Item        │ ──────────────────────────────────────────────────────────────────────────── │
│ ▌Active item │ content: containers on a 20px grid, padding 40px (24px under 1200px)          │
│  Item        │                                                                              │
└──────────────┴──────────────────────────────────────────────────────────────────────────────┘
```

- **Top bar**: 48px, dark, full width, fixed. Left: the Argus mark and name. Centre: the search field, 480px wide at most, white text on a slightly lighter dark field with a 1px border. Right: environment as plain text, the data source as a small status indicator, help, settings, notifications with a count badge, account menu showing initials, name and role.
- **Side navigation**: 240px, white, 1px right border, scrolls independently, collapsible to a 56px icon rail with labels as tooltips. Group labels 12px 700 uppercase `--text-muted` with 0.04em tracking. Items 14px, 32px tall, 8px radius, `--text` with a 16px icon; hover `--bg-hover`; active `--bg-selected`, `--accent` text and icon, 700, with a 4px accent bar on the left. Count badges right-aligned: red pill for errors, grey pill otherwise.
- **Breadcrumbs**: 14px, links in `--accent`, separator a chevron in `--text-muted`, current page `--text-muted` and not a link. Always shown, including on the dashboard ("Argus / Overview").
- **Page header**: h1 with an optional counter, a one-line description below in 14px secondary, actions right-aligned on the title line, 8px apart, at most one primary. 16px below the header before content.
- **Flash area**: under the breadcrumbs. Flashes are full-width bars, 12px radius, filled: success `--success`, error `--error`, info `--accent`, warning `#fbd332` with dark text; white text otherwise; icon, bold title, message, optional action button, dismiss.
- **Content**: fluid width; grid gutter 20px.

## Components

- **Button**: height 32 (28 compact), padding 0 20, radius 20, 14px 700. *Primary*: `--accent` fill, `--on-accent` text, hover `--accent-hover`. *Normal*: white fill, 2px `--accent` border, `--accent` text, hover `--bg-selected` fill and `--accent-hover`. *Link*: no border or fill, `--accent` text. *Icon*: 32px square, transparent, `--text-secondary` icon. *Danger* is a normal button whose confirm dialog uses a primary button labelled with the verb; red fill is not used. Disabled: `--bg-subtle` fill, `--text-muted` text, no border.
- **Container** (`ui.card`): white, 16 radius, 1px `--border-subtle`, faint shadow. Header 20px padding top and sides: h2 18/22 with optional counter, optional description in 14 secondary, actions right. Body 20px padding. Optional footer separated by a 1px `--border-subtle` divider. Containers stack with 20px between them.
- **Key value pairs** (`ui.dl`): a responsive grid of 1 to 4 columns with 1px `--border-subtle` column dividers. Label 14px 700 `--text`, value 14px below it, 16px between pairs. Never a two-column table.
- **Status indicator** (`ui.pill` becomes this): a 16px icon plus text, no background. Success: green check in a circle. Error: red cross in a circle. Warning: amber triangle with a bang. Info: blue "i" in a circle. Pending or in progress: grey clock or spinner. Stopped or unknown: grey hollow circle. Text in the status colour except stopped or unknown, which are `--text-muted`. A *badge* (count or label chip, 4 radius, 12px 700) is separate and used only for counts and tags.
- **Table**: inside a container, edge to edge. Header row `--bg-subtle`, 14px 700 `--text-secondary`, 1px `--border` bottom; sort icon beside the label, shown always for the sorted column and on hover for others. Rows 14px, padding 10px 20px (8px 16px compact), 1px `--border-subtle` dividers, hover `--bg-hover`, selected `--bg-selected` with a 2px left `--accent` bar. First column is the resource name as a link. Status columns use the status indicator. Numbers right-aligned in tabular figures. Above the table, in the container header: title with counter "(n)", actions, then a full-width filter field and pagination right-aligned. Empty: a centred "No resources" title, one line, one action. No match: "No matches" plus "Clear filter".
- **Tabs**: a row of 14px 700 labels in `--text-secondary`, 1px `--border` bottom; active label `--accent` with a 4px accent underline; hover `--text`. Tabs sit between the page header and the content, not inside a container.
- **Alert** (`ui.stateBlock`, callouts): 12 radius, 2px border in the status colour, the status background, icon, bold title, body text. Used inline for one panel's state. The "Not in this stack" state is an info alert.
- **Filter field**: 32px, 8 radius, 1px `--border-control`, a search icon, placeholder "Find resources". Tokens are badges with a remove button.
- **Modal**: 600px (800 wide), 16 radius, shadow `0 4px 20px rgba(15,20,26,.25)`, header h2 with close button, body 20px, footer with right-aligned buttons and a 1px divider.
- **Dashboard tiles** (`ui.statTile`): a container with a small label (14px 700 `--text-secondary`), the key figure (32/40 300), a status indicator or unit, and a footer link. Tiles sit in a 2 to 4 column grid.
- **Skeleton**: `--bg-subtle` bars with a gentle pulse that stops under reduced motion.
- **Charts**: a single accent line or bar per series; grid lines `--border-subtle`; axis labels 12px muted.

## Screen patterns

- **Dashboard** (Overview): header with no actions; a row of four key-figure tiles; then a two-column grid: "Needs attention" list and "Service health" table on the left, "Recent activity" and "Resources" on the right. No prose.
- **Resource list** (Applications, Instances, Buckets, Runbooks, Principals, Audit): page header with title and counter and actions; one container holding the filter, the table and pagination.
- **Resource detail** (an application, an instance, a bucket, a runbook): breadcrumbs to the list; page header with the resource name, its status indicator, and actions; tabs (Details, the resource's own sections, Monitoring, Activity); the Details tab is a key value container followed by related-resource containers.
- **Not in this stack**: one info alert per screen listing what is absent, at the bottom of the content.

## Accessibility

WCAG 2.2 AA in light, dark and forced colours: text at least 4.5:1, status icons and focus at least 3:1, targets at least 24px (44px under 768px wide), visible focus on every control, and no information carried by colour alone.
