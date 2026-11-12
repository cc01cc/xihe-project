import { expect, test } from "./helpers/mock-test";

/**
 * PLAN-0773 M0-4（task-144）第 4 条能力：**虚拟化**必须在真浏览器里验。
 *
 * 为什么不进单测：`jsdom` 没有布局（`offsetHeight`/`getBoundingClientRect()` 恒 0）⇒ 虚拟化窗口会算出
 * 「0 项可见」，而这个 0 **假红与假绿不可分辨**。本 spec 读的是预览页从 **DOM 实测量出来的读数**。
 *
 * 载体：开发期预览页 `/preview.html#tree-capabilities`（真组件 + mock 数据，不进产品路由、不进生产 bundle）。
 * mock 车道的 webServer 是 `pnpm dev`，同一 dev server 会直接服务 `preview.html`，不需要另起服务。
 *
 * 判据（两条都要成立）：
 *  - 对照组 `plain.rendered === 1000`（1000 行确实全挂）；
 *  - 虚拟化组 `virtual.engaged === true` 且 `virtual.rendered << 1000`。
 * **只开页不算通过**——若接线没生效，`virtual.rendered` 会是 1000，判据当场红。
 */
test.describe("PLAN-0773 M0-4 reka-ui tree virtualization", () => {
    test("虚拟化生效：可见行数显著少于 1000，对照组全挂", async ({ page }) => {
        await page.goto("/preview.html#tree-capabilities");

        const readings = page.getByTestId("m0-4-readings");
        await expect(readings).toBeVisible();

        // 读数在 onMounted + 一帧后才写；等它落定，不用固定 sleep。
        await expect
            .poll(
                async () => {
                    const raw = (await readings.textContent()) ?? "{}";
                    try {
                        const parsed = JSON.parse(raw) as { virtual?: { rendered?: number } };
                        return parsed.virtual?.rendered ?? -1;
                    } catch {
                        return -1;
                    }
                },
                { timeout: 15_000 },
            )
            .toBeGreaterThan(0);

        const data = JSON.parse((await readings.textContent()) ?? "{}") as {
            plain: { total: number; rendered: number; engaged: boolean };
            virtual: {
                total: number;
                rendered: number;
                engaged: boolean;
                scrollHeight?: number;
                viewportHeight?: number;
            };
        };

        // 读数写进 stdout：证据包要抄具体数，不能只写「跑绿了」。
        console.log("[m0-4] readings=" + JSON.stringify(data));

        // 对照组：1000 行全挂（否则「虚拟化减少了行数」这个对比没有意义）
        expect(data.plain.total).toBe(1000);
        expect(data.plain.rendered).toBe(1000);

        // 虚拟化组：必须真的少挂
        expect(data.virtual.rendered).toBeGreaterThan(0);
        expect(data.virtual.rendered).toBeLessThan(1000);
        expect(data.virtual.engaged).toBe(true);

        // 证据：截图落 one/.tmp（gitignored），证据包只引用命令与读数，不入库二进制。
        await page
            .locator("#tree-capabilities")
            .screenshot({ path: "../../../.tmp/xh/m0-4/virtualization.png" });
    });
});
