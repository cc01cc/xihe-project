/**
 * PLAN-0611 M2 — XH 新手 gold path（G1 首跑 / G2 到第一条回复 / G3 配模型 / G4 失败可读性目标态）。
 *
 * 与既有 98 个 real spec 的硬区别：**零 `addInitScript`、零 `waitForTimeout`**。登录态来自
 * 真实表单或 localMode 的免密重登（router），不往 localStorage 灌 token。
 *
 * 运行（batch 自带车道 flag，见 scripts/e2e-batches.jsonc）：
 *   node scripts/e2e-host.mjs --batch=goldpath-first-run   # virgin 空库，G1
 *   node scripts/e2e-host.mjs --batch=goldpath             # 已 bootstrap 账号 + fake LLM，G2/G3
 *   node scripts/e2e-host.mjs --batch=goldpath-closed      # G1-e 反向对照
 *
 * 与草案（one/.local/xh-goldpath/spec-draft.ts）的差异，均以当前 UI 为准：
 * - `identityOf` 读 `capabilities`（PLAN-0610 W5：`user.role` 已删）；
 * - G2-a 用 runner 建好的首个账号走**登录表单**（localMode 单用户，不重复注册）；
 * - G2-b 不再是"principal-grants 自授"（W2 退役 / W5 删页）：localMode 首用户即 SUPER_ADMIN，
 *   该用例改为断言"无需自授权即可见管理面 + 能力"（0611 design 决策 #1）；
 * - G1-d 由 BL-150 死路改为当前的 `login-local-mode` 一键重进（0612 M6 已修）；
 * - G2-e 不建自定义连接：custom-openai-compatible 路由 	oolsSupported=false，工作区 Chat 必然带工具 ⇒ agent 预检抛 LLM_TOOL_ROUTE_UNSUPPORTED；改为走 runner 导入的 llm-provider profile（provider openai）。
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const FIRST_RUN = process.env.XIHE_E2E_FIRST_RUN ?? "";
const REGISTRATION_POLICY = process.env.XIHE_E2E_REGISTRATION_POLICY ?? "open";
const GOLDPATH_ACCOUNT = process.env.XIHE_E2E_GOLDPATH_ACCOUNT === "1";
const GOLDPATH_EMAIL = process.env.XIHE_E2E_GOLDPATH_EMAIL ?? "";
const GOLDPATH_PASSWORD = process.env.XIHE_E2E_GOLDPATH_PASSWORD ?? "";
const FAKE_LLM_PORT = process.env.XIHE_FAKE_LLM_PORT ?? "";
const FAKE_LLM_API_KEY = "sk-fake-openai-key";
const FAKE_LLM_MODEL = "fake-openai";

function firstRunGap(): string | null {
    if (FIRST_RUN !== "local") {
        return "needs `node scripts/e2e-host.mjs --batch=goldpath-first-run` (XIHE_E2E_FIRST_RUN unset)";
    }
    return null;
}

function accountGap(): string | null {
    const first = firstRunGap();
    if (first) return first;
    if (!GOLDPATH_ACCOUNT) {
        return "needs `--bootstrap-user=register` + XIHE_E2E_GOLDPATH_ACCOUNT=1 (no local account was bootstrapped)";
    }
    return null;
}

test.describe.configure({ mode: "serial", timeout: 120_000 });

interface Identity {
    id: string;
    email: string;
    name: string;
    isInstanceAdmin: boolean;
    isInstanceSuper: boolean;
    workspaceId: string;
}

function bearer(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function readBootstrap(
    request: APIRequestContext,
): Promise<{ initialized: boolean; localMode: boolean }> {
    const response = await request.get(`${CP_URL}/api/v1/auth/bootstrap-status`);
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()) as { initialized: boolean; localMode: boolean };
}

function tokenOf(page: Page): Promise<string> {
    return page.evaluate(() => localStorage.getItem("xihe-token") ?? "");
}

async function identityOf(page: Page, request: APIRequestContext): Promise<Identity> {
    const token = await tokenOf(page);
    expect(token, "page must hold a server-issued token").not.toBe("");
    const me = await request.get(`${CP_URL}/api/v1/auth/me`, { headers: bearer(token) });
    expect(me.status(), await me.text()).toBe(200);
    const raw = (await me.json()) as {
        id: string;
        email: string;
        name?: string;
        capabilities?: { isInstanceAdmin?: boolean; isInstanceSuper?: boolean };
    };
    // PLAN-0614：空白起步的账号**没有**工作区，所以这里不再强制 URL 带 workspace；
    // 需要工作区的调用方自己断言（例如 G2-a 在 openOrCreateWorkspace 之后断言）。
    const workspaceId = page.url().match(/\/workspace\/([0-9a-f-]{36})/i)?.[1] ?? "";
    return {
        id: raw.id,
        email: raw.email,
        name: raw.name ?? raw.email,
        isInstanceAdmin: raw.capabilities?.isInstanceAdmin === true,
        isInstanceSuper: raw.capabilities?.isInstanceSuper === true,
        workspaceId,
    };
}

/**
 * PLAN-0608 I6：登录/注册后 tab 上下文是空的，`/workspace` 先渲染选择面。真实用户的下一步
 * 就是点自己的工作区；这里把它固化成 helper，后续所有用例都从"已进入工作区"开始。
 *
 * BL-169 的教训（这条 helper 之前会假失败）：`/workspace` 的落点是**竞态** —— 守卫在
 * `localLogin()` 之后写 tab 上下文并把 `/workspace` 重定向到 `/workspace/<id>`；如果只看一瞬的
 * `pathname === "/workspace"` 就进选择面分支，可能正好卡在"选择面已挂载、条目还没渲染"的窗口里
 * 等满 60s，而应用早已进入工作区。因此这里改成**按落点轮询**：只要还没出现"选择面 + 至少一个
 * 条目"或"WorkspaceView"，就一直轮询；两者择一后再走各自路径。
 */
