import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { config, flushPromises, mount } from "@vue/test-utils";
import ProviderHub from "../ProviderHub.vue";
import {
    openSelect,
    selectItemTextsFor,
    setSelectValue,
    setSelectWithin,
} from "../../../test-utils/select";
import type {
    ApiTypePair,
    ProviderConnection,
    ProviderDefinition,
    ProviderApiTypeCapability,
    SupportedApiTypeEntry,
} from "../../../types/providerConnection";
import {
    createProviderConnection,
    deleteProviderConnection,
    getDeleteImpact,
    listProviderCatalog,
    listProviderConnections,
    inspectModelDiscoveryUrl,
    updateProviderConnection,
    verifyProviderConnection,
} from "../../../services/providerConnectionService";
import { ApiError, api, request } from "../../../composables/api";
import type { CredentialSummary } from "../../../types";
import { toast } from "vue-sonner";
import { listVisibleTemplates, readTemplateConfig } from "../../../services/apiRequestTemplates";
import { useConfigStore } from "../../../stores/config";
import { i18n } from "../../../i18n";
import { formatApiType } from "../../../lib/apiTypeLabels";
import type * as apiRequestTemplatesModule from "../../../services/apiRequestTemplates";
import type * as providerConnectionServiceModule from "../../../services/providerConnectionService";
import type * as apiModule from "../../../composables/api";

// PLAN-0523 T3.4: install the real i18n plugin so template strings resolve.
(config.global.plugins ??= []).push(i18n);

vi.mock("../../../services/apiRequestTemplates", async (importOriginal) => ({
    ...(await importOriginal<typeof apiRequestTemplatesModule>()),
    listVisibleTemplates: vi.fn<typeof listVisibleTemplates>(),
    readTemplateConfig: vi.fn<typeof readTemplateConfig>(),
}));

// task-284：改为 spread importOriginal —— `chatModelNamesOf` **保持真实现**（它是「一条连接下可用于
// 对话的模型」的唯一口径，ProviderHub 现在委托它而不是持副本）。先前是 factory-only mock，只列了网络
// 函数 ⇒ 组件一旦用到未列出的导出就是 undefined，渲染直接抛（本次迁移实测 8 条红）。与
// InstanceAgentsPanel.spec.ts 同口径：只换需要断言的网络面，纯函数留真。
vi.mock("../../../services/providerConnectionService", async (importOriginal) => ({
    ...(await importOriginal<typeof providerConnectionServiceModule>()),
    listProviderCatalog: vi.fn<typeof providerConnectionServiceModule.listProviderCatalog>(),
    listProviderConnections:
        vi.fn<typeof providerConnectionServiceModule.listProviderConnections>(),
    createProviderConnection:
        vi.fn<typeof providerConnectionServiceModule.createProviderConnection>(),
    updateProviderConnection:
        vi.fn<typeof providerConnectionServiceModule.updateProviderConnection>(),
    verifyProviderConnection:
        vi.fn<typeof providerConnectionServiceModule.verifyProviderConnection>(),
    deleteProviderConnection:
        vi.fn<typeof providerConnectionServiceModule.deleteProviderConnection>(),
    getDeleteImpact: vi.fn<typeof providerConnectionServiceModule.getDeleteImpact>(),
}));
vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        request: vi.fn<typeof request>(),
        // task-146：ProviderHub 的凭据候选走 api.listCredentials。其余 api 面保持真实现
        // （既有断言只看 request 的调用），只把这一个方法换成替身，避免 jsdom 里打真网络。
        api: { ...actual.api, listCredentials: vi.fn<typeof actual.api.listCredentials>() },
    };
});
vi.mock("../../../lib/logger", () => ({ logger: { warn: vi.fn<(...args: unknown[]) => void>() } }));
vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message: string) => void>(),
        error: vi.fn<(message: string) => void>(),
        warning: vi.fn<(message: string) => void>(),
    },
}));

const provider: ProviderDefinition = {
    id: "example",
    displayName: "Example",
    adapter: "openai-compatible",
    defaultBaseUrl: "https://example.test/v1",
    modelDiscovery: "remote-models",
    credential: { type: "api-key", required: true },
    supports: { customBaseUrl: true, streaming: true },
    supportedApiTypes: [{ apiTypeId: "openai-chat-completions", version: 1 }],
    defaultApiType: { apiTypeId: "openai-chat-completions", version: 1 },
};
const user: ProviderConnection = {
    id: "user-connection",
    providerId: provider.id,
    connectionKey: "primary",
    apiTypeId: "openai-chat-completions",
    apiTypeVersion: 1,
    operation: "chat",
    label: "User connection",
    scope: "USER",
    baseUrl: "https://example.test/v1",
    modelDiscovery: "curated",
    manualModels: ["preserved-manual-model"],
    hasKey: true,
    enabled: true,
    status: "READY",
    revision: 1,
};
const workspace: ProviderConnection = {
    ...user,
    id: "workspace-connection",
    scope: "WORKSPACE",
    label: "Workspace connection",
    apiTypeId: "other-type",
};

async function mountHub(readonly = false) {
    const wrapper = mount(ProviderHub, { props: { scope: "USER", readonly } });
    await flushPromises();
    // task-121：`ProviderHub` 不再在 mount 时自己取层配置（子组件不回写全局 loading 状态）。
    // 取数由**页面**负责 —— 测试里显式扮演这个角色，否则 `layerConfig` 恒空、profile 派生不出来。
    try {
        await useConfigStore().loadLayerDomains("user");
    } catch {
        // 少数用例不给 /config/* 的 mock 响应；取数失败不影响它们要断言的行为。
    }
    await flushPromises();
    return wrapper;
}

beforeEach(() => {
    // PLAN-0523 T3.5: ProviderHub reads connections from the config store — give
    // each test an isolated pinia so the store cache never leaks between cases.
    setActivePinia(createPinia());
    vi.restoreAllMocks();
    vi.resetAllMocks();
    vi.mocked(listVisibleTemplates).mockResolvedValue([]);
    vi.mocked(readTemplateConfig).mockResolvedValue({});
    vi.mocked(listProviderCatalog).mockResolvedValue({
        catalogRevision: "1",
        providers: [provider],
    });
    vi.mocked(listProviderConnections).mockResolvedValue({ connections: [user, workspace] });
    vi.mocked(request).mockResolvedValue({
        providers: {
            [user.id]: { connectionId: user.id, models: [{ name: "user-model" }] },
            [workspace.id]: { connectionId: workspace.id, models: [{ name: "workspace-model" }] },
        },
    });
    vi.mocked(createProviderConnection).mockResolvedValue(user);
    vi.mocked(api.listCredentials).mockResolvedValue({ credentials: [], count: 0 });
    vi.mocked(updateProviderConnection).mockResolvedValue(user);
    vi.mocked(verifyProviderConnection).mockResolvedValue({ connection: user, models: [] });
});

