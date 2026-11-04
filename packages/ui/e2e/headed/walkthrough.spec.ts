/**
 * PLAN-0621 M0/M1 —— 有头浏览器真实场景走查（S1–S8）。
 *
 * 与无头批次的关系：
 * - 本目录**不在** `e2e/mock` / `e2e/real` 之内，`mock-full`（`specs: ["e2e/real"]`）天然收集不到它；
 * - 只有 `--batch=headed` 或显式传 `e2e/headed` 才会跑；
 * - 需要 `XIHE_E2E_HEADED=1`（有头）+ `XIHE_E2E_BROWSER_CHANNEL=chrome-beta`（全机单窗口，跑前确认无其它有头会话）。
 *
 * 证据（**不提交**）：`.tmp/xh-headed-walkthrough/runs/<XIHE_E2E_RUN_ID>/`
 *   shots/NN-*.png      每步截图（成功断言之后才截）
 *   report.json         每步 step/URL/断言/截图/关键状态码
 *   console-errors.log  console.error + pageerror + requestfailed
 *
 * 纪律：本文件只做**观察与断言**，不修 finding（M3 才修）；断言失败即记录事实，不吞错。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { bindToolCapableChat } from "../real/helpers/tool-capable-chat";

import { agentName } from "../real/helpers/agent-name";
const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const RUN_ID = process.env.XIHE_E2E_RUN_ID || `headed-${Date.now()}`;
const RUN_DIR = path.resolve(process.cwd(), "../../.tmp/xh-headed-walkthrough/runs", RUN_ID);
const SHOTS_DIR = path.join(RUN_DIR, "shots");
const GOLDPATH_EMAIL = process.env.XIHE_E2E_GOLDPATH_EMAIL ?? "";
const GOLDPATH_PASSWORD = process.env.XIHE_E2E_GOLDPATH_PASSWORD ?? "";
const SHARED_PASSWORD = `Headed-${randomUUID().slice(0, 8)}`;
const FAKE_LLM_MODEL = "fake-openai";

type StepRecord = {
    id: string;
    step: string;
    url: string;
    assertion: string;
    screenshot: string;
    detail?: Record<string, unknown>;
};

const steps: StepRecord[] = [];
// 注意：S6 → S7 原计划用 `lastChatUrl` 在 serial 的 test 之间传递"上一轮对话页 URL"，
// 但 S7 已并入 S6（同一浏览器上下文内验证刷新），该变量从未被读写过 —— 已删除。
const consoleLog: string[] = [];
let shotSeq = 0;

function recordStep(entry: Omit<StepRecord, "screenshot">, shotName: string): void {
    steps.push({ ...entry, screenshot: path.join("shots", shotName) });
}

/** 截图只在**断言通过之后**调用：截图 = 已证实的事实，不是"看起来还行"。 */
async function shot(page: Page, id: string, name: string, assertion: string): Promise<string> {
    shotSeq += 1;
    const fileName = `${String(shotSeq).padStart(2, "0")}-${name}.png`;
    await page.screenshot({ path: path.join(SHOTS_DIR, fileName), fullPage: true });
    recordStep({ id, step: name, url: page.url(), assertion }, fileName);
    return path.join(SHOTS_DIR, fileName);
}

function attachPageDiagnostics(page: Page): void {
    page.on("console", (message) => {
        if (message.type() === "error") consoleLog.push(`[console.error] ${message.text()}`);
    });
    page.on("pageerror", (error) => consoleLog.push(`[pageerror] ${error.message}`));
    page.on("requestfailed", (request) => {
        const reason = request.failure()?.errorText ?? "unknown";
        if (reason !== "net::ERR_ABORTED") {
            consoleLog.push(`[requestfailed] ${request.method()} ${request.url()} :: ${reason}`);
        }
    });
}

