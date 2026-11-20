/**
 * task-57 / DSD-1476：statusLabel 的**可空兜底**判据（正反两分支）。
 *
 * <p>背景：WorkspaceEnvironmentView.vue 的 statusLabel(value: string) 原先直接
 * value.trim()，三处调用（:715 environment.status、:928 executionSpecSnapshot.status、
 * :1115 environment.runtime.status）都在**渲染期**执行。类型上这些字段必填，但值来自
 * 服务端响应，CP 旧版本或半初始化状态可能给 null/undefined ⇒ 抛 TypeError 变成渲染期
 * unhandled rejection：用户看到的是空白，而不是「未知状态」。</p>
 *
 * <p>判据分正反两支，缺一不可 —— 只钉「null 不抛」会漏掉「把正常值改坏」，
 * 只钉「正常值不变」会漏掉崩溃本体（旧实现就属于后者：它今天对合法值全绿）。</p>
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import WorkspaceEnvironmentView from "../pages/WorkspaceEnvironmentView.vue";
import { api } from "../../../composables/api";
import type * as apiModule from "../../../composables/api";
import { i18n } from "../../../i18n";
import { applyLocale } from "../../../i18n/locale";

vi.mock("vue-router", () => ({
    useRoute: () => ({
        params: { workspaceId: "workspace-1" },
        path: "/workspace/workspace-1/environment",
        query: {},
    }),
    createRouter: () => ({
        beforeEach: vi.fn<() => void>(),
        afterEach: vi.fn<() => void>(),
        push: vi.fn<() => void>(),
        replace: vi.fn<() => void>(),
    }),
    createWebHistory: () => ({}),
}));

vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message?: unknown) => string | number>(),
        error: vi.fn<(message?: unknown) => string | number>(),
    },
}));

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            getWorkspaceEnvironment: vi.fn<typeof apiModule.api.getWorkspaceEnvironment>(),
            getWorkspaceJobs: vi.fn<typeof apiModule.api.getWorkspaceJobs>(),
            releaseWorkspaceRuntime: vi.fn<typeof apiModule.api.releaseWorkspaceRuntime>(),
            updateWorkspaceExecutionMode:
                vi.fn<typeof apiModule.api.updateWorkspaceExecutionMode>(),
        },
    };
});

const mockedApi = vi.mocked(api, true);

/** 最小可渲染的 environment —— 单个字段由各用例按需覆盖成 null / undefined。 */
function environment(overrides: Record<string, unknown> = {}) {
    return {
        workspaceId: "workspace-1",
        status: "ready",
        storageBackend: "local",
        storageRef: "workspace-1",
        storageMode: "managed_import" as const,
        hostPath: null,
        executionMode: "docker" as const,
        runtime: {
            status: "up",
            deviceId: "device-1",
            lastHeartbeatAt: "2026-09-21T00:00:00Z",
        },
        ...overrides,
    };
}

function messageIn(locale: string, key: string): string {
    const messages = i18n.global.getLocaleMessage(locale) as Record<string, unknown>;
    const value = key
        .split(".")
        .reduce<unknown>(
            (acc, part) => (acc as Record<string, unknown> | undefined)?.[part],
            messages,
        );
    return typeof value === "string" ? value : "";
}

async function mountView() {
    const wrapper = mount(WorkspaceEnvironmentView, { global: { plugins: [i18n] } });
    await flushPromises();
    return wrapper;
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("xihe-token", "mock-token");
    setActivePinia(createPinia());
    // 同目录既有 spec 的经验：applyLocale 是全局态，本族用例自钉 zh-CN。
    applyLocale("zh-CN");
    mockedApi.getWorkspaceEnvironment.mockResolvedValue(environment() as never);
    mockedApi.getWorkspaceJobs.mockResolvedValue([] as never);
});

