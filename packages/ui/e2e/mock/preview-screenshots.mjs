/**
 * DEPRECATED(task-137-rev2)：D-914 ① 交付改为「真产品页面 + 网络层 mock」，本文件属更早的「静态设计稿单页」路线，已不再渲染也不再产出交付图；**保留不删**（Lead 口径：零删除，退役由 PLAN-0764 M1 合并时统一处理）。指标：task-137 rev2 的真实入口是 preview-real.html + src/preview/mock/api-server.ts。
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * task-127（D-903）/ task-137（B）：整窗稿截图工具 —— 整窗视口 + 单页长图 + 关键局部放大。
 * 交付图仍以 scripts/ui-mock-shot.mjs 为唯一拍法（本脚本只做「局部放大」补充镜头）。
 *
 * 取景与 SHOTS 一致：默认 = 窗口固定 1920×1080；?winlong=1 = 窗口随内容撑高（长图）。
 * Usage: node e2e/mock/preview-screenshots.mjs <outDir> [base]
 */
const OUT = process.argv[2];
const BASE = process.argv[3] || "http://127.0.0.1:12630";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
    viewport: { width: 2000, height: 1400 },
    deviceScaleFactor: 1,
});
const errs = [];
page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
});
page.on("pageerror", (e) => errs.push("pageerror: " + e.message));

async function settle() {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
}

// 整窗视口（默认取景）
await page.goto(BASE + "/preview-mock.html", { waitUntil: "networkidle" });
await settle();
await page.locator("[data-mock-window]").screenshot({
    path: join(OUT, "00-window-view.png"),
    animations: "disabled",
});

// 单页长图（窗口撑高取景）
await page.goto(BASE + "/preview-mock.html?winlong=1", { waitUntil: "networkidle" });
await settle();
await page.locator("[data-mock-window]").screenshot({
    path: join(OUT, "01-single-page-full.png"),
    animations: "disabled",
});

// 局部放大 = 元素级 clip：实例层一个域、用户层展开示例、rail 与右 dock 各成图。
const CROPS = [
    { sel: "[data-mock-domain=llm-provider]", file: "02-zoom-llm-provider.png" },
    { sel: "[data-mock-domain=user-preference]", file: "03-zoom-user-layer.png" },
    { sel: "[data-mock-window] aside", file: "04-zoom-rail.png", nth: 0 },
    { sel: "[data-mock-window] aside", file: "05-zoom-dock.png", nth: 2 },
];
await page.goto(BASE + "/preview-mock.html", { waitUntil: "networkidle" });
await settle();
for (const crop of CROPS) {
    const el = page.locator(crop.sel).nth(crop.nth ?? 0);
    await el.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await el.screenshot({ path: join(OUT, crop.file), animations: "disabled" });
}
console.log("shots written, console errors: " + errs.length);
errs.slice(0, 5).forEach((e) => console.log("  " + e));
await browser.close();
process.exit(errs.length ? 1 : 0);
