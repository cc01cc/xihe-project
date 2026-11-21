import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as apiModule from "../../../composables/api";
import { api } from "../../../composables/api";
import { i18n } from "../../../i18n";
import { SETTINGS_TRAIL_KEY } from "../../../components/settings/settingsTrail";
import AgentPrincipalBindingsView from "../AgentPrincipalBindingsView.vue";

/**
 * task-153 S1：绑定整页的宿主判据。
 *
 * <p>本页只做三件事，因此只钉这三件：</p>
 * <ol>
 *   <li>**面包屑四段**的第三段是真名 / 无读面时回落成 principalId（卡面 H7 ③ + H11）；
 *       trail 的渲染在 `SettingsLayerHeader.spec.ts` 另有用例钉住，这里断言本页交给外框的
 *       payload 本身（含第二段的同层向上链接）。</li>
 *   <li>**名称缺口措辞红线**：只写「名称读面未提供」，不得写「不存在 / 加载失败 / 无权限」——</li>
 *   <li>**卸载清 setter**：跳到别的设置页时不能残留上一个主体名。</li>
 * </ol>
 */

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            listAgentPrincipals: vi.fn<typeof apiModule.api.listAgentPrincipals>(),
            getSelfPermissions: vi.fn<typeof apiModule.api.getSelfPermissions>(),
            listWorkspaces: vi.fn<typeof apiModule.api.listWorkspaces>(),
            getWorkspaceAgents: vi.fn<typeof apiModule.api.getWorkspaceAgents>(),
        },
    };
});

const mockedApi = vi.mocked(api, true);

function mountView(principalId = "p-1") {
    const setTrail = vi.fn<(trail: unknown) => void>();
    const wrapper = mount(AgentPrincipalBindingsView, {
        props: { id: principalId },
        global: {
            plugins: [i18n],
            provide: { [SETTINGS_TRAIL_KEY as symbol]: setTrail },
        },
    });
    return { wrapper, setTrail };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.listAgentPrincipals.mockResolvedValue([]);
    mockedApi.getSelfPermissions.mockResolvedValue({
        userId: "u-1",
        instanceCapabilities: [],
        instancePermissions: [],
        workspaces: [],
    });
    mockedApi.listWorkspaces.mockResolvedValue([]);
    mockedApi.getWorkspaceAgents.mockResolvedValue([]);
});

describe("AgentPrincipalBindingsView（task-153 S1）", () => {
    it("面包屑：第二段链回实例级列表页，第三段是主体名，末段是「绑定」", async () => {
        mockedApi.listAgentPrincipals.mockResolvedValue([{ principalId: "p-1", name: "Coder" }]);

        const { wrapper, setTrail } = mountView();
        await flushPromises();

        const last = setTrail.mock.calls.at(-1)?.[0] as Array<{ label: string; to?: string }>;
        expect(last).toHaveLength(3);
        expect(last[0]).toEqual({ label: "智能体主体", to: "/settings/instance/agent-principals" });
        expect(last[1]!.label).toBe("Coder");
        expect(last[2]!.label).toBe("绑定");
        // 末段不可点（aria-current 由外框的 BreadcrumbPage 提供）。
        expect(last[2]!.to).toBeUndefined();
        expect(wrapper.find('[data-testid="agent-bindings-subject-name"]').text()).toBe("Coder");
        expect(wrapper.find('[data-testid="agent-bindings-name-unavailable"]').exists()).toBe(
            false,
        );
    });

    it("无单条读面 ⇒ 回落 principalId + 「名称读面未提供」，不写不存在/加载失败/无权限", async () => {
        mockedApi.listAgentPrincipals.mockResolvedValue([]);

        const { wrapper, setTrail } = mountView("p-404");
        await flushPromises();

        expect(wrapper.find('[data-testid="agent-bindings-subject-name"]').text()).toBe("p-404");
        expect(wrapper.find('[data-testid="agent-bindings-name-unavailable"]').text()).toBe(
            "名称读面未提供",
        );
        const text = wrapper.text();
        for (const forbidden of ["不存在", "加载失败", "无权限"]) {
            expect(text).not.toContain(forbidden);
        }
        const last = setTrail.mock.calls.at(-1)?.[0] as Array<{ label: string }>;
        expect(last[1]!.label).toBe("p-404");
    });

    it("读面抛错也回落 principalId（不把故障写成结论）", async () => {
        mockedApi.listAgentPrincipals.mockRejectedValue(new Error("boom"));

        const { wrapper } = mountView("p-err");
        await flushPromises();

        expect(wrapper.find('[data-testid="agent-bindings-subject-name"]').text()).toBe("p-err");
        expect(wrapper.find('[data-testid="agent-bindings-name-unavailable"]').exists()).toBe(true);
    });

    it("卸载清 setter：不残留上一个主体名", async () => {
        const { wrapper, setTrail } = mountView();
        await flushPromises();
        expect(setTrail.mock.calls.at(-1)?.[0]).not.toBeNull();

        wrapper.unmount();
        expect(setTrail.mock.calls.at(-1)?.[0]).toBeNull();
    });

    it("工作区绑定面板挂在页面里（整页宿主，不是抽屉）", async () => {
        const { wrapper } = mountView();
        await flushPromises();
        expect(wrapper.find('[data-testid="agent-bindings-panel"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="settings-agent-principal-bindings"]').exists()).toBe(
            true,
        );
    });
});
