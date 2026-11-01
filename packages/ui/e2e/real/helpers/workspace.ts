import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, type APIRequestContext } from "@playwright/test";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;

type DirectAttachExecutionMode = "windows-mxc" | "windows-host";

/**
 * PLAN-0614 适配：注册**不再**创建默认工作区，`POST /auth/register` 的 `workspaceId` 为 `null`。
 *
 * 既有 real E2E 普遍假设"注册即有工作区"，于是把 `null` 塞进 `X-Workspace-Id` 头会直接抛
 * `headers[i].value: expected string, got object`。这里提供**唯一**的工作区兜底：
 * 已有工作区 → 用第一个；没有 → 显式建一个 `direct_attach`（工作区 Docker 后端按 2026-10-31
 * 裁定冻结，所以不能用 `managed_import`；DEV-031 也禁止静默回退到不受限宿主）。
 *
 * 宿主目录取自本轮隔离根（`XIHE_E2E_RUN_ID`），**不写死路径**；执行模式按真实 preflight 探测，
 * 探测不到就显式失败（不猜 `windows-host`）。
 */
export async function ensureWorkspace(
    request: APIRequestContext,
    authToken: string,
): Promise<string> {
    expect(authToken, "ensureWorkspace needs an access token").toBeTruthy();
    const headers = {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
    };

    const list = await request.get(`${CP_URL}/api/v1/workspaces`, { headers });
    expect(list.status(), await list.text()).toBe(200);
    const existing = (await list.json()) as Array<{ id?: string }>;
    const first = Array.isArray(existing) ? existing[0]?.id : undefined;
    if (first) return first;

    // 语义：**还原 0614 之前的那个默认工作区**，而不是"统一换成 direct_attach"。
    //
    // 0614 之前，注册会顺带建一个 `managed_import`（docker 执行后端）工作区；大量既有 real spec
    // 断言的正是容器语义（Sandbox 物化、容器 job、导入落盘）。host E2E 车道原本是「工作区 Docker
    // 后端冻结」的唯一豁免（DEV-020 §3.3b），**PLAN-0618 起该豁免已随产品面一起冻结、解冻时一起恢复**：
    // 车道默认注入 `XIHE_WORKSPACE_DOCKER_BACKEND=disabled`，容器语义用例改用 `docker-frozen.ts` 的
    // case 级标记（`--include-docker-frozen` 一次性恢复）。另外 runner 只把该 env 注入 CP 进程，
    // **没有**注入 Playwright 进程，所以这里不能靠 env 判断。
    //
    // 因此按**行为**判别，而不是按 env 猜：先按旧默认建 `managed_import`；只有当 CP 明确回答
    // `409 BACKEND_DISABLED`（该车道确实冻结了 docker 后端）时，才回退到 `direct_attach` + 真实
    // capability preflight。任何其它错误都不回退，直接失败 —— 不做静默降级。
    // 需要 direct_attach 语义的 spec（goldpath 等）自己建工作区，不走本 helper。
    const dockerAttempt = await createWorkspace(request, headers, {
        storageMode: "managed_import",
    });
    if (dockerAttempt.ok) {
        await expectStorageMode(request, headers, dockerAttempt.workspaceId, "managed_import");
        return dockerAttempt.workspaceId;
    }
    // 回退判据只认**精确码**：409 在本系统里还有 CONCURRENT_MODIFICATION / LAST_OWNER 等语义，
    // 拿状态码当判据迟早误伤。
    if (dockerAttempt.status !== 409 || dockerAttempt.code !== "BACKEND_DISABLED") {
        throw new Error(
            `create managed_import workspace failed: ${dockerAttempt.status} ${dockerAttempt.code} ${dockerAttempt.detail}`,
        );
    }

    const hostPath = isolatedWorkspaceHostPath();
    const executionMode = await probeExecutionMode(request, headers, hostPath);
    const directAttempt = await createWorkspace(request, headers, {
        storageMode: "direct_attach",
        hostPath,
        executionMode,
    });
    if (!directAttempt.ok) {
        throw new Error(
            `create direct_attach workspace failed: ${directAttempt.status} ${directAttempt.code} ${directAttempt.detail}`,
        );
    }
    // 回读护栏：万一 CP 将来在 docker 车道也回 409，helper 会静默降级成 direct_attach，容器语义
    // spec 又会大面积红、报错点离根因很远。这条断言让"实际建成了什么"当场可见。
    await expectStorageMode(request, headers, directAttempt.workspaceId, "direct_attach");
    return directAttempt.workspaceId;
}

/**
 * 显式建一个 `direct_attach` 工作区（**不经** managed_import 试探）。
 *
 * 用途：spec 需要一个**额外**的、确定是 direct_attach 的工作区（例如 workspace-files 的
 * "空工作区文件树" 夹具）。PLAN-0618 之后 `storageMode` 是**必填无默认值** —— 只发 `{ name }`
 * 会被 CP 以 `400 INVALID_REQUEST: storageMode is required` 拒绝，所以这里把三件套一次给全：
 * `storageMode` + 隔离根下的 `hostPath` + 真实 preflight 选出的 `executionMode`。
 */
