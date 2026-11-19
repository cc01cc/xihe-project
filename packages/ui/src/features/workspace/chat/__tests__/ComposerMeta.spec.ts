import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import type * as ConfigModule from "../../../../stores/config";
import { useChatStore } from "../stores/chat.ts";
import InputArea from "../components/InputArea.vue";

/**
 * task-135（composer 三层容器，叠在 D-1910 单列 fluid-then-cap 之上）：第 2 层右槽的
 * 模型·路由 chip 与第 3 层 `composer-meta` 元信息行。
 *
 * <p>这里钉的是**取值与占位**：有数据源就显示格式化值，没有数据源必须显示 "—"（不许现编估算值）。
 * 高度与「连续三次 token 变化 composer 高度差 0」是排版判据，jsdom 没有布局引擎，
 * 由真机读数验（one/.tmp/xh/ui-gates/composer-three-layer/readings-*.json 的 jitter 段）；
 * 本 spec 只钉它的**机制**：`min-h-4 + leading-4 + tabular-nums` 三个 class 必须在。</p>
 */
const modelBinding = vi.hoisted(() => ({
    value: null as null | { provider?: string; model: string },
}));

vi.mock("../../../../stores/config", async (importOriginal) => {
    const actual = await importOriginal<typeof ConfigModule>();
    return { ...actual, useConfigStore: () => ({ getEffectiveModel: () => modelBinding.value }) };
});

vi.mock("../composables/useSessionCommands", async () => {
    const { ref } = await import("vue");
    return {
        commandReasonKey: () => "chat.commands.reason.unknown",
        useSessionCommands: () => ({ commands: ref([]) }),
    };
});

vi.mock("../../../../services/attachmentService", () => ({
    uploadAttachments: vi.fn<(sessionId: string, files: File[]) => Promise<never>>(),
    validateAttachment: () => ({ valid: true }),
}));

vi.mock("vue-sonner", () => ({
    toast: {
        error: vi.fn<(message: string) => void>(),
        success: vi.fn<(message: string) => void>(),
    },
}));

const messages = {
    "zh-CN": {
        chat: {
            placeholder: "输入消息...",
            send: "发送",
            stop: "停止",
            input: { ccLabel: "抄送", ccEmptyHint: "未添加抄送对象" },
            delegation: { reasonUnknown: "未知原因", button: "委派" },
            composerMeta: {
                model: "模型 · 路由",
                modelUnbound: "未绑定模型",
                rounds: "轮 {value}",
                steps: "步 {value}",
                speed: "{value} tok/s",
                tokens: "{used} / {limit}",
                cacheHit: "缓存命中 {percent}",
            },
        },
        multimodal: { image: "图片", screenshot: "截图", voice: "语音" },
        common: { cancel: "取消" },
    },
};

const stubs = {
    ImageUpload: { template: "<div />" },
    FileUpload: { template: "<div />" },
    ScreenshotCapture: { template: "<div />" },
    VoiceInput: { template: "<div />" },
    LoaderCircle: { template: "<span />" },
    Image: { template: "<span />" },
    Camera: { template: "<span />" },
    Mic: { template: "<span />" },
    Send: { template: "<span />" },
};

function mountInputArea(props: Record<string, unknown> = {}) {
    return mount(InputArea, {
        props: { sessionId: "meta-session", ...props },
        global: {
            plugins: [
                createI18n({ legacy: false, locale: "zh-CN", fallbackLocale: "zh-CN", messages }),
            ],
            stubs,
        },
    });
}

beforeEach(() => {
    setActivePinia(createPinia());
    modelBinding.value = null;
});

