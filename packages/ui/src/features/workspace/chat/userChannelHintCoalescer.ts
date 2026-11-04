/**
 * PLAN-0660 T5.6 — coalescing for `user-events` hints.
 *
 * The user channel deliberately sends *hints*, not data (`spec/session/user-channel.md` §4): a burst of
 * `participant_notified` frames must collapse into ONE roster reload, otherwise three tabs or three
 * quick `@`s turn into a request storm. Nothing here computes an unread count — the badge always
 * renders the CP-derived `readCursor.mentionCount`; this only decides *when* to re-read it.
 */
export interface HintCoalescerOptions {
    /** How long to wait for more hints before flushing (default 300ms). */
    delayMs?: number;
    /** Invoked once per window; never carries a count or a payload. */
    onFlush: () => void;
    /** Injected for tests; defaults to `setTimeout`. */
    schedule?: (callback: () => void, delayMs: number) => unknown;
    /** Injected for tests; defaults to `clearTimeout`. */
    cancel?: (handle: unknown) => void;
}

export interface HintCoalescer {
    /**
     * Record a hint for one participant of one session.
     *
     * @returns `true` when the hint was accepted (session matches and a flush is pending), `false`
     *     when it was ignored (another session is on screen) — the caller can assert on this directly.
     */
    push: (sessionId: string, participantId: string) => boolean;
    /** Drop any pending flush (e.g. the store is torn down). */
    dispose: () => void;
}

export function createHintCoalescer(currentSessionId: () => string | null,
                                    options: HintCoalescerOptions): HintCoalescer {
    const delayMs = options.delayMs ?? 300;
    const schedule = options.schedule
        ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
    const cancel = options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    let pending: unknown = null;

    return {
        push(sessionId: string, participantId: string): boolean {
            if (!sessionId || sessionId !== currentSessionId()) return false;
            // The participant id is not used to count anything — it only proves the hint targets a row
            // of the session that is currently rendered.
            if (!participantId) return false;
            if (pending !== null) return true; // already scheduled: coalesce
            pending = schedule(() => {
                pending = null;
                options.onFlush();
            }, delayMs);
            return true;
        },
        dispose(): void {
            if (pending !== null) {
                cancel(pending);
                pending = null;
            }
        },
    };
}
