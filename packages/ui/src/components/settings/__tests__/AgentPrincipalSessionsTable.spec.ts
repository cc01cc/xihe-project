import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as apiModule from "../../../composables/api";
import { ApiError, api } from "../../../composables/api";
import { i18n } from "../../../i18n";
import AgentPrincipalSessionsTable from "../AgentPrincipalSessionsTable.vue";

/**
 * task-721：Agent 主体「参与的会话」表（`GET /agent-principals/{id}/sessions`）。
 *
 * <p>覆盖卡面要求的四类：正常计数与行、`readable=false` 占位、`truncated=true` 提示、错误态；
 * 另加 403 权限结论（绝不回落成 0）。</p>
 */

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            listAgentPrincipalSessions: vi.fn<typeof apiModule.api.listAgentPrincipalSessions>(),
        },
    };
});

const mockedApi = vi.mocked(api, true);

function sessionRow(
    index: number,
    extra: Partial<apiModule.AgentPrincipalSessionRow> = {},
): apiModule.AgentPrincipalSessionRow {
    return {
        id: "s-" + index,
        title: "会话 " + index,
        readable: true,
        archived: false,
        role: "MEMBER",
        kind: "spawn",
        spawnedFromSessionId: "parent-1",
        spawnedAt: "2026-11-21T00:00:00Z",
        createdAt: "2026-11-20T00:00:00Z",
        updatedAt: "2026-11-21T01:00:00Z",
        ...extra,
    };
}

function payload(
    overrides: Partial<apiModule.AgentPrincipalSessionsResponse> = {},
): apiModule.AgentPrincipalSessionsResponse {
    return {
        workspaceId: "w-1",
        principalId: "p-1",
        includeArchived: false,
        counts: { all: 0, primary: 0, member: 0, guard: 0 },
        sessions: [],
        truncated: false,
        limit: 100,
        ...overrides,
    };
}

function mountTable() {
    return mount(AgentPrincipalSessionsTable, {
        props: { principalId: "p-1", workspaceId: "w-1" },
        global: { plugins: [i18n] },
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.listAgentPrincipalSessions.mockResolvedValue(payload());
});

describe("AgentPrincipalSessionsTable（task-721）", () => {
    it("正常渲染：计数取 counts 四口径，表格显示 title/role/archived/updatedAt", async () => {
        mockedApi.listAgentPrincipalSessions.mockResolvedValue(
            payload({
                counts: { all: 7, primary: 3, member: 2, guard: 2 },
                sessions: [
                    sessionRow(1, { role: "PRIMARY", title: "主会话" }),
                    sessionRow(2, { role: "GUARD", archived: true, title: "守卫会话" }),
                ],
            }),
        );

        const wrapper = mountTable();
        await flushPromises();

        expect(wrapper.get('[data-testid="agent-principal-sessions-count-all"]').text()).toContain(
            "7",
        );
        expect(
            wrapper.get('[data-testid="agent-principal-sessions-count-primary"]').text(),
        ).toContain("3");
        expect(
            wrapper.get('[data-testid="agent-principal-sessions-count-member"]').text(),
        ).toContain("2");
        expect(
            wrapper.get('[data-testid="agent-principal-sessions-count-guard"]').text(),
        ).toContain("2");

        expect(wrapper.findAll('[data-testid^="agent-principal-sessions-row-s-"]')).toHaveLength(2);
        expect(wrapper.get('[data-testid="agent-principal-sessions-title-s-1"]').text()).toBe(
            "主会话",
        );
        expect(wrapper.get('[data-testid="agent-principal-sessions-role-s-1"]').text()).toBe(
            "主对话主体",
        );
        expect(wrapper.get('[data-testid="agent-principal-sessions-role-s-2"]').text()).toBe(
            "守卫",
        );
        expect(wrapper.get('[data-testid="agent-principal-sessions-archived-s-2"]').text()).toBe(
            "已归档",
        );
        expect(wrapper.get('[data-testid="agent-principal-sessions-updated-s-1"]').text()).not.toBe(
            "",
        );

        expect(mockedApi.listAgentPrincipalSessions).toHaveBeenCalledWith("p-1", "w-1", {
            includeArchived: false,
        });
    });

    it("readable=false ⇒ 标题占位「该会话对你不可见」，行仍计数", async () => {
        mockedApi.listAgentPrincipalSessions.mockResolvedValue(
            payload({
                counts: { all: 2, primary: 1, member: 1, guard: 0 },
                sessions: [sessionRow(1), sessionRow(2, { readable: false, title: null })],
            }),
        );

        const wrapper = mountTable();
        await flushPromises();

        const hidden = wrapper.get('[data-testid="agent-principal-sessions-title-s-2"]');
        expect(hidden.text()).toBe("该会话对你不可见");
        expect(wrapper.text()).not.toContain("会话 2");
        expect(wrapper.get('[data-testid="agent-principal-sessions-redacted"]').text()).toContain(
            "只显示数量",
        );
        expect(wrapper.get('[data-testid="agent-principal-sessions-count-all"]').text()).toContain(
            "2",
        );
    });

    it("truncated=true ⇒ 明示只显示前 limit 条，计数仍是全量", async () => {
        mockedApi.listAgentPrincipalSessions.mockResolvedValue(
            payload({
                counts: { all: 9, primary: 4, member: 3, guard: 2 },
                sessions: [sessionRow(1), sessionRow(2)],
                truncated: true,
                limit: 2,
            }),
        );

        const wrapper = mountTable();
        await flushPromises();

        expect(wrapper.get('[data-testid="agent-principal-sessions-limit-note"]').text()).toContain(
            "2",
        );
        expect(wrapper.get('[data-testid="agent-principal-sessions-count-all"]').text()).toContain(
            "9",
        );
        expect(wrapper.findAll('[data-testid^="agent-principal-sessions-row-s-"]')).toHaveLength(2);
    });

    it("403 WORKSPACE_FORBIDDEN ⇒ 明说看不到，绝不显示 0", async () => {
        mockedApi.listAgentPrincipalSessions.mockRejectedValue(
            new ApiError({
                status: 403,
                code: "WORKSPACE_FORBIDDEN",
                detail: "workspace role VIEWER cannot read the agent roster",
                requestId: "req-403",
            }),
        );

        const wrapper = mountTable();
        await flushPromises();

        expect(wrapper.get('[data-testid="agent-principal-sessions-forbidden"]').text()).toContain(
            "看不到",
        );
        expect(wrapper.find('[data-testid="agent-principal-sessions-count-all"]').exists()).toBe(
            false,
        );
        expect(wrapper.find('[data-testid="agent-principal-sessions-empty"]').exists()).toBe(false);
    });

    it("解析/网络失败 ⇒ 错误态，不渲染计数或空态", async () => {
        mockedApi.listAgentPrincipalSessions.mockRejectedValue(
            new ApiError({
                status: 500,
                code: "INTERNAL_ERROR",
                detail: "boom",
                requestId: "req-500",
            }),
        );

        const wrapper = mountTable();
        await flushPromises();

        const failed = wrapper.get('[data-testid="agent-principal-sessions-failed"]');
        expect(failed.text()).not.toBe("");
        expect(wrapper.find('[data-testid="agent-principal-sessions-count-all"]').exists()).toBe(
            false,
        );
        expect(wrapper.find('[data-testid="agent-principal-sessions-empty"]').exists()).toBe(false);
    });
});
