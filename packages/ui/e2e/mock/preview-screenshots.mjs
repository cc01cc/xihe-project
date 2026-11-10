import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2];
const BASE = process.argv[3] || "http://127.0.0.1:12696";
mkdirSync(OUT, { recursive: true });

const SHEETS = [
    { n: 1, file: "01-settings-instance-after.png" },
    { n: 2, file: "02-settings-before-after.png" },
    { n: 3, file: "03-sidebar-collapse-states.png" },
    { n: 4, file: "04-global-nav-collapsed-expanded.png" },
    { n: 5, file: "05-workspace-three-column-sash.png" },
    { n: 6, file: "06-empty-and-permission.png" },
];

const browser = await chromium.launch();
const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
});

let failed = false;
for (const s of SHEETS) {
    const errors = [];
    const onConsole = (m) => {
        if (m.type() === "error") errors.push(m.text());
    };
    const onError = (e) => errors.push("pageerror: " + e.message);
    page.on("console", onConsole);
    page.on("pageerror", onError);

    // Sheets are switched by hash (see src/preview/mock/MockApp.vue); a hash-only change fires
    // `hashchange` and re-renders without a reload, so one page serves all six.
    await page.goto(BASE + "/preview-mock.html#" + s.n, { waitUntil: "networkidle" });
    await page
        .waitForFunction(
            (n) => document.querySelector("header")?.textContent?.includes(String(n) + " · "),
            s.n,
            { timeout: 15000 },
        )
        .catch(() => {});
    await page.waitForTimeout(400);

    // A Vite transform error renders a red overlay *inside* the page; that must never reach a PNG.
    const overlay = await page.$("vite-error-overlay");
    if (overlay) {
        const msg = await page.evaluate(() => {
            const el = document.querySelector("vite-error-overlay");
            return el && el.shadowRoot ? el.shadowRoot.textContent.slice(0, 600) : "overlay";
        });
        console.log("FAIL " + s.file + " -> vite-error-overlay: " + msg);
        failed = true;
        page.off("console", onConsole);
        page.off("pageerror", onError);
        continue;
    }

    const box = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        sh: document.documentElement.scrollHeight,
    }));
    await page.screenshot({ path: join(OUT, s.file), fullPage: false });
    const tag = box.sw === 1920 && box.sh === 1080 ? "OK  " : "WARN";
    console.log(
        tag +
            " " +
            s.file +
            "  scroll=" +
            box.sw +
            "x" +
            box.sh +
            (errors.length ? "  errors=" + errors.length : ""),
    );
    if (errors.length) {
        failed = true;
        errors.slice(0, 6).forEach((e) => console.log("     " + e));
    }
    page.off("console", onConsole);
    page.off("pageerror", onError);
}
await browser.close();
if (failed) process.exit(1);
