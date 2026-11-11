import { chromium } from "@playwright/test";
const BASE = process.argv[2] || "http://127.0.0.1:12630";

/**
 * task-127（D-903）**单页稿内容检查** —— 原脚本校验 SHEETS 1-6 每屏关键词（hash 切换器已撤）。
 * 判据：单页上必须出现「层标题 / 字段键 / 页底三条 / 稿头」；不得出现旧切换器与已删第三层。
 * 旧场景稿的 EXPECT/FORBIDDEN（#1..#6）属于已退役的稿形态，git 历史可查。
 */
const EXPECT = [
    "Xihe 设置区 · 单页设计稿",
    "全局默认（实例层）",
    "用户偏好（用户层）",
    "profile.providerId",
    "defaults.fingerprintEnabled",
    "user-preference",
    "同体系参考区",
    "rail / 聊天 / 库",
];
const FORBIDDEN = ["切换层：", "工作区层", "01 · ", "globalNav"];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
});
await page.goto(BASE + "/preview-mock.html", { waitUntil: "networkidle" });
await page.waitForTimeout(500);

const text = await page.evaluate(() => document.body.innerText);
const missing = EXPECT.filter((w) => !text.includes(w));
const leaked = FORBIDDEN.filter((w) => text.includes(w));
const apiCalls = await page.evaluate(() =>
    performance
        .getEntriesByType("resource")
        .map((e) => e.name)
        .filter((u) => u.includes("/api/v1/")),
);
const weak = await page.evaluate(() => ({
    fields: document.querySelectorAll("[data-mock-field]").length,
    domains: document.querySelectorAll("[data-mock-domain]").length,
    strips: document.querySelectorAll("[data-mock-strip]").length,
}));
let bad = 0;
if (missing.length || leaked.length || apiCalls.length) bad++;
if (weak.fields < 100 || weak.domains !== 21 || weak.strips !== 3) bad++;
console.log(
    "single-page -> " +
        (missing.length ? "MISSING " + missing.join(",") : "ok") +
        (leaked.length ? " | FORBIDDEN PRESENT: " + leaked.join(",") : "") +
        (apiCalls.length ? " | API CALLS: " + apiCalls.length : ""),
);
console.log("fields=" + weak.fields + " domains=" + weak.domains + " strips=" + weak.strips);
console.log("pageerrors/console errors: " + errs.length);
errs.slice(0, 5).forEach((e) => console.log("  " + e));
await browser.close();
process.exit(bad ? 1 : 0);
