// PLAN-0586 one-shot negative probe (review round-1 #2 / round-2 P1).
//
// Proves that the ui-health guard still catches a page error thrown ~500 ms AFTER the
// page load event, with the request tracker attached BEFORE navigation (so navigation
// requests are tracked). It needs no XH stack: the page is route-mocked inline.
//
// Run (from packages/ui; stack not required, after the p2 E2E window is released):
//   (Get-Content e2e/real/helpers/probes/plan0586-pageerror-probe.spec.ts -Raw).
//     Replace('../ui-stability','./helpers/ui-stability') |
//     Set-Content e2e/real/_plan0586-pageerror-probe.spec.ts -NoNewline
//   $env:XIHE_E2E_EXTERNAL_SERVER='1'
//   pnpm exec playwright test e2e/real/_plan0586-pageerror-probe.spec.ts --config e2e/playwright.config.ts
//   # expected: 1 passed, with PLAN0586_PROBE requests/pageErrors lines as evidence
//   # afterwards move _plan0586-pageerror-probe.spec.ts out of testDir (do not commit it)
//
// This file is NOT collected by the suite: playwright.config.ts testMatch is
// `e2e/real/*.spec.ts` (top level only), so the probes/ sub-directory stays out.
import { expect, test } from "@playwright/test";
import { startRequestTracker, waitForPageErrorWindow } from "../ui-stability";

test("@probe delayed pageerror (500 ms after load) is still captured by the ui-health guard", async ({
    page,
}) => {
    const pageErrors: string[] = [];
    const requests: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    page.on("request", (request) => requests.push(`${request.resourceType()} ${request.url()}`));
    page.on("requestfinished", (request) =>
        requests.push(`finished ${request.resourceType()} ${request.url()}`),
    );
    await page.route("**/*", (route) =>
        route.fulfill({
            status: 200,
            contentType: "text/html",
            body: `<html><body><h1>pageerror probe</h1><script>
                setTimeout(() => { throw new Error("delayed-pageerror-0586"); }, 500);
            </script></body></html>`,
        }),
    );
    // Same guard sequence as ui-health.spec.ts: tracker first, then navigation.
    const tracker = startRequestTracker(page);
    try {
        await page.goto("http://probe.local/", { waitUntil: "load" });
        await tracker.waitForQuiescence();
        await waitForPageErrorWindow(page);
    } finally {
        tracker.dispose();
    }
    // Evidence for review round-2: request lifecycle + the delayed pageerror itself.
    console.log(`PLAN0586_PROBE requests=${JSON.stringify(requests)}`);
    console.log(`PLAN0586_PROBE pageErrors=${JSON.stringify(pageErrors)}`);
    // round-2 P1: the tracker is attached BEFORE goto, so the navigation request must be
    // observed (attaching after goto would report 0 and make quiescence a no-op).
    console.log(`PLAN0586_PROBE trackedRequests=${tracker.observedCount()}`);
    expect(tracker.observedCount()).toBeGreaterThan(0);
    expect(
        pageErrors,
        `delayed pageerror must be captured; got: ${pageErrors.join("; ")}`,
    ).toHaveLength(1);
    expect(pageErrors[0]).toContain("delayed-pageerror-0586");
    expect(requests.some((entry) => entry.startsWith("finished document "))).toBe(true);
});
