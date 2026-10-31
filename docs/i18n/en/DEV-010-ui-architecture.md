---
title: DEV-010 - UI Architecture
category: dev-guide
lang: en
sidebar_group: "Developer Guide"
sidebar_order: 10
created: 2026-10-10
updated: 2026-10-31
status: active
---

# UI Architecture

This English companion records the current route map and Workspace/Chat UI ownership. The zh-Hans DEV-010 remains the detailed UI architecture reference.

## 0.1 Workspace context (PLAN-0559)

- The workspace lives in the URL + sessionStorage; localStorage keeps only token/user.
- Each workspace-scoped request carries X-Workspace-Id; switching clears workspace-scoped caches and discards stale responses.
- Roles: OWNER/EDITOR/VIEWER. VIEWER write affordances are hidden; CP remains authoritative with 403.
- Cross-tab logout uses BroadcastChannel + storage fallback; workspace switches are not broadcast.


## 1. Routing

| Route | View | Behavior |
|---|---|---|
| `/` | redirect | Redirects to `/workspace`. |
| `/workspace` | `WorkspaceView` | Workspace home; may show the no-Session empty state. |
| `/workspace/:workspaceId` | `WorkspaceView` | Workspace files and the selected Workspace Chat, when a Session is selected. |
| `/workspace/:workspaceId/chat/:sessionId` | `WorkspaceView` | Selects a Session belonging to the Workspace and displays Chat. |
| `/workspace/:workspaceId/environment` | `WorkspaceEnvironmentView` | Workspace execution environment. |
| `/workspace/:workspaceId/settings` | `WorkspaceSettingsView` (PLAN-0560) | General (OWNER rename/delete) / Config (workspace-layer domains) / MCP sections; `?tab=config\|mcp` deep links. |
| `/workspace/:workspaceId/scheduled-tasks` | `WorkspaceScheduledTasksView` | Scheduled tasks; participates in routing as one tab of the **middle route tab bar** (`router/index.ts`). |

There is no standalone `/chat` route. Workspace routes share `AppLayout`, which is **two-tier left nav + main area**: leftmost `NavRail` (fixed **56px**, icons only, no text labels) + navigation panel (default **280px**, collapsible and draggable 220–360) + main area. Workbench content is owned by `WorkspaceWorkbench` (structure see below), with the **middle route tab bar** `WorkspaceTabBar` on top (a projection of the existing routes — no new routes; `chat` is always open, the other three are a per-workspace persisted open set). A Session ID does not replace a Workspace ID.

## 2. Feature Ownership

- `src/features/workspace/` owns Workspace pages, components, store, and interactions.
- `src/features/workspace/chat/` owns Workspace Chat UI, `ChatStore`, Session list UI, and Chat SSE/parser composables.
- `src/stores/session.ts` remains shared UI state for Session selection and metadata. The Control Plane remains canonical for Session, Message, and ChatRun lifecycle and durable records.
- Shared API facades, cross-feature types, and shared stores remain outside the Workspace feature.
- The unused full-screen `ChatView` and its standalone route are removed. Auth cleanup reaches Workspace Chat only through its public lifecycle entry point; it does not move Session or Control Plane ownership.

## 3. Invariants

- Preserve route behavior, public component/store contracts, API/SSE payloads, authorization, and cross-service ownership during UI organization changes.
- Workspace Chat uses the existing `toolMode=workspace` and current-Session guard; no new route, API, or SSE bridge is introduced.
- Create Workspace Chat Sessions from the Workspace UI with a Workspace-bound Agent principal.

## 4. Reference

- [Detailed zh-Hans UI architecture](../zh-Hans/DEV-010-ui-architecture.md)
- [Session and Chat ownership](../zh-Hans/DEV-017-session-architecture.md) (zh-Hans canonical; the English DEV-017 file is superseded)