describe("task-135 composer 元信息行", () => {
    it("渲染第 3 层三个槽位", () => {
        const wrapper = mountInputArea();
        const meta = wrapper.find('[data-testid="composer-meta"]');
        expect(meta.exists()).toBe(true);
        expect(wrapper.find('[data-testid="composer-meta-run"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="composer-meta-tokens"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="composer-meta-cache"]').exists()).toBe(true);
    });

    it("没有数据源的三项显示 —，分母是 200k 兜底", () => {
        const wrapper = mountInputArea();
        const run = wrapper.find('[data-testid="composer-meta-run"]').text();
        expect(run).toContain("轮 —");
        expect(run).toContain("步 —");
        expect(run).toContain("— tok/s");
        expect(wrapper.find('[data-testid="composer-meta-tokens"]').text()).toBe("— / 200k");
        expect(wrapper.find('[data-testid="composer-meta-cache"]').text()).toBe("缓存命中 —");
    });

    it("抗抖动的机制在模板里：min-h-4 + leading-4 + tabular-nums", () => {
        const meta = mountInputArea().find('[data-testid="composer-meta"]');
        const classes = meta.classes();
        expect(classes).toContain("min-h-4");
        expect(classes).toContain("leading-4");
        expect(classes).toContain("tabular-nums");
        expect(classes).toContain("flex");
        expect(classes).toContain("flex-wrap");
    });

    it("token 用量按千分位显示，行数不随位数变化（仍是单个 span）", async () => {
        const wrapper = mountInputArea();
        const chat = useChatStore();
        chat.setSessionLastUsage("meta-session", { inputTokens: 1000, outputTokens: 234 });
        await nextTick();
        const tokens = wrapper.findAll('[data-testid="composer-meta-tokens"]');
        expect(tokens).toHaveLength(1);
        expect(tokens[0]!.text()).toBe("1,234 / 200k");
    });

    it("有 totalTokens 时优先用它", async () => {
        const wrapper = mountInputArea();
        const chat = useChatStore();
        chat.setSessionLastUsage("meta-session", {
            inputTokens: 10,
            outputTokens: 20,
            totalTokens: 1234567,
        });
        await nextTick();
        expect(wrapper.find('[data-testid="composer-meta-tokens"]').text()).toBe(
            "1,234,567 / 200k",
        );
    });

    // task-154（M-5）：分母不再是常量，优先取当前 run 的 usage.windowTokens 真值。
    it("分母优先取 usage.windowTokens 真值（131072 → 131k）", async () => {
        const wrapper = mountInputArea();
        useChatStore().setSessionLastUsage("meta-session", {
            totalTokens: 12345,
            windowTokens: 131_072,
        });
        await nextTick();
        expect(wrapper.find('[data-testid="composer-meta-tokens"]').text()).toBe("12,345 / 131k");
    });

    it("windowTokens 缺失或为 null 时回落到 200k 兜底（兜底不是真值）", async () => {
        const wrapper = mountInputArea();
        const chat = useChatStore();
        chat.setSessionLastUsage("meta-session", { totalTokens: 500 });
        await nextTick();
        expect(wrapper.find('[data-testid="composer-meta-tokens"]').text()).toBe("500 / 200k");

        chat.setSessionLastUsage("meta-session", { totalTokens: 500, windowTokens: null });
        await nextTick();
        expect(wrapper.find('[data-testid="composer-meta-tokens"]').text()).toBe("500 / 200k");
    });

    it("windowTokens 非正数不渲染 0k，仍走兜底", async () => {
        const wrapper = mountInputArea();
        useChatStore().setSessionLastUsage("meta-session", { totalTokens: 7, windowTokens: 0 });
        await nextTick();
        expect(wrapper.find('[data-testid="composer-meta-tokens"]').text()).toBe("7 / 200k");
    });
});

describe("task-135 模型·路由 chip", () => {
    it("有绑定显示 provider · model", () => {
        modelBinding.value = { provider: "openai", model: "gpt-5" };
        const wrapper = mountInputArea();
        const chip = wrapper.find('[data-testid="composer-model-chip"]');
        expect(chip.exists()).toBe(true);
        expect(chip.text()).toBe("openai · gpt-5");
        expect(chip.attributes("title")).toBe("模型 · 路由: openai · gpt-5");
    });

    it("未绑定时显示占位文案，不冒充已绑模型", () => {
        const wrapper = mountInputArea();
        const chip = wrapper.find('[data-testid="composer-model-chip"]');
        expect(chip.text()).toBe("未绑定模型");
        expect(chip.attributes("title")).toBe("模型 · 路由");
    });
});
