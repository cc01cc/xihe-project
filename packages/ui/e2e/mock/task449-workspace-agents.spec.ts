import { expect, test } from "./helpers/mock-test";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";
import { i18n } from "../../src/i18n";
import {
    MOCK_AGENT_PRINCIPAL_IDS,
    MOCK_AGENT_WORKSPACE_ID,
} from "../../src/preview/mock/data/workspaceAgents";

/**
 * task-449 / D-1287 的**浏览器判据**，同时补齐 **task-417** 缺的那份证据，跑在 **preview 链路**上：
 * `XIHE_E2E_EXPECT_CHAIN=preview` ⇒ config 注入 `XIHE_UI_MOCK_API=1` ⇒ vite 挂 mock 中间件，
 * 并把 `/workspace/**` 的 HTML 入口改写成 `preview-real.html`（注入 mock 登录态、强制 zh-CN）。
 *
 * <p>**为什么不调 `setupMockAuth`**：它的 `**\/api\/v1/**` 通配兜底会把夹具通路整个盖掉 ⇒
 * 测的是 spec 自己的桩（假绿）。这里只借 `mock-test` 的失败门禁（0 pageerror / 0 console error /
 * 0 非预期 ≥400）—— 面板消费 21 条面，任何一条缺失都会以 404 让本 spec 红，这正是 D-1281 要的仪器。</p>
 *
 * <p>入口用 `/workspace/{id}/resources?resource=agents`：该页把 `layer=WORKSPACE` 与 workspaceId
 * 作为 prop 钉死（task-210），**不依赖页签上下文的隐性顺序** ⇒ 深链可复算。</p>
 *
 * <p>跑法（单 spec = L0）：`XIHE_E2E_PROFILE=mock XIHE_UI_PORT=12736 XIHE_E2E_BROWSER_CHANNEL=chrome-beta
 * XIHE_E2E_EXPECT_CHAIN=preview pnpm exec playwright test --config e2e/playwright.config.ts
 * e2e/mock/task449-workspace-agents.spec.ts --workers=1`</p>
 */
const PIDS = MOCK_AGENT_PRINCIPAL_IDS;
const URL = `/workspace/${MOCK_AGENT_WORKSPACE_ID}/resources?resource=agents`;
const zh = i18n.global.getLocaleMessage("zh-CN") as Record<string, unknown>;
function copy(path: string): string {
    const value = path.split(".").reduce<unknown>((node, key) => {
        return node && typeof node === "object"
            ? (node as Record<string, unknown>)[key]
            : undefined;
    }, zh);
    if (typeof value !== "string") throw new Error(`zh-CN 文案缺失：${path}`);
    return value;
}
const LABEL = copy("workspace.agentCapSnapshotLabel");
const HINT = copy("workspace.agentCapSnapshotHint");
const INHERIT = copy("workspace.agentCapInherit");
const EXPLICIT = copy("workspace.agentCapExplicit");
const ZERO = copy("workspace.noAgentCapabilities");

