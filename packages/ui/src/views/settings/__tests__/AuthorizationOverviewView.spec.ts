import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { i18n } from "../../../i18n";
import { ApiError } from "../../../composables/api";
import type * as apiModule from "../../../composables/api";
import AuthorizationOverviewView from "../AuthorizationOverviewView.vue";

/**
 * task-8（DSD-1516 收窄后）：授权总览 = 已登录者视角。
 *
 * <p>这里钉的都是**判据**而不是文案：三档读面（有 / 仅反向 / 无）不许互相顶替、
 * 缺读面的来源不许渲染推断数据、explain 的请求体不许出现主体参数、分页 20 是硬上限。</p>
 */

// 替身用 hoisted 持有：断言里拿到的是 mock 实例本身，而不是「类方法引用」
// （expect(api.foo) 这种写法会触发 oxlint unbound-method；本仓已有同类存量红，不新增）。
const mocks = vi.hoisted(() => ({
    getSelfPermissions: vi.fn<typeof apiModule.api.getSelfPermissions>(),
    getBindings: vi.fn<typeof apiModule.api.getBindings>(),
    getWorkspaceAgents: vi.fn<typeof apiModule.api.getWorkspaceAgents>(),
    getAgentRoles: vi.fn<typeof apiModule.api.getAgentRoles>(),
    getWorkspaceAgentEffectiveCap: vi.fn<typeof apiModule.api.getWorkspaceAgentEffectiveCap>(),
    explainAuthorization: vi.fn<typeof apiModule.api.explainAuthorization>(),
}));

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return { ...actual, api: { ...actual.api, ...mocks } };
});

// ---------------- fixtures ----------------
function roleAtom(
    actionClass: string,
    grantId = `grant-${actionClass}`,
): apiModule.PermissionAtomView {
    return {
        actionClass,
        resource: "*",
        sources: [
            { source: "role", roleName: null, scopeType: "instance", scopeId: null, grantId },
        ],
    };
}

const SELF: apiModule.SelfPermissionsView = {
    userId: "user-1",
    instanceCapabilities: [],
    instancePermissions: [
        roleAtom("CREATE_ACCOUNT", "grant-a"),
        roleAtom("MANAGE_ROLES", "grant-b"),
    ],
    workspaces: [
        {
            workspaceId: "ws-1",
            workspaceRole: "OWNER",
            permissions: [
                {
                    actionClass: "read",
                    resource: "*",
                    sources: [
                        {
                            source: "role",
                            roleName: "OWNER",
                            scopeType: "workspace",
                            scopeId: "ws-1",
                            grantId: "grant-ws1",
                        },
                    ],
                },
            ],
        },
        { workspaceId: "ws-2", workspaceRole: "MEMBER", permissions: [] },
    ],
};

const CAP: apiModule.WorkspaceAgentEffectiveCap = {
    principalId: "p-1",
    workspaceId: "ws-1",
    effectiveCap: [{ actionClass: "read", resource: "*" }],
    capSource: { binding: "binding-snapshot" },
    provenance: { principalGrantIds: ["pg-1", "pg-2"], bindingGrantIds: [] },
    defaultGrants: { readFace: ["workspace-member"] },
    bound: true,
};

const ROLE_BINDING: apiModule.AgentRoleBinding = {
    bindingId: "190cfd7e-30de-45b4-85fd-37bb3e3a3b8f",
    roleId: "00000000-0000-0000-0000-000000000008",
    name: "AGENT_USER",
    displayName: "Agent User (default)",
    scopeType: "instance",
    scopeId: null,
    scopeName: null,
    isSystem: true,
    grantedBy: null,
    atomSummary: ["read"],
    atomCount: 1,
    atomsTruncated: false,
};

const AGENT: apiModule.WorkspaceAgentBinding = {
    principalId: "p-1",
    name: "曦和助手",
    templateId: null,
    templateName: null,
    createdAt: "2026-11-20T00:00:00Z",
    permissionsSnapshot: [{ actionClass: "read", resource: "*" }],
    capSource: "explicit",
    bound: true,
    disabled: false,
};

