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