import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as apiModule from "../../../composables/api";
import { ApiError, api } from "../../../composables/api";
import { i18n } from "../../../i18n";
import AgentDelegatedSessionsTable from "../AgentDelegatedSessionsTable.vue";

/**
 * task-153 S3-a：委派子会话表（`GET /workspaces/{ws}/agents/{pid}/spawn-sessions`）。
 *
 * <p>三条判据（api.ts 的 DelegateSpawnSessions 注释 + 卡面 H3）：</p>
 * <ol>
 *   <li>**数字取 `counts`**：`counts.all=7` 而 `sessions.length=5`（limit=5）时摘要必须是 7，
 *       且带「仅显示前 5 条」的截断标注 —— 用 `sessions.length` 当数字就是静默少报；</li>
 *   <li>**403 是权限结论**：明说「看不到明细」，绝不回落成「0 个」；解析/网络失败同理（说取不到）；</li>
 *   <li>**不编数字**：没有可查工作区时给「先绑定」的空态且零请求，不显示 0。</li>
 * </ol>
 */

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            listWorkspaceAgentSpawnSessions:
                vi.fn<typeof apiModule.api.listWorkspaceAgentSpawnSessions>(),
        },
    };
});

const mockedApi = vi.mocked(api, true);

const CANDIDATES = [{ workspaceId: "w-1", workspaceName: "研发工作区" }];

function sessionRow(index: number, extra: Partial<apiModule.DelegateSpawnSession> = {}) {
    return {
        id: "s-" + index,
        parentSessionId: "parent-1",
        depth: 1,
        direct: index <= 2,
        readable: true,
        title: "子会话 " + index,
        archived: false,
        runStatus: null,
        active: false,
        spawnedAt: "2026-11-21T00:00:00Z",
        ...extra,
    } as apiModule.DelegateSpawnSession;
}

function payload(
    overrides: Partial<apiModule.DelegateSpawnSessions> = {},
): apiModule.DelegateSpawnSessions {
    return {
        workspaceId: "w-1",
        principalId: "p-1",
        depth: "all",
        includeArchived: false,
        counts: { all: 0, direct: 0 },
        sessions: [],
        truncated: false,
        limit: 50,
        ...overrides,
    };
}

