import { chromium } from "@playwright/test";
const BASE = "http://127.0.0.1:12696";
const EXPECT = {
    1: ["RAG 检索", "继承自实例层", "返回对话"],
    2: ["改造前", "SettingsSidebar.vue", "改造后"],
    3: ["「域」折起", "「域」展开", "我的资源"],
    4: ["折叠态", "展开态", "设置 · 实例层"],
    5: ["抓手三态", "硬底线 640px", "240px"],
    6: ["本域 0 项配置", "MANAGE_ROLES", "不是后端缺口"],
};
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
});
await page.goto(BASE + "/preview-mock.html", { waitUntil: "networkidle" });
let bad = 0;
for (const [n, words] of Object.entries(EXPECT)) {
    await page.goto(BASE + "/preview-mock.html#" + n);
    await page.waitForTimeout(500);
    const text = await page.evaluate(() => document.body.innerText);
    const missing = words.filter((w) => !text.includes(w));
    const apiCalls = await page.evaluate(() =>
        performance
            .getEntriesByType("resource")
            .map((e) => e.name)
            .filter((u) => u.includes("/api/v1/")),
    );
    if (missing.length || apiCalls.length) bad++;
    console.log(
        "sheet " +
            n +
            " -> " +
            (missing.length ? "MISSING " + missing.join(",") : "ok") +
            (apiCalls.length ? " | API CALLS: " + apiCalls.length : ""),
    );
}
console.log("pageerrors/console errors: " + errs.length);
errs.slice(0, 5).forEach((e) => console.log("  " + e));
await browser.close();
process.exit(bad ? 1 : 0);
