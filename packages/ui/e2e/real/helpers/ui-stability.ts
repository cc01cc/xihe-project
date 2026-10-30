import { expect, type Page, type Request } from "@playwright/test";

/**
 * PLAN-0586 helpers for the ui-health guard.
 *
 * Background (review round-1 #2 / round-2 P1): the previous fixed 1.5 s wait after
 * `goto(... load)` was a *delayed pageerror observation window*, not a rendering wait.
 * Replacing it with `waitForLoadState("load")` was a no-op; and attaching request
 * listeners after `goto` meant already in-flight requests never entered the pending set
 * (the quiescence poll returned 0 on the first tick). The tracker therefore must be
 * created BEFORE navigation:
 *
 *   const tracker = startRequestTracker(page);
 *   try {
 *       await page.goto(...);
 *       await tracker.waitForQuiescence();
 *       await waitForPageErrorWindow(page);
 *   } finally {
 *       tracker.dispose();
 *   }
 *
 * `waitForPageErrorWindow` stays a bounded `page.waitForEvent("pageerror")` observation
 * window (not a fixed sleep): a delayed error resolves it immediately and is still
 * asserted by `expect(pageErrors).toHaveLength(0)`.
 *
 * The window guarantee is proven by the negative probe in
 * `e2e/real/helpers/probes/plan0586-pageerror-probe.spec.ts` (copied into testDir only
 * while running; see the probe header for the exact commands).
 */

/** SSE / long-lived streams keep a connection open and must not block quiescence. */
const LONG_LIVED_URL = /\/(events|sse)(\?|$)|heartbeat|stream|long-poll/i;

export function isLongLivedRequest(resourceType: string, url: string): boolean {
    return resourceType === "eventsource" || LONG_LIVED_URL.test(url);
}

export interface RequestTracker {
    /** Resolves once no tracked (non-stream) request is in flight. */
    waitForQuiescence(timeoutMs?: number): Promise<void>;
    /** Number of tracked requests observed since the tracker was created (evidence). */
    observedCount(): number;
    /** Detaches the listeners; safe to call more than once. */
    dispose(): void;
}

export function startRequestTracker(page: Page): RequestTracker {
    const pending = new Set<Request>();
    let observed = 0;
    const onRequest = (request: Request): void => {
        if (isLongLivedRequest(request.resourceType(), request.url())) return;
        pending.add(request);
        observed += 1;
    };
    const onDone = (request: Request): void => {
        pending.delete(request);
    };
    page.on("request", onRequest);
    page.on("requestfinished", onDone);
    page.on("requestfailed", onDone);
    let disposed = false;
    return {
        async waitForQuiescence(timeoutMs = 5000): Promise<void> {
            // `expect.poll` is the project's standard event-driven wait (explicit timeout,
            // no fixed sleep); it returns as soon as the tracked set drains.
            await expect
                .poll(() => pending.size, {
                    timeout: timeoutMs,
                    intervals: [100, 100, 200, 300, 500],
                })
                .toBe(0);
        },
        observedCount(): number {
            return observed;
        },
        dispose(): void {
            if (disposed) return;
            disposed = true;
            page.off("request", onRequest);
            page.off("requestfinished", onDone);
            page.off("requestfailed", onDone);
        },
    };
}

/**
 * Bounded, event-driven delayed-error window. Resolves immediately when a page error
 * arrives (the caller then fails on it); otherwise it expires after `windowMs`.
 */
export async function waitForPageErrorWindow(page: Page, windowMs = 1500): Promise<void> {
    try {
        await page.waitForEvent("pageerror", { timeout: windowMs });
    } catch (error) {
        // Only a timeout means "no delayed error observed"; any other failure (page
        // closed/crashed) must surface instead of silently passing the later assertion.
        const isTimeout = error instanceof Error && error.name === "TimeoutError";
        if (!isTimeout) throw error;
    }
}
