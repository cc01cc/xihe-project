import { useChatStore } from "./stores/chat";

/**
 * Workspace Chat public lifecycle entry (PLAN-0472).
 *
 * AuthStore clears the Session-keyed local Chat cache on identity switches
 * without importing feature-private store state. This module must only depend
 * on the Chat store (no Auth/WorkspaceStore imports) to avoid module cycles.
 */
export function clearWorkspaceChatForUserSwitch(): void {
    useChatStore().clearForUserSwitch();
}