export async function createDirectAttachWorkspace(
    request: APIRequestContext,
    authToken: string,
): Promise<string> {
    expect(authToken, "createDirectAttachWorkspace needs an access token").toBeTruthy();
    const headers = {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
    };
    const hostPath = isolatedWorkspaceHostPath();
    const executionMode = await probeExecutionMode(request, headers, hostPath);
    const attempt = await createWorkspace(request, headers, {
        storageMode: "direct_attach",
        hostPath,
        executionMode,
    });
    if (!attempt.ok) {
        throw new Error(
            `create direct_attach workspace failed: ${attempt.status} ${attempt.code} ${attempt.detail}`,
        );
    }
    await expectStorageMode(request, headers, attempt.workspaceId, "direct_attach");
    return attempt.workspaceId;
}

/** 回读工作区，断言 storageMode 与本次实际走的分支一致。 */
async function expectStorageMode(
    request: APIRequestContext,
    headers: Record<string, string>,
    workspaceId: string,
    expected: "managed_import" | "direct_attach",
): Promise<void> {
    const response = await request.get(`${CP_URL}/api/v1/workspaces/${workspaceId}`, { headers });
    expect(response.status(), await response.text()).toBe(200);
    const body = (await response.json()) as { storageMode?: string };
    expect(
        body.storageMode,
        `workspace ${workspaceId} should be ${expected} (the branch ensureWorkspace took)`,
    ).toBe(expected);
}

type CreateAttempt =
    | { ok: true; workspaceId: string }
    | { ok: false; status: number; code: string; detail: string };

async function createWorkspace(
    request: APIRequestContext,
    headers: Record<string, string>,
    input: {
        storageMode: "managed_import" | "direct_attach";
        hostPath?: string;
        executionMode?: DirectAttachExecutionMode;
    },
): Promise<CreateAttempt> {
    const created = await request.post(`${CP_URL}/api/v1/workspaces`, {
        headers: { ...headers, "Idempotency-Key": globalThis.crypto.randomUUID() },
        data: {
            name: `e2e-workspace-${Date.now()}`,
            storageMode: input.storageMode,
            // `profile` 只对 docker(managed_import) 执行有意义（direct_attach 带上会被 CP 以
            // 400 INVALID_PROFILE 拒绝，实测）。0614 之前的默认工作区是 `coding`；specs 断言的
            // 沙箱/工具面正是 `coding` 档，所以 docker 分支显式带上它，还原旧默认。
            ...(input.storageMode === "managed_import" ? { profile: "coding" } : {}),
            ...(input.hostPath ? { hostPath: input.hostPath } : {}),
            ...(input.executionMode ? { executionMode: input.executionMode } : {}),
        },
    });
    const text = await created.text();
    if (created.ok()) {
        const body = JSON.parse(text) as { id?: string };
        expect(body.id, "created workspace must carry an id").toMatch(/^[0-9a-f-]{36}$/i);
        return { ok: true, workspaceId: body.id! };
    }
    let code = "";
    let detail = text;
    try {
        const problem = JSON.parse(text) as { code?: string; detail?: string };
        code = problem.code ?? "";
        detail = problem.detail ?? text;
    } catch {
        // 非 JSON 错误体：保留原始文本，交由调用方失败
    }
    return { ok: false, status: created.status(), code, detail };
}

/** 本轮隔离根下的工作区目录（`.tmp/e2e-host/<runId>/e2e-ws-<ts>`），供 Runtime 真实读取。 */
export function isolatedWorkspaceHostPath(): string {
    const runId = process.env.XIHE_E2E_RUN_ID ?? "";
    expect(runId, "ensureWorkspace needs the isolated e2e-host runner (XIHE_E2E_RUN_ID)").not.toBe(
        "",
    );
    const hostRoot = path.resolve(process.cwd(), "../../.tmp/e2e-host", runId);
    const hostPath = path.join(hostRoot, `e2e-ws-${Date.now()}`);
    mkdirSync(hostPath, { recursive: true });
    return hostPath;
}

/** 真实 capability preflight：MXC 优先，其次 windows-host；都不可用则失败（不静默降级）。 */
async function probeExecutionMode(
    request: APIRequestContext,
    headers: Record<string, string>,
    hostPath: string,
): Promise<DirectAttachExecutionMode> {
    const probe = async (executionMode: DirectAttachExecutionMode) => {
        const response = await request.post(`${CP_URL}/api/v1/workspaces/capabilities/preflight`, {
            headers,
            data: { storageMode: "direct_attach", hostPath, executionMode },
        });
        expect(response.ok(), await response.text()).toBeTruthy();
        return (await response.json()) as { available?: boolean; reason?: string };
    };

    const mxc = await probe("windows-mxc");
    if (mxc.available === true) return "windows-mxc";
    const host = await probe("windows-host");
    if (host.available === true) return "windows-host";
    throw new Error(
        `no direct_attach execution backend available (mxc=${String(mxc.reason)}, host=${String(host.reason)})`,
    );
}
