# SideKiqq design system

**SideKiqq, it goes where you go.** (Short form: *It goes where you go.*)

Calm, competent, discreet: a great human chief of staff, not a toy. One accent (Signal) marks what needs
attention or the primary action. Alert is reserved for CRITICAL and overdue. Steady means done.

`design/tokens.json` is the single source of truth. Everything else is generated.

```bash
node design/build.mjs          # regenerate all outputs (zero dependencies, Node >= 18)
node design/build.mjs --check  # exit 1 if a committed output is stale (use in CI)
```

| Output | Used by |
|---|---|
| `design/dist/tokens.css` | Any web surface (marketing site, dashboard). CSS variables, light + dark. |
| `design/dist/tailwind-preset.cjs` | Tailwind v3 projects: `presets: [require(".../tailwind-preset.cjs")]` |
| `design/dist/kotlin/SideKiqqTheme.kt` | Phone and watch apps (Jetpack Compose). See "Compose theme". |
| `brain/design/tokens.css`, `brain/design/tailwind-preset.cjs` | Identical copies for the brain. Vercel builds with Root Directory = `brain`, so the brain can't import from `../design`. |

Commit the generated files together with any `tokens.json` change. Never edit them by hand.

## Tokens

**Brand colors** (exact values shared with the marketing site)

| Name | Hex | Role |
|---|---|---|
| Ink | `#0F1420` | Primary text; dark surfaces; nav rail |
| Paper | `#F6F4EF` | Light background; text on dark |
| Slate | `#5B6475` | Secondary text |
| Line | `#E2DED5` | Borders, dividers |
| Signal | `#E8A33D` | Accent: attention, the primary action. Text on Signal is Ink. |
| Steady | `#2F8F83` | Success, "done" |
| Alert | `#C2412D` | CRITICAL, overdue, destructive |

**Semantic colors** (`--sk-*`, switch with the theme): `bg`, `surface`, `surface-sunken`, `text`, `text-muted`,
`text-faint` (decorative only, below 4.5:1), `line`, `line-strong`, `accent` / `accent-text` / `accent-ink`
(Signal-tinted text that passes contrast on light backgrounds), `success*`, `danger*`, `focus`, `nav`, `nav-text`,
`nav-muted`, `scrim`.

**Importance** (always written out, never color alone)

| Level | Color | Variables |
|---|---|---|
| CRITICAL | Alert | `--sk-imp-critical-{fg,bg,rule}` |
| HIGH | Signal | `--sk-imp-high-*` |
| MEDIUM | Slate | `--sk-imp-medium-*` |
| LOW, FYI | muted Slate | `--sk-imp-low-*`, `--sk-imp-fyi-*` |

`fg` is text on `bg` (passes AA); `rule` is the full-strength bar or dot.

**Dark mode.** Ink background, Paper text. Follows the OS by default; `data-theme="light"` or `"dark"` on `<html>`
pins it. Tailwind's `dark:` variant follows the same rule, though most components need no `dark:` classes because
the semantic variables already switch.

**Type.** Space Grotesk (headings), Inter (body), JetBrains Mono (small data only: dates, counts, codes).
Scale in px (size/line): display 40/44, h1 30/36, h2 22/28, h3 17/24, body 15/24, small 13/20, data 12/16.
Tailwind: `text-display`, `text-h1` … `text-data`; `font-heading`, `font-body`, `font-mono`.
Fonts load from Google Fonts (URL in `tokens.json` → `font.googleFontsUrl`).

**Space** 4px grid (`space.1` = 4px … `space.16` = 64px). **Radius** sm 4, md 8 (controls), lg 12 (panels),
pill. **Motion** fast 120ms (hover, press), base 200ms (dialogs), slow 320ms; easing `cubic-bezier(0.2,0,0,1)`.
All drop to 0 under `prefers-reduced-motion`. **Layout** nav rail 232px, content max 880px, tab bar 64px,
touch target 44px minimum.

## Web components (owner dashboard)

Live in `brain/src/components/ui/`. Server components unless noted.

| Component | Use |
|---|---|
| `Button`, `ButtonLink`, `buttonClass()` | Variants `primary` (Signal, one per screen), `secondary`, `danger`, `ghost`; sizes `sm`, `md`. 44px tall. |
| `Card` | Panel with optional `title` and `aside`; `flush` drops padding so rows run edge to edge. |
| `Badge` | Importance badge (`importance="HIGH"`). `Tag` for neutral/success/danger/accent labels. |
| `ListRow` | One item in a `<ul className="divide-y divide-line">`: title, badges, detail, mono meta, actions, optional importance rule on the left edge. |
| `EmptyState` | Says what an empty list means and what to do next. |
| `ConfirmDialog` (client) | Native `<dialog>` modal. Focus starts on Cancel; Escape closes. Its confirm button alone carries `confirmName=confirmValue`, so the server can require it. Used for Approve and Discard. |
| `AppShell` + `SideNav` / `TabBar` (client) | Ink side rail on desktop; top bar plus bottom tab bar under 768px. Skip link, `aria-current`, counts with screen-reader labels. |
| `Segmented` | Link-based filter (state lives in the URL). |
| `PageHeader`, `Notice`, `CopyButton` (client) | Page title + lede; post-action status line (`role=status`/`alert`); clipboard copy. |

Accessibility floor: visible `:focus-visible` ring (`--sk-focus`), AA contrast for all text roles except
`text-faint`, 44px targets, works at 375px with no horizontal scroll, reduced motion respected.

## Compose theme (phone and watch)

`design/dist/kotlin/SideKiqqTheme.kt` gives `SideKiqqTheme { }` (wraps `MaterialTheme` with a mapped color scheme),
`SideKiqqTheme.colors` (all semantic colors plus `importance(level)`), `SkType`, `SkSpace`, `SkRadius`, `SkMotion`,
and `SkBrand` (raw colors and the tagline). It has not been compiled yet (no Android SDK in the build sandbox).

To adopt it:

1. Copy the file to `android/shared/src/main/kotlin/com/sidekiqq/ui/theme/SideKiqqTheme.kt` (or create an
   `android/shared-ui` module if `shared` should stay Compose-free; then add it to `settings.gradle.kts` and as a
   dependency of `:phone` and `:watch`). The module needs `androidx.compose.material3` and `compose.ui`.
2. Map the contract enum: replace the local `Importance` enum with the one in `com.sidekiqq.shared` (same values).
3. Fonts: set `HeadingFamily`, `BodyFamily`, `MonoFamily` from `androidx.compose.ui:ui-text-google-fonts` or
   bundled `res/font` files.
4. Phone: wrap the root `setContent { SideKiqqTheme { … } }`. Use `colors.importance(item.importance)` for badges
   and rules, `colors.accent` for the primary action.
5. Watch: Wear OS uses `androidx.wear.compose.material.MaterialTheme`. Wrap it with
   `CompositionLocalProvider(LocalSkColors provides SkDarkColors)` (watch is always dark) and map `accent`,
   `bg`, `surface`, `text` into the Wear `Colors`.
6. Re-run `node design/build.mjs` after any token change and copy the file again (or point a Gradle task at it).
