import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";
import { actionableErrors, collectPageErrors } from "./helpers/console";
import { CP_URL, evidenceDir, registerJourneyUser, type JourneyContext } from "./helpers/journey";

const EVIDENCE_DIR = evidenceDir("plan0489-scheduled-tasks");

// PLAN-0489 T2.2 / V4：定时任务的真实浏览器 E2E（UI 面契约 = spec/ui-surfaces.md U1/U2/U3，
// 视觉基线 = evidence/PLAN-0489-scheduled-task-UI-preview.html，已由用户审阅通过）。
// 链路：工具栏「定时任务」入口 → 列表（表头/状态徽标/创建者列）→ 创建对话框（cron + delay_once）
// → 构造 missed（隔离 PG 夹具改 next_fire_at，**禁止的生产钩子一律不加**，T2.2 约定）
// → 三处置（补跑 / 推迟 / 移除 + remove 幂等）→ 非法 cron 错误态 → 移动 viewport。
// 夹具前提（与 agent-principal / plan0359 同模式）：fresh user 只有 GrantDefaultService 的
// read/write/exec 默认授权，CREATE_SCHEDULED_TASK 默认 deny → 经 grants 行种子；目标会话经
// helpers/agent-principal 引导（grants → 模板 → principal → binding → 会话）。
//   node scripts/e2e-host.mjs e2e/real/plan0489-scheduled-tasks.spec.ts --llm-mode=mock
test.describe("@host PLAN-0489 scheduled tasks", () => {
    test.describe.configure({ mode: "serial" });
    test.setTimeout(240000);

    const STATUS_LABELS: Record<string, string> = {
        scheduled: "调度中",
        missed: "错过 · 待处理",
        completed: "已完成",
        cancelled: "已取消",
    };

    let ctx: JourneyContext;
    let user: { id: string; email: string; name: string; workspaceId: string };
    let sessionId = "",
        cronTaskId = "",
        delayTaskId = "",
        rerunTaskId = "",
        removeTaskId = "",
        pageErrors: string[] = [];

    test.beforeEach(async ({ page }) => {
        pageErrors = collectPageErrors(page);
    });

    test.afterEach(async () => {
        expect(actionableErrors(pageErrors), pageErrors.join("\n")).toEqual([]);
    });

    // ── 夹具：隔离 PG（host runner 提供 XIHE_E2E_PG_*，缺失即失败，不 skip 掩盖拓扑缺失） ──

    function queryIsolatedPostgres(sql: string): string {
        const container = process.env.XIHE_E2E_PG_CONTAINER;
        const database = process.env.XIHE_E2E_PG_DATABASE;
        const dbUser = process.env.XIHE_E2E_PG_USER;
        if (!container || !database || !dbUser) {
            throw new Error(
                "isolated Postgres metadata is unavailable; run through scripts/e2e-host.mjs",
            );
        }
        return execFileSync(
            process.platform === "win32" ? "docker.exe" : "docker",
            ["exec", container, "psql", "-X", "-A", "-t", "-U", dbUser, "-d", database, "-c", sql],
            { encoding: "utf8", timeout: 15_000, windowsHide: true },
        ).trim();
    }

    function seedScheduledTaskGrants(userId: string): void {
        const permissions = JSON.stringify([
            { actionClass: "CREATE_SCHEDULED_TASK", resource: "*" },
            { actionClass: "MANAGE_SCHEDULED_TASK", resource: "*" },
        ]).replace(/'/g, "''");
        queryIsolatedPostgres(
            `INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source, read_state) ` +
                `VALUES (gen_random_uuid(), 'user', '${userId}'::uuid, 'user', '${userId}'::uuid, ` +
                `'${permissions}'::jsonb, 'direct', 'read')`,
        );
    }

    /** T2.2 构造 missed：把 next_fire_at 拨到 grace（10min）之前，等扫描标 missed——无生产钩子。 */
    function armPast(taskIds: string[]): void {
        const idList = taskIds.map((id) => `'${id}'::uuid`).join(", ");
        queryIsolatedPostgres(
            `UPDATE scheduled_tasks SET next_fire_at = now() - interval '11 minutes' ` +
                `WHERE status = 'scheduled' AND id IN (${idList})`,
        );
    }

    // ── API 断言助手 ─────────────────────────────────────────────────────────

    async function taskStatuses(request: APIRequestContext): Promise<Record<string, string>> {
        const response = await request.get(
            `${CP_URL}/api/v1/workspaces/${ctx.workspaceId}/scheduled-tasks?size=200`,
            { headers: ctx.headers },
        );
        expect(
            response.ok(),
            `list scheduled tasks ${response.status()} ${await response.text()}`,
        ).toBeTruthy();
        const body = (await response.json()) as { tasks: Array<{ id: string; status: string }> };
        const statuses: Record<string, string> = {};
        for (const task of body.tasks) statuses[task.id] = task.status;
        return statuses;
    }

    /**
     * 改库 → 等 30s 扫描标 missed(overdue_grace)。status='scheduled' 守卫保证不覆盖扫描已
     * 推进的状态；若扫描在改库竞态窗口里先认领分派、把它放回 scheduled，重试轮重新拨针
     * （completed 无法恢复 → 超时信息带出实际状态，运行时按此诊断）。
     */
    async function expectTasksMissed(request: APIRequestContext, taskIds: string[]): Promise<void> {
        let last = "unobserved";
        for (let attempt = 1; attempt <= 3; attempt++) {
            armPast(taskIds);
            try {
                // 失败信息取自断言输出（Received = 逐 id 状态串），message 选项在首轮求值，
                // 无法携带后续观测值，故不设置。
                await expect
                    .poll(
                        async () => {
                            const statuses = await taskStatuses(request);
                            last = taskIds
                                .map((id) => `${id.slice(0, 8)}=${statuses[id] ?? "missing"}`)
                                .join(",");
                            return taskIds.every((id) => statuses[id] === "missed")
                                ? "all-missed"
                                : last;
                        },
                        { timeout: 90000, intervals: [2000, 5000] },
                    )
                    .toBe("all-missed");
                return;
            } catch (cause) {
                if (attempt === 3) throw cause;
            }
        }
    }

    async function createFixtureCronTask(
        request: APIRequestContext,
        cronExpr: string,
        prompt: string,
    ): Promise<string> {
        const timezone = new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
        const response = await request.post(
            `${CP_URL}/api/v1/workspaces/${ctx.workspaceId}/scheduled-tasks`,
            {
                headers: ctx.headers,
                data: {
                    triggerKind: "cron",
                    cronExpr,
                    timezone,
                    targetKind: "session_wakeup",
                    targetSessionId: sessionId,
                    prompt,
                },
            },
        );
        expect(
            response.status(),
            `fixture cron create failed: ${response.status()} ${await response.text()}`,
        ).toBe(201);
        const body = (await response.json()) as { id?: string; status?: string };
        expect(body.id, "fixture task id").toBeTruthy();
        expect(body.status).toBe("scheduled");
        return String(body.id);
    }

    // ── 页面助手 ────────────────────────────────────────────────────────────

    function seedPage(page: Page): void {
        page.addInitScript((t) => localStorage.setItem("xihe-token", t), ctx.authToken);
        // xihe-user 必须带 name/email：canManageScheduledTask 以创建者名匹配启用处置按钮。
        page.addInitScript((raw) => localStorage.setItem("xihe-user", raw), JSON.stringify(user));
        page.addInitScript((ws) => localStorage.setItem("xihe-workspace", JSON.stringify(ws)), {
            id: ctx.workspaceId,
            name: "Plan0489 Workspace",
        });
        page.addInitScript((id) => localStorage.setItem("xihe-workspace-id", id), ctx.workspaceId);
    }

    function taskRow(page: Page, text: string) {
        return page.locator('[data-testid="scheduled-task-row"]').filter({ hasText: text });
    }

    function toastWith(page: Page, text: string) {
        return page.locator("[data-sonner-toast]").filter({ hasText: text }).first();
    }

    /** datetime-local 输入值（本地墙钟 YYYY-MM-DDTHH:mm）。 */
    function localDateTimeValue(offsetMs: number): string {
        const date = new Date(Date.now() + offsetMs);
        const pad = (value: number) => String(value).padStart(2, "0");
        return (
            `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
            `T${pad(date.getHours())}:${pad(date.getMinutes())}`
        );
    }

    /** 深链进入列表页并等待首屏列表 GET 落地（入口旅程单独在 U1 用工具栏覆盖）。 */
    async function gotoListPage(page: Page): Promise<void> {
        seedPage(page);
        const listLoaded = page.waitForResponse(
            (response) =>
                response.request().method() === "GET" &&
                response.url().includes(`/workspaces/${ctx.workspaceId}/scheduled-tasks`),
        );
        await page.goto(`/workspace/${ctx.workspaceId}/scheduled-tasks`, { waitUntil: "load" });
        const response = await listLoaded;
        expect(
            response.ok(),
            `scheduled task list ${response.status()} ${await response.text()}`,
        ).toBeTruthy();
        await expect(page.getByTestId("scheduled-tasks-heading")).toBeVisible({ timeout: 15000 });
    }

    test.beforeAll(async ({ request }) => {
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        ctx = await registerJourneyUser(request, "Plan0489Scheduled");

        const me = await request.get(`${CP_URL}/api/v1/auth/me`, { headers: ctx.headers });
        expect(me.ok(), `auth/me failed: ${me.status()} ${await me.text()}`).toBeTruthy();
        const meBody = (await me.json()) as { id: string; email: string; name: string };
        user = { ...meBody, workspaceId: ctx.workspaceId };
        seedScheduledTaskGrants(user.id);

        const agentAuth = { accessToken: ctx.authToken, workspaceId: ctx.workspaceId };
        const principalId = await provisionWorkspaceAgentPrincipal(request, agentAuth, {
            name: "Plan0489 Scheduled",
        });
        sessionId = await createSessionWithPrincipal(request, agentAuth, {
            principalId,
            title: "Plan0489 target session",
        });

        // 两个处置夹具（cron：仅在凌晨触发，测试窗口内不会自然到期）。
        rerunTaskId = await createFixtureCronTask(
            request,
            "0 4 * * *",
            "PLAN-0489 fixture rerun target",
        );
        removeTaskId = await createFixtureCronTask(
            request,
            "0 5 * * *",
            "PLAN-0489 fixture remove target",
        );
    });

    // ── U1：入口与列表渲染 ──────────────────────────────────────────────────

    test("U1 toolbar entry opens the list with headers, status badges and creator column", async ({
        page,
    }) => {
        seedPage(page);
        const listLoaded = page.waitForResponse(
            (response) =>
                response.request().method() === "GET" &&
                response.url().includes(`/workspaces/${ctx.workspaceId}/scheduled-tasks`),
        );
        await page.goto(`/workspace/${ctx.workspaceId}`, { waitUntil: "load" });

        const entry = page.locator('[data-testid="workspace-toolbar-scheduled-tasks"]');
        await expect(entry).toBeVisible({ timeout: 20000 });
        await expect(entry).toHaveAttribute("title", "定时任务");
        await entry.click();
        await page.waitForURL(
            (url) => url.pathname === `/workspace/${ctx.workspaceId}/scheduled-tasks`,
            { timeout: 15000 },
        );
        const list = await listLoaded;
        expect(list.ok(), `scheduled task list ${list.status()} ${await list.text()}`).toBeTruthy();

        await expect(page.getByTestId("scheduled-tasks-heading")).toContainText("定时任务");
        await expect(page.getByTestId("scheduled-tasks-filter-all")).toBeVisible();

        // 表头（U1：任务/触发/目标/状态/下次触发/创建者/操作）；exact 避免「触发」⊂「下次触发」。
        for (const header of ["任务", "触发", "目标", "状态", "下次触发", "创建者", "操作"]) {
            await expect(
                page.getByRole("columnheader", { name: header, exact: true }),
            ).toBeVisible();
        }

        // beforeAll 恰好种了 2 个 cron 夹具 → 表格渲染而非空态。
        const rows = page.locator('[data-testid="scheduled-task-row"]');
        await expect(rows).toHaveCount(2);
        const firstRow = rows.first();
        await expect(firstRow.locator('[data-testid="scheduled-task-status"]')).toContainText(
            "调度中",
        );
        await expect(firstRow.locator('[data-testid="scheduled-task-creator-type"]')).toContainText(
            "human",
        );
        await expect(firstRow.locator("td").nth(5)).toContainText(user.name);

        await page.screenshot({ scale: "css",
            path: path.join(EVIDENCE_DIR, "plan0489-u1-list.png"),
            fullPage: true,
        });
    });

    // ── U2：创建对话框 ──────────────────────────────────────────────────────

    test("U2 creates a cron session-wakeup task and the row shows scheduled with next fire", async ({
        page,
    }) => {
        await gotoListPage(page);
        await page.getByTestId("scheduled-tasks-create").click();
        const dialog = page.getByTestId("scheduled-task-create-dialog");
        await expect(dialog).toBeVisible();

        await page.getByTestId("st-create-cron-expr").fill("0 9 * * *");
        await page.getByTestId("st-create-session").selectOption(sessionId, { timeout: 20000 });
        await page.getByTestId("st-create-prompt").fill("PLAN-0489 cron wake prompt");

        const created = page.waitForResponse(
            (response) =>
                response.request().method() === "POST" &&
                response.url().endsWith(`/workspaces/${ctx.workspaceId}/scheduled-tasks`),
        );
        await page.getByTestId("st-create-submit").click();
        const response = await created;
        expect(response.status(), await response.text()).toBe(201);
        const body = (await response.json()) as {
            id?: string;
            status?: string;
            targetKind?: string;
            targetSessionId?: string;
            nextFireAt?: string | null;
        };
        cronTaskId = String(body.id ?? "");
        expect(cronTaskId).toBeTruthy();
        expect(body.status).toBe("scheduled");
        expect(body.targetKind).toBe("session_wakeup");
        expect(body.targetSessionId).toBe(sessionId);
        expect(body.nextFireAt, "cron task must carry a computed next fire").toBeTruthy();
        expect(new Date(String(body.nextFireAt)).getTime()).toBeGreaterThan(Date.now());

        await expect(dialog).toBeHidden();
        await expect(toastWith(page, "已创建")).toBeVisible({ timeout: 15000 });

        const cronRow = taskRow(page, "0 9 * * *");
        await expect(cronRow).toHaveCount(1);
        await expect(cronRow.locator('[data-testid="scheduled-task-status"]')).toContainText(
            "调度中",
        );
        await expect(cronRow.locator("td").nth(2)).toContainText("会话唤醒");
        // 下次触发非空：缺失时该单元格渲染占位「—」。
        await expect(cronRow.locator("td").nth(4)).not.toContainText("—");

        await page.screenshot({ scale: "css",
            path: path.join(EVIDENCE_DIR, "plan0489-u2-cron-created.png"),
            fullPage: true,
        });
    });

    test("U2 creates a delay-once task through the create dialog", async ({ page }) => {
        await gotoListPage(page);
        await page.getByTestId("scheduled-tasks-create").click();
        const dialog = page.getByTestId("scheduled-task-create-dialog");
        await expect(dialog).toBeVisible();

        await page.getByTestId("st-create-mode-delay").click();
        await page.getByTestId("st-create-delay-amount").fill("1");
        await page.getByTestId("st-create-session").selectOption(sessionId, { timeout: 20000 });
        await page.getByTestId("st-create-prompt").fill("PLAN-0489 delay wake prompt");

        const created = page.waitForResponse(
            (response) =>
                response.request().method() === "POST" &&
                response.url().endsWith(`/workspaces/${ctx.workspaceId}/scheduled-tasks`),
        );
        await page.getByTestId("st-create-submit").click();
        const response = await created;
        expect(response.status(), await response.text()).toBe(201);
        const body = (await response.json()) as {
            id?: string;
            status?: string;
            triggerKind?: string;
            nextFireAt?: string | null;
            expiresAt?: string | null;
        };
        delayTaskId = String(body.id ?? "");
        expect(delayTaskId).toBeTruthy();
        expect(body.triggerKind).toBe("delay_once");
        expect(body.status).toBe("scheduled");
        expect(new Date(String(body.nextFireAt)).getTime()).toBeGreaterThan(Date.now());
        expect(body.expiresAt, "delay_once carries the 7d TTL").toBeTruthy();

        await expect(dialog).toBeHidden();
        await expect(toastWith(page, "已创建")).toBeVisible({ timeout: 15000 });

        const delayRow = taskRow(page, "延迟一次");
        await expect(delayRow).toHaveCount(1);
        await expect(delayRow.locator('[data-testid="scheduled-task-status"]')).toContainText(
            "调度中",
        );

        await page.screenshot({ scale: "css",
            path: path.join(EVIDENCE_DIR, "plan0489-u2-delay-created.png"),
            fullPage: true,
        });
    });

    // ── T2.2：构造 missed（夹具改库，无生产钩子） ────────────────────────────

    test("T2.2 constructs missed rows by fixture-updating next_fire_at (no production hook)", async ({
        page,
        request,
    }) => {
        test.setTimeout(360000);
        const armed = [delayTaskId, rerunTaskId, removeTaskId];
        await expectTasksMissed(request, armed);

        await gotoListPage(page);
        await expect(page.getByTestId("scheduled-tasks-filter-pending")).toContainText("3");

        const delayRow = taskRow(page, "延迟一次");
        await expect(delayRow.locator('[data-testid="scheduled-task-status"]')).toContainText(
            "错过 · 待处理",
        );
        await expect(delayRow.locator('[data-testid="scheduled-task-reason"]')).toContainText(
            "超过宽限期未执行",
        );
        await expect(delayRow.locator('[data-testid="scheduled-task-missed-count"]')).toContainText(
            /×[1-9]/,
        );
        // U3 三个处置入口对 missed 行可用（创建者身份 → canManage 启用）。
        await expect(delayRow.getByTestId("scheduled-task-rerun")).toBeEnabled();
        await expect(delayRow.getByTestId("scheduled-task-postpone")).toBeEnabled();
        await expect(delayRow.getByTestId("scheduled-task-remove")).toBeEnabled();

        await expect(
            taskRow(page, "0 4 * * *").locator('[data-testid="scheduled-task-status"]'),
        ).toContainText("错过 · 待处理");
        await expect(
            taskRow(page, "0 5 * * *").locator('[data-testid="scheduled-task-status"]'),
        ).toContainText("错过 · 待处理");

        await page.screenshot({ scale: "css",
            path: path.join(EVIDENCE_DIR, "plan0489-u3-missed.png"),
            fullPage: true,
        });
    });

    // ── U3：三处置 ──────────────────────────────────────────────────────────

    test("U3 rerun fires exactly one request for a missed task and mirrors the settled status", async ({
        page,
        request,
    }) => {
        test.setTimeout(180000);
        await gotoListPage(page);
        const rerunRow = taskRow(page, "0 4 * * *");
        await expect(rerunRow.locator('[data-testid="scheduled-task-status"]')).toContainText(
            "错过 · 待处理",
        );

        const rerunRequests: string[] = [];
        page.on("request", (req) => {
            if (
                req.method() === "POST" &&
                req.url().includes(`/scheduled-tasks/${rerunTaskId}/rerun`)
            ) {
                rerunRequests.push(req.url());
            }
        });
        const rerunResponse = page.waitForResponse(
            (response) =>
                response.request().method() === "POST" &&
                response.url().includes(`/scheduled-tasks/${rerunTaskId}/rerun`),
        );
        // 同步双击：第一次点击置 store.mutatingTaskId → 按钮禁用 + 守卫短路，第二次不得发请求。
        await rerunRow.getByTestId("scheduled-task-rerun").evaluate((el) => {
            const button = el as HTMLElement;
            button.click();
            button.click();
        });
        const response = await rerunResponse;
        expect(response.status(), await response.text()).toBe(200);
        await expect(toastWith(page, "已补跑")).toBeVisible({ timeout: 15000 });

        // 分派在请求内同步 settle：cron 补跑成功 → scheduled（重算下次触发）；分派失败 → missed。
        // 失败信息取断言输出（Received = 最后观测状态）。
        let settled = "";
        await expect
            .poll(
                async () => {
                    const statuses = await taskStatuses(request);
                    settled = statuses[rerunTaskId] ?? "missing";
                    return settled;
                },
                { timeout: 90000 },
            )
            .toMatch(/^(scheduled|missed)$/);
        await expect(rerunRow.locator('[data-testid="scheduled-task-status"]')).toContainText(
            STATUS_LABELS[settled],
        );
        expect(rerunRequests, "mutating guard must allow exactly one rerun POST").toHaveLength(1);

        if (settled === "scheduled") {
            // 服务端 CAS 防重：settled 后再点补跑（行已非 missed）必须 409 SCHEDULED_TASK_STATE。
            const replay = await request.post(
                `${CP_URL}/api/v1/workspaces/${ctx.workspaceId}/scheduled-tasks/${rerunTaskId}/rerun`,
                { headers: ctx.headers, data: {} },
            );
            expect(replay.status()).toBe(409);
            const problem = (await replay.json()) as { code?: string };
            expect(problem.code).toBe("SCHEDULED_TASK_STATE");
        } else {
            // 分派失败使行回到 missed → 补跑仍然合法，双击防护只由上面的单请求断言覆盖。
            test.info().annotations.push({
                type: "rerun-settle",
                description:
                    "rerun dispatch settled back to missed (agent/wakeup path unavailable); replay 409 not applicable",
            });
        }

        await page.screenshot({ scale: "css",
            path: path.join(EVIDENCE_DIR, "plan0489-u3-rerun.png"),
            fullPage: true,
        });
    });

    test("U3 postpone moves a missed delay task back to scheduled with a future next fire", async ({
        page,
    }) => {
        await gotoListPage(page);
        const delayRow = taskRow(page, "延迟一次");
        await expect(delayRow.locator('[data-testid="scheduled-task-status"]')).toContainText(
            "错过 · 待处理",
        );

        await delayRow.getByTestId("scheduled-task-postpone").click();
        const dialog = page.getByTestId("scheduled-task-postpone-dialog");
        await expect(dialog).toBeVisible();
        await page.getByTestId("st-postpone-at").fill(localDateTimeValue(2 * 3_600_000));

        const postponed = page.waitForResponse(
            (response) =>
                response.request().method() === "POST" &&
                response.url().includes(`/scheduled-tasks/${delayTaskId}/postpone`),
        );
        await page.getByTestId("st-postpone-submit").click();
        const response = await postponed;
        expect(response.status(), await response.text()).toBe(200);
        const body = (await response.json()) as { status?: string; nextFireAt?: string };
        expect(body.status).toBe("scheduled");
        expect(new Date(String(body.nextFireAt)).getTime()).toBeGreaterThan(Date.now());

        await expect(dialog).toBeHidden();
        await expect(toastWith(page, "已推迟")).toBeVisible({ timeout: 15000 });
        await expect(delayRow.locator('[data-testid="scheduled-task-status"]')).toContainText(
            "调度中",
        );
        await expect(delayRow.locator("td").nth(4)).not.toContainText("—");

        await page.screenshot({ scale: "css",
            path: path.join(EVIDENCE_DIR, "plan0489-u3-postponed.png"),
            fullPage: true,
        });
    });

    test("U3 remove cancels a missed task and the remove endpoint stays idempotent", async ({
        page,
        request,
    }) => {
        await gotoListPage(page);
        const removeRow = taskRow(page, "0 5 * * *");
        await expect(removeRow.locator('[data-testid="scheduled-task-status"]')).toContainText(
            "错过 · 待处理",
        );

        await removeRow.getByTestId("scheduled-task-remove").click();
        const confirm = page.getByTestId("scheduled-task-remove-confirm");
        await expect(confirm).toBeVisible();
        const removed = page.waitForResponse(
            (response) =>
                response.request().method() === "POST" &&
                response.url().includes(`/scheduled-tasks/${removeTaskId}/remove`),
        );
        await page.getByTestId("scheduled-task-remove-confirm-btn").click();
        const response = await removed;
        expect(response.status(), await response.text()).toBe(200);
        const body = (await response.json()) as { changed?: boolean; status?: string };
        expect(body.changed).toBe(true);
        expect(body.status).toBe("cancelled");

        await expect(confirm).toBeHidden();
        await expect(toastWith(page, "已移除")).toBeVisible({ timeout: 15000 });
        await expect(removeRow.locator('[data-testid="scheduled-task-status"]')).toContainText(
            "已取消",
        );

        // 幂等（V4/0486 §4）：再 remove → 200 {changed:false}。行已 cancelled 后 UI 不再渲染
        // 移除按钮，removeUnchanged toast（i18n key workspace.scheduledTasks.removeUnchanged）
        // 无法从 UI 驱动，故幂等性由 API 断言 + i18n 映射共同证明。
        const again = await request.post(
            `${CP_URL}/api/v1/workspaces/${ctx.workspaceId}/scheduled-tasks/${removeTaskId}/remove`,
            { headers: ctx.headers, data: {} },
        );
        expect(again.status()).toBe(200);
        const idempotent = (await again.json()) as { changed?: boolean; status?: string };
        expect(idempotent.changed).toBe(false);
        expect(idempotent.status).toBe("cancelled");

        await page.screenshot({ scale: "css",
            path: path.join(EVIDENCE_DIR, "plan0489-u3-removed.png"),
            fullPage: true,
        });
        writeFileSync(
            path.join(EVIDENCE_DIR, "plan0489-disposition-evidence.json"),
            JSON.stringify(
                {
                    cronTaskId,
                    delayTaskId,
                    rerunTaskId,
                    removeTaskId,
                    removedIdempotent: idempotent,
                    finalStatuses: await taskStatuses(request),
                },
                null,
                2,
            ),
        );
    });

    // ── U2 错误态 ───────────────────────────────────────────────────────────

    test("U2 invalid cron expression surfaces INVALID_CRON_EXPR and keeps the dialog open", async ({
        page,
    }) => {
        await gotoListPage(page);
        await page.getByTestId("scheduled-tasks-create").click();
        const dialog = page.getByTestId("scheduled-task-create-dialog");
        await expect(dialog).toBeVisible();

        // 5 字段但 day-of-week=8 非法：客户端只查字段数 → 由服务端 400 拒绝（真实错误链路）。
        await page.getByTestId("st-create-cron-expr").fill("0 9 * * 8");
        await page.getByTestId("st-create-session").selectOption(sessionId, { timeout: 20000 });
        await page.getByTestId("st-create-prompt").fill("PLAN-0489 invalid cron prompt");

        const rejected = page.waitForResponse(
            (response) =>
                response.request().method() === "POST" &&
                response.url().endsWith(`/workspaces/${ctx.workspaceId}/scheduled-tasks`),
        );
        await page.getByTestId("st-create-submit").click();
        const response = await rejected;
        expect(response.status()).toBe(400);
        const problem = (await response.json()) as { code?: string };
        expect(problem.code).toBe("INVALID_CRON_EXPR");

        const fieldError = page.getByTestId("st-create-field-error");
        await expect(fieldError).toBeVisible({ timeout: 15000 });
        await expect(fieldError).toContainText("cron 表达式无效");
        await expect(dialog).toBeVisible();

        await page.screenshot({ scale: "css",
            path: path.join(EVIDENCE_DIR, "plan0489-u2-invalid-cron.png"),
            fullPage: false,
        });
        await page.getByTestId("st-create-cancel").click();
        await expect(dialog).toBeHidden();

        // 本测试故意触发 400，浏览器原生 `Failed to load resource ... 400` console 噪声无法在 UI
        // 层抑制（fetch 非 2xx 的网络层日志）。断言体已验证 400 + INVALID_CRON_EXPR 真实错误链路，
        // 故仅在此测试内剔除这条预期噪声；不动共享 actionableErrors（以免掩盖别处的意外 4xx/5xx）。
        pageErrors = pageErrors.filter(
            (entry) =>
                !/Failed to load resource: the server responded with a status of 400/.test(entry),
        );
    });

    // ── 移动 viewport ───────────────────────────────────────────────────────

    test("mobile 390x844 viewport renders stacked cards without horizontal overflow", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        seedPage(page);
        const listLoaded = page.waitForResponse(
            (response) =>
                response.request().method() === "GET" &&
                response.url().includes(`/workspaces/${ctx.workspaceId}/scheduled-tasks`),
        );
        await page.goto(`/workspace/${ctx.workspaceId}/scheduled-tasks`, { waitUntil: "load" });
        const response = await listLoaded;
        expect(
            response.ok(),
            `scheduled task list ${response.status()} ${await response.text()}`,
        ).toBeTruthy();

        const card = page.locator('[data-testid="scheduled-task-card"]').first();
        await expect(card).toBeVisible({ timeout: 15000 });
        await expect(card.locator('[data-testid="scheduled-task-status"]')).toBeVisible();
        await expect(card.locator('[data-testid="scheduled-task-creator-type"]')).toBeVisible();
        // 窄视口切换为堆叠卡片，桌面表格整体隐藏。
        await expect(page.locator("table")).toBeHidden();

        const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect(overflow, "no horizontal overflow at 390px").toBeLessThanOrEqual(2);

        await page.screenshot({ scale: "css",
            path: path.join(EVIDENCE_DIR, "plan0489-mobile-list.png"),
            fullPage: true,
        });
    });
});