async function settleIntoWorkspace(page: Page): Promise<string> {
    // 空白起步（PLAN-0614）：`picker-empty` 是合法落点，但**进不去工作区** —— 这时必须由调用方
    // 走"建第一个工作区"（`openOrCreateWorkspace`）。这里只接受"有条目的选择面"或"工作区视图"。
    const landing = await pollLanding(page, ["picker", "workspace"]);
    if (landing === "picker") {
        const item = page.locator('[data-testid^="workspace-picker-item-"]').first();
        await expect
            .poll(
                async () => {
                    const path = new URL(page.url()).pathname;
                    if (/^\/workspace\/[0-9a-f-]{36}$/i.test(path)) return "entered";
                    await item.click({ timeout: 5_000 }).catch(() => {});
                    return /^\/workspace\/[0-9a-f-]{36}$/i.test(new URL(page.url()).pathname)
                        ? "entered"
                        : "waiting";
                },
                { timeout: 60000, intervals: [500, 1000] },
            )
            .toBe("entered");
    }
    await expect
        .poll(async () => new URL(page.url()).pathname, {
            timeout: 30000,
            intervals: [300, 600],
        })
        .toMatch(/^\/workspace\/[0-9a-f-]{36}$/i);
    return new URL(page.url()).pathname.match(/\/workspace\/([0-9a-f-]{36})/i)![1];
}

/** localMode 下无 token 访问受保护路由会自动免密重登（等价于真实用户刷新）。
 *
 * 空白起步后"进入工作区"不再等价于"导航到 /workspace"（可能先落在空态），所以入口统一走
 * `openOrCreateWorkspace()`：已有工作区就进，没有就经首屏引导建一个。
 */
// ── PLAN-0611 T5.2：六步走查截图（与断言同源） ────────────────────────────────
/**
 * 截图目录：`one/plans/PLAN-0611-…/evidence/t5.2-screenshots/`。
 * 从 `packages/ui` 往上 5 层是 workspace 根（one/），避免把机器绝对路径写进 spec。
 */
const SCREENSHOT_DIR = process.env.XIHE_E2E_SCREENSHOT_DIR
    ? path.resolve(process.env.XIHE_E2E_SCREENSHOT_DIR)
    : path.resolve(
          process.cwd(),
          "../../../../..",
          "plans/PLAN-0611-XH-first-run-goldpath/evidence/t5.2-screenshots",
      );

/**
 * 截图。**必须在某个断言通过之后调用**（与断言同源，不是摆拍）；不引入任何等待/超时。
 * 同时把文件名写进 annotation，矩阵运行时能从报告里核对"哪张图由哪次断言产出"。
 */