describe("ProviderHub master-detail", () => {
    it("writes the default template binding to the user layer (task-253: no workspace layer)", async () => {
        const target = { ...workspace, apiTypeId: user.apiTypeId, workspaceId: "workspace-b" };
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [target] });
        vi.mocked(listVisibleTemplates).mockResolvedValue([
            {
                layer: "instance",
                templateId: "builtin",
                version: 1,
                name: "Built in",
                apiTypeId: user.apiTypeId,
                apiTypeVersion: 1,
            },
        ]);
        const wrapper = mount(ProviderHub, {
            props: { scope: "WORKSPACE", workspaceId: "workspace-a" },
        });
        await flushPromises();
        await setSelectValue(
            wrapper,
            '[data-slot="select-trigger"][aria-label="' +
                i18n.global.t("settings.providerHub.connDefaultTemplate") +
                '"]',
            "instance:builtin:1",
        );
        await flushPromises();
        // 连接的 scope/workspaceId 是**连接归属**那根轴，不再决定配置层；配置层只剩实例/用户。
        expect(readTemplateConfig).toHaveBeenCalledWith("user");
        expect(request).toHaveBeenCalledWith(
            "/config/user/api-request-templates",
            expect.objectContaining({ method: "PUT" }),
        );
        wrapper.unmount();
    });
    it("loads visible templates from the two UI layers without a workspace argument", async () => {
        const wrapper = mount(ProviderHub, {
            props: { scope: "USER", workspaceId: "current-workspace" },
        });
        await flushPromises();
        expect(listVisibleTemplates).toHaveBeenCalledWith();
        expect(readTemplateConfig).toHaveBeenCalledWith("user");
        wrapper.unmount();
    });
    it("groups connections by Provider and switches the entire detail by connection ID", async () => {
        const wrapper = await mountHub();
        const rows = wrapper.findAll('[data-testid="provider-connection-example"]');
        expect(rows).toHaveLength(2);
        expect(rows[0]!.attributes("data-connection-key")).toBe("primary");
        expect(rows[0]!.text()).toContain("User");
        expect(rows[1]!.text()).toContain("Workspace");
        expect(wrapper.get('[data-testid="provider-connection-models"]').text()).toContain(
            "user-model",
        );
        await rows[1]!.get("button[aria-pressed]").trigger("click");
        const detail = wrapper.get('[data-testid="provider-connection-detail"]');
        expect(detail.attributes("data-connection-id")).toBe(workspace.id);
        expect(detail.text()).toContain("workspace-model");
        expect(detail.text()).not.toContain("user-model");
        expect(detail.get('[data-testid="provider-connection-readonly-type"]').text()).toContain(
            "other-type@1",
        );
        expect(detail.find('[data-slot="select-trigger"]').exists()).toBe(true);
        expect(detail.text()).toContain(i18n.global.t("settings.providerHub.credentialConfigured"));
        expect(wrapper.text()).not.toContain("个人连接对同一 Provider 优先");
        expect(wrapper.get('[data-testid="provider-master-detail"]').classes()).toContain("grid");
        // task-106 / DEV-011:196：READY 状态是正文文案（详情 dd 与卡面 chip 同为 14px/12px 正文），
        // 需 ≥4.5:1。-600 对 --background/-card 不达标，改用 -700（深色侧 -400 不变）。
        // jsdom 不算 Tailwind/对比度，故钉结构契约：模板里不得再出现 -600。
        // 读数见 internal/A03-xihe/evidence/2026-11-17-ui-contrast-probe/（本注释不复制读数 D-1767）。
        const statusDds = detail.findAll("dd").filter((dd) => dd.text().includes("已连接"));
        expect(statusDds.length).toBeGreaterThan(0);
        for (const dd of statusDds) {
            const cls = dd.attributes("class") ?? "";
            expect(cls).toContain("text-emerald-700");
            expect(cls).not.toContain("text-emerald-600");
        }
        wrapper.unmount();
    });

    it("filters key/scope navigation and shows an explicit no-match detail", async () => {
        const wrapper = await mountHub();
        await wrapper.get('[data-testid="provider-connection-search"]').setValue("workspace");
        expect(wrapper.findAll('[data-testid="provider-connection-example"]')).toHaveLength(1);
        expect(
            wrapper
                .get('[data-testid="provider-connection-detail"]')
                .attributes("data-connection-id"),
        ).toBe(workspace.id);
        await wrapper.get('[data-testid="provider-connection-search"]').setValue("missing");
        expect(wrapper.find('[data-testid="provider-connection-detail"]').exists()).toBe(false);
        expect(wrapper.text()).toContain(i18n.global.t("settings.providerHub.noMatch"));
        wrapper.unmount();
    });

    it("gives the provider search box a real accessible name, not just a placeholder", async () => {
        const wrapper = await mountHub();
        const search = wrapper.get('[data-testid="provider-connection-search"]');
        const label = i18n.global.t("settings.providerHub.searchLabel");
        const placeholder = i18n.global.t("settings.providerHub.searchPlaceholder");
        // VTU 没有 role 查询：aria-label 就是该 textbox 的可访问名，
        // 等价于 getByRole("textbox", { name: label })；单独断言它与 placeholder 不同，
        // 防止以后把可访问名退回成 placeholder 兜底。
        expect(search.attributes("aria-label")).toBe(label);
        expect(search.attributes("placeholder")).toBe(placeholder);
        expect(label, "the label must be a real name distinct from the placeholder").not.toBe(
            placeholder,
        );
        expect(wrapper.get("label").text()).toContain(label);
        wrapper.unmount();
    });

    it("retains discovery/manualModels and never prefills or submits an unchanged secret", async () => {
        const wrapper = await mountHub();
        const row = wrapper.findAll('[data-testid="provider-connection-example"]')[0]!;
        await row
            .findAll("button")
            .find((button) => button.text() === i18n.global.t("settings.providerHub.manage"))!
            .trigger("click");
        const modal = wrapper.get('[data-testid="provider-connection-modal"]');
        // task-146：编辑既有连接默认停在「保留当前绑定」，密钥输入框根本不渲染 ⇒ 无从预填。
        expect(modal.find('input[type="password"]').exists()).toBe(false);
        expect(modal.get('[data-testid="provider-credential-current"]').exists()).toBe(true);
        // BL-476 L1 pilot: discovery is the vendored reka `Select` now, so the
        // modal no longer holds a native <select>; the closed trigger must still
        // surface the stored value instead of rendering empty.
        expect(modal.get('[data-testid="provider-connection-field-discovery"]').text()).toContain(
            i18n.global.t("settings.providerHub.discoveryCurated"),
        );
        expect(
            modal.get('[data-testid="provider-connection-form-key"]').attributes("readonly"),
        ).toBeDefined();
        await modal.get("form").trigger("submit");
        await flushPromises();
        expect(updateProviderConnection).toHaveBeenCalledWith(
            user.id,
            expect.objectContaining({
                modelDiscovery: "curated",
                manualModels: ["preserved-manual-model"],
            }),
        );
        expect(vi.mocked(updateProviderConnection).mock.calls[0]![1]).not.toHaveProperty("apiKey");
        wrapper.unmount();
    });

    it("derives the form scope from the connection and current page without a scope picker", async () => {
        const wrapper = mount(ProviderHub, {
            props: { scope: "WORKSPACE", workspaceId: "workspace-a" },
        });
        await flushPromises();
        const row = wrapper.findAll('[data-testid="provider-connection-example"]')[0]!;
        await row
            .findAll("button")
            .find((button) => button.text() === i18n.global.t("settings.providerHub.manage"))!
            .trigger("click");
        const modal = wrapper.get('[data-testid="provider-connection-modal"]');
        // A USER connection edited from the workspace tab keeps its own scope.
        expect(modal.text()).toContain(
            i18n.global.t("settings.providerHub.formScopeHint", {
                scope: i18n.global.t("settings.providerHub.scopeUser"),
            }),
        );
        expect(modal.findAll('input[type="radio"][name="provider-scope"]')).toHaveLength(0);
        wrapper.unmount();
    });

    it("keeps row-level deletion contract and falls back after deleting the selected connection", async () => {
        vi.mocked(getDeleteImpact).mockResolvedValue({
            connectionId: user.id,
            providerId: user.providerId,
            connectionKey: user.connectionKey,
            bindingCount: 0,
            bindingUserScopes: 0,
            defaultTemplateRef: false,
            profileCount: 0,
            profileScopes: [],
            sessionCount: 0,
            blocked: false,
        });
        const wrapper = await mountHub();
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [workspace] });
        const row = wrapper.findAll('[data-testid="provider-connection-example"]')[0]!;
        await row
            .findAll("button")
            .find((button) => button.text() === i18n.global.t("settings.providerHub.delete"))!
            .trigger("click");
        await flushPromises();
        expect(getDeleteImpact).toHaveBeenCalledWith(user.id);
        // PLAN-0505: the confirm dialog must show before the DELETE is issued.
        expect(deleteProviderConnection).not.toHaveBeenCalled();
        await wrapper.get('[data-testid="provider-delete-confirm"]').trigger("click");
        await flushPromises();
        expect(deleteProviderConnection).toHaveBeenCalledWith(user.id);
        // Review round-4 regression guard: the dialog must close on success
        // (the deleting-guard on cancel must not block the success path).
        expect(wrapper.find('[data-testid="provider-delete-confirm-modal"]').exists()).toBe(false);
        expect(
            wrapper
                .get('[data-testid="provider-connection-detail"]')
                .attributes("data-connection-id"),
        ).toBe(workspace.id);
        wrapper.unmount();
    });

    it("PLAN-0505: cancel closes the confirm dialog with zero mutations", async () => {
        vi.mocked(getDeleteImpact).mockResolvedValue({
            connectionId: user.id,
            providerId: user.providerId,
            connectionKey: user.connectionKey,
            bindingCount: 2,
            bindingUserScopes: 1,
            defaultTemplateRef: true,
            profileCount: 1,
            profileScopes: ["user"],
            sessionCount: 0,
            blocked: false,
        });
        const wrapper = await mountHub();
        const row = wrapper.findAll('[data-testid="provider-connection-example"]')[0]!;
        await row
            .findAll("button")
            .find((button) => button.text() === i18n.global.t("settings.providerHub.delete"))!
            .trigger("click");
        await flushPromises();
        const summary = wrapper.get('[data-testid="provider-delete-impact-summary"]');
        expect(summary.text()).toContain(
            i18n.global.t("settings.providerHub.impactModelBindings", { count: 2, scopes: 1 }),
        );
        expect(summary.text()).toContain(
            i18n.global.t("settings.providerHub.impactDefaultTemplate"),
        );
        expect(summary.text()).toContain(
            i18n.global.t("settings.providerHub.impactProfiles", { count: 1 }),
        );
        await wrapper.get('[data-testid="provider-delete-cancel"]').trigger("click");
        expect(wrapper.find('[data-testid="provider-delete-confirm-modal"]').exists()).toBe(false);
        expect(deleteProviderConnection).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it("PLAN-0505: blocked connections disable deletion and show the session hint", async () => {
        vi.mocked(getDeleteImpact).mockResolvedValue({
            connectionId: user.id,
            providerId: user.providerId,
            connectionKey: user.connectionKey,
            bindingCount: 0,
            bindingUserScopes: 0,
            defaultTemplateRef: false,
            profileCount: 0,
            profileScopes: [],
            sessionCount: 2,
            blocked: true,
        });
        const wrapper = await mountHub();
        const row = wrapper.findAll('[data-testid="provider-connection-example"]')[0]!;
        await row
            .findAll("button")
            .find((button) => button.text() === i18n.global.t("settings.providerHub.delete"))!
            .trigger("click");
        await flushPromises();
        expect(wrapper.get('[data-testid="provider-delete-blocked"]').text()).toContain(
            i18n.global.t("settings.providerHub.deleteBlocked", { count: 2 }),
        );
        expect(
            wrapper.get('[data-testid="provider-delete-confirm"]').attributes("disabled"),
        ).toBeDefined();
        expect(deleteProviderConnection).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it("PLAN-0505: a failed delete keeps the dialog open and reports the error", async () => {
        vi.mocked(getDeleteImpact).mockResolvedValue({
            connectionId: user.id,
            providerId: user.providerId,
            connectionKey: user.connectionKey,
            bindingCount: 0,
            bindingUserScopes: 0,
            defaultTemplateRef: false,
            profileCount: 0,
            profileScopes: [],
            sessionCount: 0,
            blocked: false,
        });
        vi.mocked(deleteProviderConnection).mockRejectedValue(new Error("CONNECTION_IN_USE"));
        const wrapper = await mountHub();
        const row = wrapper.findAll('[data-testid="provider-connection-example"]')[0]!;
        await row
            .findAll("button")
            .find((button) => button.text() === i18n.global.t("settings.providerHub.delete"))!
            .trigger("click");
        await flushPromises();
        await wrapper.get('[data-testid="provider-delete-confirm"]').trigger("click");
        await flushPromises();
        expect(wrapper.get('[data-testid="provider-delete-error"]').text()).toBe(
            "CONNECTION_IN_USE",
        );
        expect(wrapper.find('[data-testid="provider-delete-confirm-modal"]').exists()).toBe(true);
        wrapper.unmount();
    });

    it("allows readonly navigation but disables mutation controls", async () => {
        const wrapper = await mountHub(true);
        const rows = wrapper.findAll('[data-testid="provider-connection-example"]');
        await rows[1]!.get("button[aria-pressed]").trigger("click");
        expect(
            wrapper
                .get('[data-testid="provider-connection-detail"]')
                .attributes("data-connection-id"),
        ).toBe(workspace.id);
        expect(
            rows[1]!
                .findAll("button")
                .slice(1)
                .every((button) => button.attributes("disabled") !== undefined),
        ).toBe(true);
        expect(wrapper.find('[data-testid="provider-hub-connect"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it("does not mix models when the catalog belongs to another connection", async () => {
        vi.mocked(request).mockResolvedValue({
            providers: {
                [user.id]: { connectionId: workspace.id, models: [{ name: "wrong-model" }] },
            },
        });
        const wrapper = await mountHub();
        expect(wrapper.get('[data-testid="provider-connection-models"]').text()).not.toContain(
            "wrong-model",
        );
        expect(wrapper.get('[data-testid="provider-connection-models"]').text()).toContain(
            i18n.global.t("settings.providerHub.noModels"),
        );
        wrapper.unmount();
    });

    it("clears a cancelled replacement key without writing the connection", async () => {
        const wrapper = await mountHub();
        await wrapper.get('[data-testid="provider-connection-detail"] button').trigger("click");
        // task-146：替换密钥要先显式选「替换凭据」，再选「内联新建密钥」两态。
        await wrapper.get('[data-testid="provider-credential-replace"]').trigger("click");
        await wrapper.get('[data-testid="provider-credential-mode-inline"]').trigger("click");
        await wrapper
            .get('[data-testid="provider-credential-api-key"]')
            .setValue("replacement-for-test");
        await wrapper
            .get('button[aria-label="' + i18n.global.t("settings.providerHub.close") + '"]')
            .trigger("click");
        await wrapper.get('[data-testid="provider-connection-detail"] button').trigger("click");
        // 重开回到 keep 态：内联输入不再渲染，填过的密钥没有残留。
        expect(wrapper.find('[data-testid="provider-credential-api-key"]').exists()).toBe(false);
        expect(updateProviderConnection).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it("shows model load failure separately and keeps this connection's manual configuration", async () => {
        vi.mocked(request).mockRejectedValue(new Error("Model catalog unavailable"));
        vi.mocked(listProviderConnections).mockResolvedValue({
            connections: [{ ...user, modelDiscovery: "manual" }],
        });
        const wrapper = await mountHub();
        const models = wrapper.get('[data-testid="provider-connection-models"]');
        expect(models.text()).toContain(i18n.global.t("settings.providerHub.modelsError"));
        expect(models.text()).toContain("preserved-manual-model");
        // PLAN-0523 T3.2 行改版：请求模板下拉移入模型行展开区（点击行展开）。
        await models
            .get('[data-testid="provider-model-preserved-manual-model"] button')
            .trigger("click");
        expect(
            models.get('[data-testid="provider-model-detail-preserved-manual-model"]').exists(),
        ).toBe(true);
        expect(models.find('[data-slot="select-trigger"]').exists()).toBe(true);
        wrapper.unmount();
    });
});

describe("ProviderHub orphan template bindings (PLAN-0503)", () => {
    it("lists bindings whose model left the catalog and clears them only on user action", async () => {
        // Fresh object per call: the component mutates the returned entries and
        // relies on a new reference to trigger reactivity (same as the service).
        vi.mocked(readTemplateConfig).mockImplementation(async () => ({
            providerModelBindings: JSON.stringify({
                [user.id]: {
                    "ghost-model": { layer: "instance", templateId: "builtin", version: 1 },
                },
            }),
        }));
        const wrapper = await mountHub();

        const orphanSection = wrapper.get('[data-testid="provider-orphan-bindings"]');
        expect(orphanSection.text()).toContain("ghost-model");
        expect(orphanSection.text()).toContain(i18n.global.t("settings.providerHub.orphanTitle"));
        // Drift alone never triggers a write (I4: kept, visible, cleared by user).
        expect(
            vi.mocked(request).mock.calls.filter(([, init]) => init?.method === "PUT"),
        ).toHaveLength(0);

        await setSelectWithin(
            wrapper,
            '[data-testid="provider-orphan-model-ghost-model"]',
            "__inherit__",
        );
        await flushPromises();
        const put = vi.mocked(request).mock.calls.find(([, init]) => init?.method === "PUT");
        expect(put).toBeTruthy();
        expect(String(put![0])).toContain("/config/user/api-request-templates");
        const body = JSON.parse(String(put![1]!.body)) as Record<string, string>;
        expect(JSON.parse(body.providerModelBindings)).toEqual({});
        expect(wrapper.find('[data-testid="provider-orphan-bindings"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it("labels availability as unknown (not clearable) when the directory fetch fails", async () => {
        vi.mocked(request).mockRejectedValue(new Error("directory down"));
        vi.mocked(readTemplateConfig).mockImplementation(async () => ({
            providerModelBindings: JSON.stringify({
                [user.id]: {
                    "ghost-model": { layer: "instance", templateId: "builtin", version: 1 },
                },
            }),
        }));
        const wrapper = await mountHub();

        const orphanSection = wrapper.get('[data-testid="provider-orphan-bindings"]');
        expect(orphanSection.text()).toContain("ghost-model");
        expect(orphanSection.text()).toContain(
            i18n.global.t("settings.providerHub.orphanTitleError"),
        );
        expect(orphanSection.text()).not.toContain("可清除");
        wrapper.unmount();
    });
});

describe("ProviderHub 就地默认与每模型配置 (PLAN-0523 T3.2/T3.3)", () => {
    const second: ProviderConnection = {
        ...user,
        id: "second-connection",
        providerId: "other",
        connectionKey: "secondary",
        baseUrl: "https://other.test/v1",
    };
    const catalog = {
        providers: {
            "user-connection": {
                connectionId: "user-connection",
                providerId: "example",
                status: "ready",
                models: [
                    {
                        name: "mimo-v2.5",
                        capabilities: { chat: true },
                        inputModalities: ["text"],
                        outputModalities: ["text"],
                        contextWindowTokens: 128000,
                        maxOutputTokens: 8192,
                        pricing: { currency: "¥", unit: "1M tokens", input: 1.2, output: 4.8 },
                    },
                    { name: "mimo-asr", capabilities: { chat: false } },
                    { name: "mimo-v2.6-pro", capabilities: { chat: true } },
                ],
                verifiedAt: "2026-10-16T10:00:00Z",
            },
            "second-connection": {
                connectionId: "second-connection",
                providerId: "other",
                status: "ready",
                models: [
                    { name: "other-1", capabilities: { chat: true } },
                    { name: "other-2", capabilities: { chat: false } },
                ],
                verifiedAt: "2026-10-16T10:00:00Z",
            },
        },
    };
    const PROFILE_PRIMARY = JSON.stringify({
        providerId: "example",
        connectionKey: "primary",
        model: "mimo-v2.5",
    });

    /** request mock：/models 返回目录，/config/ 返回层 entries，其余走 api-input-types。 */
    function mockHubFetch(options: { profile?: string; modelParams?: string } = {}) {
        vi.mocked(request).mockImplementation((input) => {
            const url = typeof input === "string" ? input : input.url,
                parsed = new URL(url, "http://localhost");
            if (parsed.pathname.endsWith("/models")) {
                return Promise.resolve(catalog as never);
            }
            if (parsed.pathname.includes("/config/")) {
                const entries: Record<string, string> = {};
                if (options.profile !== undefined) entries.profile = options.profile;
                if (options.modelParams) entries.modelParams = options.modelParams;
                return Promise.resolve({
                    domain: "llm-provider",
                    entries,
                    envOverridden: {},
                } as never);
            }
            return Promise.resolve({ types: [] } as never);
        });
    }

    function requestPuts() {
        return vi
            .mocked(request)
            .mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT")
            .map(([input, init]) => ({
                url: typeof input === "string" ? input : input.url,
                body: JSON.parse(String((init as RequestInit).body ?? "{}")) as Record<
                    string,
                    string
                >,
            }));
    }

    function llmPuts() {
        return requestPuts().filter((call) => call.url.includes("/config/user/llm-provider"));
    }

    it("pins the stored default connection on top with a badge, not repeated in groups", async () => {
        mockHubFetch({ profile: PROFILE_PRIMARY });
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [user, second] });
        const wrapper = await mountHub();

        const pinned = wrapper.get('[data-testid="provider-default-connection"]');
        expect(pinned.attributes("data-connection-key")).toBe("primary");
        expect(pinned.text()).toContain(i18n.global.t("settings.providerHub.badgeDefault"));
        const occurrences = wrapper.findAll(
            '[data-testid="provider-master-detail"] nav [data-connection-key="primary"]',
        );
        expect(occurrences).toHaveLength(1);
        expect(occurrences[0]!.attributes("data-testid")).toBe("provider-default-connection");
        wrapper.unmount();
    });

    it("set-as-default writes the layer profile with the first chat model", async () => {
        mockHubFetch();
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [user, second] });
        const wrapper = await mountHub();

        await wrapper
            .get('[data-testid="provider-connection-default-second-connection"]')
            .trigger("click");
        await flushPromises();

        const puts = llmPuts();
        expect(puts).toHaveLength(1);
        expect(puts[0]!.body.profile).toBe(
            JSON.stringify({ providerId: "other", connectionKey: "secondary", model: "other-1" }),
        );
        wrapper.unmount();
    });

    it("实例层把「设为默认」写到 instance 层（task-284 / D-1140：同一套数据流，只换层）", async () => {
        mockHubFetch();
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [user, second] });
        // 实例层的挂载形态（ConfigLayerPanels）：scope=INSTANCE 决定新建连接归属，layer=instance 决定配置写哪层。
        const wrapper = mount(ProviderHub, { props: { scope: "INSTANCE", layer: "instance" } });
        await flushPromises();
        try {
            await useConfigStore().loadLayerDomains("instance");
        } catch {
            // 与 mountHub 同口径：取数失败不影响本用例要断言的行为。
        }
        await flushPromises();

        await wrapper
            .get('[data-testid="provider-connection-default-second-connection"]')
            .trigger("click");
        await flushPromises();

        const instancePuts = requestPuts().filter((call) =>
            call.url.includes("/config/instance/llm-provider"),
        );
        expect(instancePuts).toHaveLength(1);
        expect(instancePuts[0]!.body.profile).toBe(
            JSON.stringify({ providerId: "other", connectionKey: "secondary", model: "other-1" }),
        );
        // 关键负例：同一动作不得顺手写 user 层 —— 否则 profile 会变成两处真源（不是「派生值」）。
        expect(llmPuts()).toHaveLength(0);
        wrapper.unmount();
    });
    it("set-as-default keeps the stored model when it exists in the target catalog", async () => {
        // 默认连接为 user-connection；stored model other-1 在目标连接目录中 → 保留。
        mockHubFetch({
            profile: JSON.stringify({
                providerId: "example",
                connectionKey: "primary",
                model: "other-1",
            }),
        });
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [user, second] });
        const wrapper = await mountHub();

        await wrapper
            .get('[data-testid="provider-connection-default-second-connection"]')
            .trigger("click");
        await flushPromises();

        const puts = llmPuts();
        expect(puts).toHaveLength(1);
        expect(puts[0]!.body.profile).toBe(
            JSON.stringify({ providerId: "other", connectionKey: "secondary", model: "other-1" }),
        );
        wrapper.unmount();
    });

    it("keeps a drifted stored default as an amber kept entry at the list top", async () => {
        mockHubFetch({
            profile: JSON.stringify({
                providerId: "example",
                connectionKey: "gone-key",
                model: "mimo-v2.5",
            }),
        });
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [user] });
        const wrapper = await mountHub();

        const drift = wrapper.get('[data-testid="provider-default-drift"]');
        expect(drift.text()).toContain("gone-key");
        expect(drift.text()).toContain(i18n.global.t("settings.providerHub.driftBadge"));
        expect(wrapper.find('[data-testid="provider-default-connection"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it("pins the default model on top of the default connection's model list", async () => {
        mockHubFetch({
            profile: JSON.stringify({
                providerId: "example",
                connectionKey: "primary",
                model: "mimo-v2.6-pro",
            }),
        });
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [user, second] });
        const wrapper = await mountHub();

        const rows = wrapper.findAll(
            '[data-testid="provider-connection-models"] li[data-testid^="provider-model-"]',
        );
        expect(rows[0]!.attributes("data-testid")).toBe("provider-model-mimo-v2.6-pro");
        expect(rows[0]!.text()).toContain(i18n.global.t("settings.providerHub.badgeDefault"));
        wrapper.unmount();
    });

    it("set-model-as-default writes the profile with the picked model", async () => {
        mockHubFetch({
            profile: JSON.stringify({
                providerId: "example",
                connectionKey: "primary",
                model: "mimo-v2.6-pro",
            }),
        });
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [user, second] });
        const wrapper = await mountHub();

        await wrapper.get('[data-testid="provider-model-default-mimo-v2.5"]').trigger("click");
        await flushPromises();

        const puts = llmPuts();
        expect(puts).toHaveLength(1);
        expect(puts[0]!.body.profile).toBe(
            JSON.stringify({ providerId: "example", connectionKey: "primary", model: "mimo-v2.5" }),
        );
        wrapper.unmount();
    });

    it("saves per-model sampling params into the whole-unit modelParams map", async () => {
        mockHubFetch({ profile: PROFILE_PRIMARY });
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [user, second] });
        const wrapper = await mountHub();

        await wrapper.get('[data-testid="provider-model-mimo-v2.5"] button').trigger("click");
        await wrapper
            .get(
                `input[aria-label="${i18n.global.t("settings.providerHub.maxTokensAria", {
                    model: "mimo-v2.5",
                })}"]`,
            )
            .setValue("4096");
        await wrapper
            .get(
                `input[aria-label="${i18n.global.t("settings.providerHub.temperatureAria", {
                    model: "mimo-v2.5",
                })}"]`,
            )
            .setValue("0.7");
        await wrapper
            .get(
                `input[aria-label="${i18n.global.t("settings.providerHub.timeoutAria", {
                    model: "mimo-v2.5",
                })}"]`,
            )
            .setValue("60");
        await wrapper.get('[data-testid="provider-model-params-save-mimo-v2.5"]').trigger("click");
        await flushPromises();

        const puts = llmPuts();
        expect(puts).toHaveLength(1);
        expect(puts[0]!.body.profile).toBe(PROFILE_PRIMARY);
        expect(JSON.parse(puts[0]!.body.modelParams ?? "{}")).toEqual({
            "mimo-v2.5": { maxTokens: 4096, temperature: 0.7, timeout: 60 },
        });
        wrapper.unmount();
    });

    /**
     * task-26：ProviderHub 必须把「每模型采样参数草稿 vs 已存值」接进离开守卫的同一套 dirty 信号。
     * 口径要点三条（对应 Lead 收紧 ⑤）：
     * ① 基准层 = 当前层的 `llm-provider.modelParams`（`storedModelParams`，ProviderHub.vue:411-419），不是内存历史拷贝；
     * ② 比较「解析后的数值」而不是输入框字符串（ProviderHub.vue:428-433 `parseParamValue` 与保存同一份解析）；
     * ③ 保存后必须自然回落 false —— 靠 `saveModelParams` :488 重取层配置驱动，不靠手动清标志。
     */
    it("task-26：采样参数草稿脏状态按数值比较，未改不脏 / 改数值才脏 / 保存后回落", async () => {
        let storedParams = JSON.stringify({ "mimo-v2.5": { maxTokens: 4096 } });
        vi.mocked(request).mockImplementation((input, init) => {
            const url = typeof input === "string" ? input : input.url,
                parsed = new URL(url, "http://localhost");
            if (init?.method === "PUT") {
                const body = JSON.parse(String(init.body ?? "{}")) as Record<string, string>;
                if (typeof body.modelParams === "string") storedParams = body.modelParams;
                return Promise.resolve({} as never);
            }
            if (parsed.pathname.endsWith("/models")) return Promise.resolve(catalog as never);
            if (parsed.pathname.includes("/config/")) {
                return Promise.resolve({
                    domain: "llm-provider",
                    entries: { profile: PROFILE_PRIMARY, modelParams: storedParams },
                    envOverridden: {},
                } as never);
            }
            return Promise.resolve({ types: [] } as never);
        });
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [user, second] });
        const wrapper = await mountHub();

        await wrapper.get('[data-testid="provider-model-mimo-v2.5"] button').trigger("click");
        await flushPromises();
        expect(wrapper.emitted("dirty")?.at(-1)).toEqual([false]);

        const maxTokensInput = () =>
            wrapper.get(
                `input[aria-label="${i18n.global.t("settings.providerHub.maxTokensAria", {
                    model: "mimo-v2.5",
                })}"]`,
            );
        // 同值重输（字符串 "4096" vs 已存 number 4096）不算脏 —— 比字符串会在这里假脏。
        await maxTokensInput().setValue("4096");
        await flushPromises();
        expect(wrapper.emitted("dirty")?.at(-1)).toEqual([false]);

        await maxTokensInput().setValue("6000");
        await flushPromises();
        expect(wrapper.emitted("dirty")?.at(-1)).toEqual([true]);

        await wrapper.get('[data-testid="provider-model-params-save-mimo-v2.5"]').trigger("click");
        await flushPromises();
        expect(JSON.parse(storedParams)["mimo-v2.5"].maxTokens).toBe(6000);
        expect(wrapper.emitted("dirty")?.at(-1)).toEqual([false]);
        wrapper.unmount();
    });

    it("shows model details with catalog metadata and 未知 fallbacks (T3.3)", async () => {
        mockHubFetch({ profile: PROFILE_PRIMARY });
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [user] });
        const wrapper = await mountHub();

        const btn = wrapper.get('[data-testid="provider-model-mimo-v2.5"] button');
        await btn.trigger("click");
        const detail = wrapper.get('[data-testid="provider-model-detail-mimo-v2.5"]');
        expect(detail.text()).toContain("text");
        expect(detail.text()).toContain("128,000");
        expect(detail.text()).toContain("8,192");
        expect(detail.text()).toContain("¥1.2/1M tokens");
        wrapper.unmount();
    });

    it("shows 未知 for catalog models without metadata (T3.3)", async () => {
        mockHubFetch({ profile: PROFILE_PRIMARY });
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [user] });
        const wrapper = await mountHub();

        await wrapper.get('[data-testid="provider-model-mimo-asr"] button').trigger("click");
        const detail = wrapper.get('[data-testid="provider-model-detail-mimo-asr"]');
        expect(detail.text()).toContain(i18n.global.t("settings.providerHub.unknown"));
        wrapper.unmount();
    });
});