const USER_BINDINGS: apiModule.ApiBindingSet = {
    scopeType: "instance",
    scopeId: null,
    bindings: [
        {
            id: "b-1",
            subjectType: "USER",
            subjectId: "user-12345678",
            roleId: "role-1",
            roleName: "INSTANCE_ADMIN",
            grantedBy: null,
            grantedAt: null,
        },
    ],
};

let router: Router;
let wrapper: VueWrapper | null = null;

async function mountView(): Promise<VueWrapper> {
    router = createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: "/", component: { template: "<div/>" } },
            { path: "/settings/roles", component: { template: "<div/>" } },
            { path: "/resources/credentials", component: { template: "<div/>" } },
        ],
    });
    await router.push("/");
    await router.isReady();
    wrapper = mount(AuthorizationOverviewView, {
        global: { plugins: [i18n, router] },
    });
    await flushPromises();
    await flushPromises();
    return wrapper;
}

beforeEach(() => {
    mocks.getSelfPermissions.mockResolvedValue(SELF);
    mocks.getBindings.mockResolvedValue(USER_BINDINGS);
    mocks.getWorkspaceAgents.mockResolvedValue([AGENT]);
    mocks.getAgentRoles.mockResolvedValue([ROLE_BINDING]);
    mocks.getWorkspaceAgentEffectiveCap.mockResolvedValue(CAP);
    mocks.explainAuthorization.mockResolvedValue({
        allowed: true,
        matchedGrantRefs: [
            {
                level: "instance",
                levelLabel: "实例",
                actionClass: "read",
                resource: "*",
                grantId: "grant-a",
                grantSource: "role",
            },
        ],
        evaluatedLevels: [{ level: "instance", label: "实例", atomCount: 42, matched: 1 }],
    });
});

afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.clearAllMocks();
});

// ---------------- ① 我的生效授权 ----------------
describe("我的生效授权按来源分组", () => {
    it("instance 与 workspace 两处的来源行都进对应组，并显示 grant id", async () => {
        const w = await mountView();
        const roleGroup = w.get('[data-testid="authorization-source-role"]');
        // 2 条 instance atom + 1 条 workspace atom
        expect(roleGroup.findAll('[data-testid="authorization-atom-row"]')).toHaveLength(3);
        expect(roleGroup.findAll('[data-testid="authorization-atom-grant-id"]').length).toBe(3);
    });

    it("没有来源行时渲染该来源空态，而不是加载中", async () => {
        const w = await mountView();
        const empty = w.get('[data-testid="authorization-source-credential_binding-empty"]');
        expect(empty.text().length).toBeGreaterThan(0);
        expect(w.find('[data-testid="authorization-self-loading"]').exists()).toBe(false);
        // 空态组里不许有 atom 行（缺口不许被渲染成数据）
        expect(
            w
                .get('[data-testid="authorization-source-credential_binding"]')
                .findAll('[data-testid="authorization-atom-row"]'),
        ).toHaveLength(0);
    });

    it("投影缺 sources 字段（旧 fixture）时不算任何来源，也不崩", async () => {
        mocks.getSelfPermissions.mockResolvedValue({
            userId: "user-1",
            instanceCapabilities: [],
            instancePermissions: [{ actionClass: "CREATE_ACCOUNT", resource: "*" }],
        });
        const w = await mountView();
        for (const source of ["role", "credential_binding", "agent_default", "plugin_binding"]) {
            expect(
                w
                    .get(`[data-testid="authorization-source-${source}"]`)
                    .findAll('[data-testid="authorization-atom-row"]'),
            ).toHaveLength(0);
        }
        expect(w.findAll('[data-testid="authorization-atom-row"]')).toHaveLength(0);
    });

    it("分页是 20 条硬上限：第 21 条不渲染，翻页后才出现", async () => {
        mocks.getSelfPermissions.mockResolvedValue({
            userId: "user-1",
            instanceCapabilities: [],
            // 补零是刻意的：表格按 actionClass 字典序排，不补零时 ATOM_2 会排到 ATOM_10 之后，
            // 第 21 条到底是哪条就不可预期 —— 那样钉的就不是「20 条上限」而是排序实现。
            instancePermissions: Array.from({ length: 25 }, (_, index) =>
                roleAtom(`ATOM_${String(index).padStart(2, "0")}`),
            ),
        });
        const w = await mountView();
        const rows = w.findAll('[data-testid="authorization-atom-row"]');
        expect(rows).toHaveLength(20);
        const html = w.html();
        expect(html).not.toContain("ATOM_24");
        // 分页器存在且显示 1 / 2
        expect(w.get('[data-testid="authorization-source-role-pager"]').text()).toContain("1 / 2");
        await w.get('[data-testid="authorization-source-role-next"]').trigger("click");
        await flushPromises();
        expect(w.findAll('[data-testid="authorization-atom-row"]')).toHaveLength(5);
        expect(w.html()).toContain("ATOM_24");
        expect(w.html()).not.toContain("ATOM_00");
    });
});

