import { chromium } from "@playwright/test";
const BASE = "http://127.0.0.1:12696";
const EXPECT = {
    1: ["RAG 检索", "继承自实例层", "返回对话", "当前层", "安全与权限", "/settings/instance"],
    2: ["改造前", "SettingsSidebar.vue", "改造后"],
    3: ["「实例」折起", "「实例」展开", "实例运维"],
    4: ["折叠态", "展开态", "设置 · 实例层"],
    5: ["抓手三态", "硬底线 640px", "240px"],
    6: ["本域 0 项配置", "MANAGE_ROLES", "不是后端缺口"],
};
// A/B 判别力：2026-11-10 用户裁定的三条修正如果回退，这里必须红。
// 「切换层」是旧控件、「工作区层」是已删除的第三层 —— 两者都不该再出现在左栏。
// 精确到旧控件的可见标签（`切换层：实例 / 用户 / 工作区`），避免误伤解释文案里对「切换层」的引用。
const FORBIDDEN = {
    1: ["切换层：", "工作区层"],
    2: ["切换层："],
    3: ["切换层："],
    4: ["切换层："],
    5: ["切换层："],
    6: ["切换层："],
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
    const leaked = (FORBIDDEN[n] ?? []).filter((w) => text.includes(w));
    const apiCalls = await page.evaluate(() =>
        performance
            .getEntriesByType("resource")
            .map((e) => e.name)
            .filter((u) => u.includes("/api/v1/")),
    );
    if (missing.length || leaked.length || apiCalls.length) bad++;
    console.log(
        "sheet " +
            n +
            " -> " +
            (missing.length ? "MISSING " + missing.join(",") : "ok") +
            (leaked.length ? " | FORBIDDEN PRESENT: " + leaked.join(",") : "") +
            (apiCalls.length ? " | API CALLS: " + apiCalls.length : ""),
    );
}
console.log("pageerrors/console errors: " + errs.length);
errs.slice(0, 5).forEach((e) => console.log("  " + e));
await browser.close();
process.exit(bad ? 1 : 0);
