import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import Panel from "../ContextTemplatesPanel.vue";
import { i18n } from "../../../i18n";
import { listApiInputTypes } from "../../../services/providerConnectionService";
import { readTemplateConfig, validateTemplate } from "../../../services/apiRequestTemplates";

/**
 * task-23 / P2-2：**文案与状态词**的断言单独成文件 —— 生命周期 spec
 * （`ApiRequestTemplatesPanel.spec.ts:22`）把 `vue-i18n` 整模块换成 `t(key) => key`，
 * 在那里断言中文只能在 mock 里自说自话。这里用**真 locale**，三件事才真被测到：
 * ① 空态不再叫人去选一个已经填好的控件；② 空态就地给新建入口且走同一个 `create()`；
 * ③ 模板状态（CP 枚举 `draft`/`published`）渲染为中文，不直出裸英文。
 */
vi.mock("../../../services/providerConnectionService", () => ({
    listApiInputTypes: vi.fn<typeof listApiInputTypes>(),
}));
vi.mock("../../../services/apiRequestTemplates", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../services/apiRequestTemplates")>()),
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

const published = {
    id: "builtin",
    version: 1,
    name: "Builtin",
    apiTypeId: "openai-chat-completions",
    apiTypeVersion: 1,
    bodySource: '{"model":"${xh.model}"}',
    status: "published",
};

function mountPanel(entries: { templates?: string } = {}) {
    return mount(Panel, {
        props: { entries, saving: false, layer: "user" },
        global: { plugins: [i18n] },
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listApiInputTypes).mockResolvedValue({
        types: [{ apiTypeId: published.apiTypeId, version: 1, operation: "chat" }],
    } as Awaited<ReturnType<typeof listApiInputTypes>>);
    vi.mocked(readTemplateConfig).mockResolvedValue({ templates: JSON.stringify([published]) });
    vi.mocked(validateTemplate).mockResolvedValue({ valid: true, diagnostics: [] });
});

describe("API request template 文案（task-23 P2-2）", () => {
    it("空态说清「没选中模板」并就地给新建入口，点击走同一个 create()", async () => {
        const wrapper = mountPanel({});
        await flushPromises();

        // ① 不再出现「选择 API Type 后新建模板」——selectedType 在 onMounted 已填首个类型
        expect(wrapper.text()).not.toContain("选择 API Type 后新建模板");
        expect(wrapper.text()).toContain("尚未选中模板");

        // ② 空态里的 CTA（不是头部那个），点它就能新建成功
        const cta = wrapper.get('[data-testid="api-request-new-empty"]');
        expect(cta.text()).toBe("新建模板");
        await cta.trigger("click");
        await flushPromises();

        // create() 生效：出现名称输入框且默认名是「未命名请求模板」，空态消失
        const name = wrapper.get('[data-testid="api-request-name"]');
        expect((name.element as HTMLInputElement).value).toBe("未命名请求模板");
        expect(wrapper.find('[data-testid="api-request-new-empty"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it("readonly 或没有可用类型时不给空态 CTA", async () => {
        const readonlyPanel = mountPanel({});
        await flushPromises();
        await readonlyPanel.setProps({ readonly: true });
        expect(readonlyPanel.find('[data-testid="api-request-new-empty"]').exists()).toBe(false);
        readonlyPanel.unmount();

        vi.mocked(listApiInputTypes).mockResolvedValue({
            types: [],
        } as Awaited<ReturnType<typeof listApiInputTypes>>);
        const noTypePanel = mountPanel({});
        await flushPromises();
        expect(noTypePanel.find('[data-testid="api-request-new-empty"]').exists()).toBe(false);
        noTypePanel.unmount();
    });

    it("模板状态渲染为中文，不直出 draft / published", async () => {
        const draft = { ...published, id: "t2", version: 2, status: "draft" };
        vi.mocked(readTemplateConfig).mockResolvedValue({
            templates: JSON.stringify([draft]),
        });
        const wrapper = mountPanel({ templates: JSON.stringify([published, draft]) });
        await flushPromises();

        const nav = wrapper.get('nav[aria-label="请求模板"]');
        expect(nav.text()).toContain("已发布");
        expect(nav.text()).toContain("草稿");
        expect(nav.text()).not.toContain("published");
        expect(nav.text()).not.toContain("draft");
        wrapper.unmount();
    });
});
