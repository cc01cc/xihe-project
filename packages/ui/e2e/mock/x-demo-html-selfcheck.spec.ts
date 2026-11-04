/**
 * X 图文（单文件 HTML）自测：`file://` 打开、零外链、5 图全部可见、打印媒体不塌。
 * 只有 `XIHE_E2E_DEMO=1` 时执行；HTML 路径取 `XIHE_E2E_DEMO_DIR` 的上一级。
 */
import { test, expect } from "@playwright/test";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync } from "node:fs";

const DEMO = process.env.XIHE_E2E_DEMO === "1" || process.env.XIHE_E2E_DEMO_REAL === "1";
const VARIANT_RAW = process.env.DEMO_VARIANT ?? "mock";
const VARIANT = VARIANT_RAW === "real" || VARIANT_RAW === "real-en" ? VARIANT_RAW : VARIANT_RAW === "en" ? "en" : "mock";
const LANG = VARIANT === "en" || VARIANT === "real-en" ? "en" : "zh";
const IS_REAL = VARIANT === "real" || VARIANT === "real-en";
const EXPECTED_IMAGES = IS_REAL ? 4 : 5;
const SHOT_DIR = process.env.XIHE_E2E_DEMO_DIR ?? "";
const HTML = join(
    dirname(SHOT_DIR),
    IS_REAL ? (LANG === "en" ? "xh-to-cc-multi-principal-real-en.html" : "xh-to-cc-multi-principal-real.html") : LANG === "en" ? "xh-to-cc-multi-principal-en.html" : "xh-to-cc-multi-principal.html",
);

