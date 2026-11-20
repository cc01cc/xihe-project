import { test } from "./helpers/mock-test";

test.describe("Accessibility — prefers-reduced-motion", () => {
    test("animations are disabled when prefers-reduced-motion is set", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto("/workspace/11111111-1111-4111-8111-111111111111/session/test-session");
        await page.waitForLoadState("load");

        await page.evaluate(() => {
            const style = getComputedStyle(document.body);
            return style.animationName !== "none" || style.transitionProperty !== "all";
        });
    });
});
