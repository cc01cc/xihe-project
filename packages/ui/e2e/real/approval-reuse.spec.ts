/**
 * PLAN-0337 T1.3 / V5 —— 审批疲劳消除（grant 复用）与 `auto` 免批的常驻 host 回归。
 *
 * 前置条件（缺一不可）：
 *  1. 栈必须用 `--llm-mode=write_file` 启动，例如
 *     `node scripts/e2e-host.mjs --persistent --llm-mode=write_file`
 *     —— fake LLM 只在非 `mock` 模式启动，且只有 `write_file` 模式会按用户消息里的
 *     `XIHE-E2E-WRITE <path> <content...>` 标记产出**确定性**的 write_file tool call；
 *     其它模式（approval / exec_command / read_file）产出的工具与参数形态不同，本文件会 skip。
 *  2. 必须带 Runtime（**不得** `--skip-runtime`）：write_file 需要 Runtime 沙箱真正执行并落盘。
 *  3. 必须是隔离栈（`XIHE_E2E_RUN_ID` 存在）。durable 断言直接查该轮隔离库；无 run id
 *     （例如对着长期 `dev:host` 跑 `@host` 全量）时本文件整体 skip，绝不误查 dev 库。
 *     设 `XIHE_E2E_REQUIRE_APPROVAL_GUARD=1` 可把"前置不满足"从 skip 升级为硬失败，
 *     供专用 lane 防止护栏静默跳过（Audit 2 B7）。
 *  4. **每个用例运行必须配一个新栈**：Agent 每进程只绑定一个 workspace，同一持久栈二次运行会
 *     在 Agent 侧以 `MCP workspace context cannot be reused across workspaces` 秒失败
 *     （Audit 2 观察）；迭代时先 teardown 再起新栈，否则会误判为回归。
 *
 * 断言口径（三层互相独立，不看 UI 文案）：
 *  - 审批卡次数：真实 UI 的审批弹窗出现次数（**审批专属** testid：`approval-approve` /
 *    `approval-allow-session`；通用 `modal-content` 会被其它弹窗命中，已弃用）；
 *  - 审批行数：隔离 PostgreSQL `approval_requests`（durable），按各组专属写路径**字面**匹配
 *    （`position(...)`，不用 `LIKE` 以免 `_` 当通配符误匹配）；
 *  - 复用命中：CP 审计 JSONL 的 `action=grant_reused`；
 *  - 闸门来源：durable `approval_requests.origin='cp_gate'`（V25；不再依赖日志文本匹配）。
 *
 * 三组写路径与内容互不相同（避免跨组命中同一 grant），组内逐字节相同（命中同一 arguments_hash）。
 * 组 B/C 在未修复代码下会多弹审批卡：用例**始终**点击档位按钮释放 run（避免前一组把会话卡在
 * awaiting_approval 阻塞后一组），最后用 `expect.soft` 汇总断言，因此一次运行能拿到全部三组的差异。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { CP_URL, ensureAgentWorkspaceBinding, registerJourneyUser, seedPage, type JourneyContext } from "./helpers/journey";

const RUN_ID = process.env.XIHE_E2E_RUN_ID ?? "";
const LLM_MODE = process.env.XIHE_E2E_LLM_MODE ?? "";
const PROFILE = process.env.XIHE_E2E_PROFILE ?? "all";

// 隔离栈命名公式与 scripts/e2e-host.mjs:51/54/84 一致。
const COMPACT_RUN_ID = RUN_ID.replace(/[^a-z0-9]/gi, "");
const PG_CONTAINER = `xihe-e2e-host-${COMPACT_RUN_ID}-postgres-1`;
const PG_DATABASE = `xihe_e2e_${RUN_ID.replace(/[^a-z0-9]/gi, "_")}`;
const PROJECT_DIR = path.resolve(process.cwd(), "../..");
const HOST_ROOT = path.join(PROJECT_DIR, ".tmp", "e2e-host", RUN_ID);
const AUDIT_LOG = path.join(HOST_ROOT, "logs", "audit.log");

const TERMINAL_RUN_STATES = /^(succeeded|failed|partial|ambiguous|cancelled)$/;
const TERMINAL_OPERATION_STATES = /^(completed|failed|partial|cancelled|none)$/;

// 单会话单 workspace：Agent 每进程只绑定一个 workspace（PLAN-262 边界），retry 会重新注册
// 新 workspace 而旧 Agent 无法复用，因此本文件关闭重试。
test.describe.configure({ retries: 0 });

// 前置不满足时默认 skip（保持本文件可被任意 lane 安全执行），但 `XIHE_E2E_REQUIRE_APPROVAL_GUARD=1`
// 时改为硬失败——否则"护栏静默 skip + 退出码 0"会让回归在无人察觉中通过（Audit 2 B7）。
const GUARD_REQUIRED = process.env.XIHE_E2E_REQUIRE_APPROVAL_GUARD === "1";
function gateOrSkip(condition: boolean, reason: string) {
    if (!condition) {
        return;
    }
    if (GUARD_REQUIRED) {
        throw new Error(`approval-reuse 护栏前置不满足且已要求强制执行: ${reason}`);
    }
    test.skip(true, reason);
}
gateOrSkip(
    !RUN_ID,
    "需要隔离 host 栈（scripts/e2e-host.mjs --persistent），禁止对 dev 库取证",
);
gateOrSkip(
    LLM_MODE !== "write_file",
    "需要以 --llm-mode=write_file 启动的栈（fake LLM 的确定性 write_file tool call）",
);
gateOrSkip(PROFILE !== "host", "本文件是 @host 用例");

interface PhaseTurn {
    runId: string;
    cardShown: boolean;
    runStatus: string;
    tier: "once" | "session";
}

function psql(sql: string): string {
    return execFileSync(
        "docker",
        ["exec", PG_CONTAINER, "psql", "-U", "xihe", "-d", PG_DATABASE, "-tAc", sql],
        { encoding: "utf8" },
    ).trim();
}

function psqlValue(sql: string): string {
    const value = psql(sql);
    return value === "" ? "" : value.split("\n")[0];
}

/** durable 审批行数：按组专属写路径过滤（details 存的是脱敏后的 canonical 预览，含 path）。 */
function approvalRowCount(sessionId: string, pathFragment: string): number {
    return Number(
        psqlValue(
            `select count(*) from approval_requests` +
                ` where session_id = '${sessionId}' and position('${pathFragment}' in details) > 0`,
        ),
    );
}

