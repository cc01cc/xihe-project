/**
 * X 宣传卡自测 + 导出（card-spec.md §5）：
 * 1600×1200 画布单帧、无滚动、零外链、1 张图 naturalWidth>0、无拉踩词；导出 card.png / card-real.png。
 * 门控：XIHE_E2E_DEMO=1；variant 由 DEMO_VARIANT=real 切换。
 * runbook（门控变量 / 三步顺序 / 输入 HTML 契约 / 产出清单）：e2e/DEMO-CHANNEL.md。
 */
import { expect, test } from "./helpers/mock-test";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync, readFileSync } from "node:fs";

const DEMO = process.env.XIHE_E2E_DEMO === "1" || process.env.XIHE_E2E_DEMO_REAL === "1";
const VARIANT =
    process.env.DEMO_VARIANT === "real"
        ? "real"
        : process.env.DEMO_VARIANT === "en"
          ? "en"
          : "mock";
const LANG = VARIANT === "en" ? "en" : "zh";
const DIR = process.env.XIHE_E2E_DEMO_DIR ?? "";

test.describe("X 宣传卡", () => {
    test.skip(!DEMO, "只有 XIHE_E2E_DEMO(_REAL)=1 时才跑");
    test.use({ viewport: { width: 1600, height: 1200 } });

    test("单帧 1600×1200：无滚动 / 零外链 / 1 图可见 / 无拉踩词 + 导出 PNG", async ({ page }) => {
        mkdirSync(DIR, { recursive: true });
        const base = dirname(DIR);
        const html = join(
            base,
            VARIANT === "real"
                ? "xh-to-cc-card-real.html"
                : VARIANT === "en"
                  ? "xh-to-cc-card-en.html"
                  : "xh-to-cc-card.html",
        );
        const png = join(
            base,
            VARIANT === "real" ? "card-real.png" : VARIANT === "en" ? "card-en.png" : "card.png",
        );

        const requests: string[] = [];
        const consoleErrors: string[] = [];
        page.on("request", (request) => requests.push(request.url()));
        page.on("console", (message) => {
            if (message.type() === "error") consoleErrors.push(message.text());
        });
        page.on("pageerror", (error) => consoleErrors.push(error.message));

        await page.goto(pathToFileURL(html).href, { waitUntil: "load" });
        await expect(page.locator("h1")).toContainText(
            LANG === "en" ? "One session, one agent team" : "一支 agent 团队",
        );

        // 单帧：文档不得滚动（1600×1200 画布）
        const metrics = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            scrollHeight: document.documentElement.scrollHeight,
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            images: Array.from(document.images).map((image) => ({
                ok: image.complete && image.naturalWidth > 0,
                width: image.naturalWidth,
            })),
        }));
        expect(metrics.innerWidth, "画布宽").toBe(1600);
        expect(metrics.innerHeight, "画布高").toBe(1200);
        expect(metrics.scrollHeight, "不得纵向滚动").toBeLessThanOrEqual(1200);
        expect(metrics.scrollWidth, "不得横向滚动").toBeLessThanOrEqual(1600);
        expect(metrics.images, "只嵌 1 张截图").toHaveLength(1);
        expect(metrics.images[0]?.ok, "截图解码成功").toBe(true);
        // 2x 清晰度：主视觉源图必须是 2x 采集后裁切的 2880×1640（卡内按 1440×820 CSS 显示）
        expect(metrics.images[0]?.width, "主视觉应为 2x 源图").toBeGreaterThanOrEqual(2600);

        const external = requests.filter(
            (url) => !url.startsWith("file://") && !url.startsWith("data:"),
        );
        expect(external, `外链: ${external.join(", ")}`).toEqual([]);
        expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);

        const text = await page.evaluate(() => document.body.innerText);
        const banned =
            LANG === "en"
                ? /best|only one|crush|dominate|game[- ]changer|parallel agents respond/i
                : /最强|唯一|吊打|碾压|远超|降维|Cursor|Claude Code|Devin|OpenHands|Manus|AutoGPT|群策群力|多个 agent 同时回应|支持多 ?agent 并行/i;
        expect(banned.test(text), `命中禁用文案: ${text.match(banned)?.[0] ?? ""}`).toBe(false);
        // 如实口径：单发/多抄送/归属可见，不得宣称"多 agent 同时回应"
        expect(text).toContain(LANG === "en" ? "Directed dispatch" : "定向分派");
        // 用户追加：未实现的方向只能以「开发中 / in development」出现在 Roadmap 行里
        expect(text).toContain(LANG === "en" ? "(in development)" : "开发中");
        expect(text).toContain(
            LANG === "en" ? "multiple agents respond in parallel" : "多个 agent 并行回应",
        );
        // v4：slogan + 项目地址 + 博客（纯文本，不超链）
        expect(text).toContain(LANG === "en" ? "Explore & Create" : "探索 & 创造");
        expect(text).toContain("github.com/cc01cc/xihe-project");
        expect(text).toContain("cc01cc.com");
        // 用户定调（2026-11-05）：必须写明「工程稿（开发中版本），非最终发布形态」/ work-in-progress
        if (LANG === "en") {
            expect(text).toContain("work-in-progress");
            expect(text).toContain("not the final form");
        } else {
            expect(text).toContain("工程稿");
            expect(text).toContain("非最终发布形态");
        }

        // 导出 2x：3200×2400 PNG（DSF=2），与 CSS 画布 1600×1200 一一对应。
        await page.screenshot({ path: png, scale: "device" });
        const pngBytes = readFileSync(png);
        const pngWidth = pngBytes.readUInt32BE(16);
        const pngHeight = pngBytes.readUInt32BE(20);
        expect(pngWidth, "导出图宽").toBe(3200);
        expect(pngHeight, "导出图高").toBe(2400);
        console.log(
            `[card] variant=${VARIANT} png=${png} requests=${requests.length} external=0 images=1 scroll=${metrics.scrollWidth}x${metrics.scrollHeight}`,
        );
    });
});
