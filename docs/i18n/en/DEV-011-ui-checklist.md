---
title: DEV-011 - UI Visual Checklist
category: dev-guide
lang: en
sidebar_group: "Developer Guide"
sidebar_order: 11
created: 2026-05-31
updated: 2026-11-18
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
- [ ] **Assert widths rail-vs-rail, or with a tolerance — never an exact integer on a rendered width**: `store px → rendered px error ≤1%+1px; collapsed ≤2.5%`. Why: reka drives the layout in **percent** (inline `flex: <p> 1 0px`), so px→% quantizes, and the resize handle's `-ml-1` takes part in grow distribution; the **collapsed tier is a different source of error** (`data-state=collapsed` ⇒ layout is 4.44%, so the same absolute error is ~2.4% of 40px) — do not merge the two tiers into one number. Five-tier readings and the three falsified hypotheses: task-28
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

> **Interaction trap (measured 2026-11-12) | `AlertDialogAction` closes first and wipes the pending decision**: `AlertDialogAction` wraps reka-ui's `DialogClose` and closes **unconditionally** on click; the close synchronously fires `@update:open` first, so a "payload to submit on confirm" held in a ref is cleared by that handler before **your own click handler** runs — it then reads `null`, the confirm dialog is already gone, and **no request is ever sent** (task-312). **How to recognise it**: all copy assertions pass while the request never fires — the dialog did open and the wording did match, yet the call count stays 0 (`expected "vi.fn()" to be called 1 times, but got 0 times`). That red is routinely misread as "the mock isn't wired", because nothing on screen looks wrong, so the fix people reach for is a more realistic mock — which cannot help. **First check**: log the payload inside the click handler; `null` means this trap. **Fix**: never let `AlertDialogAction` carry an action with a side effect — use a plain `Button` and control the close order yourself (grab payload → close → submit); measured in `components/settings/PersonalSkillCreateDialog.vue`.


## 10. Attention budget and the danger-red two-stage criterion (user ruling 2026-11-03; `task-109` probe 2026-11-17)

> **This section exists on the zh-Hans side as well; the two sides are structurally divergent.** The zh-Hans file numbers it
> `## 10. 注意力预算` — do not translate an English section number back into a zh-Hans one, or you will edit the wrong section.

**Principle**: visual weight (colour, contrast, fill) is allocated by **what attention is for**, not by element identity.
Before colouring a new element, ask three questions: how often is it used, how irreversible is it, how hard is it to find?
**Only actions where a mistake is likely deserve colour**; frequent-but-harmless or low-frequency-but-obvious actions stay neutral.

### Ladder (L0–L4)

| Level | Purpose | Allowed treatment | Per-screen budget |
| --- | --- | --- | --- |
| L0 Surface | page/card background | white / near-white / light grey | unlimited |
| L1 Content | body text, headings | dark grey text; hierarchy carried by size and weight | unlimited |
| L2 Actionable | buttons, borders, icons, hover | mid-grey border + text; hover adds a light wash only | unlimited |
| L3 Emphasis | primary CTA, selection indicator, focus ring | may take colour, but **1–2 places only** | ≤ 2 |
| L4 Danger | delete, overwrite, irreversible | **red, and only at the confirmation step** | ≤ 1 |

Decision question: **if this element disappeared, would the user take a wrong action?** Yes → L3/L4; no → L2, no colour.

### Danger red: two orthogonal axes, judged separately

The ladder's "red only at the confirmation step" (axis B) and "only mistakes deserve colour" (axis A) are **independent**.
Collapsing them into one judgement produces the classic error: reading "this should have had a confirmation" as "this should not be red".

| Axis | Question | If yes | Who judges |
| --- | --- | --- | --- |
| **A — should it be red at all** | If this element disappeared, would the user take a wrong action? | Yes ⇒ L3/L4; no ⇒ L2, no colour | **Human** (needs business semantics: reversibility, uncommitted state, rollback surface) |
| **B — which stage carries the red** | Is the red present **only at the confirmation step**? | No ⇒ violation | **Machine** (static scan, below) |

**The order cannot be reversed.** Decide A, then B. If A says "a mistake is likely" while the confirmation surface **does not exist yet**,
the finding is **missing confirmation**, not "should not be red". Recolouring at that point **hides** the dangerous action
(neutral colour plus a one-click irreversible delete) and is worse than the status quo. Correct order: **build the confirmation surface first, so the red has a place to land**.

### Axis B: four states, machine-checkable

The unit of judgement is **an element in a stage** — not a component, not an action. The entry control and the confirm control of one action
are two separate judgements with different verdicts.

| State | Meaning | Verdict | Typical form |
| --- | --- | --- | --- |
| `ENTRY_STATIC` | red is present in the static face and not inside a confirm surface | **violation** | `class="text-destructive"` |
| `CONFIRM_SURFACE` | element sits inside a confirm container | compliant | `bg-destructive` inside `BaseModal` / `ConfirmModal` / `AlertDialogContent` |
| `HOVER_ONLY` | the only red token is in an interaction segment (`hover:` / `focus:` / `active:` / `peer-*:` …) | compliant | `text-muted-foreground hover:text-destructive` |
| `STATE_GATED` | red appears only in a dynamic conditional branch | compliant | `:class="pending ? 'text-destructive' : 'text-muted-foreground'"` |

### Three boundaries that are easy to get wrong (each pinned by a counter-fixture)

1. **Visibility gating is not colour gating.** `opacity-0 group-hover:opacity-100` only makes the control *visible* on hover; the colour itself is still a static red ⇒ `ENTRY_STATIC`. The criterion is **which body the colour token sits in**, not when it becomes visible.
2. **A red confirmation surface does not excuse a red entry.** If one action has both, the entry still violates.
3. **A conditional branch must be reachable both ways.** An object-literal `:class` key whose value is the **literal `true`** (`{ 'text-destructive': true }`) is not a branch ⇒ `ENTRY_STATIC`; only a ternary or a variable-keyed object with **both branches reachable** counts as `STATE_GATED`.

### Executable criterion (`internal/A03-xihe/scripts/check-danger-entry.mjs`)

The criterion text is the script's exported `CRITERION` constant, kept word-for-word identical to this section (`D-1767`: only document what a machine can check).
**Verbatim source (do not reword the punctuation or arrows — these lines *are* the machine criterion)**:

```js
CRITERION = {
    id: "DEV-011:155",
    question: "这个元素如果消失，用户会误操作吗？",
    answerYes: "会 -> L3/L4；L4 危险红按 :153 只在确认时出现",
    answerNo: "不会 -> L2，不许上色",
    ladder: "DEV-011:153 L4 危险 = 红，只在【确认时】出现，每屏 <= 1",
}
```

> The values are **intentionally kept in Chinese**: `CRITERION` is a machine-readable constant whose source of truth is the script,
> and the zh-Hans document quotes it verbatim. Translating them here would create a second wording that no tool compares against.