test.describe("preview mock workspace agents (task-449 / 417 证据)", () => {
    test("六行夹具渲染，capSource 四态各自的标注正确（baseline 空快照不说零权限）", async ({
        page,
    }) => {
        await page.goto(URL);
        for (const pid of Object.values(PIDS)) {
            await expect(page.getByTestId(`workspace-agent-${pid}`)).toBeVisible({
                timeout: EXPECT_TIMEOUT_MS,
            });
        }
        await expect(page.getByTestId("workspace-agent-cap-snapshot-hint")).toHaveText(HINT, {
            timeout: EXPECT_TIMEOUT_MS,
        });

        const explicitRow = page.getByTestId(`workspace-agent-${PIDS.explicit}`);
        await expect(explicitRow.getByTestId("workspace-agent-cap-label")).toHaveText(LABEL);
        await expect(page.getByTestId(`workspace-agent-cap-source-${PIDS.explicit}`)).toHaveText(
            EXPLICIT,
        );

        const inheritRow = page.getByTestId(`workspace-agent-${PIDS.inherit}`);
        await expect(page.getByTestId(`workspace-agent-cap-source-${PIDS.inherit}`)).toHaveText(
            INHERIT,
        );
        // 417 的核心更正：继承态的空快照**不得**被说成「无工具权限」。
        await expect(inheritRow.getByTestId("workspace-agent-cap-empty")).toHaveCount(0);
        await expect(inheritRow).not.toContainText(ZERO);

        // 显式零权限仍照实说（不弱化）。
        await expect(
            page
                .getByTestId(`workspace-agent-${PIDS.zero}`)
                .getByTestId("workspace-agent-cap-empty"),
        ).toHaveText(ZERO);

        // 旧响应（无 capSource）不编造来源徽标。
        await expect(page.getByTestId(`workspace-agent-cap-source-${PIDS.legacy}`)).toHaveCount(0);
        await expect(page.getByTestId(`agent-disabled-badge-${PIDS.disabled}`)).toBeVisible();
        await expect(page.getByTestId(`agent-unbound-badge-${PIDS.unbound}`)).toBeVisible();
    });

    test("改上限为继承 ⇒ PUT 空体 ⇒ 来源徽标翻成「跟随角色基线」（真写回环）", async ({ page }) => {
        await page.goto(URL);
        const pid = PIDS.explicit;
        await expect(page.getByTestId(`workspace-agent-cap-source-${pid}`)).toHaveText(EXPLICIT, {
            timeout: EXPECT_TIMEOUT_MS,
        });
        await page
            .getByTestId(`workspace-agent-edit-cap-${pid}`)
            .click({ timeout: ACTION_TIMEOUT_MS });
        await page
            .getByTestId(`workspace-agent-cap-mode-inherit-${pid}`)
            .click({ timeout: ACTION_TIMEOUT_MS });
        await page
            .getByTestId(`workspace-agent-save-cap-${pid}`)
            .click({ timeout: ACTION_TIMEOUT_MS });
        await expect(page.getByTestId(`workspace-agent-cap-source-${pid}`)).toHaveText(INHERIT, {
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(
            page.getByTestId(`workspace-agent-${pid}`).getByTestId("workspace-agent-cap-empty"),
        ).toHaveCount(0);
    });

    test("记忆子资源在浏览器里真的取到（空集曾把这条面藏起来）", async ({ page }) => {
        await page.goto(URL);
        const pid = PIDS.explicit;
        await page.getByTestId(`agent-memory-toggle-${pid}`).click({ timeout: ACTION_TIMEOUT_MS });
        await expect(page.getByText("这个仓库的构建命令是", { exact: false }).first()).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        // 归档行默认不列出（?status=active 口径）。
        await expect(page.getByText("已归档的旧结论", { exact: false })).toHaveCount(0);
    });

    test("移动端 390×844：深链同样渲染夹具与快照标注", async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(URL);
        await expect(page.getByTestId(`workspace-agent-${PIDS.explicit}`)).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByTestId("workspace-agent-cap-snapshot-hint")).toBeVisible();
        await expect(page.getByTestId(`workspace-agent-cap-source-${PIDS.inherit}`)).toHaveText(
            INHERIT,
        );
    });

    // task-469（417 P1-6）：**live 生效权限面**的浏览器判据。核心是「live 与快照分得开」：
    // 快照里有的原子 live 里没有（超出主体生效上限），继承态反过来 live 比快照多。
    // 只断言「live 面存在」的话，把快照换个字段喂进来也能绿（D-1281）。
    test("task-469：打开详情读一次 live，命中来源/bound/provenance 渲染，且 live ≠ snapshot", async ({
        page,
    }) => {
        const liveRequests: string[] = [];
        page.on("request", (req) => {
            if (req.url().includes("/effective-cap")) liveRequests.push(req.url());
        });
        await page.goto(URL);
        // **用 disabled 行而不是 explicit 行**：本文件上一条用例会把 explicit 的上限 PUT 成继承，
        // 而 preview 链路的 mock 夹具是**整个 vite 进程共享**的（没有 HTTP reset 面）⇒ 拿 explicit
        // 当样本会让本条依赖用例顺序（与 ui-1 task-467 修掉的 shuffle 顺序依赖同族）。
        // disabled 行没有任何用例写它，且它的 live ≠ snapshot 方向正好相反：
        // 快照有 1 条 file_read，而它**没有角色绑定行** ⇒ 天花板空 ⇒ live 为空（见 coverage spec 的边界留痕）。
        const pid = PIDS.disabled;
        const row = page.getByTestId(`workspace-agent-${pid}`);
        await expect(row).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        // 快照面有 1 条原子徽标 + 1 条来源徽标；**列表阶段不发 live 请求**（避免每行一次）。
        await expect(
            row.getByTestId("workspace-agent-cap").locator("span.rounded.border"),
        ).toHaveCount(2);
        expect(liveRequests).toHaveLength(0);
        await page
            .getByTestId(`workspace-agent-edit-cap-${pid}`)
            .click({ timeout: ACTION_TIMEOUT_MS });
        const face = row.getByTestId("workspace-agent-effective-cap");
        await expect(face.getByTestId("workspace-agent-effective-cap-label")).toHaveText(
            copy("workspace.agentEffectiveCapLabel"),
            { timeout: EXPECT_TIMEOUT_MS },
        );
        await expect(page.getByTestId(`workspace-agent-effective-cap-binding-${pid}`)).toHaveText(
            copy("workspace.agentEffectiveCapBindingSnapshot"),
        );
        await expect(page.getByTestId(`workspace-agent-effective-cap-bound-${pid}`)).toHaveText(
            copy("workspace.agentEffectiveCapBound"),
        );
        const atoms = face.getByTestId("workspace-agent-effective-cap-atoms");
        await expect(atoms).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        // live 面**一条都没有**（快照那 1 条超出天花板）⇒ 空态照实说，精确计数不是 ≥。
        await expect(atoms.locator("span.rounded.border")).toHaveCount(0);
        await expect(face.getByTestId("workspace-agent-effective-cap-empty")).toBeVisible();
        await expect(
            face.getByTestId("workspace-agent-effective-cap-provenance-ids"),
        ).toBeVisible();
        // **只读一次**：不是每行一次，也不是每次渲染一次。
        expect(liveRequests).toHaveLength(1);
        expect(liveRequests[0]).toContain(
            `/workspaces/${MOCK_AGENT_WORKSPACE_ID}/agents/${pid}/effective-cap`,
        );
        // 另一行的快照面不受影响 ⇒ live 没有覆盖快照（两者语义不同）。
        await expect(page.getByTestId(`workspace-agent-cap-source-${PIDS.inherit}`)).toHaveText(
            INHERIT,
        );
    });

    test("task-469：继承态 live 比快照多（role-binding + 无绑定行），空快照不等于空权限", async ({
        page,
    }) => {
        await page.goto(URL);
        const pid = PIDS.inherit;
        const row = page.getByTestId(`workspace-agent-${pid}`);
        await expect(row).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await expect(page.getByTestId(`workspace-agent-cap-source-${pid}`)).toHaveText(INHERIT);
        await page
            .getByTestId(`workspace-agent-edit-cap-${pid}`)
            .click({ timeout: ACTION_TIMEOUT_MS });
        await expect(page.getByTestId(`workspace-agent-effective-cap-binding-${pid}`)).toHaveText(
            copy("workspace.agentEffectiveCapBindingRole"),
            {
                timeout: EXPECT_TIMEOUT_MS,
            },
        );
        await expect(page.getByTestId(`workspace-agent-effective-cap-bound-${pid}`)).toHaveText(
            copy("workspace.agentEffectiveCapUnbound"),
        );
        const atoms = row.getByTestId("workspace-agent-effective-cap-atoms");
        // 角色天花板三条原子（mock 的 WS_EDITOR），而该行快照是空数组。
        await expect(atoms.locator("span.rounded.border")).toHaveCount(3);
        await expect(row.getByTestId("workspace-agent-effective-cap-empty")).toHaveCount(0);
    });
});
