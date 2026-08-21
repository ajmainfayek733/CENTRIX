# Design system

The dashboard's visual language, derived from the prototype in `Frontend/prototype/index.html`.

That prototype is a single-file mock: nine `.page` divs toggled by a `showPage()` function,
hardcoded sample data, and `onclick` attributes. **None of its JavaScript was ported.** What was
taken is the visual system - surfaces, palette, type scale, spacing, motion - reapplied to the
real routes and real server data. `Frontend/prototype/styles.css` and `script.js` are unrelated
boilerplate (a five-line body rule and a UTC clock) and carry no design signal.

Everything below lives in [`Frontend/src/app/globals.css`](../../Frontend/src/app/globals.css)
and [`Frontend/src/components/ui/index.tsx`](../../Frontend/src/components/ui/index.tsx).

---

## The ground and the surfaces

Three depths, and which one a thing gets is a performance decision as much as a visual one.

| Layer | What it is | Where |
|---|---|---|
| `.spatial-bg` | Four stacked radial gradients over a linear base, `position: fixed` | Once, in the root layout |
| `.glass` | Translucent + `backdrop-filter: blur(28px) saturate(150%)` + inset highlight | Sidebar, topbar, login card, policy save bar |
| `--surface` | Translucent, **no blur** | Every card, tile, table |

`backdrop-filter` makes the compositor re-sample everything beneath the element on every paint.
That is affordable for two elements that never move. The prototype applies it to every card,
which on the Employees and Alerts screens would mean paying it once per card over a hundred
table rows. Cards use a plain translucent surface instead - the ambient gradient still tints
through, and over the same ground the two read almost identically.

`.spatial-bg` is fixed, not scrolled: the gradient is the room the cards sit in. Scrolling it
would turn a static backdrop into an unrequested parallax effect.

Both `prefers-reduced-transparency` and `prefers-reduced-motion` are honoured - the first drops
every glass surface to opaque and flattens the ground, the second cancels transitions.

---

## Colour: three families that never mix

The single most important rule here. Before this pass one `--brand` token meant both "primary
action" and "productive time", so a submit button and a productivity percentage wore the same
colour while meaning unrelated things.

| Family | Tokens | Means |
|---|---|---|
| Interactive | `--brand`, `--brand-vivid`, `--brand-strong` | "You can act on this" - links, nav, focus, buttons |
| Semantic | `--success`, `--warning`, `--danger`, `--info` | A reading about the data - never a control |
| Neutral | `--text-primary/secondary/tertiary`, `--border`, `--surface` | Structure |

### Why the interactive family has three tokens

The prototype uses `#0ea5e9` for links, nav, and button fills alike. Measured against the
ground's lightest stop (`#f0f9ff`) it is **2.60:1** as text, and **2.77:1** under white as a
button. Both fail WCAG AA by a wide margin, and most of the product's clickable text is these
links. So the one hue is split by job:

| Token | Light | Job | Contrast |
|---|---|---|---|
| `--brand` | `#0369a1` | Foreground: link text, active nav, icons | 5.57:1 |
| `--brand-vivid` | `#0ea5e9` | Graphic only: the logo gradient. **Never text** | n/a (logotype) |
| `--brand-strong` | `#0369a1` | Solid fills carrying `--brand-contrast` | 5.93:1 under white |

Dark mode inverts the problem and collapses the split: `#38bdf8` is legible on a near-black
ground (8.12:1), so foreground and graphic converge on it, and solid fills become a *bright*
button with near-black text rather than a dark button with white text.

`--success` splits the same way for the same reason: `--success` (`#15803d`, 4.70:1) labels
11.5px badge text, while `--success-vivid` (`#16a34a`, 3.09:1) fills status dots and bar
segments, where the 3:1 graphic threshold applies instead.

`--text-tertiary` was darkened from the prototype's `#7a9bb8` (2.73:1). That token carries every
table heading, tile label and muted cell in the product - it is not decorative text.

