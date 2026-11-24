/**
 * task-964（944 B2/B3）：实例层内置 API 请求模板「可见、只读、行级复制」。
 *
 * 判据不硬编码具体内置 id/名称：输入是任取的一条 published 内置投影，
 * 期望是「按 API Type 本地化名 + 内置后缀」以及「复制后变成新 id 的可编辑草稿」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import Panel from "../ContextTemplatesPanel.vue";
import { i18n } from "../../../i18n";
import { listApiInputTypes } from "../../../services/providerConnectionService";
import { readTemplateConfig, validateTemplate } from "../../../services/apiRequestTemplates";
import type * as apiRequestTemplatesModule from "../../../services/apiRequestTemplates";

vi.mock("../../../services/providerConnectionService", () => ({
    listApiInputTypes: vi.fn<typeof listApiInputTypes>(),
}));
vi.mock("../../../services/apiRequestTemplates", async (importOriginal) => ({
    ...(await importOriginal<typeof apiRequestTemplatesModule>()),
    readTemplateConfig: vi.fn<typeof readTemplateConfig>(),
    validateTemplate: vi.fn<typeof validateTemplate>(),
}));
vi.mock("vue-sonner", () => ({
    toast: {
        info: vi.fn<(message: string) => void>(),
        success: vi.fn<(message: string) => void>(),
        error: vi.fn<(message: string) => void>(),
    },
}));

const builtin = {
    id: "builtin-any",
    version: 2,
    name: "OpenAI Chat Completions · Built-in",
    apiTypeId: "openai-chat-completions",
    apiTypeVersion: 1,
    bodySource: '{"model":"${xh.model}","messages":[]}',
    status: "published" as const,
};

function mountPanel() {
    return mount(Panel, {
        props: {
            entries: { templates: JSON.stringify([builtin]) },
            saving: false,
            layer: "instance",
        },
        global: { plugins: [i18n] },
    });
}

function mountUserPanel() {
    return mount(Panel, {
        props: {
            entries: {},
            saving: false,
            layer: "user",
        },
        global: { plugins: [i18n] },
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    i18n.global.locale.value = "zh-CN";
    vi.mocked(listApiInputTypes).mockResolvedValue({
        types: [{ apiTypeId: builtin.apiTypeId, version: 1, operation: "chat" }],
    } as Awaited<ReturnType<typeof listApiInputTypes>>);
    vi.mocked(readTemplateConfig).mockResolvedValue({
        templates: JSON.stringify([builtin]),
    });
    vi.mocked(validateTemplate).mockResolvedValue({ valid: true, diagnostics: [] });
});

afterEach(() => {
    i18n.global.locale.value = "zh-CN";
});

describe("API request built-ins · task-964", () => {
    it("中文界面用本地化内置名，不直出 Built-in / default v2 / @1", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        const nav = wrapper.get('nav[aria-label="请求模板"]');
        expect(nav.text()).toContain("OpenAI 对话补全（内置）");
        expect(nav.text()).not.toContain("Built-in");
        expect(nav.text()).not.toContain("default v2");
        expect(wrapper.text()).not.toContain("@1");
        wrapper.unmount();
    });

    it("实例层内置行只读，且提供行级复制入口", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        const name = wrapper.get('[data-testid="api-request-name"]');
        expect((name.element as HTMLInputElement).disabled).toBe(true);
        expect(wrapper.find('[data-testid="api-request-save-draft"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="api-request-publish"]').exists()).toBe(false);
        expect(wrapper.get('[data-testid="api-request-builtin-readonly"]').text()).toContain(
            "只读",
        );
        expect(wrapper.find(`[data-testid="api-request-copy-${builtin.id}"]`).exists()).toBe(true);
        wrapper.unmount();
    });

    it("复制后得到新 id 的可编辑草稿，可改名并保存", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        await wrapper.get(`[data-testid="api-request-copy-${builtin.id}"]`).trigger("click");
        await flushPromises();

        const name = wrapper.get('[data-testid="api-request-name"]');
        expect((name.element as HTMLInputElement).disabled).toBe(false);
        expect((name.element as HTMLInputElement).value).toContain("副本");
        expect(wrapper.find('[data-testid="api-request-builtin-readonly"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="api-request-save-draft"]').exists()).toBe(true);

        await name.setValue("My copy");
        await wrapper.get('[data-testid="api-request-save-draft"]').trigger("click");
        await flushPromises();
        const payload = wrapper.emitted("save")![0]![0] as Record<string, string>;
        const records = JSON.parse(payload.templates!) as Array<Record<string, unknown>>;
        expect(records).toHaveLength(2);
        expect(records.some((item) => item.id === builtin.id)).toBe(true);
        const copy = records.find((item) => item.id !== builtin.id)!;
        expect(copy).toMatchObject({
            name: "My copy",
            version: 1,
            status: "draft",
            bodySource: builtin.bodySource,
        });
        wrapper.unmount();
    });

    it("英文界面保持 · Built-in，不出现中文本地化后缀", async () => {
        i18n.global.locale.value = "en";
        const wrapper = mountPanel();
        await flushPromises();
        const nav = wrapper.get('nav[aria-label="Request templates"]');
        expect(nav.text()).toContain("OpenAI Chat Completions · Built-in");
        expect(nav.text()).not.toContain("（内置）");
        expect(wrapper.text()).not.toContain("@1");
        wrapper.unmount();
    });

    it("用户层列出实例内置（只读），复制后只保存用户自己的模板", async () => {
        const wrapper = mountUserPanel();
        await flushPromises();
        const nav = wrapper.get('nav[aria-label="请求模板"]');
        expect(nav.text()).toContain("内置模板（只读）");
        expect(nav.text()).toContain("OpenAI 对话补全（内置）");
        const row = wrapper.get(`[data-testid="api-request-builtin-row-${builtin.id}"]`);
        await row.get("button").trigger("click");
        await flushPromises();
        expect(
            (wrapper.get('[data-testid="api-request-name"]').element as HTMLInputElement).disabled,
        ).toBe(true);
        expect(wrapper.find('[data-testid="api-request-save-draft"]').exists()).toBe(false);

        await wrapper.get(`[data-testid="api-request-copy-${builtin.id}"]`).trigger("click");
        await flushPromises();
        expect(
            (wrapper.get('[data-testid="api-request-name"]').element as HTMLInputElement).disabled,
        ).toBe(false);
        await wrapper.get('[data-testid="api-request-save-draft"]').trigger("click");
        await flushPromises();
        const payload = wrapper.emitted("save")![0]![0] as Record<string, string>;
        const records = JSON.parse(payload.templates!) as Array<Record<string, unknown>>;
        expect(records).toHaveLength(1);
        expect(records[0]!.id).not.toBe(builtin.id);
        expect(records[0]).toMatchObject({ status: "draft", bodySource: builtin.bodySource });
        wrapper.unmount();
    });
});