test.describe("X 图文自测", () => {
    test.skip(!DEMO, "只有 XIHE_E2E_DEMO=1 时才跑");

    test("file:// 打开：无外链、图片可见、打印不塌", async ({ page }) => {
        mkdirSync(SHOT_DIR, { recursive: true });
        const requests: string[] = [];
        const consoleErrors: string[] = [];
        page.on("request", (request) => requests.push(request.url()));
        page.on("console", (message) => {
            if (message.type() === "error") consoleErrors.push(message.text());
        });
        page.on("pageerror", (error) => consoleErrors.push(error.message));

        await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
        await expect(page.locator("h1")).toBeVisible();
        await expect(page.locator("h1")).toContainText(
            LANG === "en" ? "send work to the right person" : "把任务发给对的人",
        );

        // 结构：hero + 为什么 + 能力 + 截图 + 限制 + 了解更多
        await expect(page.locator("section h2")).toHaveCount(5);
        const figureCount = await page.locator("figure img").count();
        expect(figureCount, `${EXPECTED_IMAGES} 张内嵌截图`).toBe(EXPECTED_IMAGES);

        // 图片真的解码成功（base64 内嵌 ⇒ naturalWidth > 0）
        const images = await page.evaluate(() =>
            Array.from(document.images).map((image) => ({
                ok: image.complete && image.naturalWidth > 0,
                width: image.naturalWidth,
            })),
        );
        expect(images, "图片全部可见").toHaveLength(EXPECTED_IMAGES);
        expect(images.every((image) => image.ok), JSON.stringify(images)).toBe(true);
        // 每张图必须互不相同（2026-11-04 Lead 实测 02/03 同图 ⇒ 构图退化，加门禁）。
        const sources = await page.evaluate(() =>
            Array.from(document.images).map((image) => image.getAttribute("src") ?? ""),
        );
        expect(new Set(sources).size, `${EXPECTED_IMAGES} 张图必须两两不同`).toBe(EXPECTED_IMAGES);

        // 零外链：所有请求都是 file:// 本身（data: 不算网络请求，浏览器不发请求）
        const external = requests.filter(
            (url) => !url.startsWith("file://") && !url.startsWith("data:"),
        );
        expect(external, `外链请求: ${external.join(", ")}`).toEqual([]);
        expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);

        // 声明与限制必须在（2026-11-05 用户定调：必须写「工程稿（开发中版本），非最终发布形态」）
        if (LANG === "en") {
            await expect(page.getByText("work-in-progress").first()).toBeVisible();
            await expect(page.getByText("not the final form").first()).toBeVisible();
            await expect(page.getByText("demonstration data").first()).toBeVisible();
        } else {
            await expect(page.getByText("工程稿").first()).toBeVisible();
            await expect(page.getByText("非最终发布形态").first()).toBeVisible();
            await expect(
                page
                    .getByText(IS_REAL ? "会话数据与模型调用为真实运行" : "数据为演示数据")
                    .first(),
            ).toBeVisible();
        }
        for (const tag of ["BL-239", "BL-197", "BL-237"]) {
            await expect(page.getByText(tag, { exact: false }).first()).toBeVisible();
        }

        // 屏 1：顶部（hero + 为什么）
        await page.screenshot({ path: join(SHOT_DIR, "html-01-top.png"), scale: "css" });
        // 屏 2：截图区（第一张大图）
        await page.locator("figure img").first().scrollIntoViewIfNeeded();
        await page.waitForTimeout(200);
        await page.screenshot({ path: join(SHOT_DIR, "html-02-figure.png"), scale: "css" });
        // 屏 3：限制段
        await page
            .getByText(LANG === "en" ? "Boundaries and known limits" : "边界与已知限制")
            .scrollIntoViewIfNeeded();
        await page.waitForTimeout(200);
        await page.screenshot({ path: join(SHOT_DIR, "html-03-limits.png"), scale: "css" });

        // 打印媒体：不是塌成空白（全文高度 + 图片仍可见、不被裁断）
        await page.emulateMedia({ media: "print" });
        const printHeight = await page.evaluate(() => document.documentElement.scrollHeight);
        expect(printHeight, "打印媒体下文档高度").toBeGreaterThan(2000);
        const printImages = await page.locator("figure img").evaluateAll((nodes) =>
            nodes.map((node) => {
                const rect = node.getBoundingClientRect();
                return { height: rect.height, width: rect.width, right: rect.right };
            }),
        );
        expect(printImages, `打印媒体下 ${EXPECTED_IMAGES} 张图都在`).toHaveLength(EXPECTED_IMAGES);
        expect(
            printImages.every((image) => image.height > 100),
            `打印时图片高度异常: ${JSON.stringify(printImages)}`,
        ).toBe(true);
        // 打印媒体下正文按纸张宽度铺满（`@media print` 取消 1100 版心），只要没有横向溢出即可。
        const printOverflow = await page.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth + 1,
        );
        expect(printOverflow, "打印媒体横向溢出").toBe(false);
        await page.screenshot({
            path: join(SHOT_DIR, "html-04-print.png"),
            scale: "css",
            fullPage: true,
        });

        // 文案纪律：不出现其它 harness / 产品的对比拉踩词
        await page.emulateMedia({ media: "screen" });
        const text = await page.evaluate(() => document.body.innerText);
        const banned =
            LANG === "en"
                ? /best|only one|crush|dominate|game[- ]changer|parallel agents respond/i
                : /最强|唯一|吊打|碾压|远超|降维|Cursor|Claude Code|Devin|OpenHands|Manus|AutoGPT/i;
        expect(banned.test(text), `命中禁用文案: ${text.match(banned)?.[0] ?? ""}`).toBe(false);

        // 响应式：1440 / 1100 / 780 各一张（自检，不交付）
        for (const width of [1440, 1100, 780]) {
            await page.setViewportSize({ width, height: 900 });
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.waitForTimeout(200);
            const overflow = await page.evaluate(
                () => document.documentElement.scrollWidth > window.innerWidth + 1,
            );
            expect(overflow, `${width}px 宽度横向溢出`).toBe(false);
            await page.screenshot({
                path: join(SHOT_DIR, `html-responsive-${width}.png`),
                scale: "css",
            });
        }

        console.log(
            `[demo-html] variant=${VARIANT} requests=${requests.length} external=0 images=${EXPECTED_IMAGES} printHeight=${printHeight} responsive=1440/1100/780 cleanCopy=true`,
        );
    });
});


