import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import Panel from "../ContextTemplatesPanel.vue";
import { listApiInputTypes } from "../../../services/providerConnectionService";
import { readTemplateConfig, validateTemplate } from "../../../services/apiRequestTemplates";

vi.mock("../../../services/providerConnectionService", () => ({
    listApiInputTypes: vi.fn<typeof listApiInputTypes>(),
}));
vi.mock("../../../services/apiRequestTemplates", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../services/apiRequestTemplates")>()),
    readTemplateConfig: vi.fn<typeof readTemplateConfig>(),
    validateTemplate: vi.fn<typeof validateTemplate>(),
}));
vi.mock("vue-sonner", () => ({ toast: { info: vi.fn<(message: string) => void>() } }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
const builtin = {
    id: "builtin",
    version: 1,
    name: "Builtin",
    apiTypeId: "openai-chat-completions",
    apiTypeVersion: 1,
    bodySource: '{"model":"${xh.model}","messages":[{"role":"user","content":"${xh.user_input}"}]}',
    status: "published",
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listApiInputTypes).mockResolvedValue({
        types: [{ apiTypeId: builtin.apiTypeId, version: 1, operation: "chat" }],
    } as Awaited<ReturnType<typeof listApiInputTypes>>);
    vi.mocked(readTemplateConfig).mockResolvedValue({ templates: JSON.stringify([builtin]) });
    vi.mocked(validateTemplate).mockResolvedValue({ valid: true, diagnostics: [] });
});

describe("API request template lifecycle", () => {
    it("clears the previous scope selection and ignores its late publication", async () => {
        let finish!: (value: { valid: boolean; diagnostics: [] }) => void;
        vi.mocked(validateTemplate).mockReturnValue(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        const wrapper = mount(Panel, {
            props: {
                entries: { templates: JSON.stringify([builtin]) },
                saving: false,
                layer: "user",
                workspaceId: "a",
            },
        });
        await flushPromises();
        await wrapper.get('[data-testid="api-request-publish"]').trigger("click");
        await wrapper.setProps({ layer: "workspace", workspaceId: "b", entries: {} });
        expect(wrapper.find('[data-testid="api-request-body-source"]').exists()).toBe(false);
        finish({ valid: true, diagnostics: [] });
        await flushPromises();
        expect(wrapper.emitted("save")).toBeUndefined();
        wrapper.unmount();
    });

    it("does not emit a publication after its scope instance unmounts", async () => {
        let finish!: (value: { valid: boolean; diagnostics: [] }) => void;
        vi.mocked(validateTemplate).mockReturnValue(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        const wrapper = mount(Panel, {
            props: {
                entries: { templates: JSON.stringify([builtin]) },
                saving: false,
                layer: "user",
            },
        });
        await flushPromises();
        await wrapper.get('[data-testid="api-request-publish"]').trigger("click");
        wrapper.unmount();
        finish({ valid: true, diagnostics: [] });
        await flushPromises();
        expect(wrapper.emitted("save")).toBeUndefined();
    });

    it("resets between Workspaces even when the layer stays the same", async () => {
        const wrapper = mount(Panel, {
            props: {
                entries: { templates: JSON.stringify([builtin]) },
                saving: false,
                layer: "workspace",
                workspaceId: "a",
            },
        });
        await flushPromises();
        await wrapper.setProps({ workspaceId: "b", entries: {} });
        expect(wrapper.find('[data-testid="api-request-body-source"]').exists()).toBe(false);
        wrapper.unmount();
    });
    it("preserves invalid raw source as a draft without invoking publication validation", async () => {
        const wrapper = mount(Panel, { props: { entries: {}, saving: false, layer: "user" } });
        await flushPromises();
        await wrapper.get('[data-testid="api-request-new"]').trigger("click");
        const raw = "{ broken ${xh.user_input}";
        await wrapper.get('[data-testid="api-request-body-source"]').setValue(raw);
        await wrapper.get('[data-testid="api-request-save-draft"]').trigger("click");
        expect(validateTemplate).not.toHaveBeenCalled();
        const payload = wrapper.emitted("save")![0]![0] as Record<string, string>;
        expect(JSON.parse(payload.templates!)[0]).toMatchObject({
            status: "draft",
            bodySource: raw,
        });
        wrapper.unmount();
    });

    it("shows validation diagnostics and does not save an invalid publication", async () => {
        vi.mocked(validateTemplate).mockResolvedValue({
            valid: false,
            diagnostics: [{ code: "JSON_INVALID", path: "$", message: "Invalid JSON" }],
        });
        const wrapper = mount(Panel, { props: { entries: {}, saving: false, layer: "user" } });
        await flushPromises();
        await wrapper.get('[data-testid="api-request-new"]').trigger("click");
        await wrapper.get('[data-testid="api-request-publish"]').trigger("click");
        await flushPromises();
        expect(wrapper.emitted("save")).toBeUndefined();
        expect(wrapper.get('[role="alert"]').text()).toContain("JSON_INVALID");
        wrapper.unmount();
    });

    it("appends a new version while preserving the exact published source", async () => {
        const wrapper = mount(Panel, {
            props: {
                entries: { templates: JSON.stringify([builtin]) },
                saving: false,
                layer: "user",
            },
        });
        await flushPromises();
        const edited = builtin.bodySource.replace("user_input", "agent_instructions");
        await wrapper.get('[data-testid="api-request-body-source"]').setValue(edited + " ");
        await wrapper.get('[data-testid="api-request-publish"]').trigger("click");
        await flushPromises();
        const payload = wrapper.emitted("save")![0]![0] as Record<string, string>;
        const records = JSON.parse(payload.templates!);
        expect(records).toHaveLength(2);
        expect(records[0]).toEqual(builtin);
        expect(records[1]).toMatchObject({
            id: builtin.id,
            version: 2,
            bodySource: edited + " ",
            status: "published",
        });
        wrapper.unmount();
    });

    it("does not publish into another selection when validation finishes late", async () => {
        let finish!: (value: { valid: boolean; diagnostics: [] }) => void;
        vi.mocked(validateTemplate).mockReturnValue(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        const wrapper = mount(Panel, { props: { entries: {}, saving: false, layer: "user" } });
        await flushPromises();
        await wrapper.get('[data-testid="api-request-new"]').trigger("click");
        await wrapper.get('[data-testid="api-request-publish"]').trigger("click");
        await wrapper.get('[data-testid="api-request-new"]').trigger("click");
        finish({ valid: true, diagnostics: [] });
        await flushPromises();
        expect(wrapper.emitted("save")).toBeUndefined();
        wrapper.unmount();
    });
});
