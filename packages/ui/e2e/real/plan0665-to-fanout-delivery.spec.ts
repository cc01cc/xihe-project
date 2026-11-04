import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import {
    CP_URL,
    ensureAgentWorkspaceBinding,
    ensureChatReady,
    registerJourneyUser,
    seedPage,
    waitForControlPlaneAgentReady,
} from "./helpers/journey";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";
import { agentName } from "./helpers/agent-name";
import { workspaceChatPath } from "../../src/lib/routes";

/**
 * PLAN-0665 M2 —— TO 多目标 fan-out 的**真栈演示**（BL-239 可视闭环的判据脚本）。
 *
 * 运行方式（标准 real lane，必须经 e2e-host；手起 dev:host 不满足本 spec 的夹具契约）：
 *
 *   # 1) 起持久隔离栈（fake LLM = success，注入 XIHE_E2E_RUN_ID / PG 容器 / 端口 / agent fake env）
 *   node scripts/e2e-host.mjs --persistent --llm-mode=success
 *   # 2) 复用该栈跑本 spec（runner 会校验 CP build commit == HEAD）
 *   node scripts/e2e-host.mjs --batch=plan0665-fanout e2e/real/plan0665-to-fanout-delivery.spec.ts
 *   # 3) 收尾（必须，零残留）
 *   node scripts/e2e-host.mjs --teardown
 *
 * 为什么不能在 `mise run dev:host` 手起栈上跑：Agent 的 LLM base 只认 e2e-host 注入的
 * `XIHE_API_BASE`，connection base / 启动 env 都不会改变它（2026-11-05 实测：fake server 收到
 * 0 个请求，run 报 LLM_CREDENTIALS_INVALID）；而手工重启 Agent 会被 dev:host 监工连带收掉
 * CP/Runtime/UI。这是 e2e-host 存在的理由，不是本 spec 的缺陷。
 *
 * 判据（一条消息、两个 TO 目标）：
 *   1. UI 出现**两个 run 分组**（`run-header` 的 `data-run-id` 不同）；
 *   2. 每个分组各自显示 `发送→A` / `发送→B` 徽标；
 *   3. **刷新后徽标仍在**（durable `messages.delivery`，BL-239）；
 *   4. DB 断言 `messages.delivery.to` 有两个 id；两条 `chat_runs.origin` 分别为
 *      `user_submission` / `scheduled`（**不同也按 runId 分组** —— 0620/0665 真栈依据）。
 *
 * 证据：`.local/evidence/plan-0665/`（截图 + 观测 JSON + DB 转储），绝不写入 worktree。
 */
/**
 * 证据根**不依赖 `process.cwd()`**（直跑 Playwright / 从 worktree 跑时 cwd 不同，会写到
 * "不知道去哪了"的位置）。优先用 e2e-host 注入的 `XIHE_WORKSPACE_HOST_ROOT`
 * （= `<one>/A03-xihe/.tmp/e2e-host/<runId>`，上 4 级即 one 根）；手工直跑时从 cwd 上 3 级
 * 推导，worktree 下多退一级 `.worktrees`。
 */
function resolveEvidenceDir(): string {
    const hostRoot = process.env.XIHE_WORKSPACE_HOST_ROOT;
    let oneRoot: string;
    if (hostRoot) {
        oneRoot = path.resolve(hostRoot, "../../../..");
    } else {
        const threeUp = path.resolve(process.cwd(), "../../..");
        oneRoot = path.basename(threeUp) === ".worktrees" ? path.resolve(threeUp, "..") : threeUp;
    }
    return path.join(oneRoot, ".local", "evidence", "plan-0665");
}
const EVIDENCE_DIR = resolveEvidenceDir();

/**
 * 真栈演示夹具（e2e-host `--llm-mode=success` 的 fake LLM 通道，Lead 2026-11-05 授权）：
 * 新用户 → USER 作用域 `openai` 连接（dummy key，指向 e2e-host 的 fake LLM）→ verify READY →
 * user 层 llm profile 指向它。Agent 侧由 e2e-host 注入 `XIHE_LLM_PROVIDER=openai` +
 * `XIHE_API_BASE=<fake>/openai/v1`，两端因此落在同一个 fake server 上。
 */
