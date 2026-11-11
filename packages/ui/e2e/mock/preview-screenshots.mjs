import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * task-127（D-903）：单页稿截图工具 —— 整页长图 + 关键局部放大。
 * 交付图仍以 scripts/ui-mock-shot.mjs 为唯一拍法（本脚本只做「局部放大」补充镜头）。
 *
 * Usage: node e2e/mock/preview-screenshots.mjs <outDir> [base]
 */
const OUT = process.argv[2];
const BASE = process.argv[3] || "http://127.0.0.1:12630";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
});
const errs = [];
page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
});
page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
await page.goto(BASE + "/preview-mock.html", { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(400);

await page.screenshot({ path: join(OUT, "00-single-page-full.png"), fullPage: true });

// 局部放大 = 元素级 clip：域块与页底三条各自成图。
const CROPS = [
    { sel: '[data-mock-domain="llm-provider"]', file: "01-zoom-llm-provider.png" },
    { sel: '[data-mock-domain="agent-runtime"]', file: "02-zoom-agent-runtime.png" },
    { sel: '[data-mock-strip="rail"]', file: "03-zoom-rail.png" },
];
for (const crop of CROPS) {
    const el = page.locator(crop.sel).first();
    await el.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await el.screenshot({ path: join(OUT, crop.file), animations: "disabled" });
}
console.log("shots written, console errors: " + errs.length);
errs.slice(0, 5).forEach((e) => console.log("  " + e));
await browser.close();
process.exit(errs.length ? 1 : 0);
