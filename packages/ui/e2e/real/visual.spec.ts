// lane: 视觉基线 lane —— 自带 chromium 直连 UI 服务器拍 register 2x 基线，无 CP 交互；host 车道（Windows）skip（helpers/visual.ts 非 linux 平台 skip，T-2318 分类表）。
import { test, chromium } from "@playwright/test";
import { expectPlatformScreenshot } from "../helpers/visual";
import { ACTION_TIMEOUT_MS } from "../timeouts";

const UI_PORT = process.env.XIHE_UI_PORT || "12630";

test("register page 2x visual snapshot", async () => {
    const browser = await chromium.launch();
    const ctx = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${UI_PORT}/register`, { waitUntil: "load" });
    await page.waitForSelector("h1", { timeout: ACTION_TIMEOUT_MS });
    const dpr = await page.evaluate(() => window.devicePixelRatio);
    // eslint-disable-next-line no-console
    console.log("DPR:", dpr);
    await expectPlatformScreenshot(page, "register-page-2x.png");
    await ctx.close();
    await browser.close();
});