function approvalRowScalar(sessionId: string, pathFragment: string, column: string): string {
    return psqlValue(
        `select coalesce(${column}, '') from approval_requests` +
            ` where session_id = '${sessionId}' and position('${pathFragment}' in details) > 0` +
            ` order by created_at asc limit 1`,
    );
}

/** CP 审计 JSONL 中该会话的 action 列表（字段口径见 AuditLogger：session= | tool= | action= | detail=）。 */
function auditActionsForSession(sessionId: string): string[] {
    if (!existsSync(AUDIT_LOG)) return [];
    const actions: string[] = [];
    for (const line of readFileSync(AUDIT_LOG, "utf8").split("\n")) {
        if (!line.includes(`session=${sessionId}`)) continue;
        let message = "";
        try {
            message = (JSON.parse(line) as { message?: string }).message ?? "";
        } catch {
            continue;
        }
        const matched = /action=([a-z_]+)/.exec(message);
        if (matched) actions.push(matched[1]);
    }
    return actions;
}

const countAction = (actions: string[], action: string): number =>
    actions.filter((entry) => entry === action).length;

/**
 * 按 durable 来源统计审批行（V25 `approval_requests.origin`）。
 * 这是审计/Audit 2 B1 建议的收口口径：不再依赖 `audit.log`/`cp.log` 的文本匹配，
 * 直接查库区分「CP 闸门判定创建」与「Agent 中继（模型显式提问）创建」。
 */
function approvalRowCountByOrigin(sessionId: string, origin: string): number {
    return Number(
        psqlValue(
            `select count(*) from approval_requests` +
                ` where session_id = '${sessionId}' and origin = '${origin}'`,
        ),
    );
}

