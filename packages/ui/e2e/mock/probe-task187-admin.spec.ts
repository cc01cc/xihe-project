import { expect, test } from "./helpers/mock-test";
import { setupMockAuth } from "./helpers/auth";

/** `task-187` 探针 4（只读分诊）：实例管理员落退役 `/settings/policy` 后**到底渲染了什么**。 */
test("探针 4：policy-management:406 实例管理员落退役 URL —— 渲染了什么", async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem(
            "xihe-user",
            JSON.stringify({
                id: "user-1",
                email: "test@xihe.local",
                capabilities: { isInstanceAdmin: true, isInstanceSuper: true },
            }),
        );
    });
    await setupMockAuth(page, {});
    await page.goto("/settings/policy");
    await page.waitForTimeout(1500);
    const dom = await page.evaluate(() => {
        const q = (id: string) => document.querySelectorAll(`[data-testid="${id}"]`).length;
        const main = document.querySelector("main");
        return {
            url: location.pathname,
            domainView: q("settings-domain-view"),
            forbidden: q("settings-forbidden"),
            atomDenied: q("settings-atom-denied"),
            noAtomNotice: q("settings-no-atom-notice"),
            navGroupPrimary: q("settings-nav-group-primary"),
            mainTextHead: (main as HTMLElement | null)?.innerText?.slice(0, 160) ?? null,
        };
    });
    console.log("[task187-probe] policy406admin " + JSON.stringify(dom));
    expect(dom.url, "前提：重定向发生了").toContain("/settings/instance/");
});