describe("ProviderHub label rules (PLAN-0555)", () => {
    async function openManageForm(wrapper: Awaited<ReturnType<typeof mountHub>>) {
        const row = wrapper.findAll('[data-testid="provider-connection-example"]')[0]!;
        await row
            .findAll("button")
            .find((button) => button.text() === i18n.global.t("settings.providerHub.manage"))!
            .trigger("click");
        return wrapper.get('[data-testid="provider-connection-modal"]');
    }

    it("blocks an empty label before calling the API", async () => {
        const wrapper = await mountHub(),
            modal = await openManageForm(wrapper);
        await modal.get('[data-testid="provider-connection-form-label"]').setValue("   ");
        await modal.get("form").trigger("submit");
        await flushPromises();

        expect(toast.error).toHaveBeenCalledWith(
            i18n.global.t("settings.providerHub.toastLabelRequired"),
        );
        expect(updateProviderConnection).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it("blocks a label longer than 40 characters before calling the API", async () => {
        const wrapper = await mountHub(),
            modal = await openManageForm(wrapper);
        await modal.get('[data-testid="provider-connection-form-label"]').setValue("x".repeat(41));
        await modal.get("form").trigger("submit");
        await flushPromises();

        expect(toast.error).toHaveBeenCalledWith(
            i18n.global.t("settings.providerHub.toastLabelTooLong"),
        );
        expect(updateProviderConnection).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it("blocks control characters before calling the API", async () => {
        const wrapper = await mountHub(),
            modal = await openManageForm(wrapper);
        await modal.get('[data-testid="provider-connection-form-label"]').setValue("bad\tname");
        await modal.get("form").trigger("submit");
        await flushPromises();

        expect(toast.error).toHaveBeenCalledWith(
            i18n.global.t("settings.providerHub.toastLabelControl"),
        );
        expect(updateProviderConnection).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it("warns on a case-insensitive sibling label but still submits", async () => {
        const sibling: ProviderConnection = {
            ...user,
            id: "user-connection-2",
            connectionKey: "secondary",
            label: "Second connection",
        };
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [user, sibling] });
        const wrapper = await mountHub(),
            modal = await openManageForm(wrapper);
        await modal
            .get('[data-testid="provider-connection-form-label"]')
            .setValue("second CONNECTION");
        await modal.get("form").trigger("submit");
        await flushPromises();

        expect(toast.warning).toHaveBeenCalledWith(
            i18n.global.t("settings.providerHub.toastLabelDuplicate"),
        );
        expect(updateProviderConnection).toHaveBeenCalledWith(
            user.id,
            expect.objectContaining({ label: "second CONNECTION" }),
        );
        wrapper.unmount();
    });

    it("maps the 409 label conflict to a localized message and keeps the dialog", async () => {
        vi.mocked(updateProviderConnection).mockRejectedValue(
            new ApiError({
                status: 409,
                code: "PROVIDER_CONNECTION_LABEL_CONFLICT",
                requestId: "test-request",
                field: "label",
            }),
        );
        const wrapper = await mountHub(),
            modal = await openManageForm(wrapper);
        await modal
            .get('[data-testid="provider-connection-form-label"]')
            .setValue("Duplicate name");
        await modal.get("form").trigger("submit");
        await flushPromises();

        expect(toast.error).toHaveBeenCalledWith(
            i18n.global.t("settings.providerHub.toastLabelConflict"),
        );
        expect(wrapper.find('[data-testid="provider-connection-modal"]').exists()).toBe(true);
        wrapper.unmount();
    });
});

describe("PLAN-0591 tool capability visibility", () => {
    it("shows the provider partial badge and per-API-Type capability detail", async () => {
        vi.mocked(listProviderCatalog).mockResolvedValue({
            catalogRevision: "v2",
            providers: [
                {
                    ...provider,
                    supports: { ...provider.supports, tools: true, toolsPartial: true },
                    // task-465（D-1318）：类型 id 用 CP 真名（`api-input-types.json` / `providers.json:11`）。
                    // **第二个是合成类型，不是 CP id**：CP 里 openai 只支持一个类型，这里造第二个只为测
                    // 「同 provider 两类型 capability 差异 ⇒ toolsPartial」这条 UI 判定。**不要改成某个真 id**
                    // （那会造出「openai 支持别家类型」的新非法组合，正是 task-457 修掉的漂移）。Lead 裁定保留。
                    supportedApiTypes: [
                        {
                            apiTypeId: "openai-chat-completions",
                            version: 1,
                            capability: { tools: true },
                        },
                        { apiTypeId: "legacy-responses", version: 1, capability: { tools: false } },
                    ],
                },
            ],
        });
        const wrapper = await mountHub();
        await wrapper.get('[data-testid="provider-hub-connect"]').trigger("click");
        expect(
            wrapper.find('[data-testid="provider-supports-tools-partial-example"]').exists(),
        ).toBe(true);
        await wrapper.get('[data-testid="provider-picker-example"]').trigger("click");
        const modal = wrapper.get('[data-testid="provider-connection-modal"]');
        const detail = modal.get('[data-testid="connection-api-type-capabilities"]').text();
        // task-465（D-1318 / D-1319）：夹具改用 CP 真名后，产品**显示本地化短名**而不是裸 id
        // （`lib/apiTypeLabels.ts:9-15` 只登记 CP 真名）⇒ 期望值跟着变，**匹配方式不变**（仍 toContain）。
        // 期望串**从产品自己的 formatter 派生**，不在 spec 里抄一份中文字面量（抄的那份会随译文漂）。
        expect(detail).toContain(
            formatApiType("openai-chat-completions", 1, (key) => i18n.global.t(key)),
        );
        expect(detail).toContain(i18n.global.t("settings.providerHub.apiTypeToolsSupported"));
        // 合成类型没有标签映射 ⇒ **原样显示裸 id**（`apiTypeLabels.ts:6-7` 的诚实回退）。
        // 这一对断言同时钉住「标签映射只覆盖 CP 真名，未登记的不猜名字」。
        expect(detail).toContain("legacy-responses@1");
        expect(detail).toContain(i18n.global.t("settings.providerHub.apiTypeToolsUnsupported"));
        wrapper.unmount();
    });

    it("PLAN-0591 P2-1: capability exists only on SupportedApiTypeEntry, never on ApiTypePair", () => {
        // OpenAPI contract: SupportedApiTypeEntry = ApiTypePair + optional capability;
        // defaultApiType and the change impact stay plain ApiTypePair.
        expectTypeOf<SupportedApiTypeEntry>().toExtend<ApiTypePair>();
        expectTypeOf<ProviderApiTypeCapability>().toEqualTypeOf<{ tools?: boolean }>();
        expectTypeOf<ProviderDefinition["defaultApiType"]>().toEqualTypeOf<ApiTypePair>();
        expectTypeOf<ApiTypePair>().not.toHaveProperty("capability");
        expect("capability" in provider.defaultApiType).toBe(false);
    });
});

// ── PLAN-0622 Resource Governor：连接页限额随 PATCH 提交（Block B 的接线证据） ─────────────
describe("ProviderHub connection resource limits (PLAN-0622)", () => {
    it("submits the edited limits together with the connection PATCH", async () => {
        const limited = { ...user, maxInflight: 2, maxQueue: 4 } as typeof user;
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [limited] });
        vi.mocked(updateProviderConnection).mockResolvedValue(limited);
        const wrapper = mount(ProviderHub, { props: { scope: "USER" } });
        await flushPromises();

        // 打开「管理」对话框（与既有用例相同的真实入口，不是点卡片本身）。
        const row = wrapper.findAll('[data-testid="provider-connection-example"]')[0]!;
        await row
            .findAll("button")
            .find((button) => button.text() === i18n.global.t("settings.providerHub.manage"))!
            .trigger("click");
        await flushPromises();
        const modal = wrapper.get('[data-testid="provider-connection-modal"]');
        // 限额区只在编辑已有连接时出现，并回显当前值。
        expect(modal.find('[data-testid="connection-resource-limits"]').exists()).toBe(true);
        expect(
            modal.get<HTMLInputElement>('[data-testid="connection-limit-max-inflight"]').element
                .value,
        ).toBe("2");

        await modal.get('[data-testid="connection-limit-max-inflight"]').setValue("6");
        await modal.get('[data-testid="connection-limit-window-seconds"]').setValue("30");
        await modal.get("form").trigger("submit");
        await flushPromises();

        expect(updateProviderConnection).toHaveBeenCalledWith(
            limited.id,
            expect.objectContaining({ maxInflight: 6, maxQueue: 4, windowSeconds: 30 }),
        );
        wrapper.unmount();
    });

    it("blocks the PATCH when a limit is not a positive integer", async () => {
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [user] });
        const wrapper = mount(ProviderHub, { props: { scope: "USER" } });
        await flushPromises();

        const row = wrapper.findAll('[data-testid="provider-connection-example"]')[0]!;
        await row
            .findAll("button")
            .find((button) => button.text() === i18n.global.t("settings.providerHub.manage"))!
            .trigger("click");
        await flushPromises();
        const modal = wrapper.get('[data-testid="provider-connection-modal"]');
        await modal.get('[data-testid="connection-limit-max-inflight"]').setValue("0");
        await modal.get("form").trigger("submit");
        await flushPromises();

        expect(updateProviderConnection).not.toHaveBeenCalled();
        wrapper.unmount();
    });
});

