import { logger } from "../../../lib/logger";

/**
 * PLAN-0507: per-session invalidation signals for the chat SSE pipeline.
 * The client keeps a single SSE channel per session (`chatTransport`), so the
 * right-panel Monitor subscribes here instead of opening a second connection.
 */
export type SessionConnectionStatus = "live" | "offline";

interface SessionSignalHandlers {
    /** One of status/done/error/usage/derived_state_changed was observed. */
    onData?: () => void;
    /** Connection opened (live) or the connection failed (offline). */
    onConnection?: (status: SessionConnectionStatus) => void;
}

const registry = new Map<string, Set<SessionSignalHandlers>>();

export function onSessionSignals(sessionId: string, handlers: SessionSignalHandlers): () => void {
    let set = registry.get(sessionId);
    if (!set) {
        set = new Set();
        registry.set(sessionId, set);
    }
    set.add(handlers);
    return () => {
        const current = registry.get(sessionId);
        current?.delete(handlers);
        if (current && current.size === 0) registry.delete(sessionId);
    };
}

function dispatch(
    sessionId: string | null | undefined,
    run: (handlers: SessionSignalHandlers) => void,
): void {
    if (!sessionId) return;
    const set = registry.get(sessionId);
    if (!set) return;
    // Iterating the live set is safe for removals during dispatch; a listener
    // registering another listener is intentionally visited once as well.
    for (const handlers of set) {
        try {
            run(handlers);
        } catch (listenerError) {
            // A monitor listener must never break the SSE pipeline.
            logger.warn("sessionEvents listener failed", listenerError);
        }
    }
}

export function notifySessionEvent(sessionId: string | null | undefined): void {
    dispatch(sessionId, (handlers) => handlers.onData?.());
}

export function notifySessionConnection(
    sessionId: string | null | undefined,
    status: SessionConnectionStatus,
): void {
    dispatch(sessionId, (handlers) => handlers.onConnection?.(status));
}
