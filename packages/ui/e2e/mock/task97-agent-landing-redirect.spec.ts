import { expect, test } from "./helpers/mock-test";
import type { Page } from "@playwright/test";
import { setupMockAuth } from "./helpers/auth";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";

/**
 * task-96 / task-97：资源区的「智能体」页已摘除（用户裁定「智能体是组织成员，不是资源」），
 * 旧 URL 一律 **302 到新家**，不是 404。本 spec 是这条分流的**唯一** e2e 契约：
 *
 * <ul>
 *   <li>`?layer=INSTANCE` ⇒ 实例层「平台智能体」页（`settings-instance-agent-principals`）；</li>
 *   <li>`?layer=WORKSPACE` + `?workspaceId=` ⇒ 该工作区成员页（`/workspace/<id>/members`）；</li>
 *   <li>`?layer=WORKSPACE` 无 id/无页签上下文、`?layer=USER`、缺省、非法 ⇒ 组织成员页（`/members`）；</li>
 *   <li>详情深链 `/resources/agents/<pk>` 同样 302 到**列表级**落点（不 404）。</li>
 * </ul>
 *
 * <p><b>判据必须两层</b>（cp-1 口径）：① URL 终态 `toHaveURL` —— 只钉状态码等于没证明分流到哪
 * （六条旧 URL 里四条分流不同，只钉状态码等于六条用例测同一件事）；② 宿主页标识可见 +
 * `settings-not-found` 计数 0 —— 证明「跳进能用的页面」而不是「跳进另一条死路」。
 * 三个目标字符串是**跨面契约**，逐字写死；不写 `toContain("members")` 这类宽断言。</p>
 *
 * <p><b>旧 query 必须被剥掉</b>（task-97 裁定 A，2026-11-15）：vue-router 4 的 `handleRedirectRecord` 是
 * `assign({ query: to.query, … }, newTargetLocation)` ⇒ 返回值不带 `query` 键时旧 query 会被继承，落地 URL 变成
 * `/members?layer=USER` 这类**过期参数**（落地页可能自行解读 `?layer`）。src 侧 `agentResourceLocation()`
 * 三条出口已显式 `query: {}`；本 spec 因此钉**不带 query** 的终态 —— 期望里一旦出现 `?layer=` 就是回归。</p>
 */
// 旧入口：这条字符串在本库只出现在本文件 —— 它就是被 302 的那个 URL，删掉它就没法证明分流。
const OLD = "/resources/agents";
const WS = "11111111-1111-4111-8111-111111111111";
const INSTANCE_URL = "/settings/instance/agent-principals";
const MEMBERS_URL = "/members";

type Landing = { expectUrl: string; marker: string };

/** 三层判据：URL 终态 → 宿主页标识 → 不是 404 页。 */
async function expectLanding(page: Page, entry: string, landing: Landing): Promise<void> {
    await page.goto(entry);
    await expect(page, "旧 URL 必须 302 到新家（不是停在原地）").toHaveURL(landing.expectUrl, {
        timeout: ACTION_TIMEOUT_MS,
    });
    await expect(page.getByTestId(landing.marker), "落到新家后宿主页必须真的渲染").toBeVisible({
        timeout: EXPECT_TIMEOUT_MS,
    });
    await expect(page.getByTestId("settings-not-found"), "302 ≠ 404").toHaveCount(0);
}

test.describe("task-97：旧智能体资源 URL 的 302 分流", () => {
    test("?layer=INSTANCE ⇒ 平台智能体页（settings-instance-agent-principals）", async ({
        page,
    }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await expectLanding(page, OLD + "?layer=INSTANCE", {
            expectUrl: INSTANCE_URL,
            marker: "settings-instance-agents",
        });
    });

    test("?layer=WORKSPACE + ?workspaceId ⇒ 该工作区成员页", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await expectLanding(page, OLD + "?layer=WORKSPACE&workspaceId=" + WS, {
            expectUrl: "/workspace/" + WS + "/members",
            marker: "workspace-members-page",
        });
    });

    test("?layer=WORKSPACE 但没有工作区上下文 ⇒ 组织成员页（不猜工作区）", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        // 「没有工作区上下文」要两件事一起做（口径见原 resources-ia 用例）：
        // ① 清两个存储键；② /me/permissions 回零工作区，否则 auth store 启动时会按权限列表写回页签上下文。
        await page.addInitScript(() => {
            sessionStorage.removeItem("xihe-workspace");
            localStorage.removeItem("xihe-workspace");
        });
        await page.route("**/api/v1/me/permissions", (route) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    userId: "user-1",
                    instanceCapabilities: ["isInstanceAdmin"],
                    instancePermissions: [],
                    workspaces: [],
                }),
            }),
        );
        await expectLanding(page, OLD + "?layer=WORKSPACE", {
            expectUrl: MEMBERS_URL,
            marker: "org-members-page",
        });
    });

    test("?layer=USER ⇒ 组织成员页（个人层智能体属于成员管理）", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await expectLanding(page, OLD + "?layer=USER", {
            expectUrl: MEMBERS_URL,
            marker: "org-members-page",
        });
    });

    test("缺省 layer ⇒ 组织成员页（资源侧默认层曾是 USER）", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await expectLanding(page, OLD, { expectUrl: MEMBERS_URL, marker: "org-members-page" });
    });

    test("非法 layer ⇒ 组织成员页（不 404、不猜层）", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await expectLanding(page, OLD + "?layer=BOGUS", {
            expectUrl: MEMBERS_URL,
            marker: "org-members-page",
        });
    });

    test("详情深链 /resources/agents/<pk> ⇒ 列表级落点（不 404）", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await expectLanding(page, OLD + "/principal-0001?layer=INSTANCE", {
            expectUrl: INSTANCE_URL,
            marker: "settings-instance-agents",
        });
    });
});
