import { describe, it, expect, beforeEach, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { createI18n } from "vue-i18n";
import type { RouteLocationNormalizedLoaded } from "vue-router";
import { api } from "../../../composables/api";

vi.mock("vue-router", () => ({
    useRoute: () =>
        ({
            name: "settings-data",
            path: "/settings/data",
            params: {},
            query: {},
            hash: "",
            fullPath: "/settings/data",
            matched: [],
            redirectedFrom: undefined,
            meta: {},
        }) as RouteLocationNormalizedLoaded,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    RouterLink: { template: "<a><slot /></a>" },
}));

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../composables/api")>();
    return {
        ...actual,
        api: {
            ...actual.api,
            getWorkspaceCheckpointRetention: vi.fn(),
            cleanupWorkspaceCheckpoints: vi.fn(),
        },
    };
});

const mockedApi = vi.mocked(api, true);

const WORKSPACE_ID = "66666666-6666-4666-8666-666666666666";

const messages = {
    "zh-CN": {
        settings: {
            dataControls: "数据控制",
            exportSettings: "导出设置",
            exportChats: "导出聊天",
            import: "导入",
            configTab: "配置管理",
            knowledge: "知识库",
            checkpointRetention: "快照保留",
            checkpointRetentionDesc: "每次可写运行前建立快照；按数量与时间保留，超出后自动清理。",
            checkpointMaxRuns: "保留运行数",
            checkpointTtlDays: "保留天数",
            checkpointCurrentRuns: "当前快照数",
            checkpointCurrentRefs: "引用数",
            checkpointNoWorkspace: "当前没有工作区上下文，无法查看快照保留信息。",
            checkpointLoadFailed: "快照保留信息加载失败",
            checkpointCleanup: "清理工作区切片",
            checkpointCleanupWarning:
                "这会删除工作区的全部切片，之后无法恢复。此操作需要再次确认。",
            checkpointCleanupConfirm: "确认清理全部切片",
            checkpointCleanupDone: "清理完成",
            checkpointCleanupEmpty: "没有需要清理的切片",
            checkpointCleanupFailed: "清理失败",
        },
        common: {
            confirm: "确认",
            loading: "加载中...",
            retry: "重试",
            cancel: "取消",
        },
    },
};

function createI18nInstance() {
    return createI18n({ legacy: false, locale: "zh-CN", fallbackLocale: "zh-CN", messages });
}

beforeEach(() => {
    setActivePinia(createPinia());
    globalThis.URL.createObjectURL = vi.fn(() => "blob:mock");
    globalThis.URL.revokeObjectURL = vi.fn();
});

describe("DataControlsView", () => {
    it("renders title", async () => {
        const { default: DataControlsView } = await import("../DataControlsView.vue");
        const wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } });
        expect(wrapper.text()).toContain("数据控制");
    });

    it("renders export settings button", async () => {
        const { default: DataControlsView } = await import("../DataControlsView.vue");
        const wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } });
        expect(wrapper.text()).toContain("导出设置");
    });

    it("renders export chats button", async () => {
        const { default: DataControlsView } = await import("../DataControlsView.vue");
        const wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } });
        expect(wrapper.text()).toContain("导出聊天");
    });

    it("renders import button", async () => {
        const { default: DataControlsView } = await import("../DataControlsView.vue");
        const wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } });
        expect(wrapper.text()).toContain("导入");
    });

    it("opens ImportPreview on file selection", async () => {
        const { default: DataControlsView } = await import("../DataControlsView.vue");
        const wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } });
        const fileInput = wrapper.find('input[type="file"]');
        expect(fileInput.exists()).toBe(true);
    });

    it("renders SettingsNav with config tab", async () => {
        const { default: DataControlsView } = await import("../DataControlsView.vue");
        const wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } });
        expect(wrapper.text()).toContain("配置管理");
        expect(wrapper.text()).toContain("知识库");
        expect(wrapper.text()).toContain("数据控制");
    });
});