// ---------------- ② 六来源读面表 ----------------
describe("六来源读面表三档", () => {
    it("六个来源逐行都在，且只有有入口的给链接", async () => {
        const w = await mountView();
        for (const source of [
            "role",
            "credential_binding",
            "agent_default",
            "plugin_binding",
            "spawn",
            "template",
        ]) {
            expect(w.find(`[data-testid="authorization-readface-${source}"]`).exists()).toBe(true);
        }
        // role → 角色页，credential_binding → 凭据页；其余不给假链接
        const links = w.findAll('[data-testid="authorization-readface-link"]');
        expect(links).toHaveLength(2);
        expect(links.map((link) => link.attributes("href"))).toEqual([
            "/settings/roles",
            "/resources/credentials",
        ]);
    });

    it("无读面的来源（spawn / template）不渲染任何计数或推断数据", async () => {
        const w = await mountView();
        for (const source of ["spawn", "template"]) {
            const row = w.get(`[data-testid="authorization-readface-${source}"]`);
            expect(row.text()).toContain(source);
            expect(row.find('[data-testid="authorization-source-count"]').exists()).toBe(false);
            expect(row.find('[data-testid="authorization-atom-row"]').exists()).toBe(false);
        }
        // 口径句与「不展示推断数据」都在
        expect(
            w.get('[data-testid="authorization-overview-scope-note"]').text().length,
        ).toBeGreaterThan(0);
        expect(
            w.get('[data-testid="authorization-readface-no-inference"]').text().length,
        ).toBeGreaterThan(0);
    });
});