const FAKE_LLM_PORT = process.env.XIHE_FAKE_LLM_PORT || "12680";
const FAKE_LLM_BASE = `http://127.0.0.1:${FAKE_LLM_PORT}/openai/v1`;
const FAKE_MODEL = "fake-fanout";
const FAKE_CONNECTION_KEY = "default";

async function ensureFakeProvider(
    request: APIRequestContext,
    auth: { accessToken: string; workspaceId: string },
): Promise<void> {
    const headers = {
        Authorization: `Bearer ${auth.accessToken}`,
        "Content-Type": "application/json",
    };
    const created = await request.post(`${CP_URL}/api/v1/provider-connections`, {
        headers,
        data: {
            providerId: "openai",
            apiTypeId: "openai-chat-completions",
            apiTypeVersion: 1,
            apiKey: "sk-fake-openai-key",
            connectionKey: FAKE_CONNECTION_KEY,
            label: "PLAN-0665 fan-out fake LLM",
            scope: "USER",
            modelDiscovery: "manual",
            manualModels: [FAKE_MODEL],
            baseUrl: FAKE_LLM_BASE,
        },
    });
    expect(
        created.ok(),
        `provider connection create ${created.status()}: ${await created.text()}`,
    ).toBe(true);
    const connection = (await created.json()) as { id: string };
    const verified = await request.post(
        `${CP_URL}/api/v1/provider-connections/${connection.id}/verify`,
        { headers },
    );
    expect(verified.ok(), `provider connection verify: ${await verified.text()}`).toBe(true);
    const profile = await request.put(`${CP_URL}/api/v1/config/user/llm-provider`, {
        headers,
        data: {
            profile: JSON.stringify({
                providerId: "openai",
                connectionKey: FAKE_CONNECTION_KEY,
                model: FAKE_MODEL,
            }),
        },
    });
    expect(profile.status(), `user llm profile write: ${await profile.text()}`).toBe(200);
}

function psql(sql: string): string {
    const container = process.env.XIHE_E2E_PG_CONTAINER,
        database = process.env.XIHE_E2E_PG_DATABASE,
        dbUser = process.env.XIHE_E2E_PG_USER;
    if (!container || !database || !dbUser) {
        throw new Error(
            "isolated PostgreSQL fixture metadata is unavailable; run through scripts/e2e-host.mjs",
        );
    }
    return execFileSync(
        process.platform === "win32" ? "docker.exe" : "docker",
        ["exec", container, "psql", "-X", "-A", "-t", "-U", dbUser, "-d", database, "-c", sql],
        { encoding: "utf8", timeout: 20_000, windowsHide: true },
    ).trim();
}

async function addAgentParticipant(
    request: APIRequestContext,
    headers: Record<string, string>,
    sessionId: string,
    principalId: string,
): Promise<string> {
    const added = await request.post(`${CP_URL}/api/v1/sessions/${sessionId}/participants`, {
        headers,
        data: { principalKind: "AGENT", principalId, role: "MEMBER" },
    });
    expect(added.status(), await added.text()).toBe(201);
    const body = (await added.json()) as { participantId?: string };
    expect(body.participantId, "participant id must be returned").toBeTruthy();
    return body.participantId as string;
}

async function awaitIdle(
    request: APIRequestContext,
    headers: Record<string, string>,
    sessionId: string,
): Promise<void> {
    await expect
        .poll(
            async () => {
                const res = await request.get(
                    `${CP_URL}/api/v1/chat/sessions/${sessionId}/runs?page=0&size=10`,
                    { headers },
                );
                if (!res.ok()) return "unavailable";
                const body = (await res.json()) as { runs?: Array<{ status?: string }> };
                const terminal = new Set([
                    "succeeded",
                    "failed",
                    "cancelled",
                    "partial",
                    "ambiguous",
                ]);
                const active = (body.runs ?? []).filter(
                    (run) => run.status === undefined || !terminal.has(run.status),
                );
                return active.length === 0 ? "idle" : String(active[0]?.status ?? "active");
            },
            { timeout: 300_000, intervals: [1_000, 2_000, 3_000] },
        )
        .toBe("idle");
}

