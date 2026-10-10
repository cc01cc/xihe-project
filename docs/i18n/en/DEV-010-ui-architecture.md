---
title: DEV-010 - UI Architecture
category: dev-guide
lang: en
sidebar_group: "Developer Guide"
sidebar_order: 10
created: 2026-10-10
updated: 2026-10-10
status: active
---

# UI Architecture

This English companion records the current route map and Workspace/Chat UI ownership. The zh-Hans DEV-010 remains the detailed UI architecture reference.

## 1. Routing

| Route | View | Behavior |
|---|---|---|
| `/` | redirect | Redirects to `/workspace`. |
| `/workspace` | `WorkspaceView` | Workspace home; may show the no-Session empty state. |
| `/workspace/:workspaceId` | `WorkspaceView` | Workspace files and the selected Workspace Chat, when a Session is selected. |
| `/workspace/:workspaceId/chat/:sessionId` | `WorkspaceView` | Selects a Session belonging to the Workspace and displays Chat. |
| `/workspace/:workspaceId/environment` | `WorkspaceEnvironmentView` | Workspace execution environment. |

There is no standalone `/chat` route. Workspace routes share `AppLayout`; a Session ID does not replace a Workspace ID.

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
