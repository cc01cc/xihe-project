/**
 * 选择面：BL-172 回归护栏 + PLAN-0614 M2（空态可操作）。
 *
 * BL-172：旧 `onMounted` 在"tab 上下文已存在"时 `router.replace(...)` 后**直接 return**，而
 * `loading` 的唯一复位点在那条路径后面的 `finally` 里 ⇒ 弹回选择面后永久停在"正在加载工作区…"。
 *
 * PLAN-0614 M2：注册不再自动建工作区 ⇒ 空态必须可操作（「创建你的第一个工作区」→ 既有创建
 * 对话框 → 建成后刷新列表并进入新工作区）。这里把"空态 → 建 → 进入"整条链固化成用例。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const mocks = vi.hoisted(() => ({
    replace: vi.fn<(to: unknown) => Promise<void>>(),
    push: vi.fn<(to: unknown) => Promise<void>>(),
    listWorkspaces: vi.fn<() => Promise<unknown[]>>(),
    writeTabWorkspace: vi.fn<(ws: unknown) => void>(),
    clearTabWorkspace: vi.fn<() => void>(),
    tabWorkspaceId: { value: null as string | null },
}));

vi.mock(
    "vue-router",
    () =>
        ({
            useRouter: () => ({ replace: mocks.replace, push: mocks.push }),
            // 选择面静态 import 了创建对话框 → 其依赖链会加载 `stores/auth` → `router/index.ts`，
            // 那里在模块求值时调用 `createRouter`/`createWebHistory`，所以 mock 必须提供最小实现。
            createRouter: () => ({
                beforeEach: () => undefined,
                push: async () => undefined,
                replace: async () => undefined,
                currentRoute: { value: {} },
            }),
            createWebHistory: () => ({}),
        }) as unknown as typeof import("vue-router"),
);

vi.mock("../../composables/api", async () => {
    const actual =
        await vi.importActual<typeof import("../../composables/api")>("../../composables/api");
    return {
        ...actual,
        api: { listWorkspaces: () => mocks.listWorkspaces() },
    };
});

vi.mock<typeof import("../../lib/workspaceContext")>("../../lib/workspaceContext", () => ({
    readTabWorkspaceId: () => mocks.tabWorkspaceId.value,
    readTabWorkspace: () =>
        mocks.tabWorkspaceId.value ? { id: mocks.tabWorkspaceId.value, name: "Chosen" } : null,
    writeTabWorkspace: (ws: unknown) => mocks.writeTabWorkspace(ws),
    clearTabWorkspace: () => mocks.clearTabWorkspace(),
}));

vi.mock<typeof import("vue-i18n")>("vue-i18n", () => ({
    useI18n: () => ({ t: (key: string) => key }),
}));

import WorkspacePicker from "../WorkspacePicker.vue";

/** 用桩替换真实创建对话框：只暴露 open / close / created 三个契约点。 */
const CreateDialogStub = {
    name: "WorkspaceCreateDialog",
    props: { open: { type: Boolean, default: false } },
    emits: ["close", "created"],
    template: '<div data-testid="create-dialog-stub" :data-open="String(open)" />',
};

function mountPicker() {
    return mount(WorkspacePicker, {
        global: { stubs: { WorkspaceCreateDialog: CreateDialogStub } },
    });
}

const NEW_ID = "33333333-3333-3333-3333-333333333333";

