# Brand

## Name and tagline

**S.A.L.T. Report Workbench**: *Field-ready SALT reporting with real-time LAN sync.*

The name stays literal on purpose: SALT (Size, Activity, Location, Time) is the
doctrinal report format operators already know, and "workbench" says it's a tool
you work in, not a dashboard you watch.

## Mark

Four rounded report lines stacked like a SALT report: Size, Activity, Location,
Time. The Location line is blue and ends on a grid reticle, because a report is
only as useful as where it says the thing is. A faint map grid sits behind it.

| File | Use |
| --- | --- |
| `logo.svg` | Primary mark. Carries its own dark tile, so it reads on any background. |
| `logo-mono.svg` | One color via `currentColor`; inherits text color when inlined. |
| `logo-mono-white.svg` | One color, white ink, for dark backgrounds. |
| `icon.svg`, `icon-512.png` | Full-bleed square for avatars; GitHub applies its own crop. Content sits inside the circle-safe zone. |
| `banner-dark.svg`, `banner-light.svg` | README header, swapped by color scheme. |
| `social-preview.svg`, `social-preview.png` | 1280×640 repository social card. |

Keep clear space of at least one report-line height (≈9% of the mark) on every side.
Don't recolor the Location line, rotate the mark, or add effects.

## Palette

Taken from the app's own CSS variables, so the brand and the product match.
The one exception is the background of the brand assets, a touch lighter than
the app's pure black so the mark doesn't vanish against dark pages.

| Role | Name | Hex |
| --- | --- | --- |
| Asset background | Night | `#0B0B0D` |
| Surface | Panel | `#1C1C1E` |
| Primary / Location | Signal Blue | `#0A84FF` |
| Online / success | Go Green | `#32D74B` |
| Viewer / BDA | Amber | `#FF9F0A` |
| Destructive | Alert Red | `#FF453A` |
| Text | Fog | `#F5F5F7` |
| Secondary text | Slate | `#8E8E93` |

## Typography

- **Interface and headings:** the platform system UI stack (SF Pro, Segoe UI,
  Roboto), so the app looks native and needs no font files offline.
- **Grids, codes, and report text:** a monospace stack (SF Mono, Consolas,
  Cascadia Mono), so MGRS coordinates line up and read unambiguously.

## Voice

Terse, operational, exact. Say what happens and when, in the order an operator
needs it. Prefer verbs over adjectives and specifics over claims: "syncs to
every connected browser within a second" beats "lightning-fast sync". No
marketing gloss, no military cosplay.