async function shot(page: Page, name: string): Promise<void> {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const file = path.join(SCREENSHOT_DIR, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    test.info().annotations.push({ type: "goldpath-screenshot", description: `${name}.png` });
}

/**
 * `/workspace` 的三种合法落点（G1-d 用）。
 *
 * - `picker-empty`：tab 上下文为空**且账号还没有任何工作区** ⇒ PLAN-0614 的"空白起步"首屏
 *   （`workspace-picker-empty` + 「创建你的第一个工作区」按钮）。注册不再自动建工作区，
 *   所以这是新账号的**正常**落点，不是失败。
 * - `picker`：tab 上下文为空但账号已有工作区 ⇒ `WorkspacePicker` 列出条目等用户选；
 * - `workspace`：守卫已恢复 tab 上下文 ⇒ **WorkspaceView 已挂载**（`workspace-toolbar-add` 是外壳
 *   的一部分，随组件挂载即渲染）。
 *
 * 为什么 `workspace` 只看外壳、不看文件树：G1-d 的契约是「免密重登后**入口可达**」，而不是
 * 「内容就绪」。内容就绪已由 G2-c（空态）、G2-e（首条回复）、G3（切工作区）各自断言；把内容就绪
 * 塞进 G1-d 会让同一个属性有两处断言、且其中一处依赖 runtime 状态 —— 实测就是它在 runtime 熔断器
 * `failureCount=3..8` 的时间窗里假失败（closed 车道 4 次里 1 次）。**一个断言只证一个属性。**
 * 内容是否滞后改为信息性观测（见 G1-d 里的 `content=ready|lagging` annotation），不参与断言。
 *
 * 返回 `none` 表示三种落点都没出现 —— 那就是真正的失败，断言不允许它通过。
 * 只用 testid 判定、不读 DOM 文本：文案会随 i18n 变，结构不会。
 */
type Landing = "picker-empty" | "picker" | "workspace" | "none";

async function visible(page: Page, testId: string): Promise<boolean> {
    return page
        .getByTestId(testId)
        .isVisible()
        .catch(() => false);
}

async function workspaceLanding(page: Page): Promise<Landing> {
    if (await visible(page, "workspace-picker-empty")) return "picker-empty";
    if (
        await page
            .locator('[data-testid^="workspace-picker-item-"]')
            .first()
            .isVisible()
            .catch(() => false)
    )
        return "picker";
    if (await visible(page, "workspace-toolbar-add")) return "workspace";
    return "none";
}

/** 内容是否已就绪（**只用于观测**，不参与断言；见 `workspaceLanding` 的注释）。 */
async function workspaceContentReady(page: Page, timeoutMs = 3_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        for (const testId of ["workspace-file-tree", "workspace-empty-state"]) {
            if (await visible(page, testId)) return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
}

/** 轮询到允许的落点之一并返回它（`none` 与不在白名单里的落点都会继续等）。 */
async function pollLanding(
    page: Page,
    allowed: Landing[] = ["picker-empty", "picker", "workspace"],
): Promise<Landing> {
    let observed: Landing = "none";
    await expect
        .poll(async () => (observed = await workspaceLanding(page)), {
            timeout: 60000,
            intervals: [250, 500],
        })
        .toMatch(new RegExp(`^(${allowed.join("|")})$`));
    return observed;
}

/** G1-d 的落点白名单：三种都合法（空白起步后 `picker-empty` 是常态）。 */
const ANY_LANDING: Landing[] = ["picker-empty", "picker", "workspace"];

/**
 * 金路径里由用户**自己新建一个 `direct_attach` 工作区**（PLAN-0614：注册不再建工作区，
 * 所以这也是"第一个工作区"的必经路径；PLAN-0611 决策 #7 要求工作区一律 `direct_attach`）。
 *
 * 两种入口复用同一条对话框流程：
 * - `picker`：空白起步首屏的「创建你的第一个工作区」按钮（`workspace-picker-create`）；
 * - `toolbar`：已在工作区内时工作区工具条的"添加 Workspace"（`workspace-toolbar-add`），G2-e 用。
 *
 * 全流程走真实 UI（含 source browser 与 preflight），不绕过 preflight 硬填路径：
 * 目录建在本次隔离 host root 下，Runtime 通过 `import-sources` 真的能读到它。
 */
async function createWorkspaceViaDialog(
    page: Page,
    request: APIRequestContext,
    opener: "picker" | "toolbar",
): Promise<string> {
    const runId = process.env.XIHE_E2E_RUN_ID ?? "";
    expect(runId, "gold path needs the isolated e2e-host runner (XIHE_E2E_RUN_ID)").not.toBe("");
    const hostRoot = path.resolve(process.cwd(), "../../.tmp/e2e-host", runId);
    const hostDir = path.join(hostRoot, `goldpath-direct-${Date.now()}`);
    mkdirSync(hostDir, { recursive: true });

    await page
        .getByTestId(opener === "picker" ? "workspace-picker-create" : "workspace-toolbar-add")
        .click();
    await expect(page.getByTestId("workspace-create-dialog")).toBeVisible({ timeout: 20000 });
    await page.getByTestId("workspace-storage-direct").click();
    await page.getByTestId("workspace-source-path").fill(hostDir);
    await page.getByTestId("workspace-source-read").click();
    await expect(page.getByTestId("workspace-source-browser")).toBeVisible({ timeout: 20000 });
    await page.getByTestId("workspace-source-use").click();

    // 真实 preflight 决定哪个执行模式可用（MXC 可能不可用 ⇒ 退到 host + 风险确认）。
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
    test.info().annotations.push({
        type: "goldpath-direct-attach",
        description: `dir=${hostDir} mxc=${mxc.available} host=${host ? host.available : "not-probed"}`,
    });

    if (mxc.available) {
        await page.getByTestId("workspace-execution-mode-mxc").click();
    } else {
        expect(
            host?.available,
            `no direct_attach execution mode available on this host (mxc=${String(mxc.reason)})`,
        ).toBe(true);
        await page.getByTestId("workspace-execution-mode-host").click();
        await page.getByTestId("workspace-host-risk-ack").click();
    }
    await page.getByTestId("workspace-execution-next").click();
    await page.getByTestId("workspace-create-name").fill(`Gold Path ${Date.now()}`);

    const createdResponse = page.waitForResponse(
        (response) =>
            response.url().endsWith("/api/v1/workspaces") && response.request().method() === "POST",
    );
    await page.getByTestId("workspace-create-submit").click();
    const created = await createdResponse;
    expect([200, 201], await created.text()).toContain(created.status());
    const workspaceId = String(((await created.json()) as { id?: string }).id ?? "");
    expect(workspaceId, "created workspace id").toMatch(/^[0-9a-f-]{36}$/i);

    await page.goto(`/workspace/${workspaceId}`, { waitUntil: "load" });
    await expect(page.getByTestId("workspace-empty-state")).toBeVisible({ timeout: 45000 });
    return workspaceId;
}

/** 从空白起步首屏建"第一个工作区"（PLAN-0614 T3.4）。 */
async function createFirstWorkspace(page: Page, request: APIRequestContext): Promise<string> {
    await expect(page.getByTestId("workspace-picker-empty")).toBeVisible({ timeout: 30000 });
    return createWorkspaceViaDialog(page, request, "picker");
}

/**
 * 进入工作区；**空白起步**时先建第一个（PLAN-0614：注册不再自动建工作区）。
 *
 * G2/G3 的起点统一走这里：已有工作区就选/进，没有就经首屏引导建一个 —— 这正是新手真实路径。
 */
async function openOrCreateWorkspace(page: Page, request: APIRequestContext): Promise<string> {
    await page.goto("/workspace", { waitUntil: "load" });
    const landing = await pollLanding(page, ANY_LANDING);
    if (landing === "picker-empty") return createFirstWorkspace(page, request);
    if (landing === "workspace") return settleIntoWorkspace(page);
    return settleIntoWorkspace(page);
}

/**
 * 给会话显式绑定一条**工具可用**的 fake-LLM 连接（G2-e）。
 *
 * 两个约束同时成立，缺一不可：
 * 1. 未绑定连接的会话直发会得到 `409 API_TYPE_REBIND_REQUIRED`（"Explicit Session binding is
 *    required"）——本 build 不接受纯 profile 路由的隐式分派；
 * 2. 绑 `custom-openai-compatible` 又不行：它在能力目录里 `toolsSupported=false`，而工作区 Chat 必带
 *    工具 ⇒ agent 在发请求前抛 `LLM_TOOL_ROUTE_UNSUPPORTED`。
 *
 * 所以这里用 provider `openai`（目录里工具可用）+ fake LLM 的 `/openai/v1`，显式绑定后再发消息。
 *
 * BL-204 实证修复（2026-11-04）：旧实现用 `page.evaluate(fetch(...))` 直接 PATCH 会话完成绑定，
 * 绕过产品 UI ⇒ E2E 绿不能证明"用户能绑上"。本实现全部走产品路径：
 * 1. 连接创建走 ProviderHub 表单（与 G3-a 同一手法）；
 * 2. verify 走 `page.request.post`（本文件 G3-a 的既有夹具手法，非产品路径）；
 * 3. **会话绑定走 ModelPopover**：点击模型项触发 `ModelPopover.vue` 选中处理器
 *    （`sessionStore.updateSession` → PATCH `/api/v1/sessions/{id}`），即产品 UI 的真实请求。
 */
async function bindToolCapableFakeLlmConnection(page: Page, sessionId: string): Promise<void> {
    const fakeLlmPort = FAKE_LLM_PORT;
    expect(fakeLlmPort, "needs XIHE_FAKE_LLM_PORT (runner-provided fake LLM)").not.toBe("");
    const chatUrl = page.url();

    // 1) 经产品 UI（ProviderHub 表单）创建连接。
    await page.goto("/settings/config", { waitUntil: "load" });
    await page.getByTestId("config-tab-user").click();
    await page.getByTestId("provider-hub-connect").click();
    await expect(page.getByTestId("provider-picker-modal")).toBeVisible({ timeout: 20000 });
    await page.getByTestId("provider-picker-search").fill("open");
    await page.locator('button[data-testid^="provider-picker-"]').first().click();

    const label = `goldpath-tools-${Date.now()}`;
    await page.getByTestId("provider-connection-form-label").fill(label);
    await page.getByTestId("provider-connection-form-key").fill(`goldpath-${Date.now()}`);
    const form = page
        .locator("form")
        .filter({ has: page.getByTestId("provider-connection-form-label") });
    await form.locator('input[type="password"]').first().fill(FAKE_LLM_API_KEY);
    await form
        .locator('input[type="url"]')
        .first()
        .fill(`http://127.0.0.1:${fakeLlmPort}/openai/v1`);
    // 表单里有多个 select（第 1 个是 API Type），按带 `manual` 选项值定位，不依赖顺序。
    for (const select of await form.locator("select").all()) {
        const values = await select
            .locator("option")
            .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
        if (values.includes("manual")) {
            await select.selectOption("manual");
            break;
        }
    }
    await form.locator("textarea").first().fill(FAKE_LLM_MODEL);

    const createResponse = page.waitForResponse(
        (response) =>
            response.url().endsWith("/api/v1/provider-connections") &&
            response.request().method() === "POST",
    );
    await form.locator('button[type="submit"]').click();
    const created = await createResponse;
    expect(created.status(), await created.text()).toBe(201);
    const connectionId = ((await created.json()) as { id: string }).id;

    // 2) verify（夹具级准备；与本文件 G3-a 的既有手法一致，不走页面内 fetch）。
    const token = await tokenOf(page);
    const verified = await page.request.post(
        `${CP_URL}/api/v1/provider-connections/${connectionId}/verify`,
        { headers: bearer(token) },
    );
    expect(verified.ok(), await verified.text()).toBe(true);
    expect(
        ((await verified.json()) as { connection?: { status?: string } }).connection?.status,
    ).toBe("READY");

    // 3) 回到会话，经 ModelPopover 产品路径完成绑定（BL-204 修复点）。
    await page.goto(chatUrl, { waitUntil: "load" });
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 25000 });
    await page.getByTestId("model-popover-trigger").click();
    const modelItem = page
        .locator(`[data-testid^="model-item-"][data-testid$="/${FAKE_LLM_MODEL}"]`)
        .first();
    await expect(modelItem).toBeVisible({ timeout: 20000 });
    const bindResponse = page.waitForResponse(
        (response) =>
            new URL(response.url()).pathname.endsWith(`/api/v1/sessions/${sessionId}`) &&
            response.request().method() === "PATCH",
    );
    await modelItem.click();
    const bound = await bindResponse;
    expect(bound.status(), await bound.text()).toBe(200);
}

