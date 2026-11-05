/**
 * BL-349 回退护栏 / 冻结冒烟闸门（`@host`）。
 *
 * 为什么存在：2026-11-06 冻结 #1 曾因 `V129__bl345_memory_write_self_atom.sql` 把
 * `MEMORY_WRITE_SELF` 加进**默认 workspace 角色**而整轮不通过 —— 任何"用默认角色绑定 agent
 * 主体"的请求都会 403 `ROLE_NOT_GRANTABLE`。当时靠一条**临时**冒烟 spec 在 41.9–58.6 秒内
 * 判定"P0 修复是否生效、要不要进全量"。本文件把那条临时 spec 正式化。
 *
 * 用法（冻结流程的 `[0]` 步；10–60 秒定判，红就不进全量）：
 *   XIHE_E2E_EXPECT_CP_COMMIT=<靶 SHA> node scripts/e2e-host.mjs --llm-mode=mock --retries=0 \
 *     --report-name=bl349-guard.json e2e/real/bl349-agent-bind-guard.spec.ts
 *
 * 覆盖：
 *   1. `POST /api/v1/agent-principals`（**带 `X-Workspace-Id`**）⇒ 201；
 *   2. `PUT /api/v1/workspaces/{ws}/agents/{pid}`（body 只有 `permissions:[{read,*}]`）⇒ **200**；
 *   3. 该主体的 materialized grants **不含 `MEMORY_WRITE_SELF`**（且非空，避免空集误绿）。
 *
 * BL-349 回退症状：第 2 步返回 403 `ROLE_NOT_GRANTABLE`，detail 含
 * "default workspace role carries an atom that cannot be granted to an agent: MEMORY_WRITE_SELF"。
 */
import { execFileSync } from "node:child_process";

import { expect, test } from "@playwright/test";

import { provisionWorkspaceAgentPrincipal } from "./helpers/agent-principal";
import { CP_URL, registerJourneyUser } from "./helpers/journey";

test.describe.configure({ retries: 0 });

function queryIsolatedPostgres(sql: string): string {
    const container = process.env.XIHE_E2E_PG_CONTAINER,
        database = process.env.XIHE_E2E_PG_DATABASE;
    const user = process.env.XIHE_E2E_PG_USER;
    if (!container || !database || !user) {
        throw new Error(
            "isolated Postgres fixture metadata is unavailable; run through scripts/e2e-host.mjs",
        );
    }
    return execFileSync(
        process.platform === "win32" ? "docker.exe" : "docker",
        ["exec", container, "psql", "-X", "-A", "-t", "-U", user, "-d", database, "-c", sql],
        { encoding: "utf8", timeout: 15_000, windowsHide: true },
    ).trim();
}

test("@host BL-349 冒烟闸门：建主体 + 绑定必须 200，且默认角色原子不含 MEMORY_WRITE_SELF", async ({
    request,
}) => {
    // journey 用户（自带 workspace，`direct_attach` + `hostPath` 由 ensureWorkspace 一并给全）
    const owner = await registerJourneyUser(request, "bl349-guard-owner");
    const nonce = Date.now().toString(36);
    const name = `AgentBl349Guard${nonce}`; // 字母开头、纯字母数字（v29 名称规则）

    // 步骤 1+2：helper 内部先 POST（带 X-Workspace-Id）再 PUT 绑定，并对 201/200 各自断言。
    // 若 BL-349 回退，这里会以 403 ROLE_NOT_GRANTABLE 抛出；包一层把"回退症状"写进失败信息，
    // 让冻结核对的人不用再翻历史记录就知道该看什么。
    let principalId: string;
    try {
        principalId = await provisionWorkspaceAgentPrincipal(
            request,
            { accessToken: owner.authToken, workspaceId: owner.workspaceId },
            { name, actions: ["read"] },
        );
    } catch (error) {
        throw new Error(
            `BL-349 冒烟失败（建主体应 201、绑定应 200）：${String(error)}\n` +
                "BL-349 回退症状：绑定返回 403 ROLE_NOT_GRANTABLE，detail 含 " +
                '"default workspace role carries an atom that cannot be granted to an agent: ' +
                'MEMORY_WRITE_SELF" ⇒ 默认 workspace 角色又把禁授原子带回来了（查 V129/V130 与 seed）。',
        );
    }
    expect(principalId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);

    // 步骤 3：绑定后的 materialized grants 必须非空（证明角色确实被 materialize），
    // 且**不得**包含 `MEMORY_WRITE_SELF`（BL-349 的正题：该原子不可授予 agent 主体）。
    const grantText = queryIsolatedPostgres(
        `SELECT COALESCE(string_agg(permissions::text, ' | ' ORDER BY permissions::text), '') ` +
            `FROM grants WHERE subject_type = 'agent_principal' AND subject_id = '${principalId}'::uuid`,
    );
    expect(
        grantText.length,
        "BL-349 回退症状：绑定后应 materialize 出 grants 行，实际为空（角色未被授予）",
    ).toBeGreaterThan(0);
    expect(
        grantText,
        "BL-349 回退症状：默认 workspace 角色把 MEMORY_WRITE_SELF 授给了 agent 主体" +
            `（detail 应为 "default workspace role carries an atom that cannot be granted to an agent"）；实际 grants=${grantText}`,
    ).not.toContain("MEMORY_WRITE_SELF");

    // 附带核验：绑定确实落到 workspace_agents（避免"200 但没写行"的假绿）
    const bindingRows = queryIsolatedPostgres(
        `SELECT count(*) FROM workspace_agents WHERE principal_id = '${principalId}'::uuid ` +
            `AND workspace_id = '${owner.workspaceId}'::uuid`,
    );
    expect(bindingRows, `绑定行数应为 1，实际 ${bindingRows}`).toBe("1");

    // 冒烟闸门的输出：一行结论，便于冻结报告直接引用
    console.log(
        `[bl349-guard] OK principal=${principalId} workspace=${owner.workspaceId} cp=${CP_URL} grantBytes=${grantText.length}`,
    );
});
