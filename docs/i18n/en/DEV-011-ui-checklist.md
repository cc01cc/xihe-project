---
title: DEV-011 - UI Visual Checklist
category: dev-guide
lang: en
sidebar_group: "Developer Guide"
sidebar_order: 11
created: 2026-05-31
updated: 2026-11-10
status: active
---

# UI Visual Checklist

> PRs involving UI changes must verify each item in this checklist. Issues found are from actual E2E screenshot reviews.

## 1. Page Rendering

- [ ] Page has no blank/white screen (Vue inline template not rendering → must use SFC)
- [ ] Title and subtitle text display correctly
- [ ] Form field labels align with input boxes
- [ ] Button text/icons are fully readable
- [ ] **Two-surface check (light)**: rail / navigation panel / file tree / dock = canvas `#f7f7f8`, main content and cards = content `#ffffff`; mean channel delta **3.01%** (algorithm in §7.1), inside the 2–4% target
- [ ] **Two-surface check (dark)**: canvas `oklch(0.185 0 0)` (≈ `rgb(19,19,19)`) vs content `oklch(0.145 0 0)` (≈ `rgb(10,10,10)`); mean channel delta **3.53%**, also inside 2–4%
- [ ] **No horizontal overflow at the four breakpoints**: test 1800 / 1440 / 1280 / 1024 (with dock open and file tree expanded), `document.documentElement.scrollWidth <= clientWidth`
- [ ] **Dock mode follows the breakpoint**: ≥1800 derives `pinned`, <1800 derives `floating`; a manual switch survives reload (`dockModeManual`) and the UI shows a manual marker

## 2. Icon Rendering

- [ ] All icons use `@lucide/vue` components (**prohibit** `i-lucide-*` CSS classes in dynamic components)
- [ ] Theme settings page icons (Sun/Moon/Monitor) display correctly
- [ ] Send button paper plane icon displays correctly
- [ ] Message bubble bot/user avatar icons display correctly

> **Root Cause**: `i-lucide-*` CSS classes are unreliable in Tailwind v4 dynamic rendering scenarios. All icons must use `@lucide/vue` Vue components.

## 3. Theme Switching

- [ ] Light mode: white background, dark text, visible buttons
- [ ] Dark mode: sidebar and chat area have distinguishable color difference (`--sidebar-background` and `--background` difference ≥ 4%)
- [ ] Dark mode form input borders are visible
- [ ] No flickering/ghosting after theme switch
- [ ] Theme settings page three buttons (light/dark/system) all render icons

## 4. Login/Register Page

- [ ] Login page: title "Login", username/password fields, login button, "Don't have an account? Register" link
- [ ] Register page: title "Register", username/password/confirm password fields, register button, "Already have an account? Login" link
- [ ] Bottom link text is not redundant (should not show "Login Login")
- [ ] Form fields have correct `name` attributes (E2E selectors depend on them)

## 5. Chat Interface

- [ ] Empty state: displays "No conversations" text
- [ ] Message bubbles: user messages right-aligned with dark background, assistant messages left-aligned with white background
- [ ] Assistant message avatar has bot icon, user message avatar has person icon
- [ ] Timestamp displayed below message
- [ ] Input box placeholder text is correct
- [ ] Send button disabled when input is empty (semi-transparent)

## 6. Sidebar

- [ ] Conversation list grouped by time (Today/Yesterday/Earlier)
- [ ] Search box filters conversation list on input
- [ ] "No conversations" displayed when search has no matches
- [ ] Clicking conversation item highlights current selected state
- [ ] Navigation panel collapse/expand animation is smooth; when collapsed the rail exposes an explicit expand entry (no hidden shortcut)

### 6.1 rail (`GlobalRail`, dual state: 56px icon-only collapsed ↔ icon + label expanded)

- [ ] **Dual state** (`GlobalRail.vue:77`: `--sidebar-width-icon: 3.5rem` = 56px collapsed, `--sidebar-width: 12rem` = expanded, `collapsible="icon"`): icon-only with no text labels when collapsed, icon + label when expanded; every icon has an `aria-label` and a hover tooltip
- [ ] Collapse/expand affordances live **neither only in the navigation panel header nor behind a shortcut**: the global rail ships its own `SidebarRail` hover toggle (`GlobalRail.vue:190`) plus `⌘/Ctrl+B` (`SidebarProvider`); the navigation panel additionally renders a 56px collapsed strip (`Sidebar.vue:154-157`, `sidebar-collapsed-strip`, expand control only); below `1024` the whole global rail is hidden (`App.vue:29-36`)