```bash
node internal/A03-xihe/scripts/check-danger-entry.mjs --selftest   # fixtures + bidirectional mutation; exit 0 means the criterion itself is trustworthy
node internal/A03-xihe/scripts/check-danger-entry.mjs              # full-repo scan, compares against baseline; exit 1 = new violations
node internal/A03-xihe/scripts/check-danger-entry.mjs --raw        # full table of every reading as state × rawState (= --readings)
node internal/A03-xihe/scripts/check-danger-entry.mjs --json       # baseline document + a raw-shape section (raw never enters the baseline file)
node internal/A03-xihe/scripts/check-danger-entry.mjs --write-baseline    # accept current state (idempotent: two writes on one tree share a sha)
node internal/A03-xihe/scripts/check-danger-entry.mjs --migrate-baseline  # rekey a baseline (boundary-checked, see below)
```

**The criterion must be able to go red**: `--selftest` runs a **bidirectional mutation** — moving the confirm-surface red onto the entry must flip to `RED`;
moving the entry red back onto the confirm surface must flip to `GREEN`. A criterion that only verifies one direction is a biased instrument, and the next defect passes through it.

#### Two readings: public bucket vs shape reading (`task-142`, 2026-11-17)

Every reading carries two numbers. They have **different jobs and are never merged**:

| Reading | What it is | Used for judgement |
| --- | --- | --- |
| `state` | **Compliance verdict.** Container recognition overrides it: anything inside a confirm surface is recorded as `CONFIRM_SURFACE`, no matter whether its own red is static or branch-gated | **Yes** — the only driver of the exit code |
| `rawState` | **Shape reading.** The classifier's raw verdict on *the red of that element itself* (static / interaction-gated / dynamic branch / disabled segment) | No — never enters the public buckets |

A mismatch between the two is **expected** (a `CONFIRM_SURFACE` entry usually has `rawState = ENTRY_STATIC`; static red inside a confirm surface is legal by definition).
What you watch is the **change** in shape readings: ① a `rawState` downgrade; ② the number of dangerous readings dropping while no bucket grew — the element became `NONE` (it vanished from the reading table).
The report prints the shape section by default; `--raw` prints the whole table; `--json` carries a `raw` section.

**Why it has to be printed** (`task-137` measurement): after fixing the bundled foreground literal in `ConfirmModal`, `rawState = STATE_GATED` went 5 → 6,
while the public buckets only recorded `CONFIRM_SURFACE` 17 → 18 — a reader could see the latter and nothing printed the former.

#### Baseline and keys (`task-143`)

The baseline key is `file:(id||tag)`; `id` is the **verbatim** `data-testid` (template literals keep their interpolation, e.g.
`provider-connection-delete-${defaultConnection.id}`). When two entries share a key base, `#1/#2` is appended by line order and the collision is printed (never silent).

- **Never key by line number**: 3 of the 8 baseline lines drifted within one working session (1340→1347 / 1921→1928 / 2256→2335+). Inserting one import creates a paired "gone + added" false red.
- **Accepting and rekeying are separate operations**: `--write-baseline` accepts the current state (no boundary check); `--migrate-baseline` rekeys it and refuses to write unless the content multiset `file+tokens+conditional` still matches the old baseline **entry for entry** (**exit 3**). Rekeying is fine; smuggling in new entries is not.

#### Three ways a confirm surface is recognised (`task-149`, 2026-11-17)

| Source | Rule | Why it is needed |
| --- | --- | --- |
| Name allowlist | `BaseModal` / `ConfirmModal` / `AlertDialogContent` / `DialogContent` / `RevertPreviewDialog` | Vendor and in-house confirm shells that already existed |
| Hand-written semantics | `role="alertdialog"` **and** `aria-modal="true"` | A hand-written confirm box has no component name (case `ProviderHub:1934`). `aria-modal` is required: plenty of always-mounted blocks carry a bare `role`, and whitelisting those would hide real violations |
| Derived from source (modal shell) | **every** `<slot>` of the component renders inside a modal primitive (`DialogContent`/`SheetContent`/`AlertDialogContent`/`BaseModal`/`ConfirmModal`) | The allowlist is maintained by hand, so its gaps surface as false positives (case `CheckpointDialogShell` ⇒ `RevertPreviewDialog:427`) |

**`role="dialog"` is deliberately excluded**: a generic dialog is not the confirmation stage (navigation sheets and import forms are dialogs too), and none of the four hand-written `role="dialog"` sites contains a dangerous action element (measured 2026-11-17).
**The derivation rule is "every slot exit is inside a modal", not "the template mentions a modal primitive"**: the latter pulls in `Sidebar.vue` (desktop slot in a plain div, only the mobile branch goes into `SheetContent`) and `FileNodeMenu.vue` (slot in a plain element, the `BaseModal`s are siblings).
Measured on fixtures (`fixture-m-not-shell` + `fixture-n-not-shell-user`): under the loose rule the host's **entry red reads as `CONFIRM_SURFACE`**, `--selftest` fails both anchors and exits 1 — **a false compliant is worse than a false positive, and it is silent** (the report only shows "fewer violations"). Derived names are printed in the report (`推导出的模态外壳：…`) so they cannot become a second invisible allowlist.

#### The `cn('…')` fallback must gate per token (`task-149` ③)

When a `:class` expression has no object, no ternary and no array (the common vendor form `cn('…default classes…', props.class)`), the old code judged the whole literal "always on",
so every per-token gate inside the literal was lost: `data-[variant=destructive]:text-destructive` means "red only under the destructive variant" but was read as red at the entry
(`DropdownMenuItem:27`, a vendor default class — changing it means editing code that is already correct).
Now each token is gated (variant / interaction / disabled) and the **worst** verdict wins; if any single token is bare, the result is still `ENTRY_STATIC` (counter-fixture `fixture-j2-cn-bare` pins this, so the rule cannot degrade into "always `STATE_GATED`").
The variant anchor was also widened to `(?:^|[\s:])` because `dark:data-[variant=destructive]:focus:bg-destructive/20` (modifier first) used to read as ungated;
**only structural variants are widened (`data-`/`aria-`/`has-`/`[&…]`), not `dark:`/`sm:` themselves** — `dark:bg-destructive` is still static red to a dark-mode user.

**Known limitations** (state them, or the next reader treats them as bugs):
1. The confirm arm of an inline two-stage confirmation (the second button rendered by a `v-if` on the same row) is not inside a confirm container and is reported as `ENTRY_STATIC`;
   the scan annotates it with the `<v-if condition>` so a human can judge. It deliberately does **not** treat every conditional branch as compliant — that would remove the bite from the entire "red at the entry" category.
