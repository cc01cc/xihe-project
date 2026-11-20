import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";
import { reactive } from "vue";
import Panel from "../components/SessionContextTemplate.vue";
import { request, type ApiSession } from "../../../../composables/api";
import { listVisibleTemplates, templateLabel } from "../../../../services/apiRequestTemplates";
import { listProviderConnections } from "../../../../services/providerConnectionService";
import { openSelect, selectItemTextsFor } from "../../../../test-utils/select";
import type * as apiRequestTemplatesModule from "../../../../services/apiRequestTemplates";

// DSD-1508 ③：用户现场看到「openai-chat-completions default v2 v2」——
// 模板名自带版本后缀，组件又拼了一遍 `v{version}`。这里锁两件事：
// ① 标签只出现一次版本号（三处同一纯函数：选项 / 触发器 / toast / 摘要）；
// ② 触发器不再被 max-w-44 硬截断（宽度跟随会话设置面板的 flex-1 容器）。

const state = reactive({ sessions: [{ id: "a", updatedAt: "1" }] });

vi.mock("../../../../stores/session", () => ({ useSessionStore: () => state }));
vi.mock("../../../../composables/api", () => ({ request: vi.fn<typeof request>() }));
vi.mock("../../../../services/apiRequestTemplates", async (original) => ({
    ...(await original<typeof apiRequestTemplatesModule>()),
    listVisibleTemplates: vi.fn<typeof listVisibleTemplates>(),
}));
vi.mock("../../../../services/providerConnectionService", () => ({
    listProviderConnections: vi.fn<typeof listProviderConnections>(),
}));
vi.mock("vue-i18n", () => ({
    useI18n: () => ({
        t: (key: string) => {
            const messages: Record<string, string> = {
                "settings.contextTemplate.layerInstance": "实例层",
                "settings.contextTemplate.layerUser": "个人层",
                "settings.contextTemplate.layerWorkspace": "工作区层",
                "chat.contextTemplateLabel": "请求模板",
                "sessionSettings.templateUnbound": "未绑定模板",
                "sessionSettings.templateSelectPlaceholder": "选择模板",
            };
            // 缺 key 必须返回真文案而不是 key 本身：mount 包装器会把裸 key 当夹具缺陷报红。
            return messages[key] ?? "missing-key:" + key;
        },
    }),
}));
vi.mock("vue-sonner", () => ({ toast: { success: vi.fn<(message: string) => void>() } }));

const apiTypeId = "openai-chat-completions";
/** 真栈现场形态：名称末尾已带 ` v2`。 */
const versionedOption = {
    layer: "user" as const,
    templateId: "versioned",
    version: 2,
    name: "openai-chat-completions default v2",
    apiTypeId,
    apiTypeVersion: 1,
};
const plainOption = {
    layer: "instance" as const,
    templateId: "plain",
    version: 3,
    name: "default",
    apiTypeId,
    apiTypeVersion: 1,
};
function session(): ApiSession {
    return {
        id: "a",
        workspaceId: "workspace",
        providerConnectionId: "connection",
        contextTemplateLayer: "user",
        contextTemplateId: "versioned",
        contextTemplateVersion: 2,
    } as ApiSession;
}
beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(listVisibleTemplates).mockResolvedValue([versionedOption, plainOption]);
    vi.mocked(listProviderConnections).mockResolvedValue({
        connections: [{ id: "connection", revision: 1, apiTypeId, apiTypeVersion: 1 }],
    } as Awaited<ReturnType<typeof listProviderConnections>>);
    vi.mocked(request).mockImplementation(async () => session());
});

describe("templateLabel (DSD-1508 ③)", () => {
    it("does not append a second version when the name already ends with it", () => {
        expect(templateLabel("openai-chat-completions default v2", 2)).toBe(
            "openai-chat-completions default v2",
        );
        expect(templateLabel("openai-chat-completions default v2", 2)).not.toContain("v2 v2");
    });

    it("appends the version when the name has none", () => {
        expect(templateLabel("default", 2)).toBe("default v2");
        expect(templateLabel("  default  ", 2)).toBe("default v2");
    });

    it("replaces a stale version suffix instead of stacking two numbers", () => {
        expect(templateLabel("default v2", 3)).toBe("default v3");
        expect(templateLabel("default V2", 3)).toBe("default v3");
        expect(templateLabel("default_v2", 3)).toBe("default v3");
    });

    it("leaves non-version digits alone", () => {
        expect(templateLabel("gpt-4", 1)).toBe("gpt-4 v1");
        expect(templateLabel("llama-3.1", 2)).toBe("llama-3.1 v2");
    });
});

describe("SessionContextTemplate labels and width (DSD-1508 ③)", () => {
    it("renders the current label once, without a duplicated version", async () => {
        const wrapper = mount(Panel, { props: { sessionId: "a" } });
        await flushPromises();
        const trigger = wrapper.get('[data-testid="session-context-template-select"]');
        expect(trigger.attributes("title")).toBe("openai-chat-completions default v2");
        // 触发器只渲染一行标签：选项的「层 + API 类型」次级行不得被 SelectValue 镜像进来。
        expect(trigger.text()).toBe("openai-chat-completions default v2");
        expect(trigger.find('[data-testid="session-context-template-option-meta"]').exists()).toBe(
            false,
        );
        const summaries = wrapper.emitted("update:summary") ?? [],
            last = summaries.at(-1)?.[0] as { label: string | null } | undefined;
        expect(last?.label).toBe("openai-chat-completions default v2");
        wrapper.unmount();
    });

    it("gives each option a layer + API type secondary line", async () => {
        const wrapper = mount(Panel, { props: { sessionId: "a" } });
        await flushPromises();
        await openSelect(wrapper, '[data-testid="session-context-template-select"]');
        const texts = selectItemTextsFor(
            wrapper,
            '[data-testid="session-context-template-select"]',
        );
        expect(texts).toEqual([
            "openai-chat-completions default v2个人层 · openai-chat-completions v1",
            "default v3实例层 · openai-chat-completions v1",
        ]);
        for (const text of texts) expect(text).not.toContain("v2 v2");
        wrapper.unmount();
    });

    it("lets the trigger follow its container instead of capping at 176px", async () => {
        const wrapper = mount(Panel, { props: { sessionId: "a" } });
        await flushPromises();
        const classes = wrapper
            .get('[data-testid="session-context-template-select"]')
            .attributes("class");
        expect(classes).not.toContain("max-w-44");
        expect(classes).not.toContain("min-w-40");
        expect(classes).toContain("w-full");
        wrapper.unmount();
    });
});