async function selectToTargets(page: Page, names: string[]): Promise<void> {
    const input = page.getByTestId("to-targets-input");
    await expect(input, "the TO multi-select must render for an AGENT session").toBeVisible({
        timeout: 30_000,
    });
    for (const name of names) {
        await input.click();
        await input.fill(name);
        const option = page
            .locator('[data-testid^="to-targets-option"]')
            .filter({ hasText: name })
            .first();
        if (await option.isVisible().catch(() => false)) {
            await option.click();
        } else {
            await input.press("Enter");
        }
        await expect(
            page.locator('[data-testid="to-targets-chip"]').filter({ hasText: name }).first(),
        ).toBeVisible({ timeout: 10_000 });
    }
    await input.press("Escape");
}

test.describe("@host PLAN-0665 M2 real TO fan-out delivery", () => {
    test.describe.configure({ mode: "serial", retries: 0 });

    test("one TO message with two targets: two run groups, two durable badges, survive reload", async ({
        page,
        request,
    }) => {
        test.skip(
            !process.env.XIHE_E2E_PG_CONTAINER,
            "requires the isolated host-E2E stack (scripts/e2e-host.mjs)",
        );
        test.setTimeout(900_000);
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        const observed: Record<string, unknown> = {
            plan: "PLAN-0665",
            task: "T2.2/T2.3 real demo",
            evidenceDir: EVIDENCE_DIR,
            steps: {} as Record<string, unknown>,
        };
        const steps = observed.steps as Record<string, unknown>;
        const persist = (): void => {
            writeFileSync(
                path.join(EVIDENCE_DIR, "to-fanout-observed.json"),
                JSON.stringify({ ...observed, observedAt: new Date().toISOString() }, null, 2),
            );
        };

        // ── Fixture: user + workspace + two AGENT principals in one session ──
        const ctx = await registerJourneyUser(request, "plan0665-fanout"),
            wsId = ctx.workspaceId,
            headers = { ...ctx.headers, "X-Workspace-Id": wsId };
        await ensureFakeProvider(request, {
            accessToken: ctx.authToken,
            workspaceId: ctx.workspaceId,
        });
        await ensureAgentWorkspaceBinding(wsId);
        await waitForControlPlaneAgentReady(request, headers);

        const auth = { accessToken: ctx.authToken, workspaceId: ctx.workspaceId };
        const agentA = await provisionWorkspaceAgentPrincipal(request, auth, {
            name: agentName("FanoutAlpha", Date.now()),
            actions: ["read"],
            systemPrompt: "Reply with a single short sentence naming yourself as Alpha.",
        });
        const agentB = await provisionWorkspaceAgentPrincipal(request, auth, {
            name: agentName("FanoutBeta", Date.now()),
            actions: ["read"],
            systemPrompt: "Reply with a single short sentence naming yourself as Beta.",
        });

        const sessionId = await createSessionWithPrincipal(request, auth, {
            principalId: agentA,
            title: "PLAN-0665 fan-out demo",
            workspaceId: wsId,
        });
        const participantB = await addAgentParticipant(request, headers, sessionId, agentB);
        steps["sessionId"] = sessionId;
        steps["participantB"] = participantB;

        // 从 UI 打开该会话（seedPage 写入 token/workspace；路由与产品入口一致）。
        await seedPage(page, ctx);
        await page.goto(workspaceChatPath(wsId, sessionId));
        await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 60_000 });
        await ensureChatReady(page);

        const roster = await request.get(`${CP_URL}/api/v1/sessions/${sessionId}/participants`, {
            headers,
        });
        expect(roster.ok(), await roster.text()).toBeTruthy();
        const rosterBody = (await roster.json()) as {
            participants: Array<{
                participantId: string;
                principalKind: string;
                displayName?: string;
            }>;
        };
        const agents = rosterBody.participants.filter((item) => item.principalKind === "AGENT");
        expect(agents.length, "the session must contain two AGENT participants").toBe(2);
        const targetNames = agents.map((agent) => agent.displayName ?? "").filter(Boolean);
        expect(targetNames.length, "both AGENT participants need display names").toBe(2);

        // ── Composer: select both TO targets, send one message ──
        await selectToTargets(page, targetNames);
        await page.getByTestId("chat-input").fill("请各自报名字，一句话即可。");
        await page.getByTestId("chat-send-button").click();
        await awaitIdle(request, headers, sessionId);
        steps["targets"] = targetNames;

        // ── UI 判据 1/2：两个 run 分组 + 消息头 `发送→A、B` 徽标（单一消息头列出两个目标）──
        await expect
            .poll(async () => page.locator('[data-testid="run-header"]').count(), {
                timeout: 60_000,
                intervals: [500, 1_000, 2_000],
            })
            .toBeGreaterThanOrEqual(2);
        const runHeaders = page.locator('[data-testid="run-header"]');
        const runIds = await runHeaders.evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute("data-run-id") ?? ""),
        );
        const distinctRunIds = [...new Set(runIds.filter(Boolean))];
        expect(distinctRunIds.length, `expected two distinct runs, got ${runIds}`).toBe(2);
        steps["runIds"] = distinctRunIds;

        const badges = page.locator('[data-testid="message-delivery-to"]');
        expect(await badges.count(), "exactly one user message header carries the delivery").toBe(
            1,
        );
        await expect(badges.first()).toBeVisible({ timeout: 30_000 });
        const badgeTexts = await badges.allTextContents();
        steps["badges"] = badgeTexts;
        for (const name of targetNames) {
            expect(
                badgeTexts.some((text) => text.includes(name)),
                `badge for ${name} missing in ${JSON.stringify(badgeTexts)}`,
            ).toBe(true);
        }
        await page.screenshot({ path: path.join(EVIDENCE_DIR, "01-two-runs-two-badges.png") });

        // ── DB 判据：durable delivery + origin 不同（user_submission / scheduled）──
        const deliveryJson = psql(
            `SELECT delivery::text FROM messages WHERE session_id = '${sessionId}' AND role = 'USER' AND delivery IS NOT NULL ORDER BY created_at ASC LIMIT 1`,
        );
        steps["messages.delivery"] = deliveryJson;
        const delivery = JSON.parse(deliveryJson) as { to?: string[]; cc?: string[] };
        expect(delivery.to, `durable delivery.to missing: ${deliveryJson}`).toHaveLength(2);
        for (const agent of agents) {
            expect(delivery.to, "durable delivery.to must carry participant ids only").toContain(
                agent.participantId,
            );
        }

        const origins = psql(
            `SELECT origin::text FROM chat_runs WHERE session_id = '${sessionId}' ORDER BY created_at ASC`,
        )
            .split(/\r?\n/)
            .filter(Boolean);
        steps["chat_runs.origin"] = origins;
        expect(origins.length, `expected two runs, got ${JSON.stringify(origins)}`).toBe(2);
        expect(origins[0], "the user_submission run is created first").toBe("user_submission");
        expect(origins[1], "the derived wake run is scheduled, not user_submission").toBe(
            "scheduled",
        );
        // 关键：origin 不同也必须按 runId 分组（这里两个 run 来自同一条消息）。
        expect(origins[0]).not.toBe(origins[1]);
        persist();

        // ── UI 判据 3：刷新后徽标仍在（BL-239 可视闭环）──
        await page.reload();
        await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 60_000 });
        await expect
            .poll(async () => page.locator('[data-testid="run-header"]').count(), {
                timeout: 60_000,
                intervals: [500, 1_000, 2_000],
            })
            .toBeGreaterThanOrEqual(2);
        const afterReload = page.locator('[data-testid="message-delivery-to"]');
        await expect(afterReload.first()).toBeVisible({ timeout: 60_000 });
        const afterReloadTexts = await afterReload.allTextContents();
        steps["badgesAfterReload"] = afterReloadTexts;
        for (const name of targetNames) {
            expect(
                afterReloadTexts.some((text) => text.includes(name)),
                `badge for ${name} lost after reload — durable delivery not applied on history: ${JSON.stringify(afterReloadTexts)}`,
            ).toBe(true);
        }
        await page.screenshot({
            path: path.join(EVIDENCE_DIR, "02-after-reload-badges-persist.png"),
        });
        persist();
    });
});