/** 在**当前**工作区里经 UI 建一个 Agent principal 并绑定（G2-c 的步骤，供 G2-e 复用）。 */ async function createAndBindAgentInCurrentWorkspace(
    page: Page,
): Promise<string> {
    await page.getByTestId("workspace-toolbar-agents").click();
    await expect(page.getByTestId("workspace-agent-management-dialog")).toBeVisible({
        timeout: 20000,
    });
    const agentName = `Gold Path Agent ${randomUUID().slice(0, 8)}`;
    await page.getByTestId("agent-principal-name").fill(agentName);
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
    expect(principalId).toMatch(/^[0-9a-f-]{36}$/i);

    const bindResponse = page.waitForResponse(
        (response) =>
            /\/api\/v1\/workspaces\/[^/]+\/agents\/[^/]+$/.test(new URL(response.url()).pathname) &&
            response.request().method() === "PUT",
    );
    await page.getByTestId("agent-principal-bind").click();
    expect((await bindResponse).status()).toBe(200);

    // BL-A（2026-11-04 Lead 裁定，A 类非 flake）：D26-09 已把该面从模态改为**常驻面板**
    // （WorkspaceAgentsPanel.vue:764-767 注释原文 "It is now the panel body, not a modal"）
    // —— 没有 Close、也不会关闭，原 `点一次 Close → toBeHidden` 结构性必挂（窗口 1 实测
    // 挂 5 分钟超时）。改为断言**绑定结果出现在面板里**（更贴产品语义）：刚创建的主体
    // 出现在「已绑定智能体」列表、且带它的 principalId，即视为这一步通过。
    // 注：`getByText` 不匹配 input 的 value，所以这断言钉的是列表渲染，不是创建表单残留。
    const panel = page.getByTestId("workspace-agent-management-dialog");
    await expect(
        panel.getByText(agentName, { exact: false }).first(),
        "bound agent must be listed in the panel after bind",
    ).toBeVisible({ timeout: 20_000 });
    await expect(
        panel.getByText(principalId, { exact: false }).first(),
        "bound principal id must be listed in the panel",
    ).toBeVisible({ timeout: 20_000 });
    return principalId;
}

async function loginViaForm(page: Page, identifier: string, password: string): Promise<void> {
    await page.goto("/login", { waitUntil: "load" });
    await page.locator("#identifier").fill(identifier);
    await page.locator("#password").fill(password);
    const loginResponse = page.waitForResponse(
        (response) =>
            response.url().endsWith("/api/v1/auth/login") && response.request().method() === "POST",
    );
    await page.locator('form button[type="submit"]').click();
    const response = await loginResponse;
    expect(response.status(), await response.text()).toBe(200);
    await settleIntoWorkspace(page);
}

// ══════════════════════════════════════════════════════════════════════════
// G1 —— 空实例首跑
// ══════════════════════════════════════════════════════════════════════════