// ---------------- ③ 按主体 ----------------
describe("按主体（读面能到的部分）", () => {
    it("默认选中第一个工作区并拉工作区智能体列表", async () => {
        const w = await mountView();
        expect(mocks.getWorkspaceAgents).toHaveBeenCalledWith("ws-1");
        const row = w.get('[data-testid="authorization-subject-agent-p-1"]');
        expect(row.text()).toContain("曦和助手");
    });

    it("点主体后同时拉角色与 effective-cap，并写清 cap 只给 grant id", async () => {
        const w = await mountView();
        await w.get('[data-testid="authorization-subject-agent-p-1"]').trigger("click");
        await flushPromises();
        expect(mocks.getAgentRoles).toHaveBeenCalledWith("ws-1", "p-1");
        expect(mocks.getWorkspaceAgentEffectiveCap).toHaveBeenCalledWith("ws-1", "p-1");
        expect(w.findAll('[data-testid="authorization-subject-role-row"]')).toHaveLength(1);
        const note = w.get('[data-testid="authorization-subject-cap-note"]').text();
        // 命中来源要翻成短标签：真栈上这里原先直接把 wire 枚举 binding-snapshot 塞进中文句子。
        expect(note).toContain("绑定快照");
        expect(note).not.toContain("binding-snapshot");
        await w.get('[data-testid="authorization-workspace-tab-ws-2"]').trigger("click");
        await flushPromises();
        expect(mocks.getWorkspaceAgents).toHaveBeenCalledWith("ws-2");
    });

    it("主体行的 cap 模式用列表字段枚举翻标签，未知取值原样显示（不出现裸 i18n key）", async () => {
        const w = await mountView();
        // 列表字段是 WorkspaceAgentBinding.capSource（baseline / explicit），
        // 与 effective-cap 的 capSource.binding 是两个枚举；混用会把裸 key 渲染到页面上。
        expect(w.get('[data-testid="authorization-subject-cap-mode"]').text()).toBe("显式冻结");
        mocks.getWorkspaceAgents.mockResolvedValue([
            { ...AGENT, capSource: "mystery-mode" } as apiModule.WorkspaceAgentBinding,
        ]);
        await w.get('[data-testid="authorization-workspace-tab-ws-2"]').trigger("click");
        await flushPromises();
        const text = w.get('[data-testid="authorization-subject-cap-mode"]').text();
        expect(text).toBe("mystery-mode");
        expect(text).not.toContain("settings.");
    });

    it("cap 403 与角色成功互不连坐：cap 显式不可用，角色照常渲染", async () => {
        mocks.getWorkspaceAgentEffectiveCap.mockRejectedValue(
            new ApiError({
                status: 403,
                code: "FORBIDDEN",
                detail: "Agent principal holds no role binding for this Workspace",
                requestId: "req-cap-403",
            }),
        );
        const w = await mountView();
        await w.get('[data-testid="authorization-subject-agent-p-1"]').trigger("click");
        await flushPromises();
        expect(w.find('[data-testid="authorization-subject-cap-error"]').exists()).toBe(true);
        expect(w.findAll('[data-testid="authorization-subject-role-row"]')).toHaveLength(1);
    });

    it("user 主体绑定 200 时列真数据", async () => {
        const w = await mountView();
        expect(mocks.getBindings).toHaveBeenCalledWith("instance");
        const rows = w.findAll('[data-testid="authorization-user-binding-row"]');
        expect(rows).toHaveLength(1);
        expect(rows[0].text()).toContain("INSTANCE_ADMIN");
        expect(w.find('[data-testid="authorization-user-bindings-denied"]').exists()).toBe(false);
    });

    it("user 主体绑定也按 20/页：25 条首屏 20 行、翻页后 5 行", async () => {
        mocks.getBindings.mockResolvedValue({
            scopeType: "instance",
            scopeId: null,
            bindings: Array.from({ length: 25 }, (_, i) => ({
                id: `b-${i}`,
                subjectType: "USER",
                subjectId: `user-${String(i).padStart(8, "0")}`,
                roleId: "role-1",
                roleName: `ROLE_${String(i).padStart(2, "0")}`,
                grantedBy: null,
                grantedAt: null,
            })),
        });
        const w = await mountView();
        // 真栈这一栈实测 476 条：不分页会把整张表塞进 DOM。
        expect(w.findAll('[data-testid="authorization-user-binding-row"]')).toHaveLength(20);
        expect(w.get('[data-testid="authorization-user-bindings-pager"]').text()).toContain(
            "1 / 2",
        );
        await w.get('[data-testid="authorization-user-bindings-next"]').trigger("click");
        await flushPromises();
        expect(w.findAll('[data-testid="authorization-user-binding-row"]')).toHaveLength(5);
        expect(w.get('[data-testid="authorization-user-bindings-pager"]').text()).toContain(
            "2 / 2",
        );
    });

    it("user 主体绑定 403 时渲染「无 MANAGE_ROLES」+ 响应体原文，且不渲染空态", async () => {
        mocks.getBindings.mockRejectedValue(
            new ApiError({
                status: 403,
                code: "FORBIDDEN",
                detail: "Missing authority: MANAGE_ROLES",
                requestId: "req-bindings-403",
            }),
        );
        const w = await mountView();
        const denied = w.get('[data-testid="authorization-user-bindings-denied"]');
        expect(denied.text().length).toBeGreaterThan(0);
        // 原子名只从响应体取（原文逐字），不自编
        expect(w.get('[data-testid="authorization-user-bindings-denied-atom"]').text()).toBe(
            "Missing authority: MANAGE_ROLES",
        );
        expect(w.find('[data-testid="authorization-user-bindings-empty"]').exists()).toBe(false);
        expect(w.findAll('[data-testid="authorization-user-binding-row"]')).toHaveLength(0);
    });
});

