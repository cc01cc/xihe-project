import { describe, it, expect, beforeEach, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { createI18n } from "vue-i18n";
import type { RouteLocationNormalizedLoaded } from "vue-router";
import { api, apiRaw, ApiError } from "../../../composables/api";
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
            // task-45：错误面统一入口的兜底文案。**task-69 B 更正措辞**：本 fixture 是 errors.* 的**子集副本**，
            // 作用是让本组件的分支在离线夹具下可判；字面**手工随真值同步**（下面 unknownCode 已随 task-64 裁 ②
            // 改成「展开技术详情」那版），但**同步不受任何保证** —— 真值以 src/i18n/index.ts 为准，等值性不由本
            // 文件保证。原注释写「同值」，而 check:i18n-fixture-copies 比的是引用关系不是字符串，不会提醒下
            // 一个人，所以那半句必须删掉而不是并列保留。也别改成「等值断言」：那等于把局部夹具钉成全仓契约。
            errors: {
                requestFailed: "请求失败，请稍后重试；若多次失败请联系管理员。",
                unknownCode:
                    "请求失败，请稍后重试；若持续失败，请展开「技术详情」，把其中的错误码报给管理员。",
                technicalDetail: "技术详情",
            },
            settings: {
                dataControls: "数据控制",
                exportSettings: "导出设置",
                exportChats: "导出会话",
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
                    // task-5（D-1521 #3=A）：按动作分判的两条就地说明。
                    instanceWriteAtomNeeded: "导入需要 {atom} 原子。",
                    instanceExportCapabilityNeeded: "导出需要能力位 {capability}。",
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

/**
 * task-5（D-1521 #3=A）：能力位来自 `/auth/me` 缓存的 `user.capabilities`（`stores/auth.ts:68-70`）。
 * 本文件的 auth 是真 store（只 mock api），所以能力位要用 localStorage 种子控制 —— 且必须在
 * store 实例化（组件 mount）之前种下。
 */
function seedCapability(isInstanceAdmin: boolean) {
    localStorage.setItem(
        "xihe-user",
        JSON.stringify({
            id: "user-1",
            email: "user@example.com",
            name: "User",
            capabilities: { isInstanceAdmin, isInstanceSuper: false, workspaceAdminOf: [] },
        }),
    );
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
    // task-467：本块此前**只设 token、不清场**，而同文件下一块（snapshot retention）既写
    // `xihe-workspace` 又真的调用 getWorkspaceCheckpointRetention。顺序跑时两块先后固定所以恒绿；
    // `--sequence.shuffle` 把两块的用例交错后，下一块记录的调用会留在同一个 vi.fn 的历史里，
    // 于是 403 用例的 `not.toHaveBeenCalled()` 被**别人的调用**判红（实测 4/4 种子单文件即复现）。
    // 清场对齐下一块：mock 调用历史 + 两个 storage 都清，再设本块自己要的 token。
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
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
        expect(wrapper.text()).toContain("导出会话");
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
        // 实例数据主体不挂载：导出 / 导入按钮不在 DOM（403 只守实例数据面）。
        expect(wrapper.text()).not.toContain("导出设置");
        // task-20（D-1667）：保留期属 workspace 成员面，已拆出实例原子门 ⇒ 区块仍在 DOM；本用例
        // 无工作区上下文，走「无工作区」空态，与 403 互不连坐（旧断言「保留区块不在 DOM」正是被修的错层）。
        expect(wrapper.find('[data-testid="settings-checkpoint-retention"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="settings-checkpoint-no-workspace"]').exists()).toBe(
            true,
        );
    });

    // task-20（D-1667）：保留期清理的判据是 **workspace 成员面**，不是实例原子门。
    // CP 端点（`RunCheckpointController`）retention:183-198 / cleanup:214-232 都是
    // `@PreAuthorize("isAuthenticated()")` + `requireWorkspaceAccess` → `WorkspaceService
    // .requireAccessibleWorkspace`:278-288（`memberships.isMember`）；而 import 是写原子
    // `WRITE_INSTANCE_CONTENT`（`ConfigController`:572）、export 是能力位 `cap:instance:admin`
    // （:607-610）⇒ 三者不是同一层。旧实现把清理入口放在整页原子门（dataDenied）里 ⇒
    // 工作区成员但无实例原子时整页 403、入口被连坐隐藏（错层）。
    it("shows the checkpoint cleanup entry to a workspace member without instance atoms", async () => {
        // 有工作区上下文（成员），但无任何实例原子与实例管理员能力位。
        sessionStorage.setItem(
            "xihe-workspace",
            JSON.stringify({ id: WORKSPACE_ID, name: "Workspace" }),
        );
        seedCapability(false);
        vi.mocked(api, true).getSelfPermissions.mockResolvedValue(selfPermissions([]) as never);
        mockedApi.getWorkspaceCheckpointRetention.mockResolvedValue({
            maxRuns: 50,
            ttlDays: 30,
            currentRuns: 2,
            currentRefs: 3,
        } as never);
        const { default: DataControlsView } = await import("../DataControlsView.vue"),
            wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } });
        await flushPromises();
        await flushPromises();

        // 实例数据面仍按原子门 403（import 缺原子、export 缺能力位）。
        expect(wrapper.find('[data-testid="settings-atom-denied"]').exists()).toBe(true);
        // 但清理入口属 workspace 成员面，必须可见且可点（不被实例原子门连坐）。
        expect(wrapper.find('[data-testid="settings-checkpoint-retention"]').exists()).toBe(true);
        const cleanup = wrapper.find('[data-testid="settings-checkpoint-cleanup"]');
        expect(cleanup.exists()).toBe(true);
        expect(cleanup.attributes("disabled")).toBeUndefined();
        // 入口真的可用：点击进入二次确认（不是死按钮）。
        await cleanup.trigger("click");
        expect(
            wrapper.find('[data-testid="settings-checkpoint-cleanup-confirm-box"]').exists(),
        ).toBe(true);
    });

    // task-5（D-1521 #3=A）：**按动作分判** —— import 门 = 写原子；export 门 = 能力位。
    it("disables only the import button when WRITE_INSTANCE_CONTENT is missing but the capability is held", async () => {
        seedCapability(true);
        vi.mocked(api, true).getSelfPermissions.mockResolvedValue(selfPermissions([]) as never);
        const { default: DataControlsView } = await import("../DataControlsView.vue"),
            wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } });
        await flushPromises();

        // 页面不再整页 403：导出那一半 CP 仍然放行（cap:instance:admin）。
        expect(wrapper.find('[data-testid="settings-atom-denied"]').exists()).toBe(false);
        const importButton = wrapper.get('[data-testid="settings-data-import"]');
        expect(importButton.attributes("disabled")).toBeDefined();
        // 就地说明（不是 `title` 提示）：键盘与读屏都能读到，且点名机器码。
        expect(wrapper.get('[data-testid="settings-data-import-denied"]').text()).toContain(
            "WRITE_INSTANCE_CONTENT",
        );
        expect(
            wrapper.get('[data-testid="settings-data-export-settings"]').attributes("disabled"),
        ).toBeUndefined();
    });

    it("disables only the export buttons when the capability is missing but the write atom is held", async () => {
        seedCapability(false);
        const { default: DataControlsView } = await import("../DataControlsView.vue"),
            wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } });
        await flushPromises();

        expect(wrapper.find('[data-testid="settings-atom-denied"]').exists()).toBe(false);
        const exportButton = wrapper.get('[data-testid="settings-data-export-settings"]');
        expect(exportButton.attributes("disabled")).toBeDefined();
        expect(wrapper.get('[data-testid="settings-data-export-denied"]').text()).toContain(
            "cap:instance:admin",
        );
        expect(
            wrapper.get('[data-testid="settings-data-import"]').attributes("disabled"),
        ).toBeUndefined();
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

    /**
     * task-45（batch-2 实拍形态）：**未知码 + 客户端兜底英文 detail 都不许直出**。
     *
     * <p>复现口径与实拍一致：码是后端没有的假码（`AUDIT_ERROR`），detail 是客户端兜底
     * （`api.ts:2550` 的 `API error <status>`）。改前本页渲染出 `AUDIT_ERROR: API error 500`；
     * 现在主文案是本地化句子，原始 detail 收进**默认折叠**的技术详情（可展开、原文不丢）。</p>
     */
    it("task-45：未知码与英文 detail 不直出，原文收进默认折叠的技术详情", async () => {
        mockedApi.getWorkspaceCheckpointRetention.mockRejectedValueOnce(
            new ApiError({
                status: 500,
                code: "AUDIT_ERROR",
                detail: "API error 500",
                requestId: "t",
            }),
        );
        const { default: DataControlsView } = await import("../DataControlsView.vue"),
            wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } });
        await flushPromises();
        await flushPromises();

        const copy = wrapper.get('[data-testid="settings-checkpoint-error-copy"]');
        expect(copy.text()).not.toMatch(/API error \d+/);
        expect(copy.text()).not.toContain("AUDIT_ERROR");
        expect(copy.text()).toBe(messages["zh-CN"].errors.unknownCode);

        // 默认折叠：触发器在，正文不挂载（不渲染空/隐藏的空折叠区）。
        const toggle = wrapper.get('[data-testid="settings-checkpoint-error-detail-toggle"]');
        expect(toggle.text()).toBe(messages["zh-CN"].errors.technicalDetail);
        expect(wrapper.find('[data-testid="settings-checkpoint-error-detail-body"]').exists()).toBe(
            false,
        );

        // 可展开且原文不丢（可诊断性不是被删掉，只是收起来）。
        await toggle.trigger("click");
        await flushPromises();
        expect(wrapper.get('[data-testid="settings-checkpoint-error-detail-body"]').text()).toBe(
            "API error 500",
        );
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

/**
 * task-75: the four checkpoint constant cells are NOT guarded, on purpose.
 *
 * Measured on the real page (mock lane 5199, .local/task75 harness, SettingsLayout main
 * column): desktop cell 1910 wide -> dt 36-60px. Phone 390 -> cell 165.5 wide, dt still
 * 36-60px with the real values. Phone 320 -> cell 130.5 wide; padding a dd to 7 digits
 * finally wraps the label (dt 44.16x38.38). The dd is an integer count of slices in a
 * workspace that caps at 50, so a 7-digit value cannot be produced.
 *
 * This test pins the absence so a later "guard every dl row" sweep has to argue with a
 * measurement rather than quietly widen the change.
 */
describe("DataControlsView checkpoint constants stay unguarded (task-75)", () => {
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

    it("renders no shrink-0/items-start guards on the numeric constant rows", async () => {
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

        const dl = wrapper.find('[data-testid="settings-checkpoint-constants"]');
        expect(dl.exists()).toBe(true);
        const rows = dl.findAll("div");
        expect(rows).toHaveLength(4);
        for (const row of rows) {
            expect(row.classes()).not.toContain("items-start");
            expect(row.get("dt").classes()).not.toContain("shrink-0");
        }
    });
});