describe("statusLabel 可空兜底（task-57）", () => {
    it("反分支：environment.status 为 undefined 时不抛，徽标渲染「未知状态」", async () => {
        const missing = environment() as Record<string, unknown>;
        delete missing.status;
        mockedApi.getWorkspaceEnvironment.mockResolvedValue(missing as never);

        const wrapper = await mountView();
        const badge = wrapper.get('[data-testid="workspace-environment-status"]');

        expect(badge.text()).toBe(messageIn("zh-CN", "workspace.environmentStatusUnknown"));
        // 定位到具体那格：整页渲染没有中断（不是「抛了但某处吞掉」）。
        expect(wrapper.find('[data-testid="workspace-environment-heading"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="workspace-environment-recovery"]').exists()).toBe(true);
    });

    it("反分支：environment.status 为 null 时不抛，且 runtime.status 同时为 null 也不抛", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue(
            environment({
                status: null,
                runtime: {
                    status: null,
                    deviceId: "device-1",
                    lastHeartbeatAt: "2026-09-21T00:00:00Z",
                },
            }) as never,
        );

        const wrapper = await mountView();
        const unknown = messageIn("zh-CN", "workspace.environmentStatusUnknown");

        expect(wrapper.get('[data-testid="workspace-environment-status"]').text()).toBe(unknown);
        expect(wrapper.get('[data-testid="workspace-runtime-status"]').text()).toBe(unknown);
    });

    it("反分支：runtime.status 缺失（undefined）时该格退化为「未知状态」，整页仍渲染", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue(
            environment({
                runtime: {
                    deviceId: "device-1",
                    lastHeartbeatAt: "2026-09-21T00:00:00Z",
                },
            }) as never,
        );

        const wrapper = await mountView();

        expect(wrapper.get('[data-testid="workspace-runtime-status"]').text()).toBe(
            messageIn("zh-CN", "workspace.environmentStatusUnknown"),
        );
    });

    // 这一格**不经过** statusLabel：模板 :913 的三元先判 executionSpecSnapshot?.status，
    // 空值直接走「尚未探测」（task-91 口径：整层没给 ≠ 值不认识）。本用例钉的是
    // 「这条路径在 null 下也不抛」，而不是它渲染成哪个词 —— 顺带把它的真实出口写死，
    // 免得以后有人把三元拆掉、让 statusLabel 真的吃到 null 时无人发现。
    it("反分支：executionSpec.status 为 null 时不抛，走「尚未探测」而不是「未知状态」", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue(
            environment({
                executionSpec: { status: null, generation: 1, sandboxSpecHash: "" },
            }) as never,
        );

        const wrapper = await mountView();

        const cell = wrapper.get('[data-testid="workspace-execution-spec-status"]');
        expect(cell.text()).toContain(messageIn("zh-CN", "workspace.environmentStatusUnprobed"));
        // 提示句也在场 —— 证明走的是「未探测」整条分支，不是把空值当未知值糊过去。
        expect(
            wrapper.find('[data-testid="workspace-execution-spec-unprobed-hint"]').exists(),
        ).toBe(true);
    });

    it("正分支：合法值仍按词表映射（ready ⇒ 就绪；assigned ⇒ 已分配执行配置）", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue(
            environment({
                status: "ready",
                executionSpec: { status: "assigned", generation: 1, sandboxSpecHash: "" },
                runtime: {
                    status: "up",
                    deviceId: "device-1",
                    lastHeartbeatAt: "2026-09-21T00:00:00Z",
                },
            }) as never,
        );

        const wrapper = await mountView();
        const unknown = messageIn("zh-CN", "workspace.environmentStatusUnknown");

        expect(wrapper.get('[data-testid="workspace-environment-status"]').text()).toBe(
            messageIn("zh-CN", "workspace.environmentStatus.ready"),
        );
        expect(wrapper.get('[data-testid="workspace-execution-spec-status"]').text()).toBe(
            messageIn("zh-CN", "workspace.environmentStatus.assigned"),
        );
        expect(wrapper.get('[data-testid="workspace-environment-status"]').text()).not.toBe(
            unknown,
        );
    });

    it("正分支：值不认识（不是 null）仍走「未知状态」，且原值只留在属性上", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue(
            environment({ status: "hibernating" }) as never,
        );

        const wrapper = await mountView();
        const badge = wrapper.get('[data-testid="workspace-environment-status"]');

        expect(badge.text()).toBe(messageIn("zh-CN", "workspace.environmentStatusUnknown"));
        expect(badge.attributes("data-value")).toBe("hibernating");
    });
});
