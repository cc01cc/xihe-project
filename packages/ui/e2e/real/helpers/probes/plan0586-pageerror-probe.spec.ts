// PLAN-0586 one-shot negative probe (review round-1 #2).
//
// Proves that the ui-health guard still catches a page error thrown ~500 ms AFTER the
// page load event. It needs no XH stack: the page is route-mocked inline.
//
// Run (from packages/ui; after the p2 E2E window is released):
//   cp e2e/real/helpers/probes/plan0586-pageerror-probe.spec.ts e2e/real/_plan0586-pageerror-probe.spec.ts
//   XIHE_E2E_EXTERNAL_SERVER=1 pnpm exec playwright test e2e/real/_plan0586-pageerror-probe.spec.ts --config e2e/playwright.config.ts
//   rm e2e/real/_plan0586-pageerror-probe.spec.ts   (windows: move to trash, do not commit)
//
// This file is NOT collected by the suite: playwright.config.ts testMatch is
// `e2e/real/*.spec.ts` (top level only), so the probes/ sub-directory stays out.
import { expect, test } from "@playwright/test";
import { waitForPageErrorWindow, waitForRequestQuiescence } from "../ui-stability";

test("@probe delayed pageerror (500 ms after load) is still captured by the ui-health guard", async ({
    page,
}) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.route("**/*", (route) =>
        route.fulfill({
            status: 200,
            contentType: "text/html",
            body: `<html><body><h1>pageerror probe</h1><script>
                setTimeout(() => { throw new Error("delayed-pageerror-0586"); }, 500);
            </script></body></html>`,
        }),
    );
    await page.goto("http://probe.local/", { waitUntil: "load" });
    // Same guard sequence as ui-health.spec.ts.
    await waitForRequestQuiescence(page);
    await waitForPageErrorWindow(page);
    expect(
        pageErrors,
        `delayed pageerror must be captured; got: ${pageErrors.join("; ")}`,
    ).toHaveLength(1);
});
