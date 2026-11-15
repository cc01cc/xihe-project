import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPinia, setActivePinia } from "pinia";
import { useAuthStore } from "../auth";

/**
 * task-217（2026-11-15，来源 D-1598）：**实例作用域原子出现在工作区作用域投影里时，不得解锁工作区写面**。
 *
 * <p>为什么需要这条：`task-216` 给共享夹具词表加了实例写原子 `WRITE_INSTANCE_CONTENT`，`ui-1` 的结论是
 * 「语义保持」。复核（`task-217` 前身，我做的只读分析）发现：**语义保持的依据不是「作用域隔离」**，
 * 而是产品侧**按名精确匹配** ——</p>
 *
 * <ul>
 *   <li>夹具把 <b>同一个</b> `permissionAtoms` 数组同时喂给 `instancePermissions` 与 `workspaces[].permissions`
 *       （`e2e/mock/helpers/auth.ts:1216` 与 `:1222`）⇒ 默认（实例管理员）预设下，实例原子**确实出现在**
 *       工作区作用域列表里 ⇒ **wire 层没有隔离**（只在预设 filter 层：owner/editor/viewer 的 `permissionAtoms`
 *       会先被 `INSTANCE_SCOPE_ATOMS` 过滤掉）；</li>
 *   <li>产品侧 `canWriteWorkspace` 只问 `WRITE_WORKSPACE_CONTENT`（`src/stores/auth.ts:256-259`），
 *       而该原子**不在** `PERMISSION_ATOMS` 里 ⇒ 新原子打不开工作区写面。</li>
 * </ul>
 *
 * <p>**本 spec 把两件事都钉住**：① 实例原子确实在 workspace 集合里（防将来有人把结论读成「夹具做了隔离」，
 * 于是信任一条不存在的隔离）；② 它在里面也**不等于**可写（防「有原子就放行」这种实现漂移）。</p>
 */
vi.mock("../../composables/api", () => ({
    api: {
        // `vitest(require-mock-type-parameters)` 是**阻断**规则（`packages/ui/AGENTS.md`）⇒ 每个 mock 都要带类型参数。
        // 这里用宽松签名而不是 `typeof apiModule.api.*`：后者需要命名空间导入，会触发 `import(no-namespace)` 警告
        // （而本仓的 warnings ratchet 只许降不许升）；本文件不调用这些 API，签名的精度对断言无影响。
        login: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
        register: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
        me: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
        getWorkspace: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
        getCurrentWorkspace: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
        getSelfPermissions: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    onAuthTokensRefreshed: vi.fn<(cb: (accessToken: string) => void) => void>(),
    registerForceLogout: vi.fn<(fn: () => void) => void>(),
    registerWorkspaceContextRequired: vi.fn<(fn: () => void) => void>(),
}));

const WS = "44444444-4444-4444-8444-444444444444";
const INSTANCE_WRITE = "WRITE_INSTANCE_CONTENT";
const WS_WRITE = "WRITE_WORKSPACE_CONTENT";
/** 与 `e2e/mock/helpers/auth.ts` 的 `PERMISSION_ATOMS` 同形的默认词表（含实例写原子）。 */
const DEFAULT_ATOMS = [
    "MANAGE_ROLES",
    "MANAGE_INSTANCE_CONFIG",
    "VIEW_INSTANCE_AUDIT",
    "MANAGE_SKILL_LIBRARY",
    "READ_INSTANCE_CONTENT",
    INSTANCE_WRITE,
];

function store() {
    return useAuthStore();
}

interface ProjectionShape {
    instance: string[];
    workspace: string[];
    admin?: boolean;
    role?: string;
}

function setProjection(s: ReturnType<typeof store>, shape: ProjectionShape) {
    const toRows = (atoms: string[]) => atoms.map((a) => ({ actionClass: a, resource: "*" }));
    s.selfPermissions = {
        userId: "u1",
        instanceCapabilities: [],
        instancePermissions: toRows(shape.instance),
        workspaces: [
            {
                workspaceId: WS,
                workspaceRole: shape.role ?? "WS_OWNER",
                workspaceAdmin: shape.admin ?? true,
                permissions: toRows(shape.workspace),
            },
        ],
    } as typeof s.selfPermissions;
    s.selfPermissionsStatus = "ready";
}

function setWorkspace(s: ReturnType<typeof store>) {
    s.workspace = {
        id: WS,
        name: "W",
        storageMode: "direct_attach",
        ownerId: "other-user",
    } as typeof s.workspace;
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    sessionStorage.clear();
});

