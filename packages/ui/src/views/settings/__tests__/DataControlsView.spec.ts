import { describe, it, expect, beforeEach, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { createI18n } from "vue-i18n";
import type { RouteLocationNormalizedLoaded } from "vue-router";
import { api, apiRaw } from "../../../composables/api";
import type * as apiModule from "../../../composables/api";
import ImportPreview from "../../../components/settings/ImportPreview.vue";

vi.mock("vue-router", () => ({
    createRouter: () => ({
        push: vi.fn<() => void>(),
        replace: vi.fn<() => void>(),
        beforeEach: vi.fn<() => void>(),
        afterEach: vi.fn<() => void>(),
        isReady: () => Promise.resolve(),
        currentRoute: { value: {} },
    }),
    createWebHistory: () => ({}),
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
    useRouter: () => ({
        push: vi.fn<(location: unknown) => Promise<void>>(),
        replace: vi.fn<(location: unknown) => Promise<void>>(),
    }),
    RouterLink: { template: "<a><slot /></a>" },
}));

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            getWorkspaceCheckpointRetention:
                vi.fn<typeof apiModule.api.getWorkspaceCheckpointRetention>(),
            cleanupWorkspaceCheckpoints: vi.fn<typeof apiModule.api.cleanupWorkspaceCheckpoints>(),
            getSelfPermissions: vi.fn<typeof apiModule.api.getSelfPermissions>(),
        },
        apiRaw: vi.fn<typeof apiModule.apiRaw>(),
    };
});

const mockedApi = vi.mocked(api, true),
    WORKSPACE_ID = "66666666-6666-4666-8666-666666666666",
    messages = {
        "zh-CN": {
            settings: {
                dataControls: "数据控制",
                exportSettings: "导出设置",
                exportChats: "导出聊天",
                import: "导入",
                configTab: "配置管理",
                knowledge: "知识库",
                // PLAN-0752 T4.4：权限面文案（无 atom 信息条 / atom 缺失 403 卡片）。
                ia: {
                    noAtomTitle: "本页没有权限原子：",
                    noAtomBody: "内容按你的归属自动收窄，这里不会出现 403。",
                    atomDeniedTitle: "权限不足",
                    atomDeniedBody: "缺少「{atom}」权限（{code}）。这是授权问题，不是功能缺失。",
                    atomDeniedNotGap: "本页不是后端缺口。",
                },
                permissionAtom: {
                    credentialManage: "凭据管理",
                    createOwnAgent: "创建个人智能体",
                    writeInstanceContent: "写入实例内容",
                },
                checkpointRetention: "快照保留",
                checkpointRetentionDesc:
                    "每次可写运行前建立快照；按数量与时间保留，超出后自动清理。",
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
                // ImportPreview 的文案：本地词典只补它挂载时真正读到的键，避免 stderr 噪声。
                importPreview: "导入预览",
                importFile: "文件",
                importSize: "大小",
                importChats: "会话数",
                importMessages: "消息数",
            },
            common: {
                confirm: "确认",
                loading: "加载中...",
                retry: "重试",
                cancel: "取消",
                close: "关闭",
            },
        },
    };

function createI18nInstance() {
    return createI18n({ legacy: false, locale: "zh-CN", fallbackLocale: "zh-CN", messages });
}

/** PLAN-0752 T4.4：数据面按实例原子门控；默认「已授予」，denied 用例显式收回。 */
function selfPermissions(atoms: string[]) {
    return {
        userId: "user-1",
        instanceCapabilities: [] as string[],
        instancePermissions: atoms.map((actionClass) => ({ actionClass, resource: "*" })),
        workspaces: [],
    };
}