test.describe("@host gold path G1 — blank instance first run (localMode)", () => {
    test.beforeEach(() => {
        const gap = firstRunGap();
        test.skip(Boolean(gap), gap ?? "");
    });

    test("G1-a first visit lands on /onboarding with the local-mode form", async ({
        page,
        request,
    }) => {
        const bootstrap = await readBootstrap(request);
        expect(bootstrap.localMode, "stack must be booted with XIHE_LOCAL_MODE=true").toBe(true);
        test.skip(bootstrap.initialized, "lane is not virgin (run --batch=goldpath-first-run)");

        await page.goto("/workspace", { waitUntil: "load" });

        await expect(page).toHaveURL(/\/onboarding\?redirect=/i, { timeout: 45000 });
        await expect(page.getByRole("heading", { name: "开始使用" })).toBeVisible({
            timeout: 45000,
        });
        await expect(page.locator("#email")).toBeVisible({ timeout: 45000 });
        await expect(page.locator("#name")).toBeVisible({ timeout: 45000 });
        await expect(page.locator("#password")).toHaveCount(0);
        await expect(page.locator('form button[type="submit"]')).toBeDisabled();

        // 证据：首跑 onboarding（T5.2 第 1 步），与上面 5 条断言同源。
        await shot(page, "01-onboarding");
    });

    test("G1-b the first account flips bootstrap-status and lands in the workspace", async ({
        page,
        request,
    }) => {
        const before = await readBootstrap(request);
        test.skip(before.initialized, "stack is not virgin; G1-b needs an empty database");

        await page.goto("/workspace", { waitUntil: "load" });
        await expect(page).toHaveURL(/\/onboarding/i, { timeout: 45000 });
        await page.locator("#email").fill(`first-${Date.now()}@test.local`);
        await page.locator("#name").fill("First Account");

        const registerResponse = page.waitForResponse(
            (response) =>
                response.url().endsWith("/api/v1/auth/register") &&
                response.request().method() === "POST",
        );
        await page.locator('form button[type="submit"]').click();
        const registered = await registerResponse;

        expect(registered.status(), await registered.text()).toBe(201);
        expect((await readBootstrap(request)).initialized).toBe(true);

        // 首跑页的 SPA 推送/缓存存在竞态；这里做一次"刷新等价"的重新导航：bootstrap 已
        // initialized=true，localMode 守卫会免密重登（真实用户的下一步动作）。
        await page.goto("/workspace", { waitUntil: "load" });

        // PLAN-0614（空白起步）：注册**不再**建工作区 ⇒ 首屏是空态选择面，不是工作区视图。
        // 原断言（等 `workspace-empty-state` / 自动出现的 Default Workspace）是旧语义，必须换掉。
        await expect(page.getByTestId("workspace-picker-empty")).toBeVisible({ timeout: 45000 });
        await expect(page.getByTestId("workspace-picker-create")).toBeVisible({ timeout: 20000 });
        // 断言"确实没有工作区"：选择面里不该有任何条目（不是"列出了但没渲染"）。
        await expect(page.locator('[data-testid^="workspace-picker-item-"]')).toHaveCount(0);
        expect(await tokenOf(page)).toBeTruthy();

        // 证据：空态首屏（T5.2 第 2 步），与上面的断言同源。
        await shot(page, "02-empty-picker");

        // PLAN-0610：首用户是 SUPER_ADMIN 绑定（不再是 users.role 字符串）。
        const identity = await identityOf(page, request);
        expect(identity.isInstanceSuper, "localMode first account must hold SUPER_ADMIN").toBe(
            true,
        );
        await expect(page.getByTestId("nav-rail-settings")).toBeVisible({ timeout: 20000 });
    });

    test("G1-b2 the empty state creates the first workspace and enters it", async ({
        page,
        request,
    }) => {
        const before = await readBootstrap(request);
        test.skip(
            !before.initialized,
            "needs a bootstrapped first account (G1-b or --bootstrap-user=register)",
        );

        // 承接 G1-b：账号已注册但没有任何工作区。
        await page.goto("/workspace", { waitUntil: "load" });
        await expect(page.getByTestId("workspace-picker-empty")).toBeVisible({ timeout: 45000 });

        // 点「创建你的第一个工作区」→ 对话框（direct_attach + source browser + preflight）。
        await page.getByTestId("workspace-picker-create").click();
        await expect(page.getByTestId("workspace-create-dialog")).toBeVisible({ timeout: 20000 });
        await page.getByTestId("workspace-storage-direct").click();
        const hostDir = path.join(
            path.resolve(process.cwd(), "../../.tmp/e2e-host", process.env.XIHE_E2E_RUN_ID ?? ""),
            `goldpath-first-${Date.now()}`,
        );
        mkdirSync(hostDir, { recursive: true });
        await page.getByTestId("workspace-source-path").fill(hostDir);
        await page.getByTestId("workspace-source-read").click();
        await expect(page.getByTestId("workspace-source-browser")).toBeVisible({ timeout: 20000 });
        await shot(page, "03-create-workspace-dialog");
        await page.getByTestId("workspace-source-use").click();

        const token = await tokenOf(page);
        const preflight = async (executionMode: "windows-mxc" | "windows-host") => {
            const response = await request.post(
                `${CP_URL}/api/v1/workspaces/capabilities/preflight`,
                {
                    headers: bearer(token),
                    data: { storageMode: "direct_attach", hostPath: hostDir, executionMode },
                },
            );
            expect(response.ok(), await response.text()).toBeTruthy();
            return (await response.json()) as { available: boolean; reason?: string };
        };
        const mxc = await preflight("windows-mxc");
        if (mxc.available) {
            await page.getByTestId("workspace-execution-mode-mxc").click();
        } else {
            const host = await preflight("windows-host");
            expect(host.available, `no direct_attach backend (mxc=${String(mxc.reason)})`).toBe(
                true,
            );
            await page.getByTestId("workspace-execution-mode-host").click();
            await page.getByTestId("workspace-host-risk-ack").click();
        }
        await page.getByTestId("workspace-execution-next").click();
        await page.getByTestId("workspace-create-name").fill("First Workspace");
        const createdResponse = page.waitForResponse(
            (response) =>
                response.url().endsWith("/api/v1/workspaces") &&
                response.request().method() === "POST",
        );
        await page.getByTestId("workspace-create-submit").click();
        const created = await createdResponse;
        expect([200, 201], await created.text()).toContain(created.status());
        const workspaceId = String(((await created.json()) as { id?: string }).id ?? "");

        // 创建成功后选择面自动进入该工作区（PLAN-0614 M2 的 handleCreated）。
        await expect(page).toHaveURL(new RegExp(`/workspace/${workspaceId}$`, "i"), {
            timeout: 45000,
        });
        await expect(page.getByTestId("workspace-empty-state")).toBeVisible({ timeout: 45000 });
        await shot(page, "04-workspace-view");

        // 移动 viewport 代表性截图（DEV-020）：同一 context 新页签共享 localStorage token。
        const mobile = await page.context().newPage();
        try {
            await mobile.setViewportSize({ width: 390, height: 844 });
            await mobile.goto(`/workspace/${workspaceId}`, { waitUntil: "load" });
            // 窄屏下文件树不常驻，得先点工具栏的「Files」把面板打开 —— 正是移动用户的真实动作。
            await mobile.getByTestId("workspace-toolbar-files-mobile").click();
            await expect(mobile.getByTestId("workspace-empty-state")).toBeVisible({
                timeout: 45000,
            });
            await shot(mobile, "07-mobile-workspace");
        } finally {
            await mobile.close();
        }
    });

    test("G1-c a fresh browser context re-enters without the login form", async ({
        browser,
        request,
    }) => {
        test.skip(
            (await readBootstrap(request)).initialized,
            "virgin-lane case; the bootstrap lane covers entry in G2-a (run --batch=goldpath-first-run)",
        );
        const context = await browser.newContext();
        const page = await context.newPage();
        try {
            await page.goto("/workspace", { waitUntil: "load" });
            // PLAN-0614：新账号没有工作区 ⇒ 落点是空态选择面（`picker-empty`），也是合法重入。
            await pollLanding(page, ANY_LANDING);
            await expect(page.locator("#identifier")).toHaveCount(0);
            expect(await tokenOf(page), "local-login must mint a token").toBeTruthy();
        } finally {
            await context.close();
        }
    });

    test("G1-d logout re-enters passwordlessly via the router guard (BL-150 B)", async ({
        page,
        request,
    }) => {
        await openOrCreateWorkspace(page, request);
        await page.getByTestId("nav-rail-logout").click();

        // BL-150 B（0612 M6）：登出把后续决策交给路由守卫；localMode 下守卫用
        // `POST /auth/local-login` 免密重进。`goto` 是"新标签页打开 /workspace"的等价动作。
        await page.goto("/workspace", { waitUntil: "load" });

        // (1) 登录态由守卫恢复：不再出现表单。
        await expect(page.locator("#identifier")).toHaveCount(0);
        await expect
            .poll(() => tokenOf(page), { timeout: 45000, intervals: [250, 500] })
            .not.toBe("");

        // (2) 落点是工作区根路径或某个具体工作区。
        await expect
            .poll(async () => new URL(page.url()).pathname, {
                timeout: 45000,
                intervals: [250, 500],
            })
            .toMatch(/^\/workspace(\/[0-9a-f-]{36})?$/i);

        // (3) PLAN-0614：落点三态都合法（polling，无固定等待）：
        //     - `picker-empty`：账号**还没有任何工作区** ⇒ 空白起步首屏（注册不再建工作区）；
        //     - `picker`：已有工作区但 tab 上下文为空 ⇒ 等用户选；
        //     - `workspace`：守卫恢复了 tab 上下文（或落在"第一个活跃工作区"）⇒ 直接进入。
        //     "什么都没渲染"仍然是失败（可证伪性保留）。
        await pollLanding(page, ANY_LANDING);

        // 记录这次断言实际观察到的事实（供 evidence 引用）。不是探针：不挂 console/pageerror
        // 监听，只把落点、picker 条目数与 WorkspaceView 的 testid 计数写进报告 annotation。
        // `content=ready|lagging` 是**信息性观测**（3s 短超时，不参与断言）：入口可达即可，
        // 内容就绪与否由 G2-c/G2-e/G3 各自断言（见 workspaceLanding 的注释）。
        const contentReady = await workspaceContentReady(page);
        test.info().annotations.push({
            type: "goldpath-g1d-landing",
            description: [
                `path=${new URL(page.url()).pathname}`,
                `landing=${await workspaceLanding(page)}`,
                `pickerItems=${await page.locator('[data-testid^="workspace-picker-item-"]').count()}`,
                `fileTree=${await page.getByTestId("workspace-file-tree").count()}`,
                `emptyState=${await page.getByTestId("workspace-empty-state").count()}`,
                `content=${contentReady ? "ready" : "lagging"}`,
            ].join(" "),
        });

        const token = await tokenOf(page);
        expect(token, "localMode re-entry must mint a token").not.toBe("");
        const me = await request.get(`${CP_URL}/api/v1/auth/me`, { headers: bearer(token) });
        expect(me.status(), await me.text()).toBe(200);
    });

    test("G1-e @closed closed policy is enforced on the CP while localMode keeps its first-account exemption", async ({
        request,
    }) => {
        test.skip(
            REGISTRATION_POLICY !== "closed",
            "needs `--batch=goldpath-closed` (XIHE_E2E_REGISTRATION_POLICY unset)",
        );

        // 产品不变式（PLAN-0581 §6 / I5，`AuthController.register` 的 `if (!localModeService.enabled())`）：
        // **localMode 明确豁免 registration policy** —— 否则「XIHE_LOCAL_MODE=true + 关闭注册」的
        // 空实例永远建不出第一个账号。所以本车道（`--first-run=local`）里 closed **不会**给出 403；
        // 原断言（第二次注册必须 403 REGISTRATION_CLOSED）是 spec 假设错，不是产品缺陷。
        //
        // 保留可证伪性：① 实例确实是 localMode（豁免的前提，`bootstrap-status.localMode`）；
        // ② 第二次注册被**豁免**放行（201）。一旦 I5 豁免被移除、或本车道不再是 localMode，
        // 本条会立刻红。严格 403 语义只能在非 localMode 栈上验（见 evidence §8.11）。
        const bootstrap = await request.get(`${CP_URL}/api/v1/auth/bootstrap-status`);
        expect(bootstrap.status(), await bootstrap.text()).toBe(200);
        expect(
            ((await bootstrap.json()) as { localMode?: boolean }).localMode,
            "the closed lane boots a localMode stack (I5 exemption applies)",
        ).toBe(true);

        const second = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: {
                email: `second-${Date.now()}@test.local`,
                password: `Second-${randomUUID().slice(0, 8)}`,
                name: "Second Account",
            },
        });
        expect(second.status(), await second.text()).toBe(201);
        test.info().annotations.push({
            type: "goldpath-closed-localmode-exemption",
            description:
                "registrationPolicy=closed enforced on CP; localMode exempts register (I5)",
        });
    });
});

