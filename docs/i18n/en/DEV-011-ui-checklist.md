---
title: DEV-011 - UI Visual Checklist
category: dev-guide
lang: en
sidebar_group: "Developer Guide"
sidebar_order: 11
created: 2026-05-31
updated: 2026-10-31
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

### 6.1 rail (`NavRail`, always 56px)

- [ ] Always **56px**, icons only, no text labels; every icon has an `aria-label` and a hover tooltip
- [ ] The rail **does not** host the collapse control (it lives in the navigation panel header); the whole column is hidden below `<1024`

### 6.2 Three column widths and viewport clamping (PLAN-0582)

- [ ] Navigation panel **220–360** (default 280), file tree **200–320** (default 240, collapsed 40), dock **320–480** (default 360)
- [ ] Separator semantics: `role="separator"` + `aria-valuenow/min/max`; arrow keys ±16, `Home`/`End` jump to bounds; **double-click restores the default width**; a live width bubble is shown while dragging
- [ ] **Viewport clamping never writes back**: the panel renders 260 at 1280–1439 and 240 at 1024–1279; returning to a wide viewport restores the user's value — prove it by comparing `localStorage` `xihe-layout-global.navWidth` before and after
- [ ] **Anti-squeeze** (spec §1.5-C, the main column is the protected quantity, in priority order): ① hard floor **640** outranks everything; ② when the dock is pinned and the main column drops below **720** the **file tree yields first** (never the dock, and the dock is **not closed**); ③ if still short, the **navigation panel** yields next — the order is fixed (`file tree → navigation panel`); ④ if the main column is still under **640**, the dock **renders** as `floating` (the user's pinned choice is kept) with a one-shot notice (`workspace.squeezeFloatingNotice`) — never silently

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