function bearer(token: string) {
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function tokenOf(page: Page): Promise<string> {
    const token = await page.evaluate(() => localStorage.getItem("xihe-token"));
    expect(token, "the UI must have persisted a token").toBeTruthy();
    return token!;
}

/** 走真实登录表单（`#identifier` + `#password`）——F-02 的观察点就在这里。 */
async function loginViaForm(page: Page, identifier: string, password: string): Promise<void> {
    await page.goto("/login", { waitUntil: "load" });
    await page.locator("#identifier").fill(identifier);
    await page.locator("#password").fill(password);
    const loginResponse = page.waitForResponse(
        (response) =>
            new URL(response.url()).pathname === "/api/v1/auth/login" &&
            response.request().method() === "POST",
    );
    await page.locator("button[type=submit]").first().click();
    const response = await loginResponse;
    // F-02：表单**确实**会 POST /auth/login；这里把状态码留档，失败时一眼能看到是 401 还是没发请求。
    test.info().annotations.push({
        type: "headed-login-form",
        description: `POST /auth/login → ${response.status()}`,
    });
    expect(response.status(), `login form must authenticate (${await response.text()})`).toBe(200);
    await expect
        .poll(() => page.evaluate(() => Boolean(localStorage.getItem("xihe-token"))), {
            timeout: 30000,
            intervals: [250, 500],
        })
        .toBe(true);
}

/** 注册页的 username 规则：1–32 位小写字母/数字且以字母开头（CP 400 USERNAME_INVALID 实测）。 */
function validUsername(seed: string): string {
    const base = seed.toLowerCase().replace(/[^a-z0-9]/g, "");
    const trimmed = (base.replace(/^[^a-z]+/, "") || "headed").slice(0, 28);
    return /^[a-z]/.test(trimmed) ? trimmed : `h${trimmed}`;
}

/**
 * 表单注册：用户名按邮箱派生（`validUsername`），第三个参数是历史遗留的显示名，
 * 注册表单并不消费它 ⇒ 用 `_name` 保留位置，调用方无需改动。
 */
async function registerViaForm(page: Page, email: string, _name: string): Promise<void> {
    await page.goto("/register", { waitUntil: "load" });
    await page.locator("#email").fill(email);
    const username = page.locator("#username");
    if (await username.count()) await username.fill(validUsername(email.split("@")[0]));
    await page.locator("#password").fill(SHARED_PASSWORD);
    const confirm = page.locator("#confirmPassword");
    if (await confirm.count()) await confirm.fill(SHARED_PASSWORD);
    const registerResponse = page.waitForResponse(
        (response) =>
            new URL(response.url()).pathname === "/api/v1/auth/register" &&
            response.request().method() === "POST",
    );
    await page.locator("button[type=submit]").first().click();
    const response = await registerResponse;
    test.info().annotations.push({
        type: "headed-register-form",
        description: `POST /auth/register → ${response.status()} (username=${validUsername(email.split("@")[0])})`,
    });
    expect([200, 201], `register must succeed (${await response.text()})`).toContain(
        response.status(),
    );
}

/** 空白起步首屏：要么空态引导，要么已有条目。 */
async function landOnWorkspacePicker(page: Page): Promise<"picker-empty" | "picker" | "workspace"> {
    await page.goto("/workspace", { waitUntil: "load" });
    await expect
        .poll(
            async () => {
                if (
                    await page
                        .getByTestId("workspace-picker-empty")
                        .isVisible()
                        .catch(() => false)
                )
                    return "picker-empty";
                if (
                    await page
                        .locator('[data-testid^="workspace-picker-item-"]')
                        .first()
                        .isVisible()
                        .catch(() => false)
                )
                    return "picker";
                if (
                    await page
                        .getByTestId("workspace-toolbar-add")
                        .isVisible()
                        .catch(() => false)
                )
                    return "workspace";
                return "unknown";
            },
            { timeout: 45000, intervals: [250, 500, 1000] },
        )
        .not.toBe("unknown");
    if (
        await page
            .getByTestId("workspace-picker-empty")
            .isVisible()
            .catch(() => false)
    )
        return "picker-empty";
    if (
        await page
            .locator('[data-testid^="workspace-picker-item-"]')
            .first()
            .isVisible()
            .catch(() => false)
    )
        return "picker";
    return "workspace";
}

/** 经真实对话框建一个 `direct_attach` 工作区（含冻结卡片观察 + preflight 选模式）。 */
async function createWorkspaceViaDialog(
    page: Page,
    request: APIRequestContext,
    opener: "picker" | "toolbar",
): Promise<{ workspaceId: string; frozenCardVisible: boolean; executionMode: string }> {
    const hostDir = path.resolve(
        process.cwd(),
        "../../.tmp/xh-headed-walkthrough/host-dirs",
        `ws-${Date.now()}`,
    );
    mkdirSync(hostDir, { recursive: true });

    await page
        .getByTestId(opener === "picker" ? "workspace-picker-create" : "workspace-toolbar-add")
        .click();
    await expect(page.getByTestId("workspace-create-dialog")).toBeVisible({ timeout: 20000 });

    // S8 的 UI 侧观察点之一：冻结的 managed_import 卡片**可见**（解释原因），但**不是可点按钮**。
    const frozenCardVisible = await page
        .getByTestId("workspace-storage-managed-frozen")
        .isVisible()
        .catch(() => false);
    expect(
        await page.getByTestId("workspace-storage-managed").count(),
        "the frozen managed_import entry must not be selectable",
    ).toBe(0);

    await page.getByTestId("workspace-storage-direct").click();
    await page.getByTestId("workspace-source-path").fill(hostDir);
    await page.getByTestId("workspace-source-read").click();
    await expect(page.getByTestId("workspace-source-browser")).toBeVisible({ timeout: 20000 });
    await page.getByTestId("workspace-source-use").click();

    const token = await tokenOf(page);
    const preflight = async (executionMode: "windows-mxc" | "windows-host") => {
        const response = await request.post(`${CP_URL}/api/v1/workspaces/capabilities/preflight`, {
            headers: bearer(token),
            data: { storageMode: "direct_attach", hostPath: hostDir, executionMode },
        });
        expect(response.ok(), await response.text()).toBeTruthy();
        return (await response.json()) as { available: boolean; reason?: string };
    };
    const mxc = await preflight("windows-mxc");
    const host = mxc.available ? null : await preflight("windows-host");
    const executionMode = mxc.available ? "windows-mxc" : "windows-host";
    if (mxc.available) {
        await page.getByTestId("workspace-execution-mode-mxc").click();
    } else {
        expect(host?.available, `no execution mode available (mxc=${String(mxc.reason)})`).toBe(
            true,
        );
        await page.getByTestId("workspace-execution-mode-host").click();
        await page.getByTestId("workspace-host-risk-ack").click();
    }
    await page.getByTestId("workspace-execution-next").click();
    await page.getByTestId("workspace-create-name").fill(`Headed ${Date.now()}`);

    const createdResponse = page.waitForResponse(
        (response) =>
            response.url().endsWith("/api/v1/workspaces") && response.request().method() === "POST",
    );
    await page.getByTestId("workspace-create-submit").click();
    const created = await createdResponse;
    expect([200, 201], await created.text()).toContain(created.status());
    const workspaceId = String(((await created.json()) as { id?: string }).id ?? "");
    expect(workspaceId).toMatch(/^[0-9a-f-]{36}$/i);

    await page.goto(`/workspace/${workspaceId}`, { waitUntil: "load" });
    await expect(page.getByTestId("workspace-empty-state")).toBeVisible({ timeout: 45000 });
    return { workspaceId, frozenCardVisible, executionMode };
}

async function createAndBindAgent(page: Page): Promise<string> {
    await page.getByTestId("workspace-toolbar-agents").click();
    await expect(page.getByTestId("workspace-agent-management-dialog")).toBeVisible({
        timeout: 20000,
    });
    await page
        .getByTestId("agent-principal-name")
        .fill(agentName("Headed", randomUUID().slice(0, 8)));
    await page.getByTestId("agent-principal-template").selectOption("");

    const createResponse = page.waitForResponse(
        (response) =>
            response.url().endsWith("/api/v1/agent-principals") &&
            response.request().method() === "POST",
    );
    await page.getByTestId("agent-principal-create").click();
    const created = await createResponse;
    expect(created.status(), await created.text()).toBe(201);
    const principalId = ((await created.json()) as { principalId: string }).principalId;

    const bindResponse = page.waitForResponse(
        (response) =>
            /\/api\/v1\/workspaces\/[^/]+\/agents\/[^/]+$/.test(new URL(response.url()).pathname) &&
            response.request().method() === "PUT",
    );
    await page.getByTestId("agent-principal-bind").click();
    expect((await bindResponse).status()).toBe(200);
    // 绑定完成后对话框仍开着（modal backdrop 会挡住工具条按钮）——按 Esc 关闭并确认已消失。
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("workspace-agent-management-dialog")).toBeHidden({
        timeout: 15000,
    });
    return principalId;
}