// ══════════════════════════════════════════════════════════════════════════
// G2 —— 从零到第一条回复
// ══════════════════════════════════════════════════════════════════════════

test.describe("@host gold path G2 — zero to first reply through the UI", () => {
    test.beforeEach(() => {
        const gap = accountGap();
        test.skip(Boolean(gap), gap ?? "");
    });

    test("G2-a the bootstrapped first account logs in through the real form", async ({
        page,
        request,
    }) => {
        expect(GOLDPATH_EMAIL, "runner must provide the bootstrap account email").not.toBe("");
        await loginViaForm(page, GOLDPATH_EMAIL, GOLDPATH_PASSWORD);

        const identity = await identityOf(page, request);
        // PLAN-0610：首用户 SUPER_ADMIN（不再断言 user.role === "ADMIN"）。
        expect(identity.isInstanceSuper).toBe(true);
        await expect(page.getByTestId("nav-rail-settings")).toBeVisible({ timeout: 20000 });
    });

    test("G2-b the SUPER_ADMIN account needs no manual grant to manage agents", async ({
        page,
        request,
    }) => {
        // 草案的 principal-grants 自授步骤已随 PLAN-0610 W2 退役；localMode 首用户直接持
        // SUPER_ADMIN（design 决策 #1），这里断言"管理面直接可用 + 能力投影正确"。
        await openOrCreateWorkspace(page, request);
        const identity = await identityOf(page, request);
        expect(identity.isInstanceSuper).toBe(true);

        const token = await tokenOf(page);
        const permissions = await request.get(`${CP_URL}/api/v1/me/permissions`, {
            headers: bearer(token),
        });
        expect(permissions.status(), await permissions.text()).toBe(200);
        const body = (await permissions.json()) as { instanceCapabilities?: string[] };
        expect(body.instanceCapabilities ?? []).toContain("instance:super");

        await expect(page.getByTestId("nav-rail-admin")).toBeVisible({ timeout: 20000 });
    });

    test("G2-c create and bind an Agent through the workspace dialog", async ({
        page,
        request,
    }) => {
        const workspaceId = await openOrCreateWorkspace(page, request);

        await page.getByTestId("workspace-toolbar-agents").click();
        await expect(page.getByTestId("workspace-agent-management-dialog")).toBeVisible({
            timeout: 20000,
        });
        await expect(page.getByTestId("agent-grant-panel-link")).toBeVisible();

        await page
            .getByTestId("agent-principal-name")
            .fill(`Gold Path Agent ${randomUUID().slice(0, 8)}`);
        // 模板留空 = 默认模板。
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
        expect(principalId).toMatch(/^[0-9a-f-]{36}$/i);
        await expect(page.getByTestId("unbound-agent-principal")).toContainText(principalId);

        const bindResponse = page.waitForResponse(
            (response) =>
                /\/api\/v1\/workspaces\/[^/]+\/agents\/[^/]+$/.test(
                    new URL(response.url()).pathname,
                ) && response.request().method() === "PUT",
        );
        await page.getByTestId("agent-principal-bind").click();
        expect((await bindResponse).status()).toBe(200);
        expect(workspaceId).toMatch(/^[0-9a-f-]{36}$/i);

        // 证据：Agent 管理面板（创建 + 绑定完成态，T5.2 第 5 步），与上面的 201/200 断言同源。
        await shot(page, "05-agent-session");
    });

    test("G2-d create a session with the bound Agent (201) and the composer appears", async ({
        page,
        request,
    }) => {
        await openOrCreateWorkspace(page, request);

        await page.getByTestId("workspace-create-session").click();
        const principalSelect = page.getByTestId("workspace-agent-principal-select");
        await expect(principalSelect).toBeVisible({ timeout: 20000 });
        const principalId = await principalSelect.locator("option").nth(1).getAttribute("value");
        expect(principalId, "a bound principal must be selectable").toBeTruthy();
        await principalSelect.selectOption(principalId!);

        const sessionResponse = page.waitForResponse(
            (response) =>
                /^\/api\/v1\/(workspaces\/[^/]+\/)?sessions$/.test(
                    new URL(response.url()).pathname,
                ) && response.request().method() === "POST",
        );
        await page.getByTestId("workspace-create-agent-session").click();
        const created = await sessionResponse;

        expect(created.status(), await created.text()).toBe(201);
        await expect(page).toHaveURL(/\/workspace\/[0-9a-f-]{36}\/chat\/[0-9a-f-]{36}/i, {
            timeout: 45000,
        });
        await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 20000 });
    });

    test("G2-e one message yields an assistant bubble, a terminal run, and survives reload", async ({
        page,
        request,
    }) => {
        // 本用例比其它 G2 步骤长（建工作区 + 建/绑 Agent + 建会话 + 聊天 + reload），单独放宽超时。
        test.setTimeout(300_000);
        // 先进入默认工作区（拿到工作区工具条的入口），再从中新建 direct_attach 工作区。
        await openOrCreateWorkspace(page, request);
        // Lead 裁定 (b)：首条回复必须在 `direct_attach` 工作区里拿（BL-171：自动建的默认工作区是
        // `managed_import/docker`，而工作区 Docker 后端按 2026-10-31 裁定冻结 ⇒ chat 必
        // `chat_handoff_failed`）。这条用例因此自包含：建工作区 → 建并绑定 Agent → 建会话 → 聊天。
        const workspaceId = await createWorkspaceViaDialog(page, request, "toolbar");
        await createAndBindAgentInCurrentWorkspace(page);

        await page.getByTestId("workspace-create-session").click();
        const principalSelect = page.getByTestId("workspace-agent-principal-select");
        await expect(principalSelect).toBeVisible({ timeout: 20000 });
        const principalId = await principalSelect.locator("option").nth(1).getAttribute("value");
        expect(principalId, "the bound principal must be selectable").toBeTruthy();
        await principalSelect.selectOption(principalId!);

        const sessionResponse = page.waitForResponse(
            (response) =>
                /^\/api\/v1\/(workspaces\/[^/]+\/)?sessions$/.test(
                    new URL(response.url()).pathname,
                ) && response.request().method() === "POST",
        );
        await page.getByTestId("workspace-create-agent-session").click();
        const createdSession = await sessionResponse;
        expect(createdSession.status(), await createdSession.text()).toBe(201);
        await expect(page).toHaveURL(/\/workspace\/[0-9a-f-]{36}\/chat\/[0-9a-f-]{36}/i, {
            timeout: 45000,
        });
        await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 25000 });
        expect(workspaceId).toMatch(/^[0-9a-f-]{36}$/i);

        // 显式绑定一条**工具可用**的连接再发消息：
        // - 未绑定 → `409 API_TYPE_REBIND_REQUIRED`（本 build 不接受纯 profile 的隐式分派）；
        // - 绑 `custom-openai-compatible` → 目录里 `toolsSupported=false`，工作区 Chat 必带工具
        //   ⇒ agent 预检抛 `LLM_TOOL_ROUTE_UNSUPPORTED`；
        // 所以用 provider `openai` + fake LLM 的 `/openai/v1`（目录里工具可用）。
        const chatUrl = page.url();
        const chatSessionId = chatUrl.match(/\/chat\/([0-9a-f-]{36})/i)?.[1] ?? "";
        expect(chatSessionId, "the created session id").toMatch(/^[0-9a-f-]{36}$/i);
        await bindToolCapableFakeLlmConnection(page, chatSessionId);
        await page.reload({ waitUntil: "load" });
        await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 25000 });
        await expect(page.getByTestId("model-popover-trigger")).toBeVisible({ timeout: 25000 });

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

        // 证据：首条回复（T5.2 第 6 步），与上面的"气泡可见 + 文本非空 + 无错误"断言同源。
        await shot(page, "06-first-reply");

        await page.reload({ waitUntil: "load" });
        await expect
            .poll(async () => page.locator('[data-slot="message"]').count(), {
                timeout: 45000,
                intervals: [500, 1000],
            })
            .toBeGreaterThanOrEqual(2);
        await expect(page.getByTestId("session-item").first()).toBeVisible();
    });
});

