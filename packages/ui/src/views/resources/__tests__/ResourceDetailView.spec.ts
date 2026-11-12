import { createPinia, setActivePinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ResourceDetailView from "../ResourceDetailView.vue";

/**
 * task-228：详情页**四态 + 数据接线**（组件级）。
 *
 * <p>判据纪律：每条状态都断言"看得见的那句话的键 + 关键 DOM"，而不是只断言"没崩"；
 * 未接线态必须**不调**该资源没有的读面（用 mock 调用次数当负数判据）。</p>
 *
 * <p>task-254：凭据的 USER/WORKSPACE 读面改走 `useCredentialsStore().load()`（"缺工作区上下文
 * 就不请求"的守卫只有 `store.load` 一处），所以本 spec 需要 active Pinia；`api` 仍走本文件的
 * `vi.mock("../../../composables/api")`，store 也从同一路径 import ⇒ mock 对 store 同样生效。</p>
 */
const { apiMock, instanceMock, routeMock, routerMock, workspaceMock, pushMock, backMock } =
    vi.hoisted(() => ({
        apiMock: {
            listCredentials: vi.fn<(params: unknown) => Promise<unknown>>(),
            getCredentialReferences: vi.fn<(id: string) => Promise<unknown>>(),
            getCredentialEvents: vi.fn<(id: string) => Promise<unknown>>(),
            getWorkspaceSkills: vi.fn<(id: string) => Promise<unknown>>(),
            getSkillDefinition: vi.fn<(id: string, body?: boolean) => Promise<unknown>>(),
            listMyAgentPrincipals: vi.fn<() => Promise<unknown>>(),
            getWorkspaceAgents: vi.fn<(id: string) => Promise<unknown>>(),
            getAgentRoles: vi.fn<(ws: string, pid: string) => Promise<unknown>>(),
            getAgentSkills: vi.fn<(ws: string, pid: string) => Promise<unknown>>(),
            getStdioServers: vi.fn<(ws: string) => Promise<unknown>>(),
            getMcpServerStatus: vi.fn<(ws: string) => Promise<unknown>>(),
            getHealth: vi.fn<() => Promise<unknown>>(),
        },
        instanceMock: {
            listInstanceCredentials: vi.fn<() => Promise<unknown>>(),
            listInstanceAgents: vi.fn<() => Promise<unknown>>(),
            listInstanceMcpServers: vi.fn<() => Promise<unknown>>(),
        },
        routeMock: {
            meta: { resourceId: "credentials" } as Record<string, unknown>,
            query: {} as Record<string, unknown>,
            params: { pk: "cred-1" } as Record<string, unknown>,
            fullPath: "/resources/credentials/cred-1?layer=USER",
        },
        routerMock: {} as {
            push: unknown;
            back: unknown;
            options: { history: { state: { back: unknown } } };
        },
        workspaceMock: { readTabWorkspaceId: vi.fn<() => string | null>() },
        pushMock: vi.fn<(location: unknown) => Promise<void>>(),
        backMock: vi.fn<() => void>(),
    }));

vi.mock("../../../composables/api", () => ({ api: apiMock }));
vi.mock("../../../services/instanceResources", () => instanceMock);
vi.mock("../../../lib/logger", () => ({
    logger: { error: vi.fn<(message: string) => void>(), warn: vi.fn<(message: string) => void>() },
}));
vi.mock("../../../lib/workspaceContext", () => ({
    readTabWorkspaceId: workspaceMock.readTabWorkspaceId,
}));
vi.mock("vue-router", () => ({
    useRoute: () => routeMock,
    useRouter: () => routerMock,
}));
// 用**真 locale** 而不是键回显：仓库的挂载兜底断言会抓"渲染出裸 i18n 键"
// （`src/test-utils/i18nKeys.ts`），键回显会让新 spec 进欠账台账 —— 那是把债当交付。
import { i18n } from "../../../i18n";

routerMock.push = pushMock;
routerMock.back = backMock;
routerMock.options = { history: { state: { back: null as unknown } } };

function mountView() {
    return mount(ResourceDetailView, {
        global: {
            plugins: [i18n],
            stubs: {
                RouterLink: { template: "<a><slot /></a>" },
                Button: { template: "<button><slot /></button>" },
            },
        },
    });
}

function setRoute(input: {
    resourceId: string;
    layer?: string;
    pk: string;
    workspace?: string | null;
}) {
    routeMock.meta = { resourceId: input.resourceId };
    routeMock.query = input.layer ? { layer: input.layer } : {};
    routeMock.params = { pk: input.pk };
    routeMock.fullPath = `/resources/${input.resourceId}/${input.pk}?layer=${input.layer ?? ""}`;
    workspaceMock.readTabWorkspaceId.mockReturnValue(input.workspace ?? null);
}

const credentialRow = {
    id: "cred-1",
    label: "部署令牌",
    kind: "token",
    deliveryTier: "reveal",
    ownerType: "USER",
    ownerId: "mock-user",
    status: "active",
    fingerprint: "fp:abcd",
    revision: 2,
    createdAt: "2026-11-01T00:00:00Z",
    replacedAt: null,
    referenceCount: 1,
};

beforeEach(() => {
    vi.clearAllMocks();
    // task-254：凭据读面走 store ⇒ 每个用例都要一个新的 active Pinia（store 是单例，跨用例复用
    // 会把上一个用例的 `credentials`/`error`/`scopeMissing` 带进来）。
    setActivePinia(createPinia());
    routeMock.meta = { resourceId: "credentials" };
    routeMock.query = {};
    routeMock.params = { pk: "cred-1" };
    routeMock.fullPath = "/resources/credentials/cred-1?layer=USER";
    routerMock.options = { history: { state: { back: null as unknown } } };
    workspaceMock.readTabWorkspaceId.mockReturnValue(null);
});

describe("ResourceDetailView — 凭据（USER/WORKSPACE/INSTANCE）", () => {
    it("四态之「正常」：元数据 + 引用 + 审计事件都来自已接线读面", async () => {
        setRoute({ resourceId: "credentials", layer: "USER", pk: "cred-1" });
        apiMock.listCredentials.mockResolvedValue({ credentials: [credentialRow], count: 1 });
        apiMock.getCredentialReferences.mockResolvedValue({
            references: [
                {
                    source: "grant",
                    subjectType: "agent",
                    subjectId: "principal-1",
                    actionClass: "credential_use",
                    resource: "*",
                },
            ],
        });
        apiMock.getCredentialEvents.mockResolvedValue({
            events: [
                {
                    id: "ev-1",
                    eventType: "REVEALED",
                    actor: "mock-user",
                    createdAt: "2026-11-02T00:00:00Z",
                },
            ],
        });

        const wrapper = mountView();
        await flushPromises();

        expect(wrapper.get('[data-testid="resource-detail-title"]').text()).toBe("部署令牌");
        expect(wrapper.get('[data-testid="resource-detail-layer"]').text()).toBe("我的凭据");
        expect(wrapper.get('[data-testid="resource-detail-fields"]').text()).toContain("指纹");
        // 引用与审计是两条独立读面，各自的区块都要出现。
        expect(wrapper.get('[data-testid="resource-detail-section-references"]').text()).toContain(
            "principal-1",
        );
        expect(wrapper.get('[data-testid="resource-detail-section-events"]').text()).toContain(
            "REVEALED",
        );
        // task-254：读面改走 `store.load("USER", undefined)` ⇒ 调用参数不再带显式
        // `ownerId: undefined`（store 只在有值时才展开）。**HTTP wire 没变**：`ownerId` 无论
        // 显式 undefined 还是缺键，axios 都不发这个参数 ⇒ 仍是 `?ownerType=USER`。
        expect(apiMock.listCredentials).toHaveBeenCalledWith({ ownerType: "USER" });
        expect(apiMock.listCredentials.mock.calls[0]?.[0]).not.toHaveProperty("ownerId");
    });

    it("四态之「404」：读面成功但 pk 不在该层 ⇒ not-found（不是未接线、不是错误）", async () => {
        setRoute({ resourceId: "credentials", layer: "USER", pk: "gone" });
        apiMock.listCredentials.mockResolvedValue({ credentials: [credentialRow], count: 1 });

        const wrapper = mountView();
        await flushPromises();

        expect(wrapper.find('[data-testid="resource-detail-not-found"]').exists()).toBe(true);
        expect(wrapper.get('[data-testid="resource-detail-not-found"]').text()).toContain(
            "找不到这条资源",
        );
        // 404 态不该继续打引用/审计读面（省两发无意义请求）。
        expect(apiMock.getCredentialReferences).not.toHaveBeenCalled();
    });

    it("实例层走 /instance/credentials，且**如实写明**没有引用/审计读面", async () => {
        setRoute({ resourceId: "credentials", layer: "INSTANCE", pk: "ic-1" });
        instanceMock.listInstanceCredentials.mockResolvedValue({
            credentials: [
                {
                    id: "ic-1",
                    label: "平台令牌",
                    kind: "token",
                    deliveryTier: "lease",
                    status: "active",
                    fingerprint: "fp:inst",
                    revision: 1,
                    createdAt: null,
                    replacedAt: null,
                    referenceCount: 0,
                },
            ],
        });

        const wrapper = mountView();
        await flushPromises();

        expect(wrapper.get('[data-testid="resource-detail-body"]').text()).toContain("平台令牌");
        expect(wrapper.get('[data-testid="resource-detail-note"]').text()).toContain(
            "实例层凭据没有引用/审计读面",
        );
        expect(apiMock.listCredentials).not.toHaveBeenCalled();
        expect(apiMock.getCredentialReferences).not.toHaveBeenCalled();
        // task-254：实例层分支一行未动 —— 仍然只打 `/instance/credentials` 那一条读面。
        expect(instanceMock.listInstanceCredentials).toHaveBeenCalledTimes(1);
    });
});

describe("ResourceDetailView — task-254：WORKSPACE 缺上下文就不请求（复用 store 守卫）", () => {
    it("无 workspaceId ⇒ 一个列表请求都不发，走既有 unwired 诚实块（不是「0 条」）", async () => {
        setRoute({
            resourceId: "credentials",
            layer: "WORKSPACE",
            pk: "ws-cred-1",
            workspace: null,
        });
        const wrapper = mountView();
        await flushPromises();

        // ④ 失败面「发了不该发的请求」：缺 ownerId 的 WORKSPACE 列表请求在 CP 侧恒 403，
        // 静默退化成无参更坏（会把工作区凭据读成个人凭据）。
        expect(apiMock.listCredentials).not.toHaveBeenCalled();
        expect(apiMock.getCredentialReferences).not.toHaveBeenCalled();
        expect(apiMock.getCredentialEvents).not.toHaveBeenCalled();
        // 诚实块：复用 detail 页既有的 unwired 形态与既有 i18n 键（不新增 testid / 文案）。
        expect(wrapper.get('[data-testid="resource-detail-unwired"]').text()).toContain(
            "没有工作区上下文",
        );
        // ⑤ 失败面「把未知读成没有」：不渲染任何"0 条"叙述，也不渲染引用区块的空态句。
        expect(wrapper.text()).not.toContain("0 条");
        expect(wrapper.find('[data-testid="resource-detail-section-references"]').exists()).toBe(
            false,
        );
        // ⑥ 失败面「假装有数据」：phase !== ready 时不得渲染 ready 壳（标题/字段/正文）。
        expect(wrapper.find('[data-testid="resource-detail-body"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="resource-detail-title"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="resource-detail-fields"]').exists()).toBe(false);
    });

    it("有 workspaceId ⇒ 仍发双参（ownerId 真的在参数里）并进入 ready", async () => {
        setRoute({
            resourceId: "credentials",
            layer: "WORKSPACE",
            pk: "ws-cred-1",
            workspace: "ws-1",
        });
        apiMock.listCredentials.mockResolvedValue({
            credentials: [
                { ...credentialRow, id: "ws-cred-1", ownerType: "WORKSPACE", ownerId: "ws-1" },
            ],
            count: 1,
        });
        apiMock.getCredentialReferences.mockResolvedValue({ references: [] });
        apiMock.getCredentialEvents.mockResolvedValue({ events: [] });

        const wrapper = mountView();
        await flushPromises();

        const call = apiMock.listCredentials.mock.calls[0]?.[0] as {
            ownerType?: string;
            ownerId?: string;
        };
        expect(call.ownerType).toBe("WORKSPACE");
        // 「URL 含 ownerId」的组件级等价断言：参数里带了工作区 id（axios 会把它发成 `?ownerId=`）。
        expect(call.ownerId).toBe("ws-1");
        expect(wrapper.get('[data-testid="resource-detail-title"]').text()).toBe("部署令牌");
        expect(wrapper.find('[data-testid="resource-detail-unwired"]').exists()).toBe(false);
        expect(apiMock.getCredentialReferences).toHaveBeenCalledWith("ws-cred-1");
    });
});

describe("ResourceDetailView — 技能/知识库（未接线诚实态）", () => {
    it("技能个人层走单条定义读面（T2b.3：不再是未接线态）", async () => {
        setRoute({ resourceId: "skills", layer: "USER", pk: "skill-1" });
        apiMock.getSkillDefinition.mockResolvedValue({
            skillId: "skill-1",
            name: "我的私有技能",
            definitionScope: { type: "user", workspaceId: null },
            description: "只属于我",
            bodyTokensEst: 12,
            oversize: false,
            trusted: false,
            sourcePath: "skills/mine/SKILL.md",
            contentHash: "hash-mine",
            version: 1,
            attachments: [],
            updatedAt: "2026-11-12T00:00:00Z",
            body: "# 私有\n\n只有我能读…",
        });
        const wrapper = mountView();
        await flushPromises();

        // 个人层用**同一张**单条读面（CP 只返回调用者自己的行，`openapi.yaml:5465`）⇒
        // 既不是"未接线"，也不需要 `getWorkspaceSkills`（那是工作区层的事）。
        expect(apiMock.getSkillDefinition).toHaveBeenCalledWith("skill-1", true);
        expect(apiMock.getWorkspaceSkills).not.toHaveBeenCalled();
        expect(wrapper.find('[data-testid="resource-detail-unwired"]').exists()).toBe(false);
        expect(wrapper.get('[data-testid="resource-detail-title"]').text()).toBe("我的私有技能");
        expect(wrapper.get('[data-testid="resource-detail-layer"]').text()).toBe("我的技能");
    });

    it("技能个人层读不到（404）⇒ not-found，而不是未接线", async () => {
        setRoute({ resourceId: "skills", layer: "USER", pk: "missing" });
        apiMock.getSkillDefinition.mockResolvedValue(null);
        const wrapper = mountView();
        await flushPromises();

        expect(wrapper.find('[data-testid="resource-detail-not-found"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="resource-detail-unwired"]').exists()).toBe(false);
    });

    it("技能实例层走单条定义读面（含正文）", async () => {
        setRoute({ resourceId: "skills", layer: "INSTANCE", pk: "skill-1" });
        apiMock.getSkillDefinition.mockResolvedValue({
            skillId: "skill-1",
            name: "部署技能",
            definitionScope: { type: "instance", workspaceId: null },
            description: "一键部署",
            bodyTokensEst: 42,
            oversize: false,
            trusted: true,
            sourcePath: "skills/deploy/SKILL.md",
            contentHash: "hash-1",
            version: 3,
            attachments: [],
            updatedAt: "2026-11-03T00:00:00Z",
            body: "# 部署\n\n步骤…",
        });

        const wrapper = mountView();
        await flushPromises();

        expect(wrapper.get('[data-testid="resource-detail-title"]').text()).toBe("部署技能");
        expect(wrapper.get('[data-testid="resource-detail-block"]').text()).toContain("步骤");
        expect(apiMock.getSkillDefinition).toHaveBeenCalledWith("skill-1", true);
        expect(apiMock.getSkillDefinition).toHaveBeenCalledTimes(1);
    });

    it("工作区层缺工作区上下文 ⇒ 未接线（说明是「没有上下文」，不是产品缺口）", async () => {
        setRoute({ resourceId: "skills", layer: "WORKSPACE", pk: "skill-1" });
        const wrapper = mountView();
        await flushPromises();

        expect(wrapper.get('[data-testid="resource-detail-unwired"]').text()).toContain(
            "没有工作区上下文",
        );
        expect(apiMock.getWorkspaceSkills).not.toHaveBeenCalled();
    });

    it("知识库（0 层 + G3）⇒ 不放行详情，一个字的数据请求都不发", async () => {
        setRoute({ resourceId: "knowledge", layer: "WORKSPACE", pk: "kb-1" });
        const wrapper = mountView();
        await flushPromises();

        expect(wrapper.get('[data-testid="resource-detail-unwired"]').text()).toContain(
            "知识库没有实体",
        );
        expect(apiMock.listCredentials).not.toHaveBeenCalled();
        expect(apiMock.getWorkspaceSkills).not.toHaveBeenCalled();
        expect(apiMock.listMyAgentPrincipals).not.toHaveBeenCalled();
    });
});

describe("ResourceDetailView — 智能体（三层）与 MCP", () => {
    it("agents 的 WORKSPACE 层能进（宿主 = 工作区绑定读面），带角色/技能绑定区块", async () => {
        setRoute({
            resourceId: "agents",
            layer: "WORKSPACE",
            pk: "principal-1",
            workspace: "ws-1",
        });
        apiMock.getWorkspaceAgents.mockResolvedValue([
            {
                principalId: "principal-1",
                name: "评审主体",
                templateId: null,
                templateName: "评审模板",
                createdAt: "2026-11-01T00:00:00Z",
                permissionsSnapshot: [],
                bound: true,
                disabled: false,
                defaultModelProvider: null,
                defaultModelName: null,
            },
        ]);
        apiMock.getAgentRoles.mockResolvedValue([
            {
                bindingId: "rb-1",
                roleId: "role-1",
                name: "审查员",
                displayName: "审查员",
                scopeType: "workspace",
                scopeId: "ws-1",
                scopeName: "工作区",
                isSystem: false,
                grantedBy: null,
                atomSummary: [],
                atomCount: 2,
                atomsTruncated: false,
            },
        ]);
        apiMock.getAgentSkills.mockResolvedValue([
            {
                bindingId: "sb-1",
                skillId: "skill-1",
                name: "部署技能",
                description: null,
                sourceType: "instance",
                sourceName: null,
                scopeType: "workspace",
                scopeId: "ws-1",
                activatedAt: null,
                boundAt: null,
            },
        ]);

        const wrapper = mountView();
        await flushPromises();

        expect(wrapper.get('[data-testid="resource-detail-title"]').text()).toBe("评审主体");
        expect(wrapper.get('[data-testid="resource-detail-section-roles"]').text()).toContain(
            "审查员",
        );
        expect(wrapper.get('[data-testid="resource-detail-section-skills"]').text()).toContain(
            "部署技能",
        );
        expect(apiMock.getWorkspaceAgents).toHaveBeenCalledWith("ws-1");
        expect(apiMock.getAgentRoles).toHaveBeenCalledWith("ws-1", "principal-1");
    });

    it("MCP 工作区层：配置来自 stdio-servers、运行状态来自 mcp/servers", async () => {
        setRoute({ resourceId: "mcp", layer: "WORKSPACE", pk: "fs-server", workspace: "ws-1" });
        apiMock.getStdioServers.mockResolvedValue({
            generation: 1,
            hash: "h-1",
            servers: { "fs-server": { command: "npx", args: ["-y", "fs-mcp"] } },
        });
        apiMock.getMcpServerStatus.mockResolvedValue({
            servers: [
                {
                    serverId: "fs-server",
                    state: "ready",
                    attempt: 1,
                    lastError: null,
                    sinceMs: 1_760_000_000_000,
                    epoch: 2,
                },
            ],
            count: 1,
        });

        const wrapper = mountView();
        await flushPromises();

        expect(wrapper.get('[data-testid="resource-detail-title"]').text()).toBe("fs-server");
        expect(wrapper.get('[data-testid="resource-detail-fields"]').text()).toContain("ready");
        expect(wrapper.get('[data-testid="resource-detail-block"]').text()).toContain("npx");
    });

    it("MCP 工作区层两个读面都没有该 pk ⇒ 404", async () => {
        setRoute({ resourceId: "mcp", layer: "WORKSPACE", pk: "missing", workspace: "ws-1" });
        apiMock.getStdioServers.mockResolvedValue({ servers: {} });
        apiMock.getMcpServerStatus.mockResolvedValue({ servers: [], count: 0 });

        const wrapper = mountView();
        await flushPromises();

        expect(wrapper.find('[data-testid="resource-detail-not-found"]').exists()).toBe(true);
    });
});

describe("ResourceDetailView — 错误态与返回栈", () => {
    it("读面失败 ⇒ 错误态 + getHealth 诊断（区分后端不健康与单条读不到）", async () => {
        setRoute({ resourceId: "credentials", layer: "USER", pk: "cred-1" });
        apiMock.listCredentials.mockRejectedValue(new Error("boom"));
        apiMock.getHealth.mockResolvedValue({ status: "DOWN" });

        const wrapper = mountView();
        await flushPromises();

        expect(wrapper.get('[data-testid="resource-detail-error"]').text()).toContain(
            "读取详情失败",
        );
        expect(wrapper.get('[data-testid="resource-detail-error-message"]').text()).toBe("boom");
        expect(wrapper.get('[data-testid="resource-detail-health"]').text()).toContain("DOWN");
        expect(apiMock.getHealth).toHaveBeenCalledTimes(1);
    });

    it("无应用内历史 ⇒ 返回列表（回落到当前层）", async () => {
        setRoute({ resourceId: "skills", layer: "WORKSPACE", pk: "skill-1", workspace: "ws-1" });
        apiMock.getWorkspaceSkills.mockResolvedValue([
            { skillId: "skill-1", name: "部署技能", definitionScope: { type: "workspace" } },
        ]);
        const wrapper = mountView();
        await flushPromises();

        await wrapper.get('[data-testid="resource-detail-back"]').trigger("click");
        expect(backMock).not.toHaveBeenCalled();
        expect(pushMock).toHaveBeenCalledWith("/resources/skills?layer=WORKSPACE");
    });

    it("有应用内历史 ⇒ 后退优先（不 push 列表页）", async () => {
        setRoute({ resourceId: "skills", layer: "WORKSPACE", pk: "skill-1", workspace: "ws-1" });
        routerMock.options = { history: { state: { back: "/resources/skills?layer=WORKSPACE" } } };
        apiMock.getWorkspaceSkills.mockResolvedValue([
            { skillId: "skill-1", name: "部署技能", definitionScope: { type: "workspace" } },
        ]);
        const wrapper = mountView();
        await flushPromises();

        await wrapper.get('[data-testid="resource-detail-back"]').trigger("click");
        expect(backMock).toHaveBeenCalledTimes(1);
        expect(pushMock).not.toHaveBeenCalled();
    });
});