// ---------------- ④ 以当前身份查询 ----------------
describe("以当前身份查询（explain）", () => {
    it("请求体只有 actionClass 与 resource，不含任何主体参数", async () => {
        const w = await mountView();
        await w.get('[data-testid="authorization-explain-action-class"]').setValue("read");
        await w.get('[data-testid="authorization-explain-resource"]').setValue("*");
        await w.get('[data-testid="authorization-explain-submit"]').trigger("submit");
        await flushPromises();
        expect(mocks.explainAuthorization).toHaveBeenCalledTimes(1);
        const [actionClass, resource] = mocks.explainAuthorization.mock.calls[0];
        expect(actionClass).toBe("read");
        expect(resource).toBe("*");
        // 视图层没有任何主体入参（api.explainAuthorization 的签名只有两个参数）
        expect(mocks.explainAuthorization.mock.calls[0]).toHaveLength(2);
    });

    it("actionClass 为空时不发请求，并给出必填提示", async () => {
        const w = await mountView();
        await w.get('[data-testid="authorization-explain-submit"]').trigger("submit");
        await flushPromises();
        expect(mocks.explainAuthorization).not.toHaveBeenCalled();
        expect(w.find('[data-testid="authorization-explain-invalid"]').exists()).toBe(true);
    });

    it("允许态渲染 matched grant 与分层求值", async () => {
        const w = await mountView();
        await w.get('[data-testid="authorization-explain-action-class"]').setValue("read");
        await w.get('[data-testid="authorization-explain-submit"]').trigger("submit");
        await flushPromises();
        expect(w.find('[data-testid="authorization-explain-result"]').exists()).toBe(true);
        expect(w.findAll('[data-testid="authorization-explain-matched-row"]')).toHaveLength(1);
        expect(w.findAll('[data-testid="authorization-explain-level-row"]')).toHaveLength(1);
        expect(w.find('[data-testid="authorization-explain-missing-atom"]').exists()).toBe(false);
    });

    it("拒绝态渲染最深缺失层与缺失原子", async () => {
        mocks.explainAuthorization.mockResolvedValue({
            allowed: false,
            deepestMissingLevel: "workspace",
            missingAtom: {
                level: "workspace",
                levelLabel: "工作区",
                actionClass: "write",
                resource: "workspace:*",
                reason: "no matching grant",
            },
            missingLevels: [],
            matchedGrantRefs: [],
            evaluatedLevels: [{ level: "instance", label: "实例", atomCount: 42, matched: 0 }],
        });
        const w = await mountView();
        await w.get('[data-testid="authorization-explain-action-class"]').setValue("write");
        await w.get('[data-testid="authorization-explain-submit"]').trigger("submit");
        await flushPromises();
        expect(w.get('[data-testid="authorization-explain-deepest-level"]').text()).toBe(
            "workspace",
        );
        expect(w.get('[data-testid="authorization-explain-missing-atom"]').text()).toContain(
            "write",
        );
        expect(w.find('[data-testid="authorization-explain-matched-empty"]').exists()).toBe(true);
    });
});