// ══════════════════════════════════════════════════════════════════════════
// G3 —— 连接到「模型可选」
// ══════════════════════════════════════════════════════════════════════════

test.describe("@host gold path G3 — provider connection to selectable model", () => {
    test.beforeEach(() => {
        const gap = accountGap();
        test.skip(Boolean(gap), gap ?? "");
        test.skip(!FAKE_LLM_PORT, "needs XIHE_FAKE_LLM_PORT (runner-provided fake LLM)");
    });

    test("G3-a a UI-created connection verifies READY against the fake provider", async ({
        page,
        request,
    }) => {
        await openOrCreateWorkspace(page, request);
        await page.goto("/settings/config", { waitUntil: "load" });

        // 实例层的 LLM 分区是只读提示（`settings.providerInstanceNote`），ProviderHub 只在
        // user / workspace 层渲染 ⇒ 新建连接必须切到「用户」层（PLAN-0554/0560 的分层面）。
        await page.getByTestId("config-tab-user").click();
        await page.getByTestId("provider-hub-connect").click();
        await expect(page.getByTestId("provider-picker-modal")).toBeVisible({ timeout: 20000 });
        await page.getByTestId("provider-picker-search").fill("open");
        await page.locator('button[data-testid^="provider-picker-"]').first().click();

        const label = `goldpath-conn-${Date.now()}`;
        await page.getByTestId("provider-connection-form-label").fill(label);
        await page.getByTestId("provider-connection-form-key").fill(`goldpath-${Date.now()}`);
        const form = page
            .locator("form")
            .filter({ has: page.getByTestId("provider-connection-form-label") });
        await form.locator('input[type="password"]').first().fill(FAKE_LLM_API_KEY);
        await form
            .locator('input[type="url"]')
            .first()
            .fill(`http://127.0.0.1:${FAKE_LLM_PORT}/openai/v1`);
        // 表单里有多个 select（第 1 个是 API Type `provider-connection-api-type`），发现方式是
        // 带 `manual` 选项的那一个 —— 按选项值定位，不依赖顺序。
        for (const select of await form.locator("select").all()) {
            const values = await select
                .locator("option")
                .evaluateAll((options) =>
                    options.map((option) => (option as HTMLOptionElement).value),
                );
            if (values.includes("manual")) {
                await select.selectOption("manual");
                break;
            }
        }
        await form.locator("textarea").first().fill(FAKE_LLM_MODEL);

        const createResponse = page.waitForResponse(
            (response) =>
                response.url().endsWith("/api/v1/provider-connections") &&
                response.request().method() === "POST",
        );
        await form.locator('button[type="submit"]').click();
        const created = await createResponse;

        expect(created.status(), await created.text()).toBe(201);
        const connectionId = ((await created.json()) as { id: string }).id;

        const token = await tokenOf(page);
        const verified = await page.request.post(
            `${CP_URL}/api/v1/provider-connections/${connectionId}/verify`,
            { headers: bearer(token) },
        );
        expect(verified.ok(), await verified.text()).toBe(true);
        expect(
            ((await verified.json()) as { connection?: { status?: string } }).connection?.status,
        ).toBe("READY");

        await page.reload({ waitUntil: "load" });
        await expect(page.getByText(label).first()).toBeVisible({ timeout: 20000 });
    });

    test("G3-b the fake model becomes selectable in the composer model popover", async ({
        page,
        request,
    }) => {
        const workspaceId = await openOrCreateWorkspace(page, request);
        const token = await tokenOf(page);

        const list = await request.get(`${CP_URL}/api/v1/sessions`, { headers: bearer(token) });
        const sessions =
            ((await list.json()) as { sessions?: Array<{ id: string }> }).sessions ?? [];
        test.skip(!sessions[0]?.id, "needs the session created by G2-d");
        await page.goto(`/workspace/${workspaceId}/chat/${sessions[0].id}`, { waitUntil: "load" });
        await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 25000 });

        await page.getByTestId("model-popover-trigger").click();
        await expect(
            page.locator(`[data-testid^="model-item-"][data-testid$="/${FAKE_LLM_MODEL}"]`).first(),
        ).toBeVisible({ timeout: 20000 });
    });
});

