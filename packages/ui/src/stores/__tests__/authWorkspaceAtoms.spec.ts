import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useAuthStore } from "../auth";
import type * as apiModule from "../../composables/api";

/**
 * task-414（RBAC P0-2，硬规则「权限面先定能力原子」）：工作区层判据必须在**能力原子层**求值，
 * 不得按角色名特判。真栈实测（证据 internal/A03-xihe/evidence/2026-11-14-instance-flow-audit/
 * task414-role-atoms.json）：WS_OWNER 15 项含 `workspace:admin(cap)`；WS_EDITOR 10 项含
 * `WRITE_WORKSPACE_CONTENT` 但**无** admin 能力；WS_VIEWER 只有 `USE_WORKSPACE_RUNTIME` + `read`。
 * **投影里没有 `MANAGE_WORKSPACE_MEMBERS`**（连 OWNER 也没有）⇒ 成员管理面的对端是 `workspaceAdmin`
 * 能力位，不是动作原子；把它映射到某个 MANAGE_* 原子会连 OWNER 一起判无权。
 *
 * 本 spec 的红线是**双向**的：角色名说无权但原子说有权 ⇒ 必须有权；角色名说有权但原子被撤 ⇒ 必须无权。
 */
vi.mock("../../composables/api", () => ({
    api: {
        login: vi.fn<typeof apiModule.api.login>(),
        register: vi.fn<typeof apiModule.api.register>(),
        me: vi.fn<typeof apiModule.api.me>(),
        getWorkspace: vi.fn<typeof apiModule.api.getWorkspace>(),
        getCurrentWorkspace: vi.fn<typeof apiModule.api.getCurrentWorkspace>(),
        getSelfPermissions: vi.fn<typeof apiModule.api.getSelfPermissions>(),
    },
    onAuthTokensRefreshed: vi.fn<(cb: (accessToken: string) => void) => void>(),
    registerForceLogout: vi.fn<(fn: () => void) => void>(),
    registerWorkspaceContextRequired: vi.fn<(fn: () => void) => void>(),
}));

const WS = "44444444-4444-4444-8444-444444444444";
const WRITE = "WRITE_WORKSPACE_CONTENT";

function store() {
    return useAuthStore();
}

function setWorkspace(s: ReturnType<typeof store>, overrides: Record<string, unknown> = {}) {
    s.workspace = {
        id: WS,
        name: "W",
        storageMode: "direct_attach",
        ownerId: "other-user",
        ...overrides,
    } as typeof s.workspace;
}

function setProjection(
    s: ReturnType<typeof store>,
    atoms: string[],
    opts: { role?: string; admin?: boolean; resource?: string } = {},
) {
    s.selfPermissions = {
        userId: "u1",
        instanceCapabilities: [],
        instancePermissions: [],
        workspaces: [
            {
                workspaceId: WS,
                workspaceRole: opts.role ?? "CUSTOM_WRITER",
                workspaceAdmin: opts.admin ?? false,
                permissions: atoms.map((a) => ({
                    actionClass: a,
                    resource: opts.resource ?? "*",
                })),
            },
        ],
    } as typeof s.selfPermissions;
    s.selfPermissionsStatus = "ready";
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    sessionStorage.clear();
});

describe("auth · task-414 工作区判据走能力原子（禁角色名特判）", () => {
    it("角色名 VIEWER 但持 WRITE_WORKSPACE_CONTENT ⇒ 可写（自定义角色不再被误判）", () => {
        const s = store();
        setWorkspace(s, { workspaceRole: "VIEWER", canWrite: false });
        setProjection(s, [WRITE, "read"]);
        expect(s.canWriteWorkspace).toBe(true);
    });

    it("角色名 OWNER 但原子被撤 ⇒ 不可写（角色名不再兜底给权限）", () => {
        const s = store();
        setWorkspace(s, { workspaceRole: "OWNER", canWrite: true });
        setProjection(s, ["read"]);
        expect(s.canWriteWorkspace).toBe(false);
    });

    it("角色名 OWNER 但投影 workspaceAdmin=false 且非实例管理员 ⇒ 不可管理", () => {
        const s = store();
        setWorkspace(s, { workspaceRole: "OWNER" });
        setProjection(s, [WRITE], { role: "OWNER", admin: false });
        expect(s.canManageWorkspace).toBe(false);
    });

    it("自定义角色名持 workspaceAdmin 能力 ⇒ 可管理（不看角色名）", () => {
        const s = store();
        setWorkspace(s, { workspaceRole: "EDITOR" });
        setProjection(s, [WRITE], { role: "EDITOR", admin: true });
        expect(s.canManageWorkspace).toBe(true);
    });

    it("资源限定的 WRITE 不算工作区级写权限（resource 非通配）", () => {
        const s = store();
        setWorkspace(s, { workspaceRole: "EDITOR" });
        setProjection(s, [WRITE], { resource: "file-1" });
        expect(s.canWriteWorkspace).toBe(false);
    });

    it("成员面：原子说可写 ⇒ 可见；只读原子 ⇒ 不可见（不看 VIEWER 这个名字）", () => {
        const s = store();
        setWorkspace(s, { workspaceRole: "VIEWER" });
        setProjection(s, [WRITE]);
        expect(s.canViewMembers).toBe(true);
        setProjection(s, ["read"], { role: "OWNER" });
        expect(s.canViewMembers).toBe(false);
    });

    it("BL-344 三态保持：投影未读到且无角色投影 ⇒ canViewMembers 仍是 undefined", () => {
        const s = store();
        setWorkspace(s, { workspaceRole: undefined, ownerId: undefined });
        s.selfPermissionsStatus = "loading";
        expect(s.canViewMembers).toBeUndefined();
    });

    it("投影 ready 但当前工作区不在 workspaces[] ⇒ 回落 CP 的 canWrite，不崩", () => {
        const s = store();
        setWorkspace(s, { workspaceRole: "EDITOR", canWrite: true });
        s.selfPermissions = {
            userId: "u1",
            instanceCapabilities: [],
            instancePermissions: [],
            workspaces: [],
        } as typeof s.selfPermissions;
        s.selfPermissionsStatus = "ready";
        expect(s.canWriteWorkspace).toBe(true);
    });
});
