/**
 * PLAN-0658 R9 @host — reasoning（思考过程）三段同值矩阵。
 *
 * mock 侧（`e2e/mock/session-matrix-reasoning.spec.ts`，M7）只验流式渲染，并把
 * **「完成后的持久折叠态」明确留给 real-lane R9**（mock 注释原话）。本 spec 验真栈三段：
 *
 *  1. **durable 读面**：`<think>…</think>` 载体（fake LLM `XIHE-E2E-REASONING` marker，
 *     见 `e2e/fixtures/reasoning-chunks.mjs` 的载体选择依据）随 `delta.content` 入库 ⇒
 *     `GET /sessions/{id}/messages` 的 assistant 内容应保留 reasoning 段；
 *  2. **UI 完成态**：消息渲染应把该段重建为 reasoning 过程行（`process-reasoning`），
 *     **默认折叠**，正文不出现原始 `<think>` 标签；
 *  3. **刷新后同值**：`reload()` 之后仍是 reasoning 行、展开内容与 durable 读面一致。
 *
 * 判据口径（Lead 2026-11-04 裁定）：UI + durable 三段同值；若真栈暴露产品缺口，用 fixme + BL
 * 编号记录期望，**不放宽断言**。
 */
import { expect, test, type APIRequestContext } from "@playwright/test";
import { CP_URL, getRootBranchId } from "./helpers/journey";
import { ensureWorkspace } from "./helpers/workspace";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";
import { agentName } from "./helpers/agent-name";
import { openSessionSse } from "./helpers/sse";
import { workspaceChatPath } from "../../src/lib/routes";

const NONCE = Date.now().toString(36);
const PASSWORD = process.env.XIHE_E2E_PASSWORD ?? "XhE2e!matrix1";
const FAKE_LLM_PORT = process.env.XIHE_FAKE_LLM_PORT ?? "";
const FAKE_LLM_MODEL = "fake-openai";
const FAKE_LLM_API_KEY = "sk-fake-openai-key";

/** 与 `e2e/fixtures/reasoning-chunks.mjs` 的冻结段落表对齐（改夹具必须同批改这里）。 */
const MARKER = "XIHE-E2E-REASONING";
const REASONING_STEP_1 = `${MARKER} 第一步`;
const REASONING_STEP_2 = `${MARKER} 第二步`;
const FINAL_TEXT = `${MARKER} 结论`;

let token = "";
let workspaceId = "";
let sessionId = "";
let rootBranchId = "";
let headers: Record<string, string> = {};
let closeSse: (() => void) | null = null;
/** durable 读面抓到的 assistant 正文（UI 断言与它对照 = 三段同值里的 durable 段）。 */
let durableContent = "";
let runId = "";

test.describe.configure({ mode: "serial", retries: 0 });

function messagesPath(): string {
    return `${CP_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/messages?branchId=${encodeURIComponent(rootBranchId)}`;
}

interface MessageRow {
    id?: string;
    role?: string;
    content?: string;
    runId?: string;
}

async function assistantContentForRun(
    request: APIRequestContext,
    targetRunId: string,
): Promise<string> {
    const response = await request.get(messagesPath(), { headers });
    if (!response.ok()) return "";
    const payload = (await response.json()) as MessageRow[] | { messages?: MessageRow[] };
    const rows = Array.isArray(payload) ? payload : (payload.messages ?? []);
    const match = rows.find((row) => row.role === "ASSISTANT" && row.runId === targetRunId);
    return match?.content ?? "";
}