// ══════════════════════════════════════════════════════════════════════════
// G4 —— 失败可读性（目标态；fixme 挂 BL-152 / BL-153 / F-09）
// ══════════════════════════════════════════════════════════════════════════

test.describe("@gap gold path G4 — failure readability (target state)", () => {
    test("G4-a no-provider failure must be localized and actionable (BL-152)", async ({ page }) => {
        test.fixme(
            true,
            "BL-152 未修：当前直出 `LLM_NOT_CONFIGURED: Agent LLM is not ready: missing_credentials`（英文技术码）",
        );
        await openOrCreateWorkspace(page, request);
        await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 25000 });
        await page.getByTestId("chat-input").fill("配置缺失时我该看到什么？");
        await page.getByTestId("chat-send-button").click();

        const error = page.getByTestId("message-error");
        await expect(error).toBeVisible({ timeout: 45000 });
        await expect(error).not.toContainText(/_/);
        await expect(error.getByRole("button", { name: /去配置|配置模型|设置/ })).toBeVisible();
    });

    test("G4-b a user-scope connection should make the Agent ready (F-09)", async ({ request }) => {
        test.fixme(
            true,
            "F-09 未修：User 层连接不参与 Agent readiness（0589 M3-10 实证：连接建好仍 missing_credentials）",
        );
        const agentPort = process.env.XIHE_AGENT_PORT || "12632";
        const response = await request.get(`http://127.0.0.1:${agentPort}/health`);
        expect(((await response.json()) as { llmReady?: string }).llmReady).toBe("ready");
    });
});
