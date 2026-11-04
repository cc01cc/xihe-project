import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import InputArea from "../components/InputArea.vue";
import type { SessionParticipantView } from "../../../../types/participant";

/**
 * PLAN-0665 M2 T2.1：composer「定向发送」多选 chips（1..N 个 AGENT）。
 *
 * 与 0659 的「代发」栏分开：代发是**身份**（单选），定向发送是**响应者集合**（多选，
 * 每个目标各起一个 run）。这里只钉渲染与发送契约（第 5 个 emit 参数 `toParticipantIds`）。
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
            followUpEnqueue: "排队发送",
            followUpEnqueuing: "加入中…",
            followUpPlaceholder: "添加后续任务…",
            followUpComposerNotice: "当前任务之后执行",
            followUpPausedNotice: "追加到暂停队列末尾",
            followUpFullNotice: "队列已满，草稿保留",
            input: {
                toLabel: "发送",
                toTargetsLabel: "定向发送",
                toAgentsOnlyHint: "人类成员请用抄送；人类作答待后续版本",
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
const HELPER_ID = "33333333-3333-4333-8333-333333333333";

function participant(overrides: Partial<SessionParticipantView>): SessionParticipantView {
    return {
        participantId: "p",
        principalKind: "AGENT",
        principalId: "5a2b7c9d-2222-4222-8222-bbbbbbbbbbbb",
        displayName: "Agent",
        role: "MEMBER",
        orderIndex: 20,
        wakePolicy: "MENTION",
        respondPolicy: "WHEN_MENTIONED",
        source: "workspace",
        disabledAt: null,
        readCursor: null,
        selfOwned: true,
        ...overrides,
    };
}

function roster(): SessionParticipantView[] {
    return [
        participant({
            participantId: PRIMARY_ID,
            displayName: "Alpha",
            role: "PRIMARY",
            orderIndex: 10,
        }),
        participant({ participantId: HELPER_ID, displayName: "Helper", orderIndex: 30 }),
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

describe("InputArea 定向发送多选（PLAN-0665 M2 T2.1）", () => {
    it("renders only when the session has AGENT participants, with the agents-only hint", async () => {
        storeState.participants = [
            participant({ participantId: "human-1", principalKind: "HUMAN" }),
        ];
        const withoutAgents = mountInputArea();
        await flushPromises();
        expect(withoutAgents.find('[data-testid="to-targets-bar"]').exists()).toBe(false);

        storeState.participants = roster();
        const withAgents = mountInputArea();
        await flushPromises();
        expect(withAgents.find('[data-testid="to-targets-bar"]').exists()).toBe(true);
        expect(withAgents.find('[data-testid="to-agents-only-hint"]').text()).toContain(
            "人类成员请用抄送",
        );
    });

    it("does not preselect any target (empty set keeps the legacy single-responder path)", async () => {
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();

        expect(wrapper.findAll('[data-testid="to-targets-chip"]')).toHaveLength(0);
    });

    it("collects multiple targets and emits them as the 5th send argument", async () => {
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();

        await wrapper.get('[data-testid="to-targets-input"]').setValue("Alpha Helper");
        await wrapper.get('[data-testid="to-targets-input"]').trigger("keydown", { key: " " });
        await flushPromises();
        expect(
            wrapper
                .findAll('[data-testid="to-targets-chip"]')
                .map((chip) => chip.attributes("data-participant-id"))
                .sort(),
        ).toEqual([PRIMARY_ID, HELPER_ID].sort());

        await wrapper.get('[data-testid="chat-input"]').setValue("hello both");
        await wrapper.get('[data-testid="chat-send-button"]').trigger("click");
        await flushPromises();

        const emitted = wrapper.emitted("send");
        expect(emitted).toBeTruthy();
        expect(emitted![0][4]).toEqual([PRIMARY_ID, HELPER_ID]);
    });

    it("removes a target chip and stops sending it", async () => {
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();

        await wrapper.get('[data-testid="to-targets-input"]').setValue("Helper");
        await wrapper.get('[data-testid="to-targets-input"]').trigger("keydown", { key: " " });
        await flushPromises();
        await wrapper.get('[data-testid="to-targets-chip-remove"]').trigger("click");
        await flushPromises();

        expect(wrapper.findAll('[data-testid="to-targets-chip"]')).toHaveLength(0);
        await wrapper.get('[data-testid="chat-input"]').setValue("hello");
        await wrapper.get('[data-testid="chat-send-button"]').trigger("click");
        await flushPromises();
        expect(wrapper.emitted("send")![0][4]).toBeUndefined();
    });
});