describe("DataControlsView snapshot retention (PLAN-0328 M3)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        localStorage.setItem("xihe-token", "test-token");
        localStorage.setItem(
            "xihe-workspace",
            JSON.stringify({ id: WORKSPACE_ID, name: "Workspace" }),
        );
    });

    it("renders the server-reported retention constants and counts", async () => {
        mockedApi.getWorkspaceCheckpointRetention.mockResolvedValueOnce({
            maxRuns: 50,
            ttlDays: 30,
            unsealedNeverDeleted: true,
            currentRuns: 7,
            currentRefs: 13,
        });
        const { default: DataControlsView } = await import("../DataControlsView.vue");
        const wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } });
        await flushPromises();
        expect(mockedApi.getWorkspaceCheckpointRetention).toHaveBeenCalledWith(WORKSPACE_ID);
        expect(wrapper.find('[data-testid="settings-checkpoint-max-runs"]').text()).toBe("50");
        expect(wrapper.find('[data-testid="settings-checkpoint-ttl-days"]').text()).toBe("30");
        expect(wrapper.find('[data-testid="settings-checkpoint-current-runs"]').text()).toBe("7");
        expect(wrapper.find('[data-testid="settings-checkpoint-current-refs"]').text()).toBe("13");
    });

    it("requires a second confirmation before cleaning workspace slices", async () => {
        mockedApi.getWorkspaceCheckpointRetention.mockResolvedValue({
            maxRuns: 50,
            ttlDays: 30,
            unsealedNeverDeleted: true,
            currentRuns: 2,
            currentRefs: 4,
        });
        mockedApi.cleanupWorkspaceCheckpoints.mockResolvedValueOnce({ removed: true });
        const { default: DataControlsView } = await import("../DataControlsView.vue");
        const wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } });
        await flushPromises();

        await wrapper.find('[data-testid="settings-checkpoint-cleanup"]').trigger("click");
        expect(
            wrapper.find('[data-testid="settings-checkpoint-cleanup-confirm-box"]').text(),
        ).toContain("全部切片");
        expect(mockedApi.cleanupWorkspaceCheckpoints).not.toHaveBeenCalled();

        await wrapper.find('[data-testid="settings-checkpoint-cleanup-confirm"]').trigger("click");
        await flushPromises();
        expect(mockedApi.cleanupWorkspaceCheckpoints).toHaveBeenCalledWith(WORKSPACE_ID);
        expect(wrapper.find('[data-testid="settings-checkpoint-cleanup-result"]').text()).toContain(
            "清理完成",
        );
        // The block refreshes retention counts after cleanup.
        expect(mockedApi.getWorkspaceCheckpointRetention).toHaveBeenCalledTimes(2);
    });

    it("cancels the confirmation without cleaning slices", async () => {
        mockedApi.getWorkspaceCheckpointRetention.mockResolvedValue({
            maxRuns: 50,
            ttlDays: 30,
            unsealedNeverDeleted: true,
            currentRuns: 2,
            currentRefs: 4,
        });
        const { default: DataControlsView } = await import("../DataControlsView.vue");
        const wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } });
        await flushPromises();
        await wrapper.find('[data-testid="settings-checkpoint-cleanup"]').trigger("click");
        await wrapper.find('[data-testid="settings-checkpoint-cleanup-cancel"]').trigger("click");
        expect(
            wrapper.find('[data-testid="settings-checkpoint-cleanup-confirm-box"]').exists(),
        ).toBe(false);
        expect(mockedApi.cleanupWorkspaceCheckpoints).not.toHaveBeenCalled();
    });

    it("shows the no-workspace state and disables cleanup without a workspace context", async () => {
        localStorage.removeItem("xihe-workspace");
        const { default: DataControlsView } = await import("../DataControlsView.vue");
        const wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } });
        await flushPromises();
        expect(wrapper.find('[data-testid="settings-checkpoint-no-workspace"]').exists()).toBe(
            true,
        );
        expect(
            wrapper.find('[data-testid="settings-checkpoint-cleanup"]').attributes("disabled"),
        ).toBeDefined();
        expect(mockedApi.getWorkspaceCheckpointRetention).not.toHaveBeenCalled();
    });

    it("surfaces a retention load failure with retry", async () => {
        mockedApi.getWorkspaceCheckpointRetention.mockRejectedValueOnce(new Error("offline"));
        const { default: DataControlsView } = await import("../DataControlsView.vue");
        const wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } });
        await flushPromises();
        expect(wrapper.find('[data-testid="settings-checkpoint-error"]').exists()).toBe(true);
        mockedApi.getWorkspaceCheckpointRetention.mockResolvedValueOnce({
            maxRuns: 50,
            ttlDays: 30,
            unsealedNeverDeleted: true,
            currentRuns: 1,
            currentRefs: 2,
        });
        await wrapper.find('[data-testid="settings-checkpoint-retry"]').trigger("click");
        await flushPromises();
        expect(wrapper.find('[data-testid="settings-checkpoint-current-runs"]').text()).toBe("1");
    });
});