beforeEach(() => {
    setActivePinia(createPinia());
    // auth store 的 token 来自 localStorage；无 token ⇒ ensureSelfPermissions() fail-closed。
    localStorage.setItem("xihe-token", "test-token");
    vi.mocked(api, true).getSelfPermissions.mockResolvedValue(
        selfPermissions(["WRITE_INSTANCE_CONTENT"]) as never,
    );
    globalThis.URL.createObjectURL = vi.fn<() => string>(() => "blob:mock");
    globalThis.URL.revokeObjectURL = vi.fn<(url: string) => void>(() => undefined);
    vi.mocked(apiRaw).mockReset();
});

describe("DataControlsView", () => {
    it("renders title", async () => {
        const { default: DataControlsView } = await import("../DataControlsView.vue"),
            wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } });
        await flushPromises();
        expect(wrapper.text()).toContain("数据控制");
    });

    it("renders export settings button", async () => {
        const { default: DataControlsView } = await import("../DataControlsView.vue"),
            wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } });
        await flushPromises();
        expect(wrapper.text()).toContain("导出设置");
    });

    it("renders export chats button", async () => {
        const { default: DataControlsView } = await import("../DataControlsView.vue"),
            wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } });
        await flushPromises();
        expect(wrapper.text()).toContain("导出聊天");
    });

    it("renders import button", async () => {
        const { default: DataControlsView } = await import("../DataControlsView.vue"),
            wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } });
        await flushPromises();
        expect(wrapper.text()).toContain("导入");
    });

    it("opens ImportPreview on file selection", async () => {
        const { default: DataControlsView } = await import("../DataControlsView.vue"),
            wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } });
        await flushPromises();
        const fileInput = wrapper.find('input[type="file"]');
        expect(fileInput.exists()).toBe(true);
    });

    // PLAN-0752 T4.4：数据面是**有 atom**的页 —— 没被授予时给 403 视图，并且**不取数**（judge ②）。
    it("renders the 403 view and skips all requests when WRITE_INSTANCE_CONTENT is missing", async () => {
        vi.mocked(api, true).getSelfPermissions.mockResolvedValue(selfPermissions([]) as never);
        const { default: DataControlsView } = await import("../DataControlsView.vue"),
            wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } });
        await flushPromises();

        expect(wrapper.find('[data-testid="settings-atom-denied"]').exists()).toBe(true);
        expect(wrapper.text()).toContain("WRITE_INSTANCE_CONTENT");
        // task-22 / P2-4：中文权限名与机器码同时在屏
        expect(wrapper.text()).toContain("写入实例内容");
        expect(mockedApi.getWorkspaceCheckpointRetention).not.toHaveBeenCalled();
        // 主体不挂载：导出/导入按钮与保留区块都不在 DOM
        expect(wrapper.text()).not.toContain("导出设置");
        expect(wrapper.find('[data-testid="settings-checkpoint-retention"]').exists()).toBe(false);
    });

    it("renders the data controls (and loads retention) when the atom is granted", async () => {
        // 有工作区上下文才会真正取保留期（无上下文时 loadRetention 直接返回）
        sessionStorage.setItem(
            "xihe-workspace",
            JSON.stringify({ id: WORKSPACE_ID, name: "Workspace" }),
        );
        mockedApi.getWorkspaceCheckpointRetention.mockResolvedValue({
            maxRuns: 50,
            ttlDays: 30,
            currentRuns: 2,
            currentRefs: 3,
        } as never);
        const { default: DataControlsView } = await import("../DataControlsView.vue"),
            wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } });
        await flushPromises();

        expect(wrapper.find('[data-testid="settings-atom-denied"]').exists()).toBe(false);
        expect(wrapper.text()).toContain("导出设置");
        expect(mockedApi.getWorkspaceCheckpointRetention).toHaveBeenCalled();
    });

    it("no longer mounts its own settings nav (task-74 B0: the layout owns navigation)", async () => {
        const { default: DataControlsView } = await import("../DataControlsView.vue"),
            wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } });
        await flushPromises();
        expect(wrapper.find('[data-testid^="settings-nav-"]').exists()).toBe(false);
    });
});