2. A hand-written confirm box using `role="dialog"` is not whitelisted (a generic dialog is not the confirmation stage); use `role="alertdialog"` + `aria-modal` instead.
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
| **F Layout & adaptivity** | Overflow, scrolling, collapsed states, breakpoints | Apple HIG (44pt) / Material (48dp) targets | **page-level** horizontal overflow at 1280/1600/1920: `documentElement.scrollWidth ≤ innerWidth` at all three (criterion + exemptions: see "F criterion, made checkable" at the end of this section); scrollbars do not cover content; collapsed panel keeps a readable entry; mobile targets ≥44px | overflow at 320px; no way back after collapsing; stacked mobile buttons; **treating a long line inside `PRE.shiki` as "overflow"** |

### F criterion, made checkable (2026-11-17, `task-90` measurements + `task-100` probe)

**The criterion is page-level only — not "no element may ever cross the viewport edge."** The original wording "no horizontal overflow" never said which of the two it meant; this fills that gap.

```js
// Criterion (1): does a page-level horizontal scrollbar exist?
document.documentElement.scrollWidth <= window.innerWidth
// and scrollWidth <= document.documentElement.clientWidth
// (a classic vertical scrollbar eats clientWidth; judging innerWidth alone goes falsely green in the
//  "content 1275 < winW 1280 but usable width 1270" band)
```

**Criterion (2), parallel to (1), either failing ⇒ red: the count of out-of-viewport elements with no clipping ancestor must be 0.**
Criterion (1) alone misses the `position: fixed` family: it does not grow `documentElement.scrollWidth`, yet the viewport still cuts it.

**The two axes are not the same thing** (`task-90`, 1280×800 mock session page):

| Axis | Reading | Verdict |
| --- | --- | --- |
| page-level `documentElement.scrollWidth` | 1270 ≤ `innerWidth` 1280 | **no horizontal overflow, criterion met** |
| single element `getBoundingClientRect().right` | max 3059 (inside `PRE.shiki`: `code`/`span.line`) | element is past the viewport edge, but a **clipping ancestor absorbs it** — it never becomes page overflow |

All three viewports have this shape: page-level overflow **false everywhere**, while out-of-viewport elements number 53–77. **The same reading can be read either as "no defect" or as "77 overflows"; the only difference is the criterion.**

**Exemption channels (recorded as "already clipped", not as overflow)**:

| Channel | Criterion | Note |
| --- | --- | --- |
| inside `PRE.shiki` (`code` / `span.line`) | an ancestor with `overflow-x: auto` exists and that ancestor has `scrollWidth > clientWidth` | code-block horizontal scrolling is standard interaction (same shape as GitHub / IDEs); `white-space: pre` is a code-semantics requirement — **never** switch it to `pre-wrap` just to silence "overflow" (line numbers and wrapping would misalign = broken semantics) |
| children of any `overflow-x: auto / hidden / scroll` container | same | tables, long paths and timelines all follow the same shape |

