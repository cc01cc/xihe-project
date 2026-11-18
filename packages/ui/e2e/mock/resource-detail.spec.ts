import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth } from "./helpers/auth";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";
import { findLeaks, summarizeLeaks } from "../../src/lib/copyLeakPatterns";

/**
 * PLAN-0772 M2 / task-228：资源**详情单页**（`/resources/<id>/:pk?layer=<LAYER>`）。
 *
 * <p>为什么这必须是浏览器证据（单测替代不了）：</p>
 * <ul>
 *   <li>**层进 URL**：`beforeEnter` 的 `replace` 真的改了地址栏吗（而不是只改内存里的层）—— 单测只能
 *       证明"函数返回了 replace 对象"；</li>
 *   <li>**列表点进**：行尾的 `<ResourceDetailLink>` 真的带着 (资源, 层, pk) 跳到详情、并且**没有把
 *       行本身的点击抢走**；</li>
 *   <li>**返回栈**：浏览器后退与"无历史回落列表页"两条路径各自落到哪个 URL；</li>
 *   <li>**knowledge 不放行**：深链进缺口资源时画面是"没有详情面"，而不是一屏错误。</li>
 * </ul>
 *
 * <p>夹具口径：每条读面都按 openapi 的**信封**回（`{credentials}` / `{references}` / `{events}` /
 * `{items}` / `{agents}` / `{bindings}`），不塞 UI 自己需要但契约没有的字段；404 用例走"列表成功但
 * 没有该 pk"，**不是**故意回 4xx —— 后者会触发 mock 车道的 page-failure 门（那是另一条判据）。</p>
 */

const CREDENTIAL = {
    id: "cred-0001",
    label: "部署令牌",
    kind: "token",
    deliveryTier: "reveal",
    ownerType: "USER",
    ownerId: "user-1",
    status: "active",
    fingerprint: "fp:9c1d",
    revision: 2,
    createdAt: "2026-11-01T09:00:00Z",
    replacedAt: null,
    referenceCount: 1,
};

const SKILL = {
    skillId: "skill-0001-instance-commit-msg",
    name: "commit-msg-review",
    definitionScope: { type: "instance", workspaceId: null },
    description: "按仓库提交规范检查 commit message。",
    bodyTokensEst: 412,
    oversize: false,
    trusted: false,
    sourcePath: "skills/commit-msg-review/SKILL.md",
    contentHash: "a3f1c9d2b47e8065b0c4e7f2139d5a86".repeat(2),
    version: 3,
    attachments: [],
    createdAt: "2026-11-01T09:00:00Z",
    updatedAt: "2026-11-12T07:41:00Z",
};

/**
 * 能力/原子投影：夹具用户默认**零原子**（见 `MockAuthOptions.capabilities` 的注释）——
 * 凭据面板的 atom 门（`credential_manage`）不授予就只渲染 403 卡片、主体不挂载，
 * 列表行根本不会出现。本 spec 验的是"列表→详情"这条路，所以按真实授予组给原子。
 * 必须注册在 `setupMockAuth` **之后**（Playwright 后注册优先）。
 */
async function stubPermissions(page: Page, atoms: string[]): Promise<void> {
    await page.route("**/api/v1/me/permissions", (route) =>
        route.fulfill(
            json({
                userId: "user-1",
                instanceCapabilities: ["config:instance:admin"],
                instancePermissions: atoms.map((actionClass) => ({ actionClass, resource: "*" })),
            }),
        ),
    );
}

function json(body: unknown) {
    return { status: 200, contentType: "application/json", body: JSON.stringify(body) };
}

/** credentials 的三条读面（列表 / 引用 / 审计）。 */
async function stubCredentials(page: Page, rows: unknown[]): Promise<void> {
    await page.route(/\/api\/v1\/credentials(\?.*)?$/, (route) =>
        route.fulfill(json({ credentials: rows, count: rows.length })),
    );
    await page.route(/\/api\/v1\/credentials\/[^/]+\/references$/, (route) =>
        route.fulfill(
            json({
                references: [
                    {
                        source: "grant",
                        subjectType: "agent",
                        subjectId: "principal-0001",
                        actionClass: "credential_use",
                        resource: "*",
                    },
                ],
            }),
        ),
    );
    await page.route(/\/api\/v1\/credentials\/[^/]+\/events(\?.*)?$/, (route) =>
        route.fulfill(
            json({
                events: [
                    {
                        id: "ev-0001",
                        eventType: "REVEALED",
                        actor: "user-1",
                        createdAt: "2026-11-02T10:00:00Z",
                    },
                ],
            }),
        ),
    );
}