describe("DataControlsView snapshot retention (PLAN-0328 M3)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        sessionStorage.clear();
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
        const { default: DataControlsView } = await import("../DataControlsView.vue"),
            wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } });
        await flushPromises();
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
        const { default: DataControlsView } = await import("../DataControlsView.vue"),
            wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } });
        await flushPromises();
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
        const { default: DataControlsView } = await import("../DataControlsView.vue"),
            wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } });
        await flushPromises();
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
        const { default: DataControlsView } = await import("../DataControlsView.vue"),
            wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } });
        await flushPromises();
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
        const { default: DataControlsView } = await import("../DataControlsView.vue"),
            wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } });
        await flushPromises();
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

/**
 * M1 页面替换丢面：旧 `ConfigSettings.vue` 把导入报告的 `warnings[]` 渲染成
 * `[data-testid="config-import-warnings"]` 列表，新 `/settings/data` 页只留了
 * `Imported: x, Skipped: y`，CP 的降级/跳过说明（如
 * `provider-connections: 1 credential(s) skipped - rebuild them via …`）被静默丢弃。
 * 这里锁三件事：有 warnings 渲染 N 条、无 warnings **不渲染空容器**、形状异常时只留字符串。
 */
describe("DataControlsView import warnings", () => {
    function importResponse(payload: unknown): Response {
        return { json: () => Promise.resolve(payload) } as unknown as Response;
    }

    async function mountView() {
        const { default: DataControlsView } = await import("../DataControlsView.vue"),
            wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } });
        await flushPromises();
        return wrapper;
    }

    /** 走用户路径：选文件 ⇒ 预览挂载 ⇒ 确认导入。 */
    async function confirmImport(wrapper: VueWrapper, payload: unknown) {
        vi.mocked(apiRaw).mockResolvedValue(importResponse(payload));
        const file = new File([JSON.stringify({ chats: [] })], "settings.json", {
                type: "application/json",
            }),
            input = wrapper.find('input[type="file"]');
        Object.defineProperty(input.element, "files", { value: [file], configurable: true });
        await input.trigger("change");
        await flushPromises();
        const preview = wrapper.findComponent(ImportPreview);
        expect(preview.exists()).toBe(true);
        preview.vm.$emit("confirm", { file, chatCount: 0, messageCount: 0 });
        await flushPromises();
        expect(vi.mocked(apiRaw)).toHaveBeenCalledWith("/config/import", expect.anything());
    }

    it("renders every CP warning line after a successful import", async () => {
        const wrapper = await mountView();
        await confirmImport(wrapper, {
            imported: 3,
            skipped: 1,
            warnings: [
                "provider-connections: 1 credential(s) skipped - rebuild them via the credentials page",
                "tool-faces: 2 entries ignored (unknown category)",
            ],
        });

        const list = wrapper.find('[data-testid="config-import-warnings"]');
        expect(list.exists()).toBe(true);
        expect(list.findAll("li")).toHaveLength(2);
        expect(list.text()).toContain("provider-connections: 1 credential(s) skipped");
        expect(list.text()).toContain("tool-faces: 2 entries ignored");
        expect(wrapper.text()).toContain("Imported: 3, Skipped: 1");
    });

    it("renders no warnings container at all when CP reports none", async () => {
        const wrapper = await mountView();
        await confirmImport(wrapper, { imported: 1, skipped: 0 });

        expect(wrapper.find('[data-testid="config-import-warnings"]').exists()).toBe(false);
        expect(wrapper.text()).toContain("Imported: 1, Skipped: 0");
    });

    it("keeps only non-empty strings when the warnings shape is unexpected", async () => {
        const wrapper = await mountView();
        await confirmImport(wrapper, {
            imported: 2,
            skipped: 0,
            warnings: [null, "   ", { detail: "nope" }, "only-this-one"],
        });

        const list = wrapper.find('[data-testid="config-import-warnings"]');
        expect(list.exists()).toBe(true);
        expect(list.findAll("li")).toHaveLength(1);
        expect(list.text()).toBe("only-this-one");
    });
});