describe("WorkspacePicker", () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        mocks.replace.mockReset().mockResolvedValue(undefined);
        mocks.push.mockReset().mockResolvedValue(undefined);
        mocks.listWorkspaces.mockReset();
        mocks.writeTabWorkspace.mockReset();
        mocks.clearTabWorkspace.mockReset();
        mocks.tabWorkspaceId.value = null;
    });

    it("BL-172: 清掉过期 tab 上下文后再重定向", async () => {
        mocks.tabWorkspaceId.value = "11111111-1111-1111-1111-111111111111";
        mocks.listWorkspaces.mockResolvedValue([]);

        mountPicker();
        await flushPromises();

        expect(mocks.clearTabWorkspace).toHaveBeenCalled();
        expect(mocks.replace).toHaveBeenCalledWith({
            name: "workspace",
            params: { workspaceId: "11111111-1111-1111-1111-111111111111" },
        });
    });

    it("BL-172: 重定向失败时退回列表，不留在 loading", async () => {
        mocks.tabWorkspaceId.value = "11111111-1111-1111-1111-111111111111";
        mocks.replace.mockRejectedValueOnce(new Error("bounced"));
        mocks.listWorkspaces.mockResolvedValue([{ id: NEW_ID, name: "Second" }]);

        const wrapper = mountPicker();
        await flushPromises();

        expect(mocks.listWorkspaces).toHaveBeenCalled();
        expect(wrapper.get('[data-testid="workspace-picker"]').text()).not.toContain(
            "workspacePicker.loading",
        );
        expect(wrapper.find(`[data-testid="workspace-picker-item-${NEW_ID}"]`).exists()).toBe(true);
    });

    // ── BL-540：副标题只在「真的多于一个工作区」时出现 ────────────────────────
    it("BL-540: 单工作区时不渲染「属于多个工作区」的副标题", async () => {
        mocks.listWorkspaces.mockResolvedValue([{ id: NEW_ID, name: "Only one" }]);

        const wrapper = mountPicker();
        await flushPromises();

        expect(wrapper.find(`[data-testid="workspace-picker-item-${NEW_ID}"]`).exists()).toBe(true);
        expect(wrapper.text(), "单工作区账号不该被告知属于多个工作区").not.toContain(
            "workspacePicker.subtitle",
        );
        expect(wrapper.text()).toContain("workspacePicker.title");
    });

    it("BL-540: 多工作区时保留副标题（正向对照，避免上一条恒真）", async () => {
        mocks.listWorkspaces.mockResolvedValue([
            { id: NEW_ID, name: "First" },
            { id: "44444444-4444-4444-4444-444444444444", name: "Second" },
        ]);

        const wrapper = mountPicker();
        await flushPromises();

        expect(wrapper.findAll("li").length).toBe(2);
        expect(wrapper.text()).toContain("workspacePicker.subtitle");
    });

    // ── PLAN-0614 M2 ─────────────────────────────────────────────────────────
    it("T3.5-①: 无工作区时渲染空态引导，点击打开创建对话框", async () => {
        mocks.listWorkspaces.mockResolvedValue([]);

        const wrapper = mountPicker();
        await flushPromises();

        expect(wrapper.find('[data-testid="workspace-picker-empty"]').exists()).toBe(true);
        const createButton = wrapper.get('[data-testid="workspace-picker-create"]');
        expect(createButton.text()).toBe("workspacePicker.createFirst");
        expect(wrapper.get('[data-testid="create-dialog-stub"]').attributes("data-open")).toBe(
            "false",
        );

        await createButton.trigger("click");

        expect(wrapper.get('[data-testid="create-dialog-stub"]').attributes("data-open")).toBe(
            "true",
        );
    });

    it("T3.5-③: 空态创建成功后刷新列表并进入新工作区", async () => {
        mocks.listWorkspaces
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                { id: NEW_ID, name: "My First Workspace", workspaceRole: "OWNER" },
            ]);

        const wrapper = mountPicker();
        await flushPromises();

        wrapper.getComponent(CreateDialogStub).vm.$emit("created", NEW_ID);
        await flushPromises();

        // 列表被重新拉取（第二次），并写入了 tab 上下文且导航到新工作区。
        expect(mocks.listWorkspaces).toHaveBeenCalledTimes(2);
        expect(mocks.writeTabWorkspace).toHaveBeenCalledWith(
            expect.objectContaining({ id: NEW_ID, name: "My First Workspace" }),
        );
        expect(mocks.push).toHaveBeenCalledWith({
            name: "workspace",
            params: { workspaceId: NEW_ID },
        });
    });
    // ── task-169 / F-02：列表页三件套（新建入口 / 搜索 / 空态出口）─────────────
    it("F-02: 有工作区时 header 也提供「新建工作区」入口；单工作区不显示搜索", async () => {
        mocks.listWorkspaces.mockResolvedValue([
            { id: "11111111-1111-1111-1111-111111111111", name: "Only one" },
        ]);

        const wrapper = mountPicker();
        await flushPromises();

        const headerCreate = wrapper.get('[data-testid="workspace-picker-new"]');
        expect(headerCreate.text()).toBe("workspacePicker.create");
        await headerCreate.trigger("click");
        expect(wrapper.get('[data-testid="create-dialog-stub"]').attributes("data-open")).toBe(
            "true",
        );
        // 只有一个工作区时不需要搜索面。
        expect(wrapper.find('[data-testid="workspace-picker-search"]').exists()).toBe(false);
    });

    it("F-02: 多工作区时按名称或 ID 过滤列表", async () => {
        mocks.listWorkspaces.mockResolvedValue([
            { id: "11111111-1111-1111-1111-111111111111", name: "Alpha" },
            { id: "44444444-4444-4444-4444-444444444444", name: "Beta" },
        ]);

        const wrapper = mountPicker();
        await flushPromises();
        expect(wrapper.findAll("li").length).toBe(2);

        const search = wrapper.get('[data-testid="workspace-picker-search"]');
        await search.setValue("beta");
        expect(wrapper.findAll("li").length).toBe(1);
        expect(
            wrapper
                .find('[data-testid="workspace-picker-item-44444444-4444-4444-4444-444444444444"]')
                .exists(),
        ).toBe(true);
        expect(
            wrapper
                .find('[data-testid="workspace-picker-item-11111111-1111-1111-1111-111111111111"]')
                .exists(),
        ).toBe(false);

        // ID 子串同样能命中（用户可以从日志/URL 里抄 ID 来搜）。
        await search.setValue("11111111");
        expect(wrapper.findAll("li").length).toBe(1);
        expect(
            wrapper
                .find('[data-testid="workspace-picker-item-11111111-1111-1111-1111-111111111111"]')
                .exists(),
        ).toBe(true);
    });

    it("F-02: 搜索无命中给「无匹配」文案与清除搜索出口", async () => {
        mocks.listWorkspaces.mockResolvedValue([
            { id: "11111111-1111-1111-1111-111111111111", name: "Alpha" },
            { id: "44444444-4444-4444-4444-444444444444", name: "Beta" },
        ]);

        const wrapper = mountPicker();
        await flushPromises();
        const search = wrapper.get('[data-testid="workspace-picker-search"]');
        await search.setValue("zzz-not-there");

        expect(wrapper.findAll("li").length).toBe(0);
        const empty = wrapper.get('[data-testid="workspace-picker-search-empty"]');
        expect(empty.text()).toContain("workspacePicker.searchEmpty");
        // 空结果 ≠ 没有工作区：出口是清除搜索，不是再点「新建」。
        await wrapper.get('[data-testid="workspace-picker-clear-search"]').trigger("click");
        expect(wrapper.findAll("li").length).toBe(2);
        expect(wrapper.find('[data-testid="workspace-picker-search-empty"]').exists()).toBe(false);
    });
});