async function latestOperationStatus(
    request: APIRequestContext,
    headers: Record<string, string>,
): Promise<string> {
    const res = await request.get(`${CP_URL}/api/v1/operations?size=1`, { headers });
    if (!res.ok()) return `http-${res.status()}`;
    const body = (await res.json()) as { operations?: Array<{ status?: string }> };
    return body.operations?.[0]?.status ?? "none";
}

async function runStatus(
    request: APIRequestContext,
    headers: Record<string, string>,
    runId: string,
): Promise<string> {
    const res = await request.get(`${CP_URL}/api/v1/chat/runs/${runId}`, { headers });
    if (!res.ok()) return `http-${res.status()}`;
    return ((await res.json()) as { status?: string }).status ?? "unknown";
}

/** 同会话连续调用必须先等上一轮 operation 落地，否则命中 409 CHAT_IN_PROGRESS。 */
async function awaitSessionIdle(
    request: APIRequestContext,
    headers: Record<string, string>,
): Promise<void> {
    await expect
        .poll(() => latestOperationStatus(request, headers), {
            timeout: 120000,
            intervals: [1000, 2000],
            message: "上一轮 operation 未在超时内settled",
        })
        .toMatch(TERMINAL_OPERATION_STATES);
}

/**
 * 发一条 `XIHE-E2E-WRITE` 标记消息并走到终态。
 * 审批卡出现时**始终**点击档位按钮（先释放 run，再做断言），返回本轮观测。
 */
async function sendMarkerTurn(
    page: Page,
    request: APIRequestContext,
    sessionId: string,
    headers: Record<string, string>,
    turn: { path: string; content: string; tier: "once" | "session" },
): Promise<PhaseTurn> {
    await awaitSessionIdle(request, headers);

    const input = page.locator('[data-testid="chat-input"]');
    const send = page.locator('[data-testid="chat-send-button"]');
    // 审批专属标识（Audit 2 B6）：通用 `modal-content` 会被任何弹窗命中而误判为"出现了审批卡"；
    // 以审批操作按钮的存在作为卡出现判据。
    const modal = page
        .locator('[data-testid="approval-approve"], [data-testid="approval-allow-session"]')
        .first();
    await expect(input).toBeVisible({ timeout: 30000 });

    const marker = `XIHE-E2E-WRITE ${turn.path} ${turn.content}`;
    let runId = "";
    // SSE 尚未 hydrate 时点击不会 POST（PLAN-294 M1）：无 sleep 地有限重试直到观测到 chat POST。
    for (let attempt = 0; attempt < 3 && !runId; attempt += 1) {
        const posted = page.waitForResponse(
            (response) =>
                response.url().endsWith("/api/v1/chat") && response.request().method() === "POST",
            { timeout: 20000 },
        );
        await input.click();
        await input.fill(marker);
        await expect(send).toBeEnabled({ timeout: 15000 });
        await send.click();
        try {
            const response = await posted;
            runId = ((await response.json()) as { runId?: string }).runId ?? "";
        } catch {
            runId = "";
        }
    }
    expect(runId, `chat POST 未返回 runId（session=${sessionId}）`).not.toBe("");

    // 无固定 sleep：轮询「审批卡出现」与「run 到终态」两个可观测事件，取先到者。
    let observed = "pending";
    await expect
        .poll(
            async () => {
                observed = (await modal.isVisible().catch(() => false))
                    ? "card"
                    : await runStatus(request, headers, runId).then((status) =>
                          TERMINAL_RUN_STATES.test(status) ? `terminal:${status}` : "pending",
                      );
                return observed;
            },
            { timeout: 180000, intervals: [500, 1000, 2000] },
        )
        .not.toBe("pending");

    const cardShown = observed === "card";
    if (cardShown) {
        const tierButton = page.locator(
            turn.tier === "session"
                ? '[data-testid="approval-allow-session"]'
                : '[data-testid="approval-approve"]',
        );
        if ((await tierButton.count()) === 0) {
            await page.locator('[data-testid="approval-approve"]').click();
        } else {
            await tierButton.click();
        }
        await expect(modal).toBeHidden({ timeout: 30000 });
    }

    await expect
        .poll(() => runStatus(request, headers, runId), { timeout: 180000, intervals: [500, 1000] })
        .toMatch(TERMINAL_RUN_STATES);

    return {
        runId,
        cardShown,
        runStatus: await runStatus(request, headers, runId),
        tier: turn.tier,
    };
}

