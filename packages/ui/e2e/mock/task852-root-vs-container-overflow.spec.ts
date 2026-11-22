// timeout-exempt: 单页 1920 采样 + 3s 布局收敛窗口（face-overflow.ts，LONG_TIMEOUT_MS 预算）。
/**
 * task-852（W2）：1920×1080「只断页面根会绿、容器轴判红」的入库反证。
 *
 * 与 `task844-1366-face-overflow.spec.ts` 同手法，但钉在 1920：
 *   1. 注入前，页面根 + `main` 容器都必须绿（否则反证没有参照物）；
 *   2. 向 `main` 注入**流内** 6000px 探针后，`document.documentElement.scrollWidth`
 *      仍 `<= window.innerWidth`（页面根假绿），而 `main.scrollWidth > clientWidth + 1`
 *      （容器轴判红）；
 *   3. `assertFaceNoHorizontalOverflow()` 必须抛红，证明 task-852 的容器判据不是恒绿。
 *
 * 探针必须留在流内：绝对定位子元素只计入其包含块的滚动溢出，不会进入 `main` 自己的
 * `scrollWidth`（task-844 首版就是这么假绿的）。
 */
import { expect, test } from "./helpers/mock-test";
import {
    assertFaceNoHorizontalOverflow,
    expectFaceNoHorizontalOverflow,
    readFaceOverflow,
} from "./helpers/face-overflow";
import { LONG_TIMEOUT_MS } from "../timeouts";

test.use({ viewport: { width: 1920, height: 1080 } });

test("1920 反证：页面根仍绿、容器轴判红", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator("#identifier")).toBeVisible({ timeout: LONG_TIMEOUT_MS });

    // 注入前：干净态必须绿（页面根 + 容器都过）。
    await expectFaceNoHorizontalOverflow(page, "1920-反证-注入前", "main");

    await page.evaluate(() => {
        const host = document.querySelector("main");
        if (!host) throw new Error("反证宿主 main 不存在");
        const probe = document.createElement("div");
        probe.setAttribute("data-testid", "task852-overflow-probe");
        probe.style.cssText =
            "display:block;flex:0 0 auto;width:6000px;min-width:6000px;height:4px;pointer-events:none;";
        host.appendChild(probe);
    });

    const broken = await readFaceOverflow(page, "main");
    console.log(
        `[task-852] 注入后 documentElement.scrollWidth=${broken.docScrollWidth}` +
            ` window.innerWidth=${broken.innerWidth}` +
            ` main=${broken.container?.scrollWidth}/${broken.container?.clientWidth}` +
            ` overflow-x=${broken.container?.overflowX}`,
    );
    expect(
        broken.docScrollWidth,
        `反证前提不成立：注入 6000px 探针后页面根已判红（documentElement.scrollWidth=` +
            `${broken.docScrollWidth} > window.innerWidth=${broken.innerWidth}），` +
            "无法证明「只断页面根会绿」",
    ).toBeLessThanOrEqual(broken.innerWidth);
    expect(broken.container, "反证宿主 main 容器读不到").not.toBeNull();
    expect(
        broken.container?.scrollWidth ?? 0,
        `容器轴未判红：main scrollWidth=${broken.container?.scrollWidth}` +
            ` clientWidth=${broken.container?.clientWidth} overflow-x=${broken.container?.overflowX}`,
    ).toBeGreaterThan((broken.container?.clientWidth ?? 0) + 1);

    let rejected: unknown = null;
    try {
        assertFaceNoHorizontalOverflow(broken, "1920-反证-注入后");
    } catch (error) {
        rejected = error;
    }
    expect(rejected, "反证失败：容器被撑破后 guard 仍判绿").not.toBeNull();
});