**Probe (the criterion's executor, not an optional extra)**: `internal/A03-xihe/scripts/check-ui-overflow.mjs`

```bash
# one command that proves the criterion reads both ways; starts no server
node internal/A03-xihe/scripts/check-ui-overflow.mjs --fixtures
```

It must report three things — **reporting only the element count turns designed behaviour into a defect**:

1. `docW` / `winW` (raw reading for criterion (1))
2. the **nearest clipping ancestor** of every out-of-viewport element (tag + computed `overflow-x` + whether that ancestor can actually scroll)
3. **the count of elements with no clipping ancestor** (**only this number is a defect candidate**)

Four fixtures, two counter-paired sets, proving the exemption really applies rather than waving everything through:

| Fixture | Expected | What it proves | Measured (1280×800) |
| --- | --- | --- | --- |
| `fixture-a-unclipped` (`w-[2000px]` block + no overflow container) | **RED** | the probe **does go red** | docW 2000 > winW 1280; unclipped 1; exit 1 |
| `fixture-b-clipped` (same block inside `overflow-x:auto`) | **GREEN** | the exemption **really applies** | docW 1280; still 1 out-of-viewport element, absorbed by `DIV[auto]` ⇒ unclipped 0; exit 0 |
| `fixture-c-shiki-like` (`PRE.shiki` + a 314-char line) | **GREEN** | designed behaviour is not misjudged | docW 1280; both out-of-viewport elements sit under `PRE.shiki[auto]` ⇒ unclipped 0 |
| `fixture-d-shiki-plus-unclipped` (shiki **present** + a separate 2000px unclipped block) | **RED** | the exemption **is not a blanket pass** | docW 2000; unclipped 1 ⇒ "there is a PRE on the page, so let it go" is caught by this fixture |

**The probe is mutation-checked too**: delete `overflow-x: auto` from `fixture-b`'s container (a single-line `edit`), and the same fixture flips from GREEN to **RED** (exit 1); after restoring, sha256 is byte-for-byte identical — i.e. "green" is not vacuously true. That is exactly what `D-1767` asks for: **only criteria with a machine judge earn a place in the doc; a criterion without a probe becomes "the doc says no overflow, nobody actually measures" a year later.**

**Severity**: **P0 blocker** (inert control / contradictory data / unreachable path) · **P1 obvious** (hierarchy, consistency, WCAG AA violation) · **P2 polish** (spacing, weight, minor differences). P0/P1 become tasks; P2 accumulates.

**Experience loop (the reason this section exists)**: route findings two ways —
```
1. the criterion was unclear => write it back here (criterion + counter-example) so the next batch cannot repeat it;
2. the implementation deviated => file a task; writing it in a doc is not a fix.
Keep only new criteria and counter-examples in the doc; screenshots stay as evidence under .tmp/<batch>/ and are reported by path.
```

**Sources (checked 2026-11-11)**: Nielsen Norman Group "10 Usability Heuristics" (headings verified by fetch) · W3C WCAG 2.2 Quick Reference · Apple Human Interface Guidelines · Material 3 · IBM Carbon · Refactoring UI. See the standards table above (zh source list: `DEV-012-ui-ux-references`, zh-only).

## 12. Motion criteria (user ruling 2026-11-18, built the same way as §10)

> **This section exists on both sides; zh-Hans is the source and this is the derived English copy.** Unlike §10, the two sides now agree on the number (`## 12`) — do not renumber when editing.
>
> **Why this section exists**: the user asked "is the UI all static, and should something like 'running' have motion?" The measured answer is "**not static** (88 animation application sites), but **no criterion governs them**" — this file previously matched `动效|动画|transition` only once (§6, navigation panel collapse), while colour already had the full L0–L4 budget ⇒ **88 sites written by whoever needed them**. This section follows the structure of §10: purpose first, then the budget ladder and the state matrix, then the machine criterion and known limitations.
>
> Per-site audit (**A keep 77 / B change 4 / C delete 1 / D inconsistent 6 = 88**) lives in `internal/A03-xihe/evidence/2026-11-18-motion-audit/README.md` (**cross-repo path**: ONE workspace private layer, not linked from this repo); re-run with `node internal/A03-xihe/evidence/2026-11-18-motion-audit/motion-inventory.mjs` (exit code 0 means the four classes sum to the measured total).

### 12.1 Motion may express exactly two things (purpose)

| Purpose | Examples | Criterion (after the motion stops) |
| --- | --- | --- |
| **State change** | loading, submitting, in progress, open/closed, uploading | the user **misses "still going"** |
| **Attention guidance** | new content entering, scroll-edge fade, focus moving | the user **misses "appeared / moved"** |

**Decorative motion is forbidden outright** — glow, decorative breathing borders, endlessly rotating icons, cards rising on hover. Decision question: **when this motion stops, what does the user miss? No answer ⇒ delete it** (same form as §10's "only mistakes deserve colour").

### 12.2 Motion budget ladder (M0–M3, read alongside §10's L0–L4)

| Level | Purpose | Allowed treatment | Per-screen budget |
| --- | --- | --- | --- |
| **M0 Static** | elements with no state change | **no motion**; hover/focus use §10's channels only (light wash / 2px focus ring) | unlimited |
| **M1 State** | loading, submitting, in progress | the only allowed **looping** motion: spinner / skeleton / row-level breathing (one carrier per screen per meaning) | unlimited, but **≤ 3 concurrent looping motions per screen** |
| **M2 Guidance** | content entering, drawer/menu open-close, scroll edge | **one-shot** transition (≤250ms) or a scroll-driven mask | ≤ 1 |
| **M3 Emphasis** | irreversible confirmation, a transfer the user must see | one-shot emphasis, **at most 2 cycles then still** | ≤ 1 |

Decision question: **when this motion disappears, what does the user miss?** "Still going" ⇒ M1; "appeared / moved" ⇒ M2; "this will destroy something" ⇒ M3; **no answer ⇒ M0 (do not add it)**.

### 12.3 State matrix (each state may use only its channel; motion must never be the only carrier)

| State | Allowed motion | Forbidden |
| --- | --- | --- |
| First load | shape **unknown** ⇒ skeleton pulse; shape **known** ⇒ spinner + label | shaking the whole block, cycling text colours |
| Submitting | 14–16px spinner inside the button + button disabled; the label may switch ("Save" → "Saving") | button size/position change, label disappearing, whole-button opacity breathing |
| In progress (>1s) | **low-frequency row-level breathing**, carried only by a **non-text, non-icon** surface (border / background) + **keep the spinner** | enlarging the icon instead of adding weight, opacity breathing over text, fast whole-row flicker |
| Completed / failed | **0ms switch**: text + icon + colour land at once | adding a transition, fading residue, a completion highlight pulse |
| hover / focus | §10 only (wash / focus ring), **no motion** | hover-triggered scaling, translation, glow |
| Empty / error | no motion | endless pulse as decoration (**an empty-state pulse reads as "still loading"**) |
| Completed history | no motion | scroll-driven entrances **replaying** when scrolling back |

**Two hard rules**:

1. **State tiers must be carried by text + icon + colour; motion is only an amplifier**. Motion-only ⇒ users with colour-vision deficiency or motion sensitivity cannot read the state (WCAG 1.4.1 / 2.3.3).
2. **Under `prefers-reduced-motion` the state must still be readable** — when motion is switched off, the state face must not degrade into "indistinguishable from the neighbouring state" (§12.7).

### 12.4 Only these 5 duration/easing tiers (arbitrary values forbidden)

| Tier | Value | Easing | Used for | Where today's values come from (measured 2026-11-18) |
| --- | --- | --- | --- | --- |
| **T0 instant** | 80–120ms | `ease` / `ease-out` | overlay, menu, tooltip in/out | of the 15 vendor `animate-in/out` sites, **12 set `duration-100` explicitly** (overriding the 150ms default); `SheetContent` and `DialogScrollContent` use `duration-200` (that is T1 — a drawer is a structural change); `TooltipContent` keeps the 150ms default (**unclassified, existing deviation**, see audit report §7) |
| **T1 structural** | 180–250ms | `ease-out` | drawer, accordion, panel open-close | `animate-accordion-down/up` = **0.2s** (`--animate-accordion-*` in `tw-animate-css`); `BaseModal` 0.2s |
| **T2 emphasis** | 300–400ms | `ease-out` | one-shot notices (**must be registered in this table when added**) | **0 sites** today |
| **R1 loop · spinner** | 1s | `linear` | loading / submitting (`animate-spin`) | Tailwind default 1s |
| **R2 loop · breathing** | 1.6–2.4s | `ease-in-out` | row-level breathing while in progress (§12.3) | **no implementation yet**; new ones must land here — `animate-pulse` (2s / opacity 0.5) **does not qualify**, see §12.5 |

**Forbidden in new code (existing instances are registered in the audit report §7)**:

- **Arbitrary values** `duration-[…]` / `ease-[…]` / `animate-[…]`: measured `duration-[` **0**, `animate-[` **0**, `ease-[` **2** (one vendor line, `MessageScrollerButton.vue:61`) ⇒ **the product surface must stay at 0**.
- **`transition: all` / `transition-all`**: named properties only (`transition-colors` / `transition-[opacity,transform]`). Measured 9 instances (mostly vendor) + 1 in CSS (`BaseModal.vue:186-190`), registered as existing.
- **Durations and easings do not live inside components**: changing a tier means editing this table first, then the code.

**Machine criterion (runnable; the 2026-11-18 readings are the baseline; the counting unit was corrected on 2026-11-19, the rule itself was not relaxed)**:

```bash
cd A03-xihe/packages/ui/src
grep -ro 'duration-\[[^]]*\]' --include=*.vue --include=*.css . | wc -l   # baseline 0
grep -ro 'animate-\[[^]]*\]'  --include=*.vue --include=*.css . | wc -l   # baseline 0
grep -ro 'ease-\[[^]]*\]'     --include=*.vue --include=*.css . | wc -l   # baseline 2 (two occurrences on one vendor line, registered individually)
```

Unit: **occurrences, not lines** — `grep -o` puts every match on its own line, so `wc -l` counts occurrences.
The previous `grep -rn … | wc -l` counted **lines**, which reads two arbitrary values on one line as 1 and
contradicted "2 instances" in the prose above and in audit report §7 (corrected by task-25 after measuring).
Executor: `node internal/A03-xihe/scripts/check-motion-arbitrary-values.mjs` (ONE repo, read-only, ~0.2 s) —
exits 1 on any hit and names `file:line`; its face additionally covers `.ts` and ignores comments; an exemption
must be **registered per token** and its family must be listed in the `VENDOR.md` family table (E1–E3, see the
script header). Blanket directory exemptions are not supported by design.

### 12.5 One channel, one meaning

§10's state matrix already assigns **left 2px indicator + light wash** to `selected` ⇒ **a left 2px bar must not also mean "running / loading / unread"**: the sidebar's selected row and the chat stream's running row appear on screen together, and the user can only read them as "both are selected".

Likewise **`opacity` breathing may only target non-text, non-icon surfaces** (`border` / `background`). Putting `animate-pulse` on a whole row or button that contains text compresses the text/icon to 50% opacity at the trough ⇒ **periodically harder to read** (the opposite of the intent), and 0.5 amplitude at a 2s period is already in the WCAG 2.3.1 "flash" concern zone.

### 12.6 Where motion is forbidden (hard list)

| # | Location | Why forbidden |
| --- | --- | --- |
| 1 | **Message bubble enter/exit** | High-frequency stream + virtual scrolling: the animation competes with scroll anchoring in the same frame, and a node inserted during scrolling is re-laid-out, swallowing the animation (visible as "a blink"); scrolling already communicates "position changed" |
| 2 | **The state text itself** ("running" → "completed") | Must switch in **0ms**. A transition makes users **think the transition has not finished** (worse when the state does not update at all, see §12.8); text is information, not decoration |
| 3 | **Anything that already has a hover wash** | §10 puts hover at L2 (wash only). Adding motion = a repaint on every pointer move, and it lifts L2 to L3 ⇒ both the budget and the channel are broken |
| 4 | **List row entrance / reordering** | Under virtual scrolling, "new row fades in" is indistinguishable from "row reused" — users see rows they already read fade in again |
| 5 | **Streaming output / logs / terminal append** | Animating every appended frame = a flicker source; the arrival rate itself is the motion |
| 6 | **Completed states and history** | A highlight/pulse after "done" suggests more is coming; scroll-driven animation replays when scrolling back through history |

> The three candidates on the task card (bubble enter/exit, state text, existing hover wash) are **all kept**; items 4–6 are the same criterion applied to virtual scrolling and streaming (the high-frequency surfaces such as `MessageItem` / `MessageScrollerViewport`).

### 12.7 `prefers-reduced-motion` is a hard requirement

**Requirement**: any new motion **must fall inside the existing media queries**; do not introduce a second switch.

| Existing implementation | Coverage |
| --- | --- |
| `styles/main.css:241` | `*, *::before, *::after` `animation-duration` / `transition-duration` forced to `0.01ms !important` (covers everything) |
| `styles/shadcn-vue-tailwind.css:569` | `.shimmer` explicitly `animation: none` + `-webkit-text-fill-color: currentColor` (text gradient falls back to solid) |

**Required checks on any motion PR**:

- [ ] Under `prefers-reduced-motion: reduce` **the state is still readable** (loading has a label, in-progress has a static marker, completed is distinguishable from in-progress)
- [ ] `animation` is not declared inline or in an `!important` rule later than `main.css` (that would bypass the global override)
- [ ] Looping motion is **still, not phase-jittering**, under reduce (see "known gap" below)

**Known gap (measured 2026-11-18, `[source]` fact)**: the global override only sets `animation-duration`; it **lacks `animation-iteration-count: 1`** (mainstream resets pair the two). Consequence: `infinite` animations keep looping with the period squashed to 0.01ms ⇒ the browser samples a near-random phase each frame, so the intended "still" may show up as **jitter**. Two fixes: add `animation-iteration-count: 1 !important`, or add `motion-reduce:animate-none` to the `animate-spin` family (63 sites ⇒ use a global rule). **The visual consequence still needs a browser measurement** (this section only records source readings).

### 12.8 Motion must not mask a bug (hard constraint; F1 / F2 evidence)

**Confirmed fact**: `F1` / `F2` are **states that simply never update** — `e2e-1` measured the running anchor unchanged for 25s (a state-fact defect, not a motion defect).

⇒ **Animating a state that never updates is using motion to hide the defect**: the spinner/breathing reads as "the system is progressing" while the UI has in fact stopped, and during triage such motion makes people misjudge "the link is alive".

**Fixed order, not negotiable**:

1. fix the **state fact** (state really goes running → completed / failed);
2. then discuss **motion expression** (whether it should breathe, at what weight).

**PR criterion**: a motion PR **must not** double as a workaround for "state does not update" — if review finds the motion exists to make the UI look alive, reject it and file a state defect instead.

### 12.9 Who executes the criterion, and known limitations

- **Executor**: `internal/A03-xihe/evidence/2026-11-18-motion-audit/motion-inventory.mjs` (enumerate → named rules → assert "four classes sum to the measured total"; **the exit code is the criterion**). **Changing this section's criteria means changing that script in the same batch**, otherwise this section becomes another unverified document (same as `D-1767`).
- **Known limitations (state them, or the next reader treats them as bugs)**:
  1. The counting unit is the **application site**, not "the number of visually distinct animations": element reuse in virtual scrolling makes one code site produce many visible animations.
  2. `transition` / `<Transition>` are only registered in the audit report's supporting layer, not classified site by site (larger surface, half of it vendor).
  3. Vendor (`src/components/ui/**`) is **judged but never edited**: its header requires byte-alignment with upstream ⇒ inconsistencies are resolved on the in-house side, or by a batch that edits vendor and records it.


## 13. Top-bar chrome and input-field visual weight (user ruling 2026-11-19, `task-38`)

> Source: the user pointed at four defects on a real screenshot — the top bar is two rows, hint sentences each
> occupy a row, CC is impossible to find, and a second rectangle appears with the caret while typing.
> None of these were covered by any criterion (grepping `DEV-010`/`DEV-011` for "top bar / one row / two rows / nav"
> returned nothing), which is why self-reviews never caught them. This section turns them into criteria **with a
> measurement method** (`D-1871`: a criterion without a measurement method is not a criterion).

### 13.1 The top bar is one row

**Draw the boundary first (this matters more than any number — user ruling 2026-11-19)**:

- **The top bar = the single `workspace-secondary-nav` band**, carrying "page navigation + panel toggles".
- **`workspace-container-tabs` belongs to the content area and is explicitly NOT part of the top bar** (user: "the
  container tabs are still the container's, not a top-bar component"). The reason "one row" was said many times and
  never landed is exactly this undefined boundary: whoever read "one row" could not decide whether the container tabs
  had to move, so everyone stayed put.
- **`workspace-toolbar` is not part of the top bar**: it is the workbench (content area) tool band, and on desktop it
  **must not form a band**.

**Criterion**: on desktop (≥ `md`) there is exactly **one** top bar — `workspace-secondary-nav` — and the six panel
toggles (files / code / changes / monitor / members / delegation) fall inside that band's x range.

**Measurement** (real browser at 1920×1080, `getBoundingClientRect()`; "it looks like one row" does not count):

| Element | Requirement |
| --- | --- |
| `[data-testid="workspace-secondary-nav"]` | `height == 32` (`h-8`); aligned to the page top |
| `[data-testid="workspace-secondary-nav-actions"]` | present, `width > 0`, and its x range **inside the nav band's x range** |
| `[data-testid="workspace-toolbar"]` | desktop: `height == 0` **or absent**; mobile still renders it (the only narrow-screen page entry — see the C3 guard comment in `WorkspaceToolbar.vue`, do not delete) |
| top-band count | in the region y < 40 there is exactly **one** band carrying navigation plus the panel toggles |

**Implementation constraint**: the toggle cluster moves via the Vue core `<Teleport to="#workspace-nav-actions">`;
**props / emits / testids stay identical**. Do not lift the workbench's 6 props and 6 emits into the shell to merge the
row — that turns a visual card into a structural refactor.

**Counter-example anchor (the criterion must be able to go red, otherwise it is decoration)**: put the panel toggles
back into the `workspace-toolbar` content band ⇒ both "nav-actions exists inside the nav band's x range" and
"toolbar forms no band on desktop" **must go red**. Static guard:
`packages/ui/src/features/workspace/__tests__/TopBarSingleRow.spec.ts`

### 13.2 Three weight tiers for input fields

**Criterion**: input fields on one screen **must not all be fully boxed** — if everything is important, nothing is.

| Tier | Form | Applies to | Anchor |
| --- | --- | --- | --- |
| **1 · boxed** | full `border` + radius | the primary input (where the user actually types: the composer textarea container) | `InputArea.vue` composer container |
| **2 · light bottom rule** | `border-b` (muted), **no** side/top border, **no** rounded frame | auxiliary fields: Send (TO) / Cc (CC) / Send as | `RecipientField.vue` row container |
| **3 · shadow only** | no `border`; `shadow-*` establishes the clickable surface | inline affordances: chips, the `+ Cc` pill | `RecipientField` chip, `cc-expand` |

**Why the vendor default does not satisfy this** (the answer AGENTS demands before deviating): the base class of
`components/ui/input/Input.vue` is `rounded-lg border … h-8` ⇒ **the vendor field is already tier 1**. The composer's
auxiliary fields are an inline "label + chips + input" row; putting a vendor Input there inserts a 32px solid frame into
every row, **equal in weight to the primary input** — exactly what this section forbids. Tier 2 is therefore a **new**
form in this design system, implemented **locally on those composer fields only**. Adding a `secondary` variant to the
global `Input.vue` is **forbidden**: it becomes an unowned global switch.

**Basis**: information hierarchy — auxiliary fields must not weigh the same as the primary input. **Not** "it looks lighter".

**Measurement**: real-browser `getComputedStyle` at three places — primary container `borderTopWidth == 1px` and
`borderTopLeftRadius > 0`; TO/CC/Send-as row container `borderTopWidth == 0` and `borderBottomWidth >= 1px`;
chip `borderTopWidth == 0` and `boxShadow != "none"`.

### 13.3 Exactly one focus indicator

**Criterion**: any focusable element may show **one** focus visual at a time. In nested forms (outer container +
inner `input`/`textarea`/contenteditable) the indicator is drawn **by the outer element**; the inner element must not
draw its own `box-shadow` ring and must not keep a UA / global `outline`.

**Root cause (measured — do not chase the wrong thing again)**: the composer's "rectangle that appears with the caret"
is **not** a UA outline: the inner `outline-style` already computes to `none`. The inner textarea draws
`box-shadow … oklab(0.205 0 0 / 0.5) 0 0 0 3px` while the outer container has a `1px oklch(0.922 0 0)` rule ⇒
**two frames, with different colour and width**. `--ring` / `--sidebar-ring` = `var(--primary)` is a **deliberate**
deviation from the official shadcn value (`m2-impl.md:26/48`); reverting those two lines to `oklch(0.708 0 0)` "for a
cleaner diff" is **a functional regression, not a cleanup**.

**Measurement** (keyboard path per the focus-evidence discipline; scripted `focus()` does not count): after Tab reaches
the target, **settle before reading**, then read `getComputedStyle`:

> **Settling is a hard precondition** (pitfall measured 2026-11-19): when the focus ring carries `transition-shadow`, reading
> `getComputedStyle` **immediately** after pressing Tab returns the **animation start value** — the ring layer still has alpha 0
> (same element, measured: `oklab(0 0 0 / 0) 0px 0px 0px 0px` immediately vs `oklab(0.205 0 0 / 0.5) 0px 0px 0px 2px` after 400 ms).
> The consequence is a **systematic false negative**: a ring that exists is read as absent, so a missing focus indicator goes undetected.
> ⇒ **Criterion**: any `doubles` reading (including `doubles = 0`) must also state the **per-stop settle duration**, otherwise that 0
> does not count; settle floor **220 ms** (longer than the vendor default 150 ms transition). This repo's measurement uses 220 ms.

> **Fifth required item: "which layer are you reading" (the cascade fills back in, `D-1880` ②)** — any focus-visual change
> **must measure the settled final `outline` / `box-shadow`**, never just the declaration you deleted. Two measured counter-examples:
>
> 1. **Deleting a utility lets `@layer base` take over**: removing only the vendor `TabsTrigger` declaration
>    `focus-visible:outline-1 outline-ring` made the global `*:focus-visible { outline: 2px solid var(--ring) }` fill back in,
>    so `workspace-container-tab-main-*` was still a true double indicator (`outline solid/2px` + 3px ring); only adding
>    `focus-visible:outline-none` brought it to zero.
> 2. **One and the same Δ stacks two layers**: the composer column vs the message column differed by 131 px — layer one was
>    `mx-auto max-w-4xl` centring ((1158−896)/2 = 131); after removing the centring **16 px remained** — layer two was the
>    composer frame `px-4` (the message scroller has `padding-left: 0`). Fixing one layer and calling it done turns that
>    16 px residue into noise.
>
> ⇒ **Criterion**: a reading must state **which element box it measures** (including `padding` and positioning context),
> and one quantity must come with **at least a two-layer comparison** (own layer plus parent or child), otherwise
> "fixed" cannot be told apart from "the cascade filled it back in".

1. **inner**: `outlineStyle == "none"` **and** `boxShadow == "none"`;
2. **outer**: a ring in `boxShadow` **or** `outlineStyle != "none"` — never both;
3. **repo sweep**: walk every tab stop and **split `boxShadow` into layers** before judging —
   a **ring layer** ⇔ `inset == false && offsetX == 0 && offsetY == 0 && blur == 0 && spread > 0` **and its colour alpha > 0**;
   a **projection layer** ⇔ `blur > 0` or `offset ≠ 0`; layers with alpha 0 are **transparent placeholders**
   (vendor `shadow-*` utilities lay down 5 layers, most of them transparent) and must be discarded.
   **Double indicator ⇔ one valid ring layer exists AND `outlineStyle != "none" && parseFloat(outlineWidth) >= 1`.**
   The literal `boxShadow != "none"` is **not usable as the test** (independent re-run 2026-11-19:
   **2 false positives / 4 false negatives**) — it flagged `dock-tab-files` (5 fully transparent layers, in fact one outline)
   and `message-search-toggle` (a `shadow-sm` projection, not a focus language at all) while missing four real ones.
   **Inventory under the corrected test**: 4 `global-rail-menu-*` buttons (workbench / org-members / resources / settings —
   `outline 2px solid` plus a solid `ring 2px`) and the tab's `outline-1` + `ring-3` pair (vendor
   `components/ui/tabs/TabsTrigger.vue:20`). Both are fixed in this batch: the rail gains `focus-visible:outline-none`,
   the vendor trigger drops `focus-visible:outline-1 focus-visible:outline-ring` (keeping `border-ring + ring-3`,
   this repo's common focus language); the re-run after the fix measures 0.

### 13.4 Hint copy must not occupy a whole row

**Criterion**: a field explanation rendered as a **permanent full-width row** is retired — it moves into a tooltip
(the in-stack `components/ui/tooltip/*`, reka-ui primitives; **no hand-rolled tooltip**), with all four holding:

1. **keyboard reachable**: shown on focus, not hover only;
2. **single source of copy**: still in `src/i18n/index.ts`, never hardcoded in the component;
3. **motion tier**: §12.4 **T0, 80–120ms, `ease`|`ease-out`** — no invented durations;
4. **AT-readable**: the text stays in the DOM permanently (`sr-only`), not only while the overlay is open.

**Exceptions (registered as facts, not as loosening)**: `composer-workspace-less-hint` (task-547 F-A: an independent
session must *say* why two controls are missing) and the one-shot `role="status"` notices
(`chat-to-empty-hint`, `compose-deeplink-unsat-hint`: dismissible, not permanent chrome) **stay as rows**.

**Measurement**: Tab to `composer-*-hint-trigger` in a real browser ⇒ `[data-testid="composer-*-hint"]` has
`getBoundingClientRect().height > 0`; and the count of permanent hint paragraphs in the composer region
(`[data-testid*="hint"]` `<p>` children of `.space-y-1.5`) is **0**.

## 14. User-facing copy must not contain reviewer-shaped strings

> Source: `D-1879` ruling 2 (2026-11-19, `task-47`). **This is a criterion, not a style preference.**

**Criterion**: text a user can read must not contain any of these **shapes**: class names, shell commands, contract/spec file names, `file:line`, endpoint paths, permission atoms or enum constants, internal ticket ids, or internal jargon (`读面` / "read face", `契约` / "contract") used as body copy.

**Why shapes rather than an enumerated word list**: earlier criteria enumerated known bad field names, while the actual leakage is a **shape**. `task-47` measured one page leaking a class name, a `grep` command, `openapi.yaml`, `lib/legacyRoutes.ts:34` and `/api/v1/rag/*` at once — **none of them was on any pre-enumerated list** ⇒ **enumeration never catches up with new shapes** (the headline conclusion of `task-39`).

**Category error (the real cause)**: **verifiability belongs to the test surface and the evidence pack, not to product copy.** Copy is read by users; "how to verify this claim" is read by reviewers. Writing the reviewer's verification duty into user body text forces every user-facing sentence to carry its own citation ⇒ **the output necessarily degenerates into an engineering work log**, and **the tests actively preserve that deformation** (`task-47`'s spec asserted `toContain("怎么核")` / `toContain("CP")`; changing the copy without the assertions invites the next person to change it back).

### 14.1 Measurement (five required fields; the fifth added by `D-1880`, on top of `D-1876` / `D-1879` ruling 3)

| Required field | Value for this criterion |
| --- | --- |
| **What to measure** | number of regex hits in rendered text, **naming both the matching shape and the offending string** |
| **Where to measure** | `document.querySelector("main").innerText`. **Not `textContent`** — it swallows `sr-only`, `display:none` subtrees and script text ⇒ false positives |
| **Which layers to read** | (1) **rendered-text layer = the only criterion layer**; (2) component source layer (`t()` key reference integrity, owned by `lint:i18n`); (3) i18n source layer (**for locating only, never a criterion**). **Every reading must state which layer it read** |
| **When to measure** | after route `networkidle` **plus expanding every `role=tab`**; one-shot `role="status"` notices and toasts **do not count** (transient by design) |
| **What red looks like** | name the surface / shape / offending string, e.g. `条目 noDocList 命中「类名」形态：RagProxyController`. **It must be able to go red**: `task-47` ran the mutation test — injecting `RagProxyController` back into body copy turns 2 assertions red while the other 6 stay green |

### 14.2 Regex whitelist (the only allowed expression; no string enumeration)

```text
class name                    [A-Z][A-Za-z]*(Controller|Service|Repository|Middleware)\b
command                       \bgrep\b
contract/spec file name       \b(openapi|swagger)\.ya?ml\b
source file:line              \b[\w./-]+\.(ts|vue|java|yaml|yml|mjs|js|json):\d+
endpoint path                 \/api\/v1\/
permission atom/enum constant \b[A-Z][A-Z0-9]+(_[A-Z0-9]+)+\b
internal ticket id            \b[A-Z]-\d+\b
jargon: read face             读面 | \bread-face\b | \bread face\b   (i)
jargon: contract              契约 | \bcontracts?\b                  (i)
```

**The last two must cover both languages (added by `task-57`)**: they originally matched only the Chinese terms, so the English run came back **all zeros** —
that was not cleanliness, it was a **false green caused by an incomplete criterion** (`The read face returned none of these fields` was on screen and the gate could not see it).
**General shape**: when the criterion is written per-language but the reading is taken per-language, a 0 reading must first raise suspicion about the criterion, not about the product.
The other half of the same lesson: `findLeaks()` used to add only the `g` flag and drop `i`, so case-insensitive English forms leaked through anyway.
Both copies (canonical `src/lib/copyLeakPatterns.ts` and the Node gate) are aligned item-by-item by `src/lib/__tests__/copyLeakPatterns.spec.ts` — **change one side and it goes red**.

**Implementation anchors**: `LEAK_PATTERNS` (9 shapes) plus the two negative assertions in `packages/ui/src/views/resources/__tests__/KnowledgeResourceView.spec.ts`; the machine gate `packages/ui/scripts/check-copy-leak.mjs` (`report-only`, see `task-51`).

### 14.3 The scan matrix must be persisted

Scan surface = **`route × tab/layer`**; the grid list is **committed** (`matrix.json`). **Scanning only the route default state misses content**: `task-47` measured that `/resources/skills` defaults to the "moved to workspace settings" notice (66 characters of rendered body) with the real panel behind `role=tab`, which produced the wrong conclusion "1 of 9 pages leaks"; after expanding the tabs, **4 surfaces leak**.

### 14.4 Counter-example anchors (both directions pinned, `D-1876`)

- **Scanning the i18n source gives false positives**: 66 source hits, mostly **comments** and **migrated/unmounted** surfaces. Measured: `MANAGE_PERSONAL_SKILLS` and internal ticket id `P-189-3` were identified from source but **never appeared on any rendered page** ⇒ **a source-level inventory is not render-level evidence**.
- **Scanning the default state gives false negatives**: see §14.3. **The instrument not seeing it is not the same as it not existing.**

### 14.5 Exception (registered as a fact, not as a loosening)

Technical detail the **user deliberately expands** is not a violation: diagnostic surfaces follow the existing ruling in `packages/ui/AGENTS.md` ("error surface: code → copy") by putting `technicalDetail` inside a **collapsed-by-default** control with a label saying it is technical detail. The criterion is the **body text the user reads**; collapsed content is not body text, but **it must be visibly identifiable as technical detail** and must never be mixed into body copy.

**The exception covers collapsed content only ⇒ an error code that stays on screen is a violation** (Lead ruling ②, 2026-11-19, ledger §14 `fc327a318`). First-hand evidence: `task-58`'s trigger judged the `session` cell red on its very first real run (shape 权限原子/枚举常量, sample `CHECKPOINT_UNAVAILABLE`, clean on the confirmation run) — that was the change panel's **always-on-screen** code, not build/HMR noise.
Current wording: **the two diagnostic shapes converge into one** — `code` and `technicalDetail` go into the same collapsed-by-default control (`packages/ui/AGENTS.md` §错误面). The rejected alternative was a DOM-surface allowlist for the gate: it would move §14.1's **single judgement layer from rendered text to the DOM axis**, i.e. dismantle the criterion to avoid editing a few specs.
Consequence on the copy side: once the code is collapsed, “visible and copyable” only holds **after expanding**, so any copy that asks the user to “provide the error code” must also name the action (expand Technical details). `errors.unknownCode` was changed in both locales in the same batch.

### 14.6 Some cells the gate cannot reach must be labelled, not skipped silently (`task-57`)

The copy under "resource detail › instance layer › fields the API did not return" renders **only when the wire is missing keys**. On the real stack every instance list is empty (`credentials` 0 rows, `agent-principals` 0 rows, `mcp` **404**), so the gate cannot reach that cell; it is covered by the mock-lane spec (`e2e/mock/resource-detail.spec.ts`).

Such cells carry `via: "mock"` in the matrix and the gate prints **`MOCK … (not scanned by the gate, covered by <spec>)`** and skips them:

- **never skip silently** — silence would make "12 surfaces covered" a false statement;
- **never print "0 hits / 0 chars"** — that reads like "scanned and clean". The gate did not scan it, so the reading must not be 0.

This is the **dual** of §14.4 ("the instrument not seeing it is not the same as it not existing"): **an instrument reporting 0 is not the same as an instrument having looked.**

### 14.7 Copy provenance must never come from the model's self-report (`task-59`; Lead approved into the ledger as F-24, 2026-11-19)

**Criterion**: any **factual claim** put into product copy (what the UI did, what it covers, why there was no result) must be sourced from an **instrument reading** — the CP log, an API response, rendered text or a durable record **from the same run**. It must **never** be sourced from the model describing its own behaviour.

This is not a metaphor for `D-1879`, it is a **new shape** of it: before, we inferred on the model's behalf; here somebody used **the model's word as an instrument reading**. First-hand evidence (same-run comparison, `task-59`): the CP recorded **`tools=0`** for that run and its durable records contained only USER + ASSISTANT, while the model's `reasoning` listed a tool set — "workspace file tools, git, team tasks" — **that does not exist**. Writing from the self-report yields sentences like "retrieval found nothing in your workspace files": **something that never happened is reported as having happened, and the user is handed a wrong next step along with it**.

**Operable criterion (three steps, reproducible by a second person)**:

1. Every **action / capability** noun in the copy ("retrieval", "reads your workspace", "calls a tool") must point at one instrument record **from the same run** (a CP log line, a response field, a `main.innerText` fragment). No record ⇒ **do not write it**; and do not write a half-guess like "it probably covers X and Y" — report only what was observed.
2. The provenance lives in the **evidence surface** (the "where measured" / "reading" columns of the five required fields), **never inside the user-facing copy** — that is §14's category error; do not push provenance back into body copy just to justify yourself.
3. "The UI has no such surface" and "this surface did not fire this run" are **two different claims**: the first needs the addressing evidence from §14.8, the second needs this run's records. Neither may be derived from a self-report.

**Counter-example anchor (must be able to go red, on an axis a second person can recompute)**: put the sentence "retrieval currently covers only this session and your workspace files" into any i18n key.

- **The honest half**: that sentence contains **none of the nine shapes** (clean prose ⇒ `check:copy-leak` stays green). Anyone claiming "the regex will catch self-report copy automatically" is selling a false green.
- **The half that does go red**: step 1 pins this criterion on the **capability axis**, not the text axis — that run's `tools=0` contradicts the sentence outright, so a review card **judges it red under this rule**, recomputed with the same read-only probe (list the run's durable records and tool count). Like §14.6, this rule **states out loud that the nine shapes do not cover it**, so the next person does not assume the regex has their back.

### 14.8 An instrument returning nothing is not the same as nothing being there — two addressing traps (`task-59` / `task-64`)

Both bit during the same night, with the same symptom: the instrument reports empty or 404, and the next sentence concludes "this surface does not exist".

| Trap | Measured symptom | Operable criterion |
| --- | --- | --- |
| Missing `x-workspace-id` header | The CP answers **404, never 403** — it reports neither "no permission" nor "missing header" | Any conclusion built on "could not fetch" must **first prove the request matches the page's real request, header-for-header and parameter-for-parameter**: capture the request the UI itself sends and replay it with the same headers and query. **Control group**: hit a resource known to exist with those same parameters; only when that hits is the addressing usable |
| `branchId` is a required query parameter | Omitting it ⇒ **404** (not a full list) | Before writing a probe, check the operation's `required` in `docs/api/openapi.yaml` (here: `openapi.yaml:3827`). **The first candidate explanation for a 404 is "my addressing is incomplete", not "the resource does not exist"** |

**General shape**: a 404 or an empty result is **not** evidence that a product surface is missing. To write "there is none", you must show **complete addressing** — same headers and parameters, plus a known-existing control that hits.

P-9 in `task-59` was corrected exactly this way: the 404s first read as "there is no knowledge-base surface"; after adding the header and `branchId` the surfaces were all there, and the real finding was that **retrieval never happened that run** (`tools=0`). The two conclusions produce different copy, and the wrong one sends users looking for an entry point that does not exist.
