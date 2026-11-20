import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import type * as ConfigModule from "../../../../stores/config";
import {
    openSelect,
    selectItemTextsFor,
    selectItemValuesFor,
    setSelectValue,
} from "../../../../test-utils/select";
import { useChatStore } from "../stores/chat.ts";
import InputArea from "../components/InputArea.vue";

/**
 * task-133（DSD-1508 ①② / DSD-1507 ④）：composer 的三个「有源才说、无源不占位」判据。
 *
 * <ol>
 *   <li><b>元信息行</b>：只有 token 用量有数据源（chat store 的上次 usage）。没有 usage 时
 *       <b>整行不渲染</b>，不许留一排 "—" 占位（旧 task-135 口径已被 task-133 取代）；轮 / 步 /
 *       tok·s / 缓存命中四条<b>代码路径与文案键仍在</b>，接上数据源即显示。</li>
 *   <li><b>模型 chip</b>：未绑定 = 警示态（虚线 + amber，aria 写明「发送前需绑定」）；已绑定 =
 *       中性态 provider · model；两态都可点，点开交给宿主页去 llm-provider 域。</li>
 *   <li><b>权限档位 chip</b>：复用 SessionTierSelect 的行内紧凑形态挂进工具行，不新增行高
 *       （h-7 + 说明压成 sr-only），点开仍能选三档并走既有 store 写路径。</li>
 * </ol>
 *
 * <p>高度与「token 变化时 composer 高度差 0」是排版判据，jsdom 没有布局引擎，由真机读数验
 * （证据档 readings 段）；本 spec 只钉机制：min-h-4 + leading-4 + tabular-nums 三个 class 仍在。</p>
 */
const modelBinding = vi.hoisted(() => ({
    value: null as null | { provider?: string; model: string },
}));

/** 档位 store 的最小替身：真 store 的 load 会打 /api/v1/sessions/:id/tier，jsdom 里没有 origin。 */
const tierMock = vi.hoisted(() => ({
    state: {
        tier: "workspace",
        source: "workspace",
        workspaceTier: "workspace",
        canConfigure: true,
        denyReason: null,
        available: ["view", "workspace", "full"],
        loading: false,
        changing: false,
        loaded: true,
        error: null,
    } as Record<string, unknown>,
    loads: [] as string[],
    changes: [] as [string, string][],
}));

vi.mock("../../../../stores/config", async (importOriginal) => {
    const actual = await importOriginal<typeof ConfigModule>();
    return { ...actual, useConfigStore: () => ({ getEffectiveModel: () => modelBinding.value }) };
});

vi.mock("../../../../stores/sessionTier", () => ({
    useSessionTierStore: () => ({
        getState: () => tierMock.state,
        load: async (sessionId: string) => {
            tierMock.loads.push(sessionId);
        },
        change: async (sessionId: string, tier: string) => {
            tierMock.changes.push([sessionId, tier]);
            return tierMock.state;
        },
    }),
}));

vi.mock("../../../../stores/auth", () => ({
    useAuthStore: () => ({
        canWriteWorkspace: true,
        currentWorkspaceId: "ws-meta",
        user: { id: "user-meta" },
    }),
}));

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
                modelUnboundHint: "发送前需绑定 provider 连接（点此打开模型设置）",
                modelChangeHint: "点此打开模型设置",
                rounds: "轮 {value}",
                steps: "步 {value}",
                speed: "{value} tok/s",
                tokens: "{used} / {limit}",
                cacheHit: "缓存命中 {percent}",
            },
        },
        sessionSettings: {
            tierLabel: "权限档位",
            tierView: "只看不改",
            tierWorkspace: "工作区内修改",
            tierFull: "完全权限",
        },
        multimodal: { image: "图片", screenshot: "截图", voice: "语音" },
        common: { cancel: "取消" },
        workspace: { viewerReadOnly: "只读成员不能修改权限档位" },
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

const CHIP = '[data-testid="composer-model-chip"]';
const TIER_CHIP = '[data-testid="composer-tier-chip"]';

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

async function mountWithUsage(usage: Record<string, number | null>) {
    const wrapper = mountInputArea();
    useChatStore().setSessionLastUsage("meta-session", usage);
    await nextTick();
    return wrapper;
}

beforeEach(() => {
    setActivePinia(createPinia());
    modelBinding.value = null;
    tierMock.loads.length = 0;
    tierMock.changes.length = 0;
});