describe("task-217 · 实例作用域原子不得解锁工作区写面", () => {
    it("默认预设形状（同一份词表喂两个字段）⇒ 实例原子在 workspace 集合里（wire 层未隔离）", () => {
        const s = store();
        setWorkspace(s);
        setProjection(s, { instance: DEFAULT_ATOMS, workspace: DEFAULT_ATOMS });
        // ① 实例面：可用（这就是 task-216 要修的三条红的前提）
        expect(s.hasInstanceAtom(INSTANCE_WRITE)).toBe(true);
        // ② 工作区面：不可写 —— 而「实例原子确实进了工作区列表」这件事由文件末尾的形状钉子证明
        //    （store 只导出 `hasInstanceAtom`，没有 `hasWorkspaceAtom`：工作区面只能通过 `canWriteWorkspace` 观察）
        expect(s.canWriteWorkspace).toBe(false);
    });

    it("工作区 permissions 只含实例原子 ⇒ canWriteWorkspace 为 false（按名匹配，不是「有原子就放行」）", () => {
        const s = store();
        setWorkspace(s);
        setProjection(s, { instance: [INSTANCE_WRITE], workspace: [INSTANCE_WRITE] });
        expect(s.canWriteWorkspace).toBe(false);
    });

    it("对照：工作区 permissions 含 WRITE_WORKSPACE_CONTENT ⇒ 可写（证明上一条不是「store 恒 false」）", () => {
        const s = store();
        setWorkspace(s);
        setProjection(s, { instance: [INSTANCE_WRITE], workspace: [WS_WRITE] });
        expect(s.canWriteWorkspace).toBe(true);
    });

    it("MANAGE_WORKSPACE_AGENTS 判定只按名取该原子 ⇒ 实例原子无法满足它", () => {
        // 面板里的判据是 `workspaceAtoms.includes("MANAGE_WORKSPACE_AGENTS")`（组件局部，store 不导出），
        // 所以这条在**消费方源码**上钉：它要求的就是这个名字，而实例原子的名字不是它。
        const panel = readFileSync(
            resolve(process.cwd(), "src/features/workspace/components/WorkspaceAgentsPanel.vue"),
            "utf8",
        );
        expect(panel).toContain('workspaceAtoms.value.includes("MANAGE_WORKSPACE_AGENTS")');
        expect(panel).toContain('workspaceAtoms.value.includes("MEMORY_WRITE")');
        expect(panel).not.toContain(INSTANCE_WRITE);
    });
});

describe("task-217 · 夹具形状钉子（防「夹具做了隔离」的误读传播）", () => {
    /**
     * 这里**读源码文本**而不是 import `e2e/mock/helpers/auth.ts`：该文件顶层 `import { test } from "@playwright/test"`，
     * 在 `src/**` 的 vitest/tsc 面里引入会把 Playwright 类型与运行时带进产品侧 —— 那是更差的耦合。
     * 钉的是**形状**（同一个变量喂两个字段），不是实现细节；改动这两行必须同时改本断言。
     */
    // vitest 的 cwd 是包根（`packages/ui`）—— 用 `process.cwd()` 而不是 `import.meta.url`：
    // jsdom 环境下 `import.meta.url` 不是 file: scheme（实测 `TypeError: The URL must be of scheme file`）。
    const FIXTURE = readFileSync(resolve(process.cwd(), "e2e/mock/helpers/auth.ts"), "utf8");

    it("实例与工作区两个字段吃的是同一个 permissionAtoms 变量", () => {
        expect(FIXTURE).toContain("instancePermissions: permissionAtoms");
        expect(FIXTURE).toContain("permissions: permissionAtoms");
    });

    it("新原子同时在 PERMISSION_ATOMS 与 INSTANCE_SCOPE_ATOMS 里（预设 filter 才排得掉）", () => {
        expect(FIXTURE).toContain('{ actionClass: "WRITE_INSTANCE_CONTENT", resource: "*" }');
        expect(FIXTURE).toContain(
            'export const INSTANCE_SCOPE_ATOMS = ["READ_INSTANCE_CONTENT", "WRITE_INSTANCE_CONTENT"]',
        );
    });
});