/** 绑定一条"工具可用"的连接（复用 real lane 已验证的 helper：provider=openai + fake LLM `/openai/v1`）。 */
async function bindToolCapableConnection(
    request: APIRequestContext,
    authToken: string,
    workspaceId: string,
    sessionId: string,
): Promise<void> {
    await bindToolCapableChat(request, { authToken, workspaceId }, sessionId, FAKE_LLM_MODEL);
}
// 原来的 `latestSessionId(page, workspaceId)` 已删除：S6/S7 合并后没有任何调用点（oxlint
// 报未使用函数）。会话 id 现在由 `bindToolCapableChat` 或各用例自己的 API 调用取得。
test.describe.serial("@host headed walkthrough — real user scenarios S1–S8", () => {
    test.beforeAll(() => {
        mkdirSync(SHOTS_DIR, { recursive: true });
    });

    test.afterAll(() => {
        mkdirSync(RUN_DIR, { recursive: true });
        writeFileSync(
            path.join(RUN_DIR, "report.json"),
            JSON.stringify(
                {
                    plan: "PLAN-0621",
                    runId: RUN_ID,
                    headed: process.env.XIHE_E2E_HEADED === "1",
                    browserChannel: process.env.XIHE_E2E_BROWSER_CHANNEL ?? "",
                    generatedAt: new Date().toISOString(),
                    steps,
                },
                null,
                2,
            ),
            "utf8",
        );
        writeFileSync(
            path.join(RUN_DIR, "console-errors.log"),
            consoleLog.length === 0
                ? "（无 console.error / pageerror / requestfailed）\n"
                : consoleLog.join("\n") + "\n",
            "utf8",
        );
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(300_000);
        attachPageDiagnostics(page);
    });

    // ── S1 / S2：只有**空白实例**才能观察；本车道栈已 bootstrap（已有账号）──────
    test("S1@host 空白实例第一次打开落到 onboarding", async ({ page, request }) => {
        const bootstrap = await request.get(`${CP_URL}/api/v1/auth/bootstrap-status`);
        const body = (await bootstrap.json()) as { initialized?: boolean };
        test.skip(
            body.initialized === true,
            "S1 未覆盖：本车道栈已 bootstrap（已有账号），观察不到空白实例首屏。复现需 `--first-run=local --bootstrap-user=none` 起独立栈。",
        );
        await page.goto("/", { waitUntil: "load" });
        await expect(page).toHaveURL(/\/onboarding/, { timeout: 30000 });
        await shot(page, "S1", "s1-onboarding", "首访落在 /onboarding");
    });

    test("S2@host 注册第一个账号后落到空态选择面", async ({ page, request }) => {
        const bootstrap = await request.get(`${CP_URL}/api/v1/auth/bootstrap-status`);
        const body = (await bootstrap.json()) as { initialized?: boolean };
        test.skip(
            body.initialized === true,
            "S2 未覆盖：本车道栈已 bootstrap（已有账号），注册第一个账号只能在空白实例上观察。",
        );
        await registerViaForm(page, `headed-first-${Date.now()}@test.local`, "Headed First");
        await expect(page).toHaveURL(/\/workspace/, { timeout: 60000 });
        const landing = await landOnWorkspacePicker(page);
        expect(landing).toBe("picker-empty");
        await shot(page, "S2", "s2-first-account-empty-picker", "首个账号注册后落到空态选择面");
    });

    // ── S3：非首个账号注册（F-01 的账号来源）────────────────────────────────
    test("S3@host 非首个账号注册成功并落到空态选择面", async ({ page }) => {
        const email = `headed-second-${Date.now()}@test.local`;
        await registerViaForm(page, email, "Headed Second");
        await expect
            .poll(() => page.evaluate(() => Boolean(localStorage.getItem("xihe-token"))), {
                timeout: 60000,
                intervals: [250, 500],
            })
            .toBe(true);
        await page.goto("/workspace", { waitUntil: "load" });
        const landing = await landOnWorkspacePicker(page);
        expect(["picker-empty", "picker"]).toContain(landing);
        await shot(page, "S3", "s3-second-account-landing", `第二个账号落点=${landing}`);

        // 留档：这个账号的实例能力（F-01 的判断依据之一）。
        const token = await tokenOf(page);
        const permissions = await page.request.get(`${CP_URL}/api/v1/me/permissions`, {
            headers: bearer(token),
        });
        expect(permissions.status(), await permissions.text()).toBe(200);
        const caps = (await permissions.json()) as { instanceCapabilities?: string[] };
        test.info().annotations.push({
            type: "headed-second-account-caps",
            description: (caps.instanceCapabilities ?? []).join(",") || "(none)",
        });
    });

    // ── S4：建第一个工作区（direct_attach）＋冻结卡片观察 ────────────────────
    test("S4@host 建第一个工作区：冻结卡片可见不可选、真实 preflight、进入工作区", async ({
        page,
        request,
    }) => {
        expect(GOLDPATH_EMAIL, "the headed lane needs the bootstrap account").not.toBe("");
        await loginViaForm(page, GOLDPATH_EMAIL, GOLDPATH_PASSWORD);
        const landing = await landOnWorkspacePicker(page);
        expect(["picker-empty", "picker", "workspace"]).toContain(landing);
        // 落点决定入口：空白起步 → 首屏引导；已有条目 → 先选一个再走工具条；已在工作区 → 工具条。
        let created: { workspaceId: string; frozenCardVisible: boolean; executionMode: string };
        if (landing === "picker-empty") {
            created = await createWorkspaceViaDialog(page, request, "picker");
        } else {
            if (landing === "picker") {
                await page.locator('[data-testid^="workspace-picker-item-"]').first().click();
            }
            await expect(page.getByTestId("workspace-toolbar-add")).toBeVisible({
                timeout: 30000,
            });
            created = await createWorkspaceViaDialog(page, request, "toolbar");
        }
        test.info().annotations.push({
            type: "headed-workspace",
            description: `id=${created.workspaceId} mode=${created.executionMode} frozenCard=${created.frozenCardVisible} landing=${landing}`,
        });
        await shot(
            page,
            "S4",
            "s4-workspace-created",
            "经对话框建 direct_attach 工作区并落到 workspace-empty-state",
        );
    });

    // ── S5：普通账号的 Agent 入口（F-01）────────────────────────────────────
    test("S5@host 普通账号尝试建 Agent：入口可见性与提示是否可操作（F-01）", async ({
        page,
        request,
    }) => {
        // 用 S3 造的第二个账号登录：它没有 CREATE_ACCOUNT 原子。
        const email = `headed-second-${Date.now()}@test.local`;
        void email; // S3 的账号邮箱带时间戳，这里重新注册一个等价账号，保证本用例自包含。
        const fresh = `headed-plain-${Date.now()}@test.local`;
        await registerViaForm(page, fresh, "Headed Plain");
        await expect
            .poll(() => page.evaluate(() => Boolean(localStorage.getItem("xihe-token"))), {
                timeout: 60000,
                intervals: [250, 500],
            })
            .toBe(true);

        // PLAN-0621 F-01 真机证据：普通账号必须在**工作区内**才能看到 Agent 工具条。
        // 因此先由首个账号（持 CREATE_ACCOUNT / MANAGE_WORKSPACE_AGENTS）把它邀请进工作区，
        // 再切回普通账号观察入口 —— 否则 S5 的 UI 分支会因"无工作区"被跳过（那不是证据）。
        const plainEmail = fresh;
        const plainUsername = validUsername(plainEmail.split("@")[0]);
        await page.evaluate(() => localStorage.clear());
        await loginViaForm(page, GOLDPATH_EMAIL, GOLDPATH_PASSWORD);
        const adminToken = await tokenOf(page);
        const createdWs = await request.post(`${CP_URL}/api/v1/workspaces`, {
            headers: { ...bearer(adminToken), "Content-Type": "application/json" },
            data: {
                name: `S5 invite ws ${Date.now()}`,
                storageMode: "direct_attach",
                hostPath: (() => {
                    const dir = `${process.env.XIHE_HEADED_EVIDENCE_ROOT ?? "H:/zeogit/one/.tmp/xh-headed-walkthrough"}/s5-ws-${Date.now()}`;
                    mkdirSync(dir, { recursive: true });
                    return dir;
                })(),
                executionMode: "windows-host",
            },
        });
        expect([200, 201], await createdWs.text()).toContain(createdWs.status());
        const s5WorkspaceId = String(((await createdWs.json()) as { id?: string }).id ?? "");
        expect(s5WorkspaceId).toMatch(/^[0-9a-f-]{36}$/i);
        const invited = await request.post(`${CP_URL}/api/v1/workspaces/${s5WorkspaceId}/members`, {
            headers: { ...bearer(adminToken), "Content-Type": "application/json" },
            data: { username: plainUsername, role: "EDITOR" },
        });
        expect([200, 201], await invited.text()).toContain(invited.status());

        // 切回普通账号，并直接进入被邀请的工作区（真实用户路径：选择面 → 该工作区）。
        await page.evaluate(() => localStorage.clear());
        await loginViaForm(page, plainEmail, SHARED_PASSWORD);
        await page.goto(`/workspace/${s5WorkspaceId}`, { waitUntil: "load" });
        // `landOnWorkspacePicker` 的返回值（picker-empty / picker / workspace 三态）在 S5 里
        // 只用于"等到落点确定"，断言交给下面的截图与后续 API 行为 ⇒ 不绑定变量
        // （原本的 `const landing = …` 从未被读取，oxlint 报未使用变量）。
        await landOnWorkspacePicker(page);
        await shot(page, "S5", "s5-plain-account-landing", "普通账号进入后的落点");

        const token = await tokenOf(page);

        // D8 后的 F-01 语义：普通账号默认拥有 CREATE_OWN_AGENT ⇒ 可以建 **PERSONAL**，
        // 但不能建 WORKSPACE（无 MANAGE_WORKSPACE_AGENTS）/ INSTANCE（无 CREATE_ACCOUNT）。
        // API 侧两条拒绝都要有可读 code；不允许用"任意状态码都接受"的万能断言。
        const deniedScopes: Array<{ scope: string; status: number; code: string | null }> = [];
        for (const scope of ["WORKSPACE", "INSTANCE"] as const) {
            const denied = await request.post(`${CP_URL}/api/v1/agent-principals`, {
                headers: { ...bearer(token), "X-Workspace-Id": s5WorkspaceId },
                data: { scope, name: agentName(`headedF01${scope}`, Date.now()) },
            });
            const problem = (await denied.json().catch(() => ({}))) as { code?: string };
            deniedScopes.push({ scope, status: denied.status(), code: problem.code ?? null });
            test.info().annotations.push({
                type: `headed-f01-api-${scope.toLowerCase()}`,
                description: `POST /agent-principals (scope=${scope}) → ${denied.status()}${problem.code ? ` ${problem.code}` : ""}`,
            });
            expect(
                [403, 409],
                `scope=${scope} must be denied, got ${denied.status()} ${problem.code ?? ""}`,
            ).toContain(denied.status());
        }

        // UI 侧：打开 Agent 管理面板 —— 普通账号应能建 PERSONAL，且 scope 下拉只出现 PERSONAL。
        const toolbarVisible = await page
            .getByTestId("workspace-toolbar-agents")
            .isVisible()
            .catch(() => false);
        expect(toolbarVisible, "the invited member must see the Agent toolbar").toBe(true);
        await page.getByTestId("workspace-toolbar-agents").click();
        await expect(page.getByTestId("workspace-agent-management-dialog")).toBeVisible({
            timeout: 20000,
        });
        const scopeSelect = page.getByTestId("agent-principal-scope");
        await expect(scopeSelect).toBeVisible({ timeout: 20000 });
        // 只出现 PERSONAL：WORKSPACE / INSTANCE 因缺少对应授权不渲染。
        await expect
            .poll(
                async () =>
                    scopeSelect
                        .locator("option")
                        .evaluateAll((options) => options.map((o) => o.getAttribute("value"))),
                {
                    timeout: 20000,
                    intervals: [250, 500],
                },
            )
            .toEqual(["PERSONAL"]);
        await expect(page.getByTestId("agent-create-forbidden-hint")).toHaveCount(0);
        await page.getByTestId("agent-principal-name").fill(agentName("HeadedPlain", Date.now()));
        await expect(page.getByTestId("agent-principal-create")).toBeEnabled();
        const personalCreateResponse = page.waitForResponse(
            (response) =>
                new URL(response.url()).pathname === "/api/v1/agent-principals" &&
                response.request().method() === "POST",
        );
        await page.getByTestId("agent-principal-create").click();
        const personalCreated = await personalCreateResponse;
        expect(personalCreated.status(), await personalCreated.text()).toBe(201);
        const personalBody = (await personalCreated.json()) as { scope?: string };
        expect(personalBody.scope, "PERSONAL create must echo scope=PERSONAL").toBe("PERSONAL");
        await shot(
            page,
            "S5b",
            "s5b-agent-dialog-plain-account",
            "普通账号只能建 PERSONAL：scope 仅 PERSONAL、创建可用、无 forbidden hint",
        );
        test.info().annotations.push({
            type: "headed-f01-ui",
            description: JSON.stringify({
                toolbarVisible,
                scopeOptions: ["PERSONAL"],
                forbiddenHintCount: 0,
                personalCreateStatus: personalCreated.status(),
                deniedScopes,
            }),
        });
    });

    // ── S6：建 Agent → 绑会话 → 发消息 → 首条回复 ───────────────────────────
    test("S6@host 建 Agent、建会话、绑工具可用连接并收到首条回复", async ({ page, request }) => {
        await loginViaForm(page, GOLDPATH_EMAIL, GOLDPATH_PASSWORD);
        await page.goto("/workspace", { waitUntil: "load" });
        const landing = await landOnWorkspacePicker(page);
        let workspaceId: string;
        if (landing === "workspace") {
            const url = page.url();
            const fromUrl = url.match(/\/workspace\/([0-9a-f-]{36})/i)?.[1];
            if (fromUrl) {
                workspaceId = fromUrl;
            } else {
                const items = page.locator('[data-testid^="workspace-picker-item-"]');
                await items.first().click();
                await expect(page.getByTestId("workspace-toolbar-agents")).toBeVisible({
                    timeout: 30000,
                });
                workspaceId = page.url().match(/\/workspace\/([0-9a-f-]{36})/i)?.[1] ?? "";
            }
        } else if (landing === "picker") {
            await page.locator('[data-testid^="workspace-picker-item-"]').first().click();
            await expect(page.getByTestId("workspace-toolbar-agents")).toBeVisible({
                timeout: 30000,
            });
            workspaceId = page.url().match(/\/workspace\/([0-9a-f-]{36})/i)?.[1] ?? "";
        } else {
            workspaceId = (await createWorkspaceViaDialog(page, request, "picker")).workspaceId;
        }
        expect(workspaceId).toMatch(/^[0-9a-f-]{36}$/i);
        await shot(page, "S6a", "s6a-workspace-entered", "进入工作区视图");

        const boundPrincipalId = await createAndBindAgent(page);

        // 会话经 CP 路径端点创建（`POST /api/v1/workspaces/{id}/sessions`，agentPrincipalId 必填，
        // 探针实测：缺字段 400、带正确 id 201），再进 `/workspace/<ws>/chat/<sid>`；
        // UI 侧的 agent 选择弹窗是 Reka 组合框（`workspace-create-agent-session` 在其内），
        // 点选不稳定，故 S6 的 UI 覆盖点放在 composer / 发送 / 回复（会话创建本身由 S4/S6 的 API 断言覆盖）。
        const token = await tokenOf(page);
        const createdSessionResponse = await request.post(
            `${CP_URL}/api/v1/workspaces/${workspaceId}/sessions`,
            {
                headers: bearer(token),
                data: { agentPrincipalId: boundPrincipalId, title: "Headed 走查会话" },
            },
        );
        expect(createdSessionResponse.status(), await createdSessionResponse.text()).toBe(201);
        const headedSessionId = ((await createdSessionResponse.json()) as { id: string }).id;
        await page.goto(`/workspace/${workspaceId}/chat/${headedSessionId}`, { waitUntil: "load" });

        // 进入工作区时 UI 已自动开了一个对话（`/workspace/<ws>` 内联 chat）。刷新一次拿干净状态，
        // 若仍弹出「选择 Agent」modal，用 Esc 关闭（本轮的 Agent 绑定已由 createAndBindAgent 完成）。
        await page.reload({ waitUntil: "load" });
        await expect(
            page.getByTestId("chat-input").or(page.getByTestId("sidebar-new-chat")).first(),
        ).toBeVisible({ timeout: 45000 });
        if (
            await page
                .getByTestId("workspace-agent-principal-select")
                .isVisible()
                .catch(() => false)
        ) {
            await page.keyboard.press("Escape");
        }
        await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 45000 });
        await shot(page, "S6b", "s6b-session-composer", "会话（自动开的对话）可用且 composer 可见");

        await bindToolCapableConnection(request, token, workspaceId, headedSessionId);
        await page.reload({ waitUntil: "load" });
        await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30000 });
        // 2026-11-04 用户裁定移除 composer 模型选择器：不再断言模型选择器触发器可见。

        await page.getByTestId("chat-input").fill("你好，介绍一下这个工作区");
        const chatResponse = page.waitForResponse(
            (response) =>
                response.url().endsWith("/api/v1/chat") && response.request().method() === "POST",
        );
        await page.getByTestId("chat-send-button").click();
        const sent = await chatResponse;
        expect([200, 202], await sent.text()).toContain(sent.status());
        expect(((await sent.json().catch(() => ({}))) as { runId?: string }).runId ?? "").not.toBe(
            "",
        );

        const assistant = page.locator('[data-slot="message"][data-align="start"]').last();
        await expect(assistant).toBeVisible({ timeout: 60000 });
        await expect
            .poll(async () => (await assistant.innerText()).trim().length, {
                timeout: 60000,
                intervals: [500, 1000],
            })
            .toBeGreaterThan(0);
        await expect(page.getByTestId("message-error")).toHaveCount(0);
        await shot(
            page,
            "S6c",
            "s6c-first-reply",
            "assistant 气泡可见、文本非空、无 message-error",
        );

        // S7（并入本用例）：刷新后会话与消息仍在、且不需要重新登录 —— **必须在同一个浏览器上下文里**
        // 才有意义（Playwright 每个 test 默认是新 context，单独跑 S7 等于换了浏览器，断言的是"新浏览器要登录"）。
        await page.reload({ waitUntil: "load" });
        await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 45000 });
        await expect
            .poll(async () => page.locator('[data-slot="message"]').count(), {
                timeout: 45000,
                intervals: [500, 1000],
            })
            .toBeGreaterThanOrEqual(2);
        await shot(page, "S7", "s7-reload-persistence", "刷新后会话与消息仍在且未要求重新登录");

        test.info().annotations.push({
            type: "headed-chat",
            description: `workspace=${workspaceId} session=${headedSessionId}`,
        });
    });

    // ── S7：已并入 S6（同一浏览器上下文内验证刷新；单独 test 会换 context，断言对象就错了）
    test("S7@host 刷新后会话与消息仍在，不需要重新登录（已并入 S6 同上下文）", async () => {
        test.skip(
            true,
            "S7 已并入 S6：刷新必须在同一浏览器上下文内验证；Playwright 每个 test 默认新 context，单跑 S7 只能验证'新浏览器需要登录'。",
        );
    });
    // ── S8：冻结能力的用户可见性（UI + API 两侧）────────────────────────────
    test("S8@host 冻结能力对用户透明：UI 无可选 managed_import，API 返回 409", async ({
        page,
        request,
    }) => {
        // 每个 test 是新浏览器上下文（无 token），S8 用自己的登录（与真实用户"再打开一次"一致）。
        expect(GOLDPATH_EMAIL, "the headed lane needs the bootstrap account").not.toBe("");
        await loginViaForm(page, GOLDPATH_EMAIL, GOLDPATH_PASSWORD);
        await page.goto("/workspace", { waitUntil: "load" });
        const landing = await landOnWorkspacePicker(page);
        if (landing === "picker") {
            await page.locator('[data-testid^="workspace-picker-item-"]').first().click();
        } else if (landing === "picker-empty") {
            await createWorkspaceViaDialog(page, request, "picker");
        }
        await expect(page.getByTestId("workspace-toolbar-add")).toBeVisible({ timeout: 30000 });
        await page.getByTestId("workspace-toolbar-add").click();
        await expect(page.getByTestId("workspace-create-dialog")).toBeVisible({ timeout: 20000 });
        expect(await page.getByTestId("workspace-storage-managed").count()).toBe(0);
        expect(await page.getByTestId("workspace-storage-managed-frozen").isVisible()).toBe(true);
        await shot(
            page,
            "S8a",
            "s8a-frozen-card-phrase",
            "UI 只显示冻结说明、无可选 managed_import 入口",
        );
        await page.keyboard.press("Escape");

        const token = await tokenOf(page);
        const denied = await request.post(`${CP_URL}/api/v1/workspaces`, {
            headers: { ...bearer(token), "Idempotency-Key": randomUUID() },
            data: { name: `headed-frozen-${Date.now()}`, storageMode: "managed_import" },
        });
        expect(denied.status(), await denied.text()).toBe(409);
        const problem = (await denied.json()) as { code?: string; detail?: string };
        expect(problem.code).toBe("BACKEND_DISABLED");
        recordStep(
            {
                id: "S8b",
                step: "managed_import create API",
                url: `${CP_URL}/api/v1/workspaces`,
                assertion: `409 ${String(problem.code)} — detail=${String(problem.detail)}`,
            },
            steps.at(-1)?.screenshot ?? "shots/s8a-frozen-card-phrase.png",
        );
    });
});