### 6.2 Three column widths and viewport clamping (PLAN-0582)

- [ ] Navigation panel **220–360** (default 280), file tree **200–320** (default 240, collapsed 40), dock **320–480** (default 360)
- [ ] Separator semantics: `role="separator"` + `aria-valuenow/min/max`; arrow keys ±16, `Home`/`End` jump to bounds; **double-click restores the default width**; a live width bubble is shown while dragging
- [ ] **Viewport clamping never writes back**: the panel renders 260 at 1280–1439 and 240 at 1024–1279; returning to a wide viewport restores the user's value — prove it by comparing `localStorage` `xihe-layout-global.navWidth` before and after
- [ ] **Anti-squeeze** (spec §1.5-C; the main column is the protected quantity; shipped with S3b + S5-W2): ① hard floor **640** (`MAIN_MIN_WIDTH`) outranks everything, **including a manual expansion preference**; ② **720 comfort line** (only while a pinned dock squeezes the row): the **file tree** yields first → if still <720 the **navigation panel** yields next — the order is fixed (`file tree → navigation panel`, `navYielded` collapses the panel to the rail); ③ if still under **640**, the dock **renders** as `floating` (the dock is **not closed**, the user's pinned choice is kept) with a one-shot notice (`workspace.squeezeFloatingNotice`) — never silently; ④ if still under 640 after floating, the file tree then the navigation panel yield in turn (the nav panel is the last lever and yields even if the user re-opened it) — the floor is never breached

## 7. Dark Mode Contrast

| Element | Expected |
|---------|----------|
| Sidebar background | 2-4% brighter than chat area (to distinguish levels) |
| Chat area background | No less than 6% brightness (avoid pure black) |
| Card/bubble background | 2% brighter than chat area (highlight content) |
| Borders | Still visible in dark mode |

### 7.1 Light-mode layering (PLAN-0582 new criterion)

| Element | Expected |
|---------|----------|
| canvas (rail / navigation panel / file tree / dock) | `--surface-canvas` = `#f7f7f8` |
| content (main content / cards / inputs) | `--surface-content` = `#ffffff` |
| Mean channel delta between the two layers | **3.01%** (inside the 2–4% target) |
| Borders | `--border-subtle` = `#e5e7eb`, 1px single line; never double lines between the two layers |
| Dark-mode counterpart | canvas `oklch(0.185 0 0)` (≈ `rgb(19,19,19)`) vs content `oklch(0.145 0 0)` (≈ `rgb(10,10,10)`), mean channel delta **3.53%** |

**Algorithm (reproducible; "looks about right" is not acceptable)**: mean channel delta = Σ|per-channel delta| ÷ 3 ÷ 255 × 100. Light = (8+8+7)/3/255 = **3.0065% → 3.01%**; dark converts the achromatic oklch values (`Y = L³` for zero chroma, then sRGB-encode) to `rgb(19,19,19)` vs `rgb(10,10,10)` = 9/255 = **3.53%**. Reference WCAG contrast: light **1.07:1**, dark **1.06:1** — this is a **layering metric**, not a readability criterion (text contrast is judged by the table above).

## 8. i18n

- [ ] All user-visible text uses `t()` internationalization function
- [ ] Both zh-Hans and en locales have corresponding keys
- [ ] Link text does not show raw keys (e.g., `login.login`)
- [ ] Form validation error messages have corresponding translations
- [ ] Zero key-set difference between locales (measured 2026-11-10: `packages/ui/src/i18n/index.ts` zh 2307 / en 2307) — machine check: `mise run lint:i18n` (a standing gate since task-96; read-only, silent on success)
- [ ] A key's `{placeholder}` set is identical on both sides (drift renders "undefined" at runtime)
- **Known trap (measured 2026-11-10)**: a wrong prefix inside a same-named family only shows up at runtime — the second line of `ApprovalModal.vue`'s "handled in another window" notice used `chat.approvalResolvedElsewhereDraftKept` while the key lives under `workspace.*`, so users saw the bare key (fixed in `efa527a0`). Scan recipe: key diff + placeholder drift + static `t("…")` references; the scanner is now a standing repo gate: `mise run lint:i18n` (`A03-xihe/scripts/i18n-scan.mjs`, task-96).
- **Known trap (measured 2026-11-10) | ellipsis glyph**: a hand-written `Loading...` (three ASCII dots) and the actual i18n value `common.loading` = `加载中…` (**single U+2026 character**) are different strings ⇒ a `text=Loading...` / `textContent` assertion fails even though the page renders it (task-112: the product was already fixed and the test still failed). **Rules**: ① assert on structural anchors first (`data-testid`, role, `aria-*`); ② when text must be asserted, take the value from the i18n source instead of a literal; ③ if a literal is unavoidable, match only a punctuation-free stable prefix. Same family of character diffs: full-width vs half-width brackets, `：`vs`:`, `·`vs`-`, and non-breaking spaces (U+00A0).
- **New-gate first-day false-positive audit (measured 2026-11-10, task-96 / task-148)**: on day one `mise run lint:i18n` **false-positived 3 times** under its `literal-brace` rule — the vue-i18n literal interpolation `{'@'}` in `chat.delivery.mentioned`, and the mcpServers JSON sample in `settings.jsonPlaceholder` (one per locale); it only became usable after "allow when the brace content is an identifier / a `'…'` literal / contains a quote". Three requirements: ① **audit for false positives on day one** — run the gate on the real repo and classify every hit as a real defect or a rule false positive; **shipping with un-triaged noise means nobody reads it later** (a gate nobody reads is not a gate); ② **false-positive criteria** — a real leftover placeholder is a non-identifier brace (`{...}`, `{ … }`, `${x}`); legitimate braces are declared interpolation params `{name}`, vue-i18n literals `{'@'}`, and JSON samples (a quote inside the braces); ③ **every allow-rule needs a positive unit test** — here `legitimate braces (vue-i18n literals, JSON samples) are not false positives` exists alongside the negative case asserting `{...}` still fails; **changing the rule means changing both**.

## 9. E2E Screenshot Baselines

- [ ] `login-page` — Login page full render
- [ ] `register-page` — Register page full render
- [ ] `chat-empty` — Empty chat page + sidebar
- [ ] `chat-with-messages` — Chat page with messages
- [ ] `theme-default-light` — Light theme page
- [ ] `theme-dark-persisted-chat` — Dark mode chat page
- [ ] `workspace-3col-1920` — Workbench three columns (rail + panel + tree/main/dock) @1920
- [ ] `workspace-dock-overlay-1440` — Dock overlay mode @1440 (shadow, main column not part of flex)
- [ ] `workspace-rail-collapsed` — Rail state after the navigation panel is collapsed
- [ ] `workspace-tree-empty` — File tree empty state (primary create-file + secondary upload + drag hint)

> **Platform limitation (do not misread as a regression)**: baseline comparison **only runs on Linux** (`packages/ui/e2e/helpers/visual.ts:16-26`: on non-Linux it attaches a `visual-baseline-platform` annotation and returns). A "pass" on Windows means **not compared** — it can only be reviewed manually via actual/diff, and the record must state "Linux lane not run".

> **Assertion trap (measured 2026-11-10) | redirects drop the query string**: since `6002ea60` (PLAN-0752 M1) `/settings/config` is `redirect: () => defaultLayerPath("instance")`, which **does not carry the query** ⇒ `goto("/settings/config?tab=tool-faces")` silently loses its parameter, so a test can **land on the right page while asserting a different state** (an old read-only view vs the domain page's default tab). **Rules**: ① before asserting, check whether the path is a component route or a redirect in `router/index.ts`, and whether the redirect forwards `query`/`params`; ② for tests aimed at legacy entries, also assert the landed URL (`page.url()`) or the target page testid instead of content alone; ③ during migration, point tests straight at the final address (and in new code never push a legacy literal — reuse the SSOT helper from `lib/settingsIa`).

> **Assertion trap (measured 2026-11-10) | Vue boolean attributes bound as `:attr="cond"`**: Vue has two attribute paths — a name that exists as a DOM property (`key in el`) goes through `patchDOMProp`, which coerces booleans correctly; everything else goes through `patchAttr`, whose boolean check is the **seven-name** `isSpecialBooleanAttr` list (`itemscope,allowfullscreen,formnovalidate,ismap,nomodule,novalidate,readonly`, `@vue/shared` 3.5.44) — **not** `isBooleanAttr`. A boolean attribute outside that list receives `false` and is rendered as `attr="false"`, and HTML only checks a boolean attribute's **presence** ⇒ the control stays disabled forever while looking "set to false". **Measured in this repo's jsdom**: `inert: false` ⇒ `inert="false"` (attribute still present; task-122 failed with `expected 'false' to be undefined`); `disabled` / `hidden` / `readonly` / `required` / `multiple: false` ⇒ attribute correctly removed (they are DOM properties and take the other path). **Executable rules**: ① always bind `:attr="cond || undefined"` (or `cond ? '' : undefined`) — never bet on whether a given attribute has a DOM implementation in the current environment; ② the unit test must assert the attribute is **absent** in the false state — `expect(el.hasAttribute("inert")).toBe(false)`; `toHaveAttribute` alone passes on `attr="false"` because the attribute really is there; ③ for new HTML attributes (`inert` / `popover` / `commandfor` / `anchor`) write rule-① style instead of copying today's browser behaviour — "does it have a DOM property" shifts with browser and jsdom versions.

## 11. UI review dimensions (screenshot review, user ruling 2026-11-11, D-926 / D-927)

> The user's words: after UI work is done, review it from screenshots first — "button layout and whether each button means something; fonts, icons, overall interaction and static elements".
> This section expands that into **six checkable dimensions**; only judgements decidable from a screenshot are listed — anything else belongs to E2E/unit tests.

**Preconditions**: shoot from a committed tree (never a dirty one) · fixed viewports (1600×1000 primary, plus one pass each at 1920×1080 and 390×844) · real data (the mock must round-trip reads/writes first).

| Dim | What to look at | Source | Checkable criterion | Typical failure |
| --- | --- | --- | --- | --- |
| **A Feedback** | Does every clickable element produce an observable result; are loading/disabled/error states present | Nielsen H1/H3/H9; WCAG 4.1.3 | state changes within a frame (spinner/label/navigation); disabled looks disabled and is really inert; error copy says what to do | click does nothing; enabled but broken; "an error occurred" |
| **B Consistency** | Same semantics → same icon/control/format | Nielsen H4; design tokens (Carbon/Material) | same action, same icon and size; spacing/radius/border come from tokens; one date/number/unit format | two icons for one action; 8px here, 10px there |
| **C Hierarchy & typography** | Type scale, line height, long values, CJK+Latin | Refactoring UI (size+weight+colour); 8pt grid | three visually distinct steps (e.g. 24/16/14); body line-height ≥1.5; digits/code monospaced; long values truncate or wrap | four heading levels at one size; a long id breaks the card; baselines jump |
| **D Accessibility** | Contrast, focus, keyboard, target size, accessible name | WCAG 2.2 AA: 1.4.3 (4.5:1) / 1.4.11 (3:1) / 2.4.7 / 2.5.8 (≥24×24) / 4.1.2 | sane tab order with visible focus ring; icon buttons carry aria-label; status never colour-only | pale grey small text; unlabeled icon button; invisible focus |
| **E Content & truth** | Copy, counts, empty states, i18n | Nielsen H2/H10 | counts/badges match visible data; empty states offer an exit; no hardcoded strings; sample values have real shapes | "8 settings in this domain" with zero fields; empty state with no action |
| **F Layout & adaptivity** | Overflow, scrolling, collapsed states, breakpoints | Apple HIG (44pt) / Material (48dp) targets | no horizontal overflow at 1280/1600/1920; scrollbars do not cover content; collapsed panel keeps a readable entry; mobile targets ≥44px | overflow at 320px; no way back after collapsing; stacked mobile buttons |

**Severity**: **P0 blocker** (inert control / contradictory data / unreachable path) · **P1 obvious** (hierarchy, consistency, WCAG AA violation) · **P2 polish** (spacing, weight, minor differences). P0/P1 become tasks; P2 accumulates.

**Experience loop (the reason this section exists)**: route findings two ways —
```
1. the criterion was unclear => write it back here (criterion + counter-example) so the next batch cannot repeat it;
2. the implementation deviated => file a task; writing it in a doc is not a fix.
Keep only new criteria and counter-examples in the doc; screenshots stay as evidence under .tmp/<batch>/ and are reported by path.
```

**Sources (checked 2026-11-11)**: Nielsen Norman Group "10 Usability Heuristics" (headings verified by fetch) · W3C WCAG 2.2 Quick Reference · Apple Human Interface Guidelines · Material 3 · IBM Carbon · Refactoring UI. See the standards table above (zh source list: `DEV-012-ui-ux-references`, zh-only).
