/**
 * DEPRECATED(task-137-rev2)：D-914 ① 交付改为「真产品页面 + 网络层 mock」，本文件属更早的「静态设计稿单页」路线，已不再渲染也不再产出交付图；**保留不删**（Lead 口径：零删除，退役由 PLAN-0764 M1 合并时统一处理）。指标：task-137 rev2 的真实入口是 preview-real.html + src/preview/mock/api-server.ts。
 */
import { chromium } from "@playwright/test";
const BASE = process.argv[2] || "http://127.0.0.1:12630";

/**
 * task-127（D-903）**单页稿内容检查** —— 原脚本校验 SHEETS 1-6 每屏关键词（hash 切换器已撤）。
 * task-137（B）整窗构图 + D-911 用户层折叠后，判据改为：
 *   ① 真窗口三区在对（rail 56 / 设置左栏 256 / 内容列 / 聊天条 / 右 dock 360，尺寸 1920×1080）；
 *   ② 内容 = 实例层 12 域全量字段 + 用户层 9 域折叠行 + 一个「按人覆盖」展开示例；
 *   ③ 中文适配：字段 label 全是中文（无未译），枚举值显示中文标签；
 *   ④ 禁止项：旧切换器、旧「同体系参考区」页底条（已并入真实位置）、任何 /api/v1 调用。
 * 旧场景稿的 EXPECT/FORBIDDEN（#1..#6）属于已退役的稿形态，git 历史可查。
 */
const EXPECT = [
    "设置",
    "全局默认（实例层）",
    "用户偏好（用户层 · 默认折叠）",
    "提供商 ID",
    "连接标识",
    "模型采样参数",
    "继承自实例默认",
    "项可覆盖",
    "按人覆盖（示例）",
    "输入消息…",
    "搜索库内容",
    "搜索设置",
];
const FORBIDDEN = ["切换层：", "工作区层", "01 · ", "globalNav", "同体系参考区"];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 2000, height: 1400 } });
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
const dom = await page.evaluate(() => {
    const win = document.querySelector("[data-mock-window]");
    const box = win ? win.getBoundingClientRect() : null;
    const rail = win?.querySelector("aside");
    const nav = win?.querySelectorAll("aside")[1];
    const dock = win?.querySelectorAll("aside")[2];
    const labels = [...document.querySelectorAll("[data-mock-field]")].map((el) =>
        (el.querySelector("[data-mock-label]")?.textContent ?? "").trim(),
    );
    const cjk = /[\u4e00-\u9fff]/;
    return {
        hasWindow: Boolean(win),
        size: box ? { width: Math.round(box.width), height: Math.round(box.height) } : null,
        railButtons: rail?.querySelectorAll("button").length ?? 0,
        railWidth: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
        navWidth: nav ? Math.round(nav.getBoundingClientRect().width) : 0,
        dockWidth: dock ? Math.round(dock.getBoundingClientRect().width) : 0,
        fields: document.querySelectorAll("[data-mock-field]").length,
        domains: document.querySelectorAll("[data-mock-domain]").length,
        strips: document.querySelectorAll("[data-mock-strip]").length,
        untranslated: labels.filter((label) => !cjk.test(label)).length,
        collapsedRows: document.querySelectorAll("[data-mock-domain]").length,
        chatBar: document.body.innerText.includes("发送"),
    };
});
let bad = 0;
if (missing.length || leaked.length || apiCalls.length) bad++;
if (!dom.hasWindow || dom.size?.width !== 1920 || dom.size?.height !== 1080) bad++;
if (dom.railWidth !== 56 || dom.navWidth !== 256 || dom.dockWidth !== 360) bad++;
if (dom.railButtons < 3 || !dom.chatBar) bad++;
if (dom.fields < 70 || dom.domains < 20 || dom.strips !== 0) bad++;
if (dom.untranslated > 0) bad++;
console.log(
    "single-page -> " +
        (missing.length ? "MISSING " + missing.join(",") : "ok") +
        (leaked.length ? " | FORBIDDEN PRESENT: " + leaked.join(",") : "") +
        (apiCalls.length ? " | API CALLS: " + apiCalls.length : ""),
);
console.log(
    "window=" +
        (dom.size ? dom.size.width + "x" + dom.size.height : "none") +
        " rail=" +
        dom.railWidth +
        "(" +
        dom.railButtons +
        "btn) nav=" +
        dom.navWidth +
        " dock=" +
        dom.dockWidth +
        " chatBar=" +
        dom.chatBar,
);
console.log(
    "fields=" +
        dom.fields +
        " domains=" +
        dom.domains +
        " strips=" +
        dom.strips +
        " untranslated=" +
        dom.untranslated,
);
console.log("pageerrors/console errors: " + errs.length);
errs.slice(0, 5).forEach((e) => console.log("  " + e));
await browser.close();
process.exit(bad ? 1 : 0);
