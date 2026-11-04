import { useSessionStore } from "../stores/session";
import { useSessionParticipantsStore } from "../features/workspace/stores/sessionParticipants";
import { useWorkspaceStore } from "../features/workspace/stores/workspace";
import {
    PREVIEW_SESSION_ID,
    mockParticipantCapabilities,
    mockParticipants,
    mockSessions,
} from "./mockData";

/**
 * Seeds the stores the reused product components read from, so the preview mounts the
 * **real** components without a backend.
 *
 * Everything here is page-local state: the page issues no `/api/v1/**` request. The
 * store actions that would fetch on mount are replaced on this page's instances only —
 * the components themselves are untouched and the product app never loads this module.
 */
export function installPreviewStores(): void {
    const sessions = useSessionStore();
    sessions.sessions = mockSessions;
    sessions.currentSessionId = PREVIEW_SESSION_ID;

    const participants = useSessionParticipantsStore();
    participants.sessionId = PREVIEW_SESSION_ID;
    participants.participants = mockParticipants;
    participants.capabilities = { ...mockParticipantCapabilities };
    participants.ensureLoaded = async () => {};

    const workspace = useWorkspaceStore();
    workspace.fileTree = [];

    // The composer no longer offers model selection (2026-11-04 ruling: the model comes
    // from the agent principal / connection config), so no config-store seeding is needed.
}
