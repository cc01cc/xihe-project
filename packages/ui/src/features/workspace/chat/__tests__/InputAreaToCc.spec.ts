import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import InputArea from "../components/InputArea.vue";
import type { SessionParticipantView } from "../../../../types/participant";

/**
 * PLAN-0630 M5b (D30-14) composer to/cc 的单元契约。
 *
 * store 被替换为受控替身：这里只验证**渲染与发送契约**——
 * to 默认 = PRIMARY、cc 初始为空、chips 增删、@自动入 cc、to 改变不写回任何绑定。
 */
const storeState = vi.hoisted(() => ({
    canSpeakAs: false,
    speakAsCandidates: [] as SessionParticipantView[],
    participants: [] as SessionParticipantView[],
    ensureLoaded: vi.fn<(id: string | null) => Promise<void>>(),
}));

vi.mock("../../stores/sessionParticipants", () => ({
    useSessionParticipantsStore: () => storeState,
}));

vi.mock("../../../../services/attachmentService", () => ({
    uploadAttachments: vi.fn<() => Promise<{ success: never[]; failed: never[] }>>(),
    validateAttachment: () => ({ valid: true }),
}));

const messages = {
    "zh-CN": {
        chat: {
            placeholder: "输入消息...",
            send: "发送",
            stop: "停止",
            input: {
                toLabel: "收件人",
                ccLabel: "抄送",
                ccAdd: "添加…",
                ccRemove: "移除抄送",
            },
        },
        workspace: {
            speakAsLabel: "以此身份发言",
            participantUnknownName: "未知用户",
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

const PRIMARY_ID = "11111111-1111-4111-8111-111111111111";
const SELF_ID = "22222222-2222-4222-8222-222222222222";
const HELPER_ID = "33333333-3333-4333-8333-333333333333";

function participant(overrides: Partial<SessionParticipantView>): SessionParticipantView {
    return {
        participantId: "p",
        principalKind: "HUMAN",
        principalId: "5a2b7c9d-2222-4222-8222-bbbbbbbbbbbb",
        displayName: "Ada Lovelace",
        role: "MEMBER",
        orderIndex: 20,
        wakePolicy: "MENTION",
        respondPolicy: "WHEN_MENTIONED",
        source: null,
        disabledAt: null,
        readCursor: null,
        selfOwned: true,
        ...overrides,
    };
}

/** 典型会话：PRIMARY agent（我能代发）+ 我自己 + 一个 MEMBER agent Helper。 */
function roster(): SessionParticipantView[] {
    return [
        participant({
            participantId: PRIMARY_ID,
            principalKind: "AGENT",
            displayName: "Alpha",
            role: "PRIMARY",
            orderIndex: 10,
        }),
        participant({ participantId: SELF_ID, displayName: "Ada Lovelace" }),
        participant({
            participantId: HELPER_ID,
            principalKind: "AGENT",
            displayName: "Helper",
            orderIndex: 30,
        }),
    ];
}

function mountInputArea() {
    return mount(InputArea, {
        props: { sessionId: "session-1" },
        global: {
            plugins: [
                createI18n({ legacy: false, locale: "zh-CN", fallbackLocale: "zh-CN", messages }),
            ],
            stubs,
        },
    });
}

/**
 * 2026-11-04 composer 打磨：抄送栏**默认收起**为「抄送 +」小按钮 —— 需要输入框的用例先点开。
 * （旧断言"挂载即见 cc-input"已随折叠模型废止。）
 */
async function openCcBar(wrapper: ReturnType<typeof mountInputArea>) {
    await wrapper.get('[data-testid="cc-expand"]').trigger("click");
    await flushPromises();
}

beforeEach(() => {
    setActivePinia(createPinia());
    storeState.canSpeakAs = false;
    storeState.speakAsCandidates = [];
    storeState.participants = [];
    storeState.ensureLoaded.mockReset();
    storeState.ensureLoaded.mockResolvedValue(undefined);
});

describe("InputArea to/cc (PLAN-0630 M5b, D30-14)", () => {
    // 2026-11-04 用户裁定：「发送 / 抄送」都是「输入 + 候选浮层」，空格结束一个名字。
    it("发送栏默认选中 PRIMARY participant", async () => {
        storeState.canSpeakAs = true;
        storeState.speakAsCandidates = roster().filter((item) => item.selfOwned);
        const wrapper = mountInputArea();
        await flushPromises();

        expect(wrapper.get('[data-testid="speak-as-chip"]').attributes("data-participant-id")).toBe(
            PRIMARY_ID,
        );
        expect(wrapper.get('[data-testid="speak-as-chip"]').text()).toContain("Alpha");
    });

    it("抄送默认收起为「抄送 +」，点击后才出现输入行", async () => {
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();

        // 2026-11-04 裁定：有候选也不再常驻占一行 —— 默认只给一个小按钮。
        expect(wrapper.find('[data-testid="cc-chip"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="cc-input"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="cc-bar"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="cc-expand"]').exists()).toBe(true);

        await openCcBar(wrapper);
        expect(wrapper.find('[data-testid="cc-input"]').exists()).toBe(true);
    });

    it("抄送 chips 可输入添加、可 × 移除、可再次添加", async () => {
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();
        await openCcBar(wrapper);

        const field = wrapper.get('[data-testid="cc-input"]');
        await field.setValue("Helper");
        await field.trigger("keydown", { key: " " });
        await flushPromises();
        expect(
            wrapper
                .findAll('[data-testid="cc-chip"]')
                .map((chip) => chip.attributes("data-participant-id")),
        ).toEqual([HELPER_ID]);

        await wrapper.get('[data-testid="cc-chip-remove"]').trigger("click");
        await flushPromises();
        expect(wrapper.findAll('[data-testid="cc-chip"]')).toHaveLength(0);

        // 移除后候选里还能再选回同一个人。
        await wrapper.get('[data-testid="cc-input"]').setValue("Helper");
        await wrapper.get('[data-testid="cc-input"]').trigger("keydown", { key: "Enter" });
        await flushPromises();
        expect(
            wrapper
                .findAll('[data-testid="cc-chip"]')
                .map((chip) => chip.attributes("data-participant-id")),
        ).toEqual([HELPER_ID]);
    });

    it("多个名字用空格分隔，一次可以加入多条抄送", async () => {
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();
        await openCcBar(wrapper);

        await wrapper.get('[data-testid="cc-input"]').setValue("Helper Alpha");
        await wrapper.get('[data-testid="cc-input"]').trigger("keydown", { key: " " });
        await flushPromises();
        expect(
            wrapper
                .findAll('[data-testid="cc-chip"]')
                .map((chip) => chip.attributes("data-participant-id"))
                .sort(),
        ).toEqual([HELPER_ID, PRIMARY_ID].sort());
    });

    it("输入不存在的人名时不落 chip，并给出提示", async () => {
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();
        await openCcBar(wrapper);

        await wrapper.get('[data-testid="cc-input"]').setValue("Nobody");
        await wrapper.get('[data-testid="cc-input"]').trigger("keydown", { key: " " });
        await flushPromises();

        expect(wrapper.findAll('[data-testid="cc-chip"]')).toHaveLength(0);
        expect(wrapper.find('[data-testid="cc-unknown"]').exists()).toBe(true);
    });

    it("发送栏改变不写回 Session 绑定（store 数据源不被触碰）", async () => {
        storeState.canSpeakAs = true;
        storeState.speakAsCandidates = roster().filter((item) => item.selfOwned);
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();

        const participantsBefore = storeState.participants;
        const callsBefore = storeState.ensureLoaded.mock.calls.length;
        await wrapper.get('[data-testid="speak-as-input"]').setValue("Ada Lovelace");
        await wrapper.get('[data-testid="speak-as-input"]').trigger("keydown", { key: "Enter" });
        await flushPromises();

        expect(wrapper.get('[data-testid="speak-as-chip"]').attributes("data-participant-id")).toBe(
            SELF_ID,
        );
        expect(storeState.participants).toBe(participantsBefore);
        expect(storeState.ensureLoaded.mock.calls.length).toBe(callsBefore);
    });

    it("发送时把 cc participantId 数组作为第四个参数发出", async () => {
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();
        await openCcBar(wrapper);

        await wrapper.get('[data-testid="cc-input"]').setValue("Helper");
        await wrapper.get('[data-testid="cc-input"]').trigger("keydown", { key: " " });
        await flushPromises();
        await wrapper.get('[data-testid="chat-input"]').setValue("hello");
        await wrapper.get('[data-testid="chat-send-button"]').trigger("click");
        await flushPromises();

        const emitted = wrapper.emitted("send");
        expect(emitted).toBeTruthy();
        expect(emitted![0][3]).toEqual([HELPER_ID]);
    });

    it("输入 @displayName 自动把被提及者加入 cc（T5b.2）", async () => {
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();

        await wrapper.get('[data-testid="chat-input"]').setValue("@Helper 看下这个");
        await flushPromises();

        const chips = wrapper.findAll('[data-testid="cc-chip"]');
        expect(chips.map((chip) => chip.attributes("data-participant-id"))).toEqual([HELPER_ID]);
    });

    it("自动入 cc 后发送，cc 字段含被 @ 的 participantId（T5b.2 判据）", async () => {
        storeState.canSpeakAs = true;
        storeState.speakAsCandidates = roster().filter((item) => item.selfOwned);
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();

        await wrapper.get('[data-testid="chat-input"]').setValue("@Helper 看下这个");
        await wrapper.get('[data-testid="chat-send-button"]').trigger("click");
        await flushPromises();

        const emitted = wrapper.emitted("send");
        expect(emitted).toBeTruthy();
        expect(emitted![0][3]).toEqual([HELPER_ID]);
    });

    it("手动移除的 chip 不会被同一个 @ 自动加回（直到该 @ 从文本消失）", async () => {
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();

        await wrapper.get('[data-testid="chat-input"]').setValue("@Helper 看下这个");
        await flushPromises();
        expect(wrapper.findAll('[data-testid="cc-chip"]')).toHaveLength(1);

        await wrapper.get('[data-testid="cc-chip-remove"]').trigger("click");
        expect(wrapper.findAll('[data-testid="cc-chip"]')).toHaveLength(0);

        // 文本里仍挂着 @Helper —— 继续输入不自动加回。
        await wrapper.get('[data-testid="chat-input"]').setValue("@Helper 再看下这个");
        await flushPromises();
        expect(wrapper.findAll('[data-testid="cc-chip"]')).toHaveLength(0);

        // @ 消失后再重新 @，自动入 cc 恢复。
        await wrapper.get('[data-testid="chat-input"]').setValue("没有提及");
        await flushPromises();
        await wrapper.get('[data-testid="chat-input"]').setValue("@Helper 重新提及");
        await flushPromises();
        expect(
            wrapper
                .findAll('[data-testid="cc-chip"]')
                .map((chip) => chip.attributes("data-participant-id")),
        ).toEqual([HELPER_ID]);
    });

    it("@all 不自动入 cc（保留 token 由 mention fan-out 处理）", async () => {
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();

        await wrapper.get('[data-testid="chat-input"]').setValue("@all 大家看");
        await flushPromises();

        expect(wrapper.findAll('[data-testid="cc-chip"]')).toHaveLength(0);
    });
});

describe("composer 打磨（2026-11-04 用户裁定）", () => {
    it("抄送三态：默认收起 → 手动展开 → 手动收起（chips 清空后）", async () => {
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();

        expect(wrapper.find('[data-testid="cc-expand"]').exists()).toBe(true);
        await openCcBar(wrapper);
        expect(wrapper.get('[data-testid="cc-input"]').exists()).toBe(true);
        // 展开态且无 chips → 允许手动收起。
        expect(wrapper.find('[data-testid="cc-collapse"]').exists()).toBe(true);
        await wrapper.get('[data-testid="cc-collapse"]').trigger("click");
        await flushPromises();
        expect(wrapper.find('[data-testid="cc-input"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="cc-expand"]').exists()).toBe(true);
    });

    it("已有 chips 时不允许收起（名字必须可见）；chips 清空后可收起", async () => {
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();
        await openCcBar(wrapper);

        await wrapper.get('[data-testid="cc-input"]').setValue("Helper");
        await wrapper.get('[data-testid="cc-input"]').trigger("keydown", { key: " " });
        await flushPromises();
        expect(wrapper.findAll('[data-testid="cc-chip"]')).toHaveLength(1);
        // 有 chips → 收起按钮不渲染（避免把名字藏起来）。
        expect(wrapper.find('[data-testid="cc-collapse"]').exists()).toBe(false);

        await wrapper.get('[data-testid="cc-chip-remove"]').trigger("click");
        await flushPromises();
        expect(wrapper.find('[data-testid="cc-collapse"]').exists()).toBe(true);
        await wrapper.get('[data-testid="cc-collapse"]').trigger("click");
        await flushPromises();
        expect(wrapper.find('[data-testid="cc-expand"]').exists()).toBe(true);
    });

    it("手动展开按会话记忆：切走再切回保持展开，新会话回到默认收起", async () => {
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();
        await openCcBar(wrapper);

        // 切到另一个会话 → 未记忆过 ⇒ 默认收起。
        await wrapper.setProps({ sessionId: "session-2" });
        await flushPromises();
        expect(wrapper.find('[data-testid="cc-expand"]').exists()).toBe(true);

        // 切回 session-1 → 记得上次手动展开。
        await wrapper.setProps({ sessionId: "session-1" });
        await flushPromises();
        expect(wrapper.find('[data-testid="cc-input"]').exists()).toBe(true);
    });

    it("焦点环只落在真实 input：composer 容器不再套满框 ring", async () => {
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();

        const textarea = wrapper.get('[data-testid="chat-input"]');
        expect(textarea.classes().join(" ")).toContain("focus-visible:ring-1");
        // 全宽容器（textarea 的祖先）不得再把 focus-within ring 套成满框。
        const composerBox = textarea.element.parentElement?.parentElement;
        expect(composerBox?.className ?? "").not.toContain("focus-within:ring");
    });
});
