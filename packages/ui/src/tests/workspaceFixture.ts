/**
 * `GET /api/v1/workspaces/{id}` 响应夹具工厂（task-172；依据 task-160 `eab417a2` / task-166 `bf3d5cbac`）。
 *
 * **契约**：`docs/api/openapi.yaml:6594` 的 `Workspace.required` = 8 项 ——
 * `id` / `name` / `ownerId` / `storageBackend` / `storageRef` / `storageMode` / `executionMode` / `generation`。
 *
 * **为什么要有它**：手写字面量只填用例当下用到的那几项，其余字段在 UI 里读到 `undefined` 也不抛错 ——
 * 断言照绿，但「页面读 `generation` / `ownerId` 拿到 `undefined`」这件事被永久掩盖（task-166 的判据
 * `A03-xihe/scripts/check-fixture-schema.mjs` 在 `bl344-members-capability` 缺 5 项、
 * `workspaceRoots.httpRoundTrip` 缺 6 项，就是这么报出来的）。工厂把 8 项一次填满，用例只写它**在意**的覆盖项。
 *
 * **默认值一律取合法值**：`storageMode` / `executionMode` 只给契约 enum 内的取值，`storageBackend` 取 CP 实体
 * 默认值（`packages/control-plane/.../Workspace.java:32` 的 `host_directory`），不给空串或占位枚举 ——
 * 否则夹具会引入第二类假绿（「非法枚举也能过」）。
 */

/** 契约 required 的 8 个字段（顺序同 `openapi.yaml:6594`），供夹具与判据脚本对账。 */
export const WORKSPACE_REQUIRED_FIELDS = [
    "id",
    "name",
    "ownerId",
    "storageBackend",
    "storageRef",
    "storageMode",
    "executionMode",
    "generation",
] as const;

export type WorkspaceStorageMode = "managed_import" | "direct_attach";

export type WorkspaceExecutionMode = "docker" | "windows-mxc" | "windows-host";

/**
 * 契约必填 8 项必出；其余契约字段（`hostPath` / `roots` / `workspaceRole` / `canWrite` / `description` …）
 * 由用例按需覆盖 —— 额外属性允许，缺省时保持「契约没说必填」的原状（不替用例编造 `roots`）。
 */
export type WorkspaceFixture = {
    id: string;
    name: string;
    ownerId: string;
    storageBackend: string;
    storageRef: string;
    storageMode: WorkspaceStorageMode;
    executionMode: WorkspaceExecutionMode;
    generation: number;
} & Record<string, unknown>;

const DEFAULTS = {
    id: "ws-fixture",
    name: "Workspace",
    ownerId: "00000000-0000-4000-8000-000000000001",
    storageBackend: "host_directory",
    storageRef: "ws-fixture",
    storageMode: "direct_attach",
    executionMode: "windows-host",
    generation: 1,
} as const;

/**
 * 建一份契约完整的 workspace 响应体；`overrides` 覆盖任意字段（含契约可选字段）。
 *
 * 用法：`makeWorkspace({ id: WORKSPACE_ID, name: "多根工作区", roots: DECLARED_ROOTS })` ——
 * 只写这个用例**关心**的字段，其余 8 项必填由工厂保证。
 */
export function makeWorkspace(
    overrides: Partial<WorkspaceFixture> & Record<string, unknown> = {},
): WorkspaceFixture {
    return { ...DEFAULTS, ...overrides };
}