test.describe("@host PLAN-0658 R9 reasoning 三段同值", () => {
    test.beforeAll(async ({ request }) => {
        expect(FAKE_LLM_PORT, "needs XIHE_FAKE_LLM_PORT (runner fake LLM)").not.toBe("");
        const email = `r9-owner-${NONCE}-${Math.floor(Math.random() * 10000)}@test.com`;
        const registered = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: { email, password: PASSWORD, name: "r9-owner" },
        });
        expect(registered.status(), await registered.text()).toBe(201);
        const auth = (await registered.json()) as { accessToken: string };
        token = auth.accessToken;
        workspaceId = await ensureWorkspace(request, token);
        headers = {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-Workspace-Id": workspaceId,
        };

        const connection = await request.post(`${CP_URL}/api/v1/provider-connections`, {
            headers,
            data: {
                providerId: "openai",
                apiTypeId: "openai-chat-completions",
                apiTypeVersion: 1,
                apiKey: FAKE_LLM_API_KEY,
                connectionKey: `r9-${NONCE}`,
                label: `R9 fake LLM (${NONCE})`,
                scope: "USER",
                modelDiscovery: "manual",
                manualModels: [FAKE_LLM_MODEL],
                baseUrl: `http://127.0.0.1:${FAKE_LLM_PORT}/openai/v1`,
            },
        });
        expect(connection.status(), await connection.text()).toBe(201);
        const connectionId = ((await connection.json()) as { id: string }).id;
        const verified = await request.post(
            `${CP_URL}/api/v1/provider-connections/${connectionId}/verify`,
            { headers },
        );
        expect(verified.ok(), await verified.text()).toBe(true);

        const principalId = await provisionWorkspaceAgentPrincipal(
            request,
            { accessToken: token, workspaceId },
            {
                name: agentName("R9", NONCE),
                actions: [],
                defaultModelProvider: "openai",
                defaultModelName: FAKE_LLM_MODEL,
            },
        );
        sessionId = await createSessionWithPrincipal(
            request,
            { accessToken: token, workspaceId },
            { principalId, title: `r9-reasoning-${NONCE}`, workspaceId },
        );
        rootBranchId = await getRootBranchId(request, sessionId, headers);
        closeSse = await openSessionSse(sessionId, token, {
            "X-Workspace-Id": workspaceId,
        });
    });

    test.afterAll(() => {
        closeSse?.();
        closeSse = null;
    });

    test("R9-1 durable 读面保留 reasoning 段与正文", async ({ request }) => {
        const sent = await request.post(`${CP_URL}/api/v1/chat`, {
            headers,
            data: {
                sessionId,
                branchId: rootBranchId,
                content: `${MARKER} 请给出两步结论 ${NONCE}`,
            },
        });
        expect(sent.status(), await sent.text()).toBe(202);
        runId = ((await sent.json()) as { runId?: string }).runId ?? "";
        expect(runId, "runId").toBeTruthy();

        // reasoning 载体随 content 入库：等 assistant 消息出现并带齐标记。
        await expect
            .poll(() => assistantContentForRun(request, runId), {
                timeout: 90_000,
                intervals: [500, 1_000],
            })
            .toContain(REASONING_STEP_1);

        durableContent = await assistantContentForRun(request, runId);
        expect(durableContent, "reasoning 开标签").toContain("<think>");
        expect(durableContent, "reasoning 闭标签").toContain("</think>");
        expect(durableContent, "reasoning 第二步").toContain(REASONING_STEP_2);
        expect(durableContent, "正文段").toContain(FINAL_TEXT);
        // 开标签必须在闭标签之前（顺序即"先思考再作答"）。
        expect(durableContent.indexOf("<think>")).toBeLessThan(durableContent.indexOf("</think>"));
    });

    test("R9-2 UI 完成态：reasoning 过程行默认折叠、正文无原始标签", async ({ page }) => {
        expect(durableContent, "R9-1 必须先拿到 durable 内容").not.toBe("");
        // OWNER 视角的浏览器上下文种子（PLAN-0560：角色只认 sessionStorage）。
        await page.addInitScript(
            ({ accessToken, ws }) => {
                localStorage.setItem("xihe-token", accessToken);
                localStorage.setItem(
                    "xihe-user",
                    JSON.stringify({
                        id: "e2e-owner",
                        email: "e2e-owner@test.com",
                        name: "E2E Owner",
                    }),
                );
                localStorage.setItem(
                    "xihe-workspace",
                    JSON.stringify({ id: ws, name: "R9 workspace" }),
                );
                sessionStorage.setItem(
                    "xihe-workspace",
                    JSON.stringify({
                        id: ws,
                        name: "R9 workspace",
                        workspaceRole: "OWNER",
                        ownerId: "x",
                    }),
                );
            },
            { accessToken: token, ws: workspaceId },
        );
        await page.goto(workspaceChatPath(workspaceId, sessionId));
        await expect(page.getByTestId("chat-input"), "composer mounts").toBeVisible({
            timeout: 30_000,
        });

        // 诊断（失败时能看到现场）：过程行数量 / 是否漏出原始标签。**只作日志**，不作断言 ——
        // 一次性快照会与流式收尾竞态（实测在冷栈上偶发），断言一律用 locator（自带重试）。
        const reasoningRows = page.getByTestId("process-reasoning");
        const rowCount = await reasoningRows.count();
        const bodySnapshot = await page.locator("body").innerText();
        console.log(
            `[R9] rows=${rowCount} hasOpenTag=${String(bodySnapshot.includes("<think>"))} ` +
                `hasStep1=${String(bodySnapshot.includes(REASONING_STEP_1))} ` +
                `hasFinal=${String(bodySnapshot.includes(FINAL_TEXT))}`,
        );

        await expect(reasoningRows.first(), "reasoning 过程行").toBeVisible({
            timeout: 30_000,
        });
        // PLAN-0659 T2.1 §2 · T1.2 渲染契约（real 链路，身份只认 data-*）：
        // ① 过程行带 `data-process-kind`；
        // ② 本会话是**单主体**（只有 PRIMARY agent 应答）⇒ 不得出现 `process-row-actor` 徽标；
        // ③ 单 run 会话**无** `run-header`（只有分组态/多 run 才渲染）。
        await expect(reasoningRows.first(), "过程行带 data-process-kind").toHaveAttribute(
            "data-process-kind",
            "reasoning",
        );
        await expect(
            page.getByTestId("process-row-actor"),
            "单主体线程不出现 process-row-actor",
        ).toHaveCount(0);
        await expect(page.getByTestId("run-header"), "单 run 会话无 run-header").toHaveCount(0);
        const toggle = reasoningRows.first().getByTestId("process-row-toggle");
        // 默认折叠：aria-expanded=false；折叠行只显示 summary（第一行），展开体里的第二段不渲染。
        await expect(toggle, "默认折叠").toHaveAttribute("aria-expanded", "false");
        await expect(
            reasoningRows.first().getByTestId("process-row-summary"),
            "折叠行显示首行摘要",
        ).toContainText(REASONING_STEP_1);
        await expect(
            reasoningRows.first().getByText(REASONING_STEP_2, { exact: false }),
            "折叠时不渲染 reasoning 全文（第二段只在展开体里）",
        ).toHaveCount(0);
        // 正文（消息 markdown 区）不得漏出原始标签 —— 否则说明没被解析成过程行。
        await expect(
            page.getByText("<think>", { exact: false }),
            "UI 不得显示原始标签",
        ).toHaveCount(0);
        await expect(
            page.getByText(FINAL_TEXT, { exact: false }).first(),
            "正文结论可见",
        ).toBeVisible({ timeout: 30_000 });

        // 展开：第二段（只在展开体里）出现 ⇒ 折叠/展开两态可区分（BL-231「展不开」若复现就在这失败）。
        await toggle.click();
        await expect(toggle, "展开后 aria-expanded=true").toHaveAttribute("aria-expanded", "true");
        await expect(
            reasoningRows.first().getByTestId("process-row-summary"),
            "摘要行仍在",
        ).toContainText(REASONING_STEP_1);
        await expect(
            reasoningRows.first().getByText(REASONING_STEP_2, { exact: false }),
            "展开体显示第二段（全文）",
        ).toBeVisible();
    });

    test("R9-3 刷新后同值：reasoning 行仍在，展开内容与 durable 读面一致", async ({ page }) => {
        expect(durableContent, "R9-1 必须先拿到 durable 内容").not.toBe("");
        await page.addInitScript(
            ({ accessToken, ws }) => {
                localStorage.setItem("xihe-token", accessToken);
                localStorage.setItem(
                    "xihe-user",
                    JSON.stringify({
                        id: "e2e-owner",
                        email: "e2e-owner@test.com",
                        name: "E2E Owner",
                    }),
                );
                localStorage.setItem(
                    "xihe-workspace",
                    JSON.stringify({ id: ws, name: "R9 workspace" }),
                );
                sessionStorage.setItem(
                    "xihe-workspace",
                    JSON.stringify({
                        id: ws,
                        name: "R9 workspace",
                        workspaceRole: "OWNER",
                        ownerId: "x",
                    }),
                );
            },
            { accessToken: token, ws: workspaceId },
        );
        await page.goto(workspaceChatPath(workspaceId, sessionId));
        await expect(page.getByTestId("chat-input"), "composer mounts").toBeVisible({
            timeout: 30_000,
        });
        await page.reload();
        await expect(page.getByTestId("chat-input"), "composer mounts after reload").toBeVisible({
            timeout: 30_000,
        });

        const reasoningRows = page.getByTestId("process-reasoning");
        await expect(reasoningRows.first(), "刷新后 reasoning 过程行仍在").toBeVisible({
            timeout: 30_000,
        });
        const toggle = reasoningRows.first().getByTestId("process-row-toggle");
        // 刷新后仍是折叠态（持久折叠 = mock M7 留给 R9 的判据）。
        await expect(toggle, "刷新后默认折叠").toHaveAttribute("aria-expanded", "false");
        await expect(
            reasoningRows.first().getByText(REASONING_STEP_2, { exact: false }),
        ).toHaveCount(0);
        await toggle.click();
        await expect(toggle, "刷新后展开").toHaveAttribute("aria-expanded", "true");
        await expect(
            reasoningRows.first().getByTestId("process-row-summary"),
            "摘要行与 durable 读面第一行同值",
        ).toContainText(REASONING_STEP_1);
        await expect(
            reasoningRows.first().getByText(REASONING_STEP_2, { exact: false }),
            "展开体与 durable 读面第二行同值",
        ).toBeVisible({ timeout: 10_000 });
    });
});
