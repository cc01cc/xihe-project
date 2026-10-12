import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { reactive } from "vue";
import Panel from "../components/SessionContextTemplate.vue";
import { request, type ApiSession } from "../../../../composables/api";
import { listVisibleTemplates } from "../../../../services/apiRequestTemplates";
import { listProviderConnections } from "../../../../services/providerConnectionService";

const state = reactive({ sessions: [{ id: "a", updatedAt: "1" }, { id: "b", updatedAt: "1" }] });
vi.mock("../../../../stores/session", () => ({ useSessionStore: () => state }));
vi.mock("../../../../composables/api", () => ({ request: vi.fn<typeof request>() }));
vi.mock("../../../../services/apiRequestTemplates", async (original) => ({
    ...(await original<typeof import("../../../../services/apiRequestTemplates")>()),
    listVisibleTemplates: vi.fn<typeof listVisibleTemplates>(),
}));
vi.mock("../../../../services/providerConnectionService", () => ({ listProviderConnections: vi.fn<typeof listProviderConnections>() }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("vue-sonner", () => ({ toast: { success: vi.fn<(message: string) => void>() } }));

const option = { layer: "user" as const, templateId: "template", version: 1, name: "Template", apiTypeId: "openai-chat-completions", apiTypeVersion: 1 };
function session(id: string, templateId = "template"): ApiSession {
    return { id, workspaceId: "workspace", providerConnectionId: "connection", contextTemplateLayer: "user", contextTemplateId: templateId, contextTemplateVersion: 1 } as ApiSession;
}
beforeEach(() => {
    vi.clearAllMocks();
    state.sessions = [{ id: "a", updatedAt: "1" }, { id: "b", updatedAt: "1" }];
    vi.mocked(listVisibleTemplates).mockResolvedValue([option]);
    vi.mocked(listProviderConnections).mockResolvedValue({ connections: [{ id: "connection", revision: 1, apiTypeId: option.apiTypeId, apiTypeVersion: 1 }] } as Awaited<ReturnType<typeof listProviderConnections>>);
    vi.mocked(request).mockImplementation(async (path) => session(path.endsWith("/b") ? "b" : "a"));
});
describe("Session template identity", () => {
    it("clears and disables old options while the next Session loads", async () => {
        const wrapper = mount(Panel, { props: { sessionId: "a" } });
        await flushPromises();
        let finish!: (value: ApiSession) => void;
        vi.mocked(request).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
        await wrapper.setProps({ sessionId: "b" });
        const select = wrapper.get('[data-testid="session-context-template-select"]');
        expect(select.attributes("disabled")).toBeDefined();
        await select.setValue("user:template:1");
        expect(vi.mocked(request).mock.calls.some(([, options]) => options?.method === "PATCH")).toBe(false);
        finish(session("b"));
        await flushPromises();
        expect(select.attributes("disabled")).toBeUndefined();
        wrapper.unmount();
    });

    it("ignores an older response for the same Session after its update generation changes", async () => {
        const pending: Array<(value: ApiSession) => void> = [];
        vi.mocked(request).mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
        const wrapper = mount(Panel, { props: { sessionId: "a" } });
        state.sessions[0]!.updatedAt = "2";
        await flushPromises();
        expect(pending).toHaveLength(2);
        pending[1]!(session("a", "new-template"));
        await flushPromises();
        pending[0]!(session("a", "old-template"));
        await flushPromises();
        expect(wrapper.get('[data-testid="session-context-template-current"]').text()).toContain("new-template");
        wrapper.unmount();
    });
});