// ── task-146（DSD-1512）：连接的密钥来源三态 = 保留绑定 / 绑定已有凭据 / 内联新建 ──────────────
describe("ProviderHub credential binding (task-146)", () => {
    type Hub = Awaited<ReturnType<typeof mountHub>>;

    function credentialRow(over: Partial<CredentialSummary> = {}): CredentialSummary {
        return {
            id: "cred-a",
            label: "Team key",
            kind: "token",
            deliveryTier: "lease",
            ownerType: "USER",
            ownerId: "user-1",
            status: "active",
            fingerprint: "fp-aaaaaaaaaaaa",
            revision: 3,
            createdAt: "2026-11-20T00:00:00Z",
            replacedAt: null,
            referenceCount: 0,
            ...over,
        };
    }

    /** 走真实入口打开「新建连接」表单（connect → picker），并填好必填的 label / connectionKey。 */
    async function openCreate(wrapper: Hub) {
        await wrapper.get('[data-testid="provider-hub-connect"]').trigger("click");
        await wrapper.get('[data-testid="provider-picker-example"]').trigger("click");
        await flushPromises();
        const modal = wrapper.get('[data-testid="provider-connection-modal"]');
        await modal.get('[data-testid="provider-connection-form-label"]').setValue("Bound key");
        await modal.get('[data-testid="provider-connection-form-key"]').setValue("bound-key");
        return modal;
    }

    async function openManage(wrapper: Hub) {
        const row = wrapper.findAll('[data-testid="provider-connection-example"]')[0]!;
        await row
            .findAll("button")
            .find((button) => button.text() === i18n.global.t("settings.providerHub.manage"))!
            .trigger("click");
        await flushPromises();
        return wrapper.get('[data-testid="provider-connection-modal"]');
    }

    it("binds an existing credential and sends only credentialId", async () => {
        vi.mocked(api.listCredentials).mockResolvedValue({
            credentials: [credentialRow()],
            count: 1,
        });
        const wrapper = await mountHub();
        const modal = await openCreate(wrapper);
        await modal.get('[data-testid="provider-credential-mode-bind"]').trigger("click");
        // 候选按表单所属层拉：USER 层不带 ownerId。
        expect(api.listCredentials).toHaveBeenCalledWith({ ownerType: "USER" });
        // 候选已到手 ⇒ 空态提示不该出现（空态 = 当前作用域没有可用凭据）。
        expect(modal.find('[data-testid="provider-credential-empty"]').exists()).toBe(false);
        await setSelectValue(wrapper, '[data-testid="provider-credential-select"]', "cred-a");
        await flushPromises();
        await modal.get("form").trigger("submit");
        await flushPromises();
        const input = vi.mocked(createProviderConnection).mock.calls[0]![0]!;
        expect(input.credentialId).toBe("cred-a");
        // 互斥由 UI 保证：绑定态绝不把 apiKey 再送一遍（否则 CP 400）。
        expect(input).not.toHaveProperty("apiKey");
        wrapper.unmount();
    });

    it("sends only apiKey when the key is created inline", async () => {
        const wrapper = await mountHub();
        const modal = await openCreate(wrapper);
        await modal.get('[data-testid="provider-credential-mode-inline"]').trigger("click");
        await modal.get('[data-testid="provider-credential-api-key"]').setValue("sk-inline-123");
        await modal.get("form").trigger("submit");
        await flushPromises();
        const input = vi.mocked(createProviderConnection).mock.calls[0]![0]!;
        expect(input.apiKey).toBe("sk-inline-123");
        expect(input).not.toHaveProperty("credentialId");
        wrapper.unmount();
    });

    it("blocks a provider that requires a key when neither a credential nor a key is given", async () => {
        const wrapper = await mountHub();
        const modal = await openCreate(wrapper);
        await modal.get("form").trigger("submit");
        await flushPromises();
        expect(toast.error).toHaveBeenCalledWith(
            i18n.global.t("settings.providerHub.toastApiKeyRequired"),
        );
        expect(createProviderConnection).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it("echoes the currently bound credential when editing", async () => {
        const bound = { ...user, credentialId: "cred-a" };
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [bound] });
        vi.mocked(api.listCredentials).mockResolvedValue({
            credentials: [credentialRow()],
            count: 1,
        });
        const wrapper = await mountHub();
        const modal = await openManage(wrapper);
        const current = modal.get('[data-testid="provider-credential-current"]');
        expect(current.text()).toContain("Team key");
        expect(current.text()).toContain("rev 3");
        // keep 态不渲染密钥输入框：编辑不会把旧密钥回显出来。
        expect(modal.find('input[type="password"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it("replaces the bound credential with another one", async () => {
        const bound = { ...user, credentialId: "cred-a" };
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [bound] });
        vi.mocked(api.listCredentials).mockResolvedValue({
            credentials: [
                credentialRow(),
                credentialRow({ id: "cred-b", label: "Spare key", revision: 1 }),
            ],
            count: 2,
        });
        const wrapper = await mountHub();
        const modal = await openManage(wrapper);
        await modal.get('[data-testid="provider-credential-replace"]').trigger("click");
        await modal.get('[data-testid="provider-credential-mode-bind"]').trigger("click");
        await setSelectValue(wrapper, '[data-testid="provider-credential-select"]', "cred-b");
        await flushPromises();
        await modal.get("form").trigger("submit");
        await flushPromises();
        const input = vi.mocked(updateProviderConnection).mock.calls[0]![1]!;
        expect(input.credentialId).toBe("cred-b");
        expect(input).not.toHaveProperty("apiKey");
        wrapper.unmount();
    });

    it("warns when the selected credential is disabled", async () => {
        vi.mocked(api.listCredentials).mockResolvedValue({
            credentials: [credentialRow({ status: "disabled" })],
            count: 1,
        });
        const wrapper = await mountHub();
        const modal = await openCreate(wrapper);
        await modal.get('[data-testid="provider-credential-mode-bind"]').trigger("click");
        await setSelectValue(wrapper, '[data-testid="provider-credential-select"]', "cred-a");
        await flushPromises();
        expect(modal.get('[data-testid="provider-credential-disabled"]').text()).toContain(
            i18n.global.t("settings.providerHub.credentialDisabledWarning"),
        );
        wrapper.unmount();
    });

    it("surfaces the raw credential list failure instead of an empty picker", async () => {
        vi.mocked(api.listCredentials).mockRejectedValue(
            new Error("403 FORBIDDEN: no credential read"),
        );
        const wrapper = await mountHub();
        const modal = await openCreate(wrapper);
        await modal.get('[data-testid="provider-credential-mode-bind"]').trigger("click");
        expect(modal.get('[data-testid="provider-credential-error"]').text()).toContain(
            "403 FORBIDDEN: no credential read",
        );
        wrapper.unmount();
    });

    it("refuses to list workspace credentials without a workspace context", async () => {
        const wrapper = mount(ProviderHub, { props: { scope: "WORKSPACE" } });
        await flushPromises();
        const modal = await openCreate(wrapper);
        await modal.get('[data-testid="provider-credential-mode-bind"]').trigger("click");
        expect(modal.get('[data-testid="provider-credential-error"]').text()).toContain(
            i18n.global.t("settings.providerHub.credentialWorkspaceMissing"),
        );
        // 没有工作区就根本不发请求（而不是发一个 ownerType=WORKSPACE 的空查询）。
        expect(api.listCredentials).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it("offers only two key-source modes, inline first and selected by default (task-953 R10)", async () => {
        const wrapper = await mountHub();
        const modal = await openCreate(wrapper);
        const modes = modal.findAll('[data-testid^="provider-credential-mode-"]');
        expect(modes).toHaveLength(2);
        expect(modes[0]!.attributes("data-testid")).toBe("provider-credential-mode-inline");
        expect(modes[1]!.attributes("data-testid")).toBe("provider-credential-mode-bind");
        // 默认选中新建密钥：内联输入框在，绑定下拉不在；第三个「新建一条凭据」按钮已删除。
        expect(modal.get('[data-testid="provider-credential-api-key"]').exists()).toBe(true);
        expect(modal.find('[data-testid="provider-credential-select"]').exists()).toBe(false);
        expect(modal.find('[data-testid="provider-credential-create"]').exists()).toBe(false);
        await modes[1]!.trigger("click");
        expect(modal.find('[data-testid="provider-credential-api-key"]').exists()).toBe(false);
        expect(modal.get('[data-testid="provider-credential-select"]').exists()).toBe(true);
        wrapper.unmount();
    });

    it("verifies an existing connection without writing it (task-953 R19)", async () => {
        const wrapper = await mountHub();
        const modal = await openManage(wrapper);
        await modal.get('[data-testid="provider-connection-verify-only"]').trigger("click");
        await flushPromises();
        expect(verifyProviderConnection).toHaveBeenCalledWith(user.id);
        expect(updateProviderConnection).not.toHaveBeenCalled();
        expect(wrapper.find('[data-testid="provider-connection-modal"]').exists()).toBe(true);
        wrapper.unmount();
    });

    it("saves without auto-verifying the connection (task-953 R19)", async () => {
        const wrapper = await mountHub();
        const modal = await openManage(wrapper);
        await modal.get("form").trigger("submit");
        await flushPromises();
        expect(updateProviderConnection).toHaveBeenCalledWith(user.id, expect.anything());
        expect(verifyProviderConnection).not.toHaveBeenCalled();
        wrapper.unmount();
    });
});

describe("task-953 R15 instance scope copy", () => {
    it("shows Instance rather than User or an internal enum value", async () => {
        const wrapper = mount(ProviderHub, { props: { scope: "INSTANCE", layer: "instance" } });
        await flushPromises();
        await wrapper.get('[data-testid="provider-hub-connect"]').trigger("click");
        await flushPromises();
        const picker = wrapper.find('[data-testid="provider-picker-modal"]');
        await picker.findAll('button[data-testid^="provider-picker-"]').at(0)!.trigger("click");
        await flushPromises();
        const modal = wrapper.get('[data-testid="provider-connection-modal"]');
        expect(modal.text()).toContain(i18n.global.t("settings.providerHub.scopeInstance"));
        expect(modal.text()).not.toContain(i18n.global.t("settings.providerHub.scopeUser"));
        expect(modal.text()).not.toMatch(/\b(INSTANCE|WORKSPACE|USER)\b/);
        wrapper.unmount();
    });
});

describe("task-953 R17 model discovery URL", () => {
    it("falls back to {baseUrl}/models when the custom URL is empty", () => {
        expect(inspectModelDiscoveryUrl("https://api.example/v1", "")).toEqual({
            kind: "empty",
            effective: "https://api.example/v1/models",
        });
    });

    it("rejects non-http(s) URLs and keeps the fallback", () => {
        expect(inspectModelDiscoveryUrl("https://api.example/v1", "ftp://files.example")).toEqual({
            kind: "invalid",
            effective: "https://api.example/v1/models",
        });
    });

    it("flags a cross-origin model list URL", () => {
        expect(
            inspectModelDiscoveryUrl("https://api.example/v1", "https://models.example/list"),
        ).toEqual({ kind: "cross-origin", effective: "https://models.example/list" });
    });

    it("accepts a same-origin model list URL", () => {
        expect(
            inspectModelDiscoveryUrl("https://api.example/v1", "https://api.example/models"),
        ).toEqual({ kind: "same-origin", effective: "https://api.example/models" });
    });

    it("reports the backend-unsupported field instead of silently dropping it", async () => {
        const wrapper = await mountHub();
        await wrapper.get('[data-testid="provider-hub-connect"]').trigger("click");
        await flushPromises();
        const picker = wrapper.find('[data-testid="provider-picker-modal"]');
        await picker.findAll('button[data-testid^="provider-picker-"]').at(0)!.trigger("click");
        await flushPromises();
        const modal = wrapper.get('[data-testid="provider-connection-modal"]');
        await modal.get('[data-testid="provider-credential-api-key"]').setValue("sk-test");
        await modal
            .get('[data-testid="provider-connection-model-discovery-url"]')
            .setValue("https://models.example/list");
        await modal.get("form").trigger("submit");
        await flushPromises();
        expect(toast.warning).toHaveBeenCalledWith(
            i18n.global.t("settings.providerHub.modelDiscoveryUrlCrossOrigin"),
        );
        expect(toast.error).toHaveBeenCalledWith(
            i18n.global.t("settings.providerHub.modelDiscoveryUrlUnsupported"),
        );
        expect(createProviderConnection).not.toHaveBeenCalled();
        wrapper.unmount();
    });
});

/**
 * task-170（R7）：请求模板标签收敛到唯一拼接点 templateOptionLabel。
 *
 * 原来四处 SelectItem 各自在模板里写「名称 + 空格 + v + 版本号」，两个后果：
 * 1) 同一段格式散在四处，改一处漏三处；
 * 2) 模板名自带版本后缀（如「OpenAI 对话补全 v2」）时再拼一次就成了「… v2 v2」。
 */
function mountHubWithTemplates(
    templates: { name: string; version: number; templateId?: string }[],
) {
    vi.mocked(listVisibleTemplates).mockResolvedValue(
        templates.map((item) => ({
            layer: "instance",
            templateId: item.templateId ?? "tpl-" + item.name,
            version: item.version,
            name: item.name,
            apiTypeId: user.apiTypeId,
            apiTypeVersion: 1,
        })),
    );
    return mountHub();
}

function defaultTemplateTriggerSelector() {
    return (
        '[data-slot="select-trigger"][aria-label="' +
        i18n.global.t("settings.providerHub.connDefaultTemplate") +
        '"]'
    );
}

describe("ProviderHub request-template labels (task-170 R7)", () => {
    it("appends the version exactly once when the template name has no version suffix", async () => {
        const wrapper = await mountHubWithTemplates([{ name: "OpenAI 对话补全", version: 2 }]);
        await openSelect(wrapper, defaultTemplateTriggerSelector());
        const labels = selectItemTextsFor(wrapper, defaultTemplateTriggerSelector());
        const label = labels.find((text) => text.includes("OpenAI 对话补全"));
        expect(label).toBe("OpenAI 对话补全 v2");
        wrapper.unmount();
    });

    it("does not repeat a version the template name already carries", async () => {
        const wrapper = await mountHubWithTemplates([{ name: "OpenAI 对话补全 v2", version: 2 }]);
        await openSelect(wrapper, defaultTemplateTriggerSelector());
        const labels = selectItemTextsFor(wrapper, defaultTemplateTriggerSelector());
        const label = labels.find((text) => text.includes("OpenAI 对话补全"));
        expect(label).toBe("OpenAI 对话补全 v2");
        expect(label?.match(/v2/g)?.length).toBe(1);
        wrapper.unmount();
    });

    it("renders every template dropdown through the single label assembly point", () => {
        // 四处模板站点是同一段插值；用源码守卫把「四处都走 templateOptionLabel」钉住，
        // 避免新增下拉时又手写一份「name + v + version」。
        const source = readFileSync(
            resolve(process.cwd(), "src/components/settings/ProviderHub.vue"),
            "utf8",
        );
        const throughHelper = source.match(/\{\{ templateOptionLabel\(item\) \}\}/g) ?? [];
        expect(throughHelper.length).toBe(4);
        expect(source).not.toContain("{{ item.name }} v{{ item.version }}");
    });
});
