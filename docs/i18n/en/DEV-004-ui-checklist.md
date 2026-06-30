---
title: DEV-004 - UI Visual Checklist
category: dev-guide
lang: en
sidebar_group: "Developer Guide"
sidebar_order: 4
created: 2026-05-31
updated: 2026-06-15
status: active
---

# UI Visual Checklist

> PRs involving UI changes must verify each item in this checklist. Issues found are from actual E2E screenshot reviews.

## 1. Page Rendering

- [ ] Page has no blank/white screen (Vue inline template not rendering → must use SFC)
- [ ] Title and subtitle text display correctly
- [ ] Form field labels align with input boxes
- [ ] Button text/icons are fully readable

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
- [ ] Sidebar collapse/expand animation is smooth

## 7. Dark Mode Contrast

| Element | Expected |
|---------|----------|
| Sidebar background | 2-4% brighter than chat area (to distinguish levels) |
| Chat area background | No less than 6% brightness (avoid pure black) |
| Card/bubble background | 2% brighter than chat area (highlight content) |
| Borders | Still visible in dark mode |

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
- [ ] `theme-light-settings` — Light theme settings page (three icons visible)
- [ ] `theme-dark-settings` — Dark theme settings page
- [ ] `theme-dark-persisted-chat` — Dark mode chat page