describe("task-133 元信息行：有值才渲染", () => {
    it("没有 usage 时整行不渲染，不留一排 — 占位", () => {
        const wrapper = mountInputArea();
        expect(wrapper.find('[data-testid="composer-meta"]').exists()).toBe(false);
        expect(wrapper.html()).not.toContain("轮 —");
    });

    it("有 usage 时只渲染 tokens 一项；无数据源的轮 / 步 / 缓存命中不出现", async () => {
        const wrapper = await mountWithUsage({ inputTokens: 1000, outputTokens: 234 });
        const meta = wrapper.find('[data-testid="composer-meta"]');
        expect(meta.exists()).toBe(true);
        expect(wrapper.findAll('[data-testid="composer-meta-tokens"]')).toHaveLength(1);
        expect(wrapper.find('[data-testid="composer-meta-tokens"]').text()).toBe("1,234 / 200k");
        expect(wrapper.find('[data-testid="composer-meta-run"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="composer-meta-cache"]').exists()).toBe(false);
        expect(meta.text()).not.toContain("—");
    });

    it("抗抖动的机制在模板里：min-h-4 + leading-4 + tabular-nums", async () => {
        const wrapper = await mountWithUsage({ totalTokens: 10 });
        const classes = wrapper.find('[data-testid="composer-meta"]').classes();
        expect(classes).toContain("min-h-4");
        expect(classes).toContain("leading-4");
        expect(classes).toContain("tabular-nums");
        expect(classes).toContain("flex");
        expect(classes).toContain("flex-wrap");
    });

    it("token 用量按千分位显示，仍是单个 span", async () => {
        const wrapper = await mountWithUsage({ inputTokens: 1000, outputTokens: 234 });
        const tokens = wrapper.findAll('[data-testid="composer-meta-tokens"]');
        expect(tokens).toHaveLength(1);
        expect(tokens[0]!.text()).toBe("1,234 / 200k");
    });

    it("有 totalTokens 时优先用它", async () => {
        const wrapper = await mountWithUsage({
            inputTokens: 10,
            outputTokens: 20,
            totalTokens: 1234567,
        });
        expect(wrapper.find('[data-testid="composer-meta-tokens"]').text()).toBe(
            "1,234,567 / 200k",
        );
    });

    it("分母优先取 usage.windowTokens 真值（131072 → 131k）", async () => {
        const wrapper = await mountWithUsage({ totalTokens: 12345, windowTokens: 131_072 });
        expect(wrapper.find('[data-testid="composer-meta-tokens"]').text()).toBe("12,345 / 131k");
    });

    it("windowTokens 缺失 / 为 null / 非正数时回落到 200k 兜底（兜底不是真值）", async () => {
        const wrapper = await mountWithUsage({ totalTokens: 500 });
        expect(wrapper.find('[data-testid="composer-meta-tokens"]').text()).toBe("500 / 200k");

        const chat = useChatStore();
        chat.setSessionLastUsage("meta-session", { totalTokens: 500, windowTokens: null });
        await nextTick();
        expect(wrapper.find('[data-testid="composer-meta-tokens"]').text()).toBe("500 / 200k");

        chat.setSessionLastUsage("meta-session", { totalTokens: 7, windowTokens: 0 });
        await nextTick();
        expect(wrapper.find('[data-testid="composer-meta-tokens"]').text()).toBe("7 / 200k");
    });
});

describe("task-133 模型 chip：未绑定警示 / 已绑定中性 / 点开去设置", () => {
    it("已绑定时是中性态 provider · model，点击把设置交给宿主页", async () => {
        modelBinding.value = { provider: "openai", model: "gpt-5" };
        const wrapper = mountInputArea();
        const chip = wrapper.find(CHIP);
        expect(chip.exists()).toBe(true);
        expect(chip.text()).toBe("openai · gpt-5");
        expect(chip.attributes("data-bound")).toBe("true");
        expect(chip.attributes("title")).toBe("模型 · 路由: openai · gpt-5");
        expect(chip.classes()).not.toContain("border-dashed");
        await chip.trigger("click");
        expect(wrapper.emitted("settings")).toHaveLength(1);
    });

    it("未绑定时是警示态：虚线 + amber，aria 写明发送前需绑定", async () => {
        const wrapper = mountInputArea();
        const chip = wrapper.find(CHIP);
        expect(chip.text()).toBe("未绑定模型");
        expect(chip.attributes("data-bound")).toBe("false");
        expect(chip.classes()).toContain("border-dashed");
        expect(chip.classes()).toContain("border-amber-500/60");
        expect(chip.attributes("title")).toBe("发送前需绑定 provider 连接（点此打开模型设置）");
        expect(chip.attributes("aria-label")).toContain("发送前需绑定 provider 连接");
        await chip.trigger("click");
        expect(wrapper.emitted("settings")).toHaveLength(1);
    });
});

describe("task-133 权限档位 chip：进工具行、不新增行高、可切三档", () => {
    it("工具行里有一个紧凑形态的档位 chip，说明压成 sr-only（不占行高）", () => {
        const wrapper = mountInputArea();
        const chips = wrapper.findAll(TIER_CHIP);
        expect(chips).toHaveLength(1);
        const chip = chips[0]!;
        // jsdom 里 SelectValue 取不到 item 文案（弹层未真正挂载），标签走 title 这条真实路径。
        expect(chip.attributes("title")).toBe("工作区内修改");
        expect(chip.attributes("aria-label")).toBe("权限档位");
        expect(chip.classes()).toContain("h-7");
        const hint = wrapper.find('[data-testid="composer-tier-chip-hint"]');
        expect(hint.exists()).toBe(true);
        expect(hint.classes()).toContain("sr-only");
        expect(wrapper.find('[data-testid="session-tier-select"]').exists()).toBe(false);
        expect(tierMock.loads).toContain("meta-session");
    });

    it("点开就是三档，且文案取自 sessionSettings 三档键（与面板选择器同源）", async () => {
        const wrapper = mountInputArea();
        await openSelect(wrapper, TIER_CHIP);
        expect(selectItemValuesFor(wrapper, TIER_CHIP)).toEqual(["view", "workspace", "full"]);
        expect(selectItemTextsFor(wrapper, TIER_CHIP)).toEqual([
            "只看不改",
            "工作区内修改",
            "完全权限",
        ]);
    });

    it("切档走既有 store 写路径（composer 不自己发请求）", async () => {
        const wrapper = mountInputArea();
        await setSelectValue(wrapper, TIER_CHIP, "full");
        expect(tierMock.changes).toEqual([["meta-session", "full"]]);
    });
});
