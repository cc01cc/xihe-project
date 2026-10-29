import { expect, type Page, type Request } from "@playwright/test";

/**
 * PLAN-0586 helpers for the ui-health guard.
 *
 * Background (review round-1 #2): the previous fixed 1.5 s wait after `goto(... load)`
 * was a *delayed pageerror observation window*, not a rendering wait. Replacing it with
 * `waitForLoadState("load")` was a no-op and collapsed the window to two rAF ticks.
 * These helpers keep the guarantee while staying event-driven:
 *  1. `waitForRequestQuiescence` waits until no non-stream request is in flight (SSE and
 *     long-lived streams are excluded so chat/event pages can still settle);
 *  2. `waitForPageErrorWindow` then waits for the `pageerror` event itself, bounded by the
 *     configured window. A delayed error resolves it immediately and is still asserted by
 *     `expect(pageErrors).toHaveLength(0)`.
 * The window guarantee is proven by the one-shot negative probe in
 * `.local/plan-0586/plan0586-pageerror-probe.spec.ts` (run after the p2 stack window).
 */

/** SSE / long-lived streams keep a connection open and must not block quiescence. */
const LONG_LIVED_URL = /\/(events|sse)(\?|$)|heartbeat|stream|long-poll/i;

export function isLongLivedRequest(resourceType: string, url: string): boolean {
    return resourceType === "eventsource" || LONG_LIVED_URL.test(url);
}

export async function waitForRequestQuiescence(page: Page, timeoutMs = 5000): Promise<void> {
    const pending = new Set<Request>();
    const onRequest = (request: Request): void => {
        if (!isLongLivedRequest(request.resourceType(), request.url())) pending.add(request);
    };
    const onDone = (request: Request): void => {
        pending.delete(request);
    };
    page.on("request", onRequest);
    page.on("requestfinished", onDone);
    page.on("requestfailed", onDone);
    try {
        // `expect.poll` is the project's standard event-driven wait (explicit timeout,
        // no fixed sleep); it returns as soon as the tracked set drains.
        await expect
            .poll(() => pending.size, { timeout: timeoutMs, intervals: [100, 100, 200, 300, 500] })
            .toBe(0);
    } finally {
        page.off("request", onRequest);
        page.off("requestfinished", onDone);
        page.off("requestfailed", onDone);
    }
}

/**
 * Bounded, event-driven delayed-error window. Resolves immediately when a page error
 * arrives (the caller then fails on it); otherwise it expires after `windowMs`.
 */
export async function waitForPageErrorWindow(page: Page, windowMs = 1500): Promise<void> {
    await page.waitForEvent("pageerror", { timeout: windowMs }).catch(() => undefined);
}