test("@host 审批复用护栏：once 对照组 3/3、session 复用 1 行 + grant_reused≥2、auto 0 卡 0 行、卡来自 CP 闸门", async ({
    page,
    request,
}) => {
    test.setTimeout(900000);

    let ctx: JourneyContext;
    let sessionId: string;
    const phaseTurns: Record<"A" | "B" | "C", PhaseTurn[]> = { A: [], B: [], C: [] };

    const pathA = "pl0337-guard-a-once.txt";
    const pathB = "pl0337-guard-b-session.txt";
    const pathC = "pl0337-guard-c-auto.txt";
    // 内容用于验证"真实落盘"（排除残留同名文件造成的假绿），组间互不相同。
    const CONTENT_A = "pl0337 guard group A once-tier probe";
    const CONTENT_B = "pl0337 guard group B session-tier probe";
    const CONTENT_C = "pl0337 guard group C auto-mode probe";

    await test.step("准备：注册单 workspace + 单会话（Agent 单 workspace 绑定）", async () => {
        ctx = await registerJourneyUser(request, "ApprovalReuseGuard");
        // PLAN-0369: single-binding Agent — rebind before the workspace chats.
        await ensureAgentWorkspaceBinding(ctx.workspaceId);
        const created = await request.post(`${CP_URL}/api/v1/sessions`, {
            headers: ctx.headers,
            data: { title: "PLAN-0337 approval reuse guard" },
        });
        expect(
            created.ok(),
            `创建会话失败: ${created.status()} ${await created.text()}`,
        ).toBeTruthy();
        const body = (await created.json()) as { id?: string; sessionId?: string };
        sessionId = body.id ?? body.sessionId ?? "";
        expect(sessionId).not.toBe("");
        seedPage(page, ctx);
        await page.goto(`/workspace/${ctx.workspaceId}`, { waitUntil: "load" });
        await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({ timeout: 30000 });
    });

    await test.step("A 对照组（once）：3 次同参数调用 → 3 张卡 / 3 行", async () => {
        for (let index = 0; index < 3; index += 1) {
            phaseTurns.A.push(
                await sendMarkerTurn(page, request, sessionId, ctx.headers, {
                    path: pathA,
                    content: CONTENT_A,
                    tier: "once",
                }),
            );
        }
    });

    await test.step("B 复用（session）：3 次同参数调用，第 1 次本会话允许 → 后续 0 卡 / 1 行", async () => {
        for (let index = 0; index < 3; index += 1) {
            phaseTurns.B.push(
                await sendMarkerTurn(page, request, sessionId, ctx.headers, {
                    path: pathB,
                    content: CONTENT_B,
                    tier: "session",
                }),
            );
        }
    });

    await test.step("C 免批（auto）：会话模式 auto + 2 次同参数调用 → 0 卡 / 0 行", async () => {
        const setMode = await request.post(`${CP_URL}/api/v1/policy/mode`, {
            headers: ctx.headers,
            data: { sessionId, mode: "auto" },
        });
        expect(
            setMode.ok(),
            `设置 auto 模式失败: ${setMode.status()} ${await setMode.text()}`,
        ).toBeTruthy();
        try {
            for (let index = 0; index < 2; index += 1) {
                phaseTurns.C.push(
                    await sendMarkerTurn(page, request, sessionId, ctx.headers, {
                        path: pathC,
                        content: CONTENT_C,
                        tier: "once",
                    }),
                );
            }
        } finally {
            await request.post(`${CP_URL}/api/v1/policy/mode`, {
                headers: ctx.headers,
                data: { sessionId, mode: "manual" },
            });
        }
    });

    // ---- 汇总断言（expect.soft：一次运行拿到全部三组的差异）----
    // 每轮都必须真正跑到终态：否则「没弹卡」可能只是工具被跳过，而不是复用/免批生效。
    for (const [group, turns] of Object.entries(phaseTurns) as Array<
        ["A" | "B" | "C", PhaseTurn[]]
    >) {
        expect
            .soft(
                turns.map((entry) => entry.runStatus),
                `${group} 组每轮 run 都必须 succeeded（工具真实执行）`,
            )
            .toEqual(turns.map(() => "succeeded"));
    }

    // A 对照组（once）：无复用 → 3 次调用 3 张卡 + 3 行。
    expect
        .soft(
            phaseTurns.A.map((entry) => entry.cardShown),
            "A 对照组：每次同参数调用都必须出现审批卡",
        )
        .toEqual([true, true, true]);
    const rowsA = approvalRowCount(sessionId, pathA);
    expect.soft(rowsA, "A 对照组 durable 审批行数 = 3").toBe(3);
    expect
        .soft(approvalRowScalar(sessionId, pathA, "decision_kind"), "A 组档位必须落成 once")
        .toBe("once");

    // B 复用（session）：第 1 次本会话允许 → 第 2/3 次不再弹卡、不再建行，并命中 grant 复用。
    expect
        .soft(
            phaseTurns.B.map((entry) => entry.cardShown),
            "B 复用：第 1 次出现审批卡，第 2/3 次同参数调用必须命中 grant 复用、不得再弹卡",
        )
        .toEqual([true, false, false]);
    const rowsB = approvalRowCount(sessionId, pathB);
    expect.soft(rowsB, "B 复用组 durable 审批行数 = 1（复用命中后不得再建行）").toBe(1);
    expect
        .soft(approvalRowScalar(sessionId, pathB, "reuse_scope"), "B 组首轮档位必须落成 session")
        .toBe("session");
    const actions = auditActionsForSession(sessionId);
    const grantReused = countAction(actions, "grant_reused");
    expect
        .soft(grantReused, "B 组第 2/3 次调用必须命中 CP 侧 grant 复用（审计 action=grant_reused）")
        .toBe(2);

    // C 免批（auto）：会话模式 auto → 0 卡、0 行，但写必须真实落盘。
    expect
        .soft(
            phaseTurns.C.map((entry) => entry.cardShown),
            "C 免批：会话模式 auto 下不得出现任何审批卡",
        )
        .toEqual([false, false]);
    const rowsC = approvalRowCount(sessionId, pathC);
    expect.soft(rowsC, "C auto 组 durable 审批行数 = 0").toBe(0);
    const hostFile = path.join(HOST_ROOT, ctx.workspaceId, pathC);
    expect.soft(existsSync(hostFile), `auto 模式下的写必须真实落盘: ${hostFile}`).toBe(true);
    // 只验存在会被"残留同名文件"假绿：内容必须与该轮写入逐字节相同（每轮独立 host root，故内容即新鲜度）。
    const cContent = existsSync(hostFile) ? readFileSync(hostFile, "utf8") : "";
    expect
        .soft(cContent, "auto 模式落盘内容必须与写入内容一致（排除残留文件假绿）")
        .toBe(CONTENT_C);

    // 来源：审批行必须由 CP 闸门判定产生，而不是 Agent 中继（模型显式提问）。
    // V25 起 `approval_requests.origin` 是唯一权威口径（此前两条创建路径在 durable 行上同构，
    // 只能翻 audit.log/cp.log 文本猜，见 Audit 2 B1）。
    // 精确值而非 >0：A 组 3 次 + B 组首轮 1 次 = 恰好 4；阈值过松会放过"混合回归"。
    const gateOwnedRows = approvalRowCountByOrigin(sessionId, "cp_gate");
    expect
        .soft(gateOwnedRows, "审批行必须恰好 4 条来自 CP 闸门（approval_requests.origin=cp_gate）")
        .toBe(4);
    const relayOwnedRows = approvalRowCountByOrigin(sessionId, "agent_relay");
    expect
        .soft(relayOwnedRows, "本场景不得出现 Agent 中继来源的审批行（模型未调用 request_approval）")
        .toBe(0);
    const legacyOriginRows = Number(
        psqlValue(
            `select count(*) from approval_requests where session_id = '${sessionId}' and origin is null`,
        ),
    );
    expect
        .soft(legacyOriginRows, "本会话不得有无来源（NULL）的历史行：每轮新库，全部行都应带 origin")
        .toBe(0);
});