async function stubSkills(page: Page): Promise<void> {
    await page.route(/\/api\/v1\/skills(\?.*)?$/, (route) =>
        route.fulfill(json({ items: [SKILL], total: 1 })),
    );
    await page.route(/\/api\/v1\/skills\/[^/]+(\?.*)?$/, (route) =>
        route.fulfill(json({ ...SKILL, body: "# commit-msg-review\n\n检查提交信息规范。" })),
    );
}

test.describe("PLAN-0772 task-228: 资源详情单页", () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test("凭据：列表点进 → 详情 → 浏览器后退回到同层列表", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await stubPermissions(page, ["credential_manage"]);
        await stubCredentials(page, [CREDENTIAL]);

        await page.goto("/resources/credentials?layer=USER");
        const row = page.getByTestId(`credentials-row-${CREDENTIAL.id}`);
        await expect(row).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        // 行尾详情入口带着 pk 跳转（`@click.stop` 不抢行本身的点击）。
        await page.getByTestId(`resource-detail-link-${CREDENTIAL.id}`).click();
        await expect(page).toHaveURL(`/resources/credentials/${CREDENTIAL.id}?layer=USER`, {
            timeout: ACTION_TIMEOUT_MS,
        });

        await expect(page.getByTestId("resource-detail-title")).toHaveText(CREDENTIAL.label);
        // 两条独立读面（引用 / 审计）在详情页都真的渲染出来了。
        await expect(page.getByTestId("resource-detail-section-references")).toBeVisible();
        await expect(page.getByTestId("resource-detail-section-references")).toContainText(
            "principal-0001",
        );
        await expect(page.getByTestId("resource-detail-section-events")).toContainText("REVEALED");
        await expect(page.getByTestId("resource-detail-fields")).toContainText("fp:9c1d");

        // 返回栈路径①：浏览器后退 ⇒ 回到进入时的层 tab（同一层次）。
        await page.goBack();
        await expect(page).toHaveURL("/resources/credentials?layer=USER", {
            timeout: ACTION_TIMEOUT_MS,
        });
        await expect(row).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
    });

    test("凭据：无应用内历史（直接粘详情 URL）时「返回列表」回落到同层列表", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await stubPermissions(page, ["credential_manage"]);
        await stubCredentials(page, [CREDENTIAL]);

        // 直接打开详情页：history.state.back 为空 ⇒ 后退不可用，必须回落到列表。
        await page.goto(`/resources/credentials/${CREDENTIAL.id}?layer=USER`);
        await expect(page.getByTestId("resource-detail-title")).toHaveText(CREDENTIAL.label);
        await page.getByTestId("resource-detail-back").click();
        await expect(page).toHaveURL("/resources/credentials?layer=USER", {
            timeout: ACTION_TIMEOUT_MS,
        });
        await expect(page.getByTestId(`credentials-row-${CREDENTIAL.id}`)).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
    });

    test("技能：列表点进 → 详情（含正文）→ 后退回同层列表", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await stubSkills(page);

        await page.goto("/resources/skills?layer=INSTANCE");
        const row = page.getByTestId(`skill-item-${SKILL.skillId}`);
        await expect(row).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await page.getByTestId(`resource-detail-link-${SKILL.skillId}`).click();
        await expect(page).toHaveURL(`/resources/skills/${SKILL.skillId}?layer=INSTANCE`, {
            timeout: ACTION_TIMEOUT_MS,
        });

        await expect(page.getByTestId("resource-detail-title")).toHaveText(SKILL.name);
        await expect(page.getByTestId("resource-detail-block")).toContainText("检查提交信息规范");

        await page.goBack();
        await expect(page).toHaveURL("/resources/skills?layer=INSTANCE", {
            timeout: ACTION_TIMEOUT_MS,
        });
    });

    test("?layer= 强制：缺省补默认层、非法值回落默认层，都写回地址栏", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await stubCredentials(page, [CREDENTIAL]);

        // 缺省 layer：credentials 默认层 = USER。
        await page.goto(`/resources/credentials/${CREDENTIAL.id}`);
        await expect(page).toHaveURL(`/resources/credentials/${CREDENTIAL.id}?layer=USER`, {
            timeout: ACTION_TIMEOUT_MS,
        });

        // 非法 layer：不给 404，回落到默认层并改 URL（不是只改内存里的层）。
        await page.goto(`/resources/credentials/${CREDENTIAL.id}?layer=SESSION`);
        await expect(page).toHaveURL(`/resources/credentials/${CREDENTIAL.id}?layer=USER`, {
            timeout: ACTION_TIMEOUT_MS,
        });
        await expect(page.getByTestId("resource-detail-title")).toHaveText(CREDENTIAL.label);
    });

    test("pk 不存在 ⇒ 404 诚实态（不是未接线、不是错误页）", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await stubCredentials(page, [CREDENTIAL]);

        await page.goto("/resources/credentials/does-not-exist?layer=USER");
        await expect(page.getByTestId("resource-detail-not-found")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByTestId("resource-detail-not-found")).toContainText("找不到这条资源");
        await expect(page.getByTestId("resource-detail-unwired")).toHaveCount(0);
    });

    test("knowledge 不放行详情（0 层 + G3）：画面是「没有详情面」，且层规范化为 WORKSPACE", async ({
        page,
    }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });

        await page.goto("/resources/knowledge/any-kb?layer=INSTANCE");
        await expect(page).toHaveURL("/resources/knowledge/any-kb?layer=WORKSPACE", {
            timeout: ACTION_TIMEOUT_MS,
        });
        await expect(page.getByTestId("resource-detail-unwired")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByTestId("resource-detail-unwired")).toContainText("知识库没有实体");
        await expect(page.getByTestId("resource-detail-body")).toHaveCount(0);
    });

    /*
     * task-96/task-97：原本这里有一条「agents 的 ?layer=WORKSPACE 能进」的详情页用例。
     * 资源区的智能体页（含详情深链）已摘除 ⇒ 该页不存在，用例连同断言一起删除。
     * 旧 URL 的去向（302 到哪个新家）**统一由** `task97-agent-landing-redirect.spec.ts` 钉住，
     * 避免同一条契约在两个文件里各写一份（两份会各自漂移，正是今晚反复踩的坑）。
     */

    /**
     * task-57：absent（「接口没有返回这几个字段」）区块的**可达性**判据。
     *
     * <p>为什么这条必须存在：卡面原先写「真栈凑不出来，得走 mock 车道」，但那是**推定**、不是读数。
     * 现在两侧都量过：真栈 stack-2 的实例层三个列表全空 —— `/instance/credentials` 0 行、
     * `/instance/agent-principals` 0 行、`/instance/mcp` **HTTP 404** ⇒ 真栈上确实到不了这个区块。
     * 结论同向，但依据从推定变成读数（D-1879 的教训就是推定当读数用会带走一整批结论）。</p>
     *
     * <p>形态判据（`services/fieldState.ts#wireStateOf`）：**wire 里没有这个键**才叫 absent；
     * `null` / `""` / `[]` 都是 empty。所以夹具必须**整键删掉** —— 本文件上面的 CREDENTIAL 写的是
     * `replacedAt: null`，那条渲染成「（空）」，到不了 absent 区块。这就是为什么既有的 mock 车道
     * 一直「绿着但没覆盖到」这一段文案。</p>
     */
    const INSTANCE_CREDENTIAL_SPARSE = {
        id: "cred-inst-sparse",
        label: "实例令牌（wire 缺键）",
        kind: "token",
        status: "active",
        createdAt: "2026-11-01T09:00:00Z",
        // 故意不写：deliveryTier / fingerprint / revision / replacedAt / referenceCount
    };

    test("实例层 wire 缺键 ⇒ absent 区块上屏，且区块文案不得含审查者形态（task-57 / D-1879）", async ({
        page,
    }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await stubPermissions(page, ["credential_manage"]);
        await page.route(/\/api\/v1\/instance\/credentials(\?.*)?$/, (route) =>
            route.fulfill(json({ credentials: [INSTANCE_CREDENTIAL_SPARSE], count: 1 })),
        );

        await page.goto("/resources/credentials/cred-inst-sparse?layer=INSTANCE");
        const block = page.getByTestId("resource-detail-absent-fields");
        await expect(block).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        // 缺席的字段要逐个点名，不能只给一句「有字段缺失」
        await expect(block.getByTestId("resource-detail-absent-field")).not.toHaveCount(0);
        // 阳性对照：wire 里在的键（label/kind/status/createdAt）不许被算成缺席
        await expect(page.getByTestId("resource-detail-fields")).toContainText("token");

        // 判据本体：这段文案是**用户能读到的正文**，所以它同样要过 9 形态（DEV-011 §14）。
        // 用 innerText 不用 textContent —— 与 §14.1「在哪量」同口径。
        const blockLeaks = findLeaks(await block.innerText());
        expect(blockLeaks, "absent 区块泄露审查者形态：" + summarizeLeaks(blockLeaks)).toEqual([]);

        // 整页级：同页的 notes（如「实例层凭据没有引用/审计读面…」）也是正文，
        // 只断区块会漏掉它们 —— DEV-011 §14.2 的实现锚点要求条目级与整页级各一条。
        const pageLeaks = findLeaks(await page.locator("main").innerText());
        expect(pageLeaks, "实例层详情页整页泄露：" + summarizeLeaks(pageLeaks)).toEqual([]);
    });
});