function mountTable(workspaces = CANDIDATES) {
    return mount(AgentDelegatedSessionsTable, {
        props: { principalId: "p-1", workspaces },
        global: { plugins: [i18n] },
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.listWorkspaceAgentSpawnSessions.mockResolvedValue(payload());
});

describe("AgentDelegatedSessionsTable（task-153 S3-a）", () => {
    it("counts.all=7 而 sessions.length=5（limit=5）⇒ 摘要显示 7 并带截断标注，表里 5 行", async () => {
        mockedApi.listWorkspaceAgentSpawnSessions.mockResolvedValue(
            payload({
                counts: { all: 7, direct: 2 },
                sessions: [1, 2, 3, 4, 5].map((index) => sessionRow(index)),
                truncated: true,
                limit: 5,
            }),
        );

        const wrapper = mountTable();
        await flushPromises();

        // 数字取 counts，不取 sessions.length（7 ≠ 5）。
        expect(wrapper.get('[data-testid="agent-bindings-sessions-count-all"]').text()).toContain(
            "7",
        );
        expect(
            wrapper.get('[data-testid="agent-bindings-sessions-count-all"]').text(),
        ).not.toContain("5 个");
        expect(
            wrapper.get('[data-testid="agent-bindings-sessions-count-direct"]').text(),
        ).toContain("2");
        // 截断必须显式说清"只显示前 5 条"，否则读者会把 5 当全量。
        expect(wrapper.get('[data-testid="agent-bindings-sessions-limit-note"]').text()).toContain(
            "5",
        );
        expect(wrapper.findAll('[data-testid^="agent-bindings-sessions-row-s-"]')).toHaveLength(5);
        // 只查已绑的候选工作区；includeArchived 默认不带。
        expect(mockedApi.listWorkspaceAgentSpawnSessions).toHaveBeenCalledTimes(1);
        expect(mockedApi.listWorkspaceAgentSpawnSessions).toHaveBeenCalledWith("w-1", "p-1", {
            includeArchived: false,
        });
    });

    it("403 WORKSPACE_FORBIDDEN ⇒ 显示「看不到明细」原文，绝不显示 0 个", async () => {
        mockedApi.listWorkspaceAgentSpawnSessions.mockRejectedValue(
            new ApiError({
                status: 403,
                code: "WORKSPACE_FORBIDDEN",
                detail: "workspace role VIEWER cannot read the agent roster",
                requestId: "req-403",
            }),
        );

        const wrapper = mountTable();
        await flushPromises();

        const forbidden = wrapper.get('[data-testid="agent-bindings-sessions-forbidden"]');
        expect(forbidden.text()).toContain("看不到委派明细");
        // 不许出现任何"0 个"的结论，也不许把失败画成空态。
        expect(wrapper.text()).not.toContain("0 个委派的子会话");
        expect(wrapper.find('[data-testid="agent-bindings-sessions-empty"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="agent-bindings-sessions-count-all"]').exists()).toBe(
            false,
        );
    });

    it("counts.all=0 ⇒ 空态（不是错误态），且不渲染表格", async () => {
        mockedApi.listWorkspaceAgentSpawnSessions.mockResolvedValue(
            payload({ counts: { all: 0, direct: 0 }, sessions: [] }),
        );

        const wrapper = mountTable();
        await flushPromises();

        expect(wrapper.get('[data-testid="agent-bindings-sessions-empty"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="agent-bindings-sessions-list"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="agent-bindings-sessions-forbidden"]').exists()).toBe(
            false,
        );
        // 空态也要给计数（0 来自 counts，是服务端结论）。
        expect(wrapper.get('[data-testid="agent-bindings-sessions-count-all"]').text()).toContain(
            "0",
        );
    });

    it("不可读行仍计数：显示「该会话对你不可见」且给出「只显示数量」提示", async () => {
        mockedApi.listWorkspaceAgentSpawnSessions.mockResolvedValue(
            payload({
                counts: { all: 2, direct: 1 },
                sessions: [sessionRow(1), sessionRow(2, { readable: false, title: null })],
            }),
        );

        const wrapper = mountTable();
        await flushPromises();

        const hidden = wrapper.get('[data-testid="agent-bindings-sessions-row-s-2"]');
        expect(hidden.text()).toContain("该会话对你不可见");
        expect(hidden.text()).not.toContain("子会话 2");
        expect(wrapper.get('[data-testid="agent-bindings-sessions-redacted"]').text()).toContain(
            "只显示数量",
        );
        expect(wrapper.get('[data-testid="agent-bindings-sessions-count-all"]').text()).toContain(
            "2",
        );
    });

    it("「含已归档」开关 ⇒ 第二次请求带 includeArchived=true 并重取", async () => {
        const wrapper = mountTable();
        await flushPromises();
        expect(mockedApi.listWorkspaceAgentSpawnSessions).toHaveBeenCalledTimes(1);

        await wrapper
            .get('[data-testid="agent-bindings-sessions-archived-toggle"]')
            .trigger("click");
        await flushPromises();

        expect(mockedApi.listWorkspaceAgentSpawnSessions).toHaveBeenCalledTimes(2);
        expect(mockedApi.listWorkspaceAgentSpawnSessions).toHaveBeenLastCalledWith("w-1", "p-1", {
            includeArchived: true,
        });
        // 默认态写明「计数不含已归档」，切到含已归档后这条说明消失。
        expect(wrapper.find('[data-testid="agent-bindings-sessions-archived-note"]').exists()).toBe(
            false,
        );
    });

    it("没有已绑工作区 ⇒ 给「先绑定」空态且零请求（不编 0）", async () => {
        const wrapper = mountTable([]);
        await flushPromises();

        expect(
            wrapper.get('[data-testid="agent-bindings-sessions-need-binding"]').text(),
        ).toContain("先在上方把主体绑定到工作区");
        expect(mockedApi.listWorkspaceAgentSpawnSessions).not.toHaveBeenCalled();
        expect(wrapper.find('[data-testid="agent-bindings-sessions-empty"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="agent-bindings-sessions-summary"]').exists()).toBe(
            false,
        );
    });

    it("读面形状不对（解析抛错）⇒ 说「取不到」，不补 0", async () => {
        mockedApi.listWorkspaceAgentSpawnSessions.mockRejectedValue(
            new Error("spawn-sessions response is malformed (DelegateSpawnSessionsResponse)"),
        );

        const wrapper = mountTable();
        await flushPromises();

        const failed = wrapper.get('[data-testid="agent-bindings-sessions-failed"]');
        expect(failed.text().length).toBeGreaterThan(0);
        expect(wrapper.find('[data-testid="agent-bindings-sessions-count-all"]').exists()).toBe(
            false,
        );
        expect(wrapper.text()).not.toContain("0 个委派的子会话");
    });
});