Colour is never the only signal. Status dots are always paired with text, productivity segments
always have their figures printed beside them, and nav icons always keep their label.

---

## Type

Inter, loaded through `next/font/google` - self-hosted, so there is no render-blocking request to
a third party and no layout shift. The prototype's `@import url(fonts.googleapis.com)` was not
carried over.

| Role | Spec | Component |
|---|---|---|
| Page title | 24px / 600 / `-0.5px` | `PageHeader` |
| Hero figure | 30px / 600 / `-0.9px` | `HeroPercent` |
| Tile value | 26px / 600 / `-0.7px` | `StatTile` |
| Label | 11px / 500 / uppercase / `0.06em` | Card titles, `Th`, tile labels |
| Body | 13.5px | `Td`, list rows |

`.tnum` (tabular figures) on every number compared down a column. Without it, proportional digits
make a column of durations unscannable.

---

## Components

`Frontend/src/components/ui/index.tsx` is the whole vocabulary. Hand-rolled rather than pulled
from a library so every element resolves its colours from the tokens above, keeping light and
dark in step without a second set of class names.

- **Containers** - `Card`, `PageHeader`, `SectionTitle`, `Notice`
- **Readings** - `StatTile`, `HeroPercent`, `Badge`, `TagBadge`, `SeverityBadge`, `StatusDot`
- **Tables** - `TableWrap`, `TABLE_CLASS`, `Th`, `Td`, `EntityCell`, `EmptyState`
- **Productivity** - `ProductivityBar`, `Legend`
- **Controls** - `Button`, `IconButton`, `Input`, `Field`, `Skeleton`

`TableWrap` bleeds to the card's edges (`-m-[18px]`) so the heading row's tint spans the full
width, which means it belongs to a table that is its card's only child - how every table in this
dashboard is arranged. `TABLE_CLASS` carries row hover and the borderless last row via
descendant selectors, because a `<tr>` cannot reliably paint a background across its cells.

`EntityCell` uses `next/link`. These cells are the main route into a detail screen, and a bare
`<a href>` would tear down the app shell and re-fetch it on every click.

---

## Shell

A 230px sticky rail plus a floating topbar, replacing the previous full-width top header.

Both the rail and the topbar are `sticky` against the **document** scroll. The prototype wraps
its content in an inner `overflow-y: auto` container; that looks identical until used, then
breaks scroll restoration between navigations and hides the page from the browser's own
find-in-page scrolling.

The prototype hides its sidebar entirely below 768px. Here the same links render inside the
topbar instead - dropping navigation on a phone leaves no way between screens. Exactly one of
the two navs is in the accessibility tree at any width, since `hidden`/`md:hidden` resolve to
`display: none`.

### Navigation is five items, not nine

The prototype's rail lists Departments, Attendance, Performance and Reports. The API behind this
dashboard exposes `overview`, `roster`, `employees/:id`, `employees/:id/activity`, `alerts`,
`usb-events` and `screenshots` - and nothing else (`Backend/src/modules/report/`). Departments
and Performance would be derivable from the roster; Attendance exists only inside employee
detail; Reports ("generate and download") has no endpoint at all. None were built, because a
monitoring tool that offers controls which do nothing is worse than one that offers fewer.

---

## What was deliberately not taken

| Prototype feature | Why not |
|---|---|
| Chart.js via CDN | Not a dependency here, and the two charts belong to screens that have no endpoint |
| Search pill in the topbar | There is no search endpoint - it would be a dead control |
| Notification bell + badge | No notification store exists to count |
| `[data-theme='dark']` | This app keys dark mode off a `.dark` class on `<html>` with a no-flash inline script; only the palette values changed |
| Nine-page SPA routing | Real App Router routes already exist |

---

## Related

- [README.md](README.md) - layout, server vs client components, data flow
- [resilience.md](resilience.md) - the degraded states these components render
- [../architecture/decisions.md](../architecture/decisions.md)
