import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ResourceDetailView from "../ResourceDetailView.vue";

/**
 * task-228：详情页**四态 + 数据接线**（组件级）。
 *
 * <p>判据纪律：每条状态都断言"看得见的那句话的键 + 关键 DOM"，而不是只断言"没崩"；
 * 未接线态必须**不调**该资源没有的读面（用 mock 调用次数当负数判据）。</p>
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
        expect(apiMock.listCredentials).toHaveBeenCalledWith({
            ownerType: "USER",
            ownerId: undefined,
        });
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
    });
});

describe("ResourceDetailView — 技能/知识库（未接线诚实态）", () => {
    it("技能个人层（pendingBackend）⇒ 未接线，且不调任何技能读面", async () => {
        setRoute({ resourceId: "skills", layer: "USER", pk: "skill-1" });
        const wrapper = mountView();
        await flushPromises();

        expect(wrapper.get('[data-testid="resource-detail-unwired"]').text()).toContain(
            "个人技能库后端未实现",
        );
        expect(apiMock.getSkillDefinition).not.toHaveBeenCalled();
        expect(apiMock.getWorkspaceSkills).not.toHaveBeenCalled();
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
