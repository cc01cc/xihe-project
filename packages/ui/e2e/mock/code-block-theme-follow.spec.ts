import { expect, test } from "./helpers/mock-test";
import { setupMockAuth } from "./helpers/auth";

// PLAN-0753 M1 (F2, task-167 render matrix): code blocks must follow the document scheme —
// the shiki singleton emits BOTH palettes as CSS custom properties (defaultColor: false) and
// styles/main.css picks one by the Tailwind dark class on <html>. Nothing may pin a theme.
//
// The component pipeline (dual-var emission + DOMPurify survival) is covered by unit tests
// (CodeBlockToken.spec / CodeBlock.spec); this probe proves the stylesheet half in a REAL
// browser: inject shiki-shaped output (the exact shape CodeBlock renders via v-html), toggle
// the app dark class, and read computed styles. In-page DOM only — no fetch, no API.
test.describe("CodeBlock theme following", () => {
    test("shiki dual-theme palette switches with the app dark class", async ({ page }) => {
        await setupMockAuth(page);
        await page.goto("/workspace");
        await page.waitForLoadState("load");

        await page.evaluate(() => {
            const host = document.createElement("div");
            host.id = "f2-shiki-probe";
            host.innerHTML = [
                '<pre class="shiki" style="--shiki-light-bg:#ffffff;--shiki-dark-bg:#0d1117">',
                '<code><span class="f2-probe-token" style="--shiki-light:#24292e;--shiki-dark:#e1e4e8">const x = 1</span></code>',
                "</pre>",
            ].join("");
            document.body.appendChild(host);
        });

        const readProbe = () =>
            page.evaluate(() => {
                const token = document.querySelector(".f2-probe-token") as HTMLElement;
                const pre = document.querySelector("#f2-shiki-probe pre") as HTMLElement;
                return {
                    color: getComputedStyle(token).color,
                    background: getComputedStyle(pre).backgroundColor,
                };
            });

        // Default = light palette.
        const light = await readProbe();
        expect(light.color).toBe("rgb(36, 41, 46)"); // --shiki-light #24292e
        expect(light.background).toBe("rgb(255, 255, 255)"); // --shiki-light-bg #ffffff

        // The dark palette paints purely from CSS — no re-highlight, no attribute change
        // beyond the app's own dark class.
        await page.evaluate(() => document.documentElement.classList.add("dark"));
        const dark = await readProbe();
        expect(dark.color).toBe("rgb(225, 228, 232)"); // --shiki-dark #e1e4e8
        expect(dark.background).toBe("rgb(13, 17, 23)"); // --shiki-dark-bg #0d1117

        await page.evaluate(() => document.documentElement.classList.remove("dark"));
        const restored = await readProbe();
        expect(restored.color).toBe("rgb(36, 41, 46)");
    });
});
