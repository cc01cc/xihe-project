import type { Route } from "@playwright/test";

/**
 * task-59：`GET /api/v1/workspaces/{id}` 的**唯一来源**。
 *
 * ## 为什么要有这个文件
 * 旧夹具在 `auth.ts` 里自编 `{ id, name, status: "ready" }` —— 没有信封、没有 `roots`，
 * 14 个 wire 字段只有 2 个。后果不是"响应不对"，而是**产品代码里那条映射从来没被走到**：
 * 把 `normalizeWorkspaceRoots` 整行注释掉，多根用例照样绿（判别力 = 0）。
 *
 * ## 为什么不是"放行给 mock 服务器"
 * mock 车道默认 `XIHE_UI_MOCK_API=0`（`e2e/helpers/chain.ts#mockApiEnvFor` 只对 `preview` 回 `1`）
 * ⇒ `src/preview/mock/api-server.ts` 的中间件**根本没挂**，`route.fallback()` 只会掉到 dev proxy
 * 的真 CP 上（实测 401）。要放行到插件，得换整条车道的数据面 —— 那是 `task-339`，不在本卡。
 *
 * ## 这个来源能证明什么、不能证明什么（D-1185）
 * 能：UI 能从一份**形状完整**的信封里正确读出 `roots` 并归一化。
 * 不能：真实 CP 返回的信封就是这 14 个字段 —— 后者归真栈窗口与 PLAN-0763 A+ 生成腿。
 */

/** wire 字段清单与 `src/composables/api.ts` 的 `WORKSPACE_WIRE_FIELDS` 同序同集合。 */
export interface WorkspaceWire {
    id: string;
    name: string;
    description: string | null;
    ownerId: string;
    storageBackend: string;
    storageRef: string | null;
    storageMode: "managed_import" | "direct_attach";
    hostPath: string | null;
    roots: Array<{
        id: string;
        alias: string | null;
        position: number;
        path?: string | null;
    }>;
    executionMode: "windows-host";
    workspaceRole: "OWNER" | "EDITOR" | "VIEWER" | null;
    canWrite: boolean;
    createdAt: string;
    updatedAt: string;
}

/**
 * 默认工作区（单根、无 roots 投影 ⇒ 文件树保持扁平，与改造前的画面一致）。
 * `roots` 默认空数组而不是 `undefined`：前者是"CP 明确给了个空投影"，
 * 后者是"CP 没给这个字段"—— 两者对 `isMultiRoot` 等价，但语义不同，这里选"给了"。
 */
export function workspaceWire(overrides: Partial<WorkspaceWire> = {}): WorkspaceWire {
    const id = overrides.id ?? "workspace-1";
    return {
        id,
        name: "Mock Workspace",
        description: null,
        ownerId: "user-1",
        storageBackend: "direct",
        storageRef: null,
        storageMode: "direct_attach",
        hostPath: null,
        roots: [],
        executionMode: "windows-host",
        workspaceRole: "OWNER",
        canWrite: true,
        createdAt: "2026-11-01T09:00:00Z",
        updatedAt: "2026-11-11T09:00:00Z",
        ...overrides,
    };
}

/**
 * 只有这些 id 算"我们有这个工作区"，其余一律 404 ——
 * 泛化匹配会让 mock 车道永远无法验"访问不存在的工作区应当 404"（D-1178）。
 */
export const KNOWN_WORKSPACE_IDS = [
    "workspace-1",
    "ws-1",
    "slice-b",
    "ws-new",
    "mock-ws-main",
] as const;

export interface WorkspaceDetailOptions {
    /** 覆盖默认 wire 字段；`roots` 走这里就是"从 wire 来的多根"。 */
    workspace?: Partial<WorkspaceWire>;
    /** 未知 id 的响应（默认 404 信封，与 CP 的 WORKSPACE_NOT_FOUND 同形）。 */
    unknownIdStatus?: number;
}

/**
 * 在**网络层**回 `GET /api/v1/workspaces/{id}`。
 *
 * 注册顺序：Playwright 后注册优先，所以 spec 应当**在 `setupMockAuth` 之后**调用本函数来覆盖默认值。
 */
export async function fulfillWorkspaceDetail(
    route: Route,
    requestedId: string,
    options: WorkspaceDetailOptions = {},
): Promise<void> {
    if (!(KNOWN_WORKSPACE_IDS as readonly string[]).includes(requestedId)) {
        await route.fulfill({
            status: options.unknownIdStatus ?? 404,
            contentType: "application/problem+json",
            body: JSON.stringify({
                code: "WORKSPACE_NOT_FOUND",
                detail: `No workspace ${requestedId}`,
            }),
        });
        return;
    }
    await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
            workspace: workspaceWire({ id: requestedId, ...options.workspace }),
        }),
    });
}
