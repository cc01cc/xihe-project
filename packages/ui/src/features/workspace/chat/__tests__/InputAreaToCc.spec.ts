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
    ModelPopover: { template: "<div />" },
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

beforeEach(() => {
    setActivePinia(createPinia());
    storeState.canSpeakAs = false;
    storeState.speakAsCandidates = [];
    storeState.participants = [];
    storeState.ensureLoaded.mockReset();
    storeState.ensureLoaded.mockResolvedValue(undefined);
});

describe("InputArea to/cc (PLAN-0630 M5b, D30-14)", () => {
    it("to 默认选中 PRIMARY participant", async () => {
        storeState.canSpeakAs = true;
        storeState.speakAsCandidates = roster().filter((item) => item.selfOwned);
        const wrapper = mountInputArea();
        await flushPromises();

        expect(
            (wrapper.get('[data-testid="speak-as-select"]').element as HTMLSelectElement).value,
        ).toBe(PRIMARY_ID);
    });

    it("cc 初始为空（无 chips、无待选残留）", async () => {
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();

        expect(wrapper.find('[data-testid="cc-chip"]').exists()).toBe(false);
        expect(wrapper.findAll('[data-testid="cc-add-select"] option')).toHaveLength(
            // placeholder + 全部未停用参与者（to 栏未渲染，无排除项）
            roster().length + 1,
        );
    });

    it("cc chips 可添加与移除", async () => {
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();

        await wrapper.get('[data-testid="cc-add-select"]').setValue(HELPER_ID);
        let chips = wrapper.findAll('[data-testid="cc-chip"]');
        expect(chips.map((chip) => chip.attributes("data-participant-id"))).toEqual([HELPER_ID]);

        await wrapper.get('[data-testid="cc-chip-remove"]').trigger("click");
        chips = wrapper.findAll('[data-testid="cc-chip"]');
        expect(chips).toHaveLength(0);
        // 移除后回到候选列表，可再次添加。
        const options = wrapper.findAll('[data-testid="cc-add-select"] option');
        expect(options.some((option) => option.attributes("value") === HELPER_ID)).toBe(true);
    });

    it("to 改变不写回 Session 绑定（store 数据源不被触碰）", async () => {
        storeState.canSpeakAs = true;
        storeState.speakAsCandidates = roster().filter((item) => item.selfOwned);
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();

        const participantsBefore = storeState.participants;
        const callsBefore = storeState.ensureLoaded.mock.calls.length;
        await wrapper.get('[data-testid="speak-as-select"]').setValue(SELF_ID);
        await flushPromises();

        expect(storeState.participants).toBe(participantsBefore);
        expect(storeState.ensureLoaded.mock.calls.length).toBe(callsBefore);
    });

    it("发送时把 cc participantId 数组作为第四个参数发出", async () => {
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();

        await wrapper.get('[data-testid="cc-add-select"]').setValue(HELPER_ID);
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
