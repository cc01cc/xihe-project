import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import InputArea from "../components/InputArea.vue";
import type { SessionParticipantView } from "../../../../types/participant";

/**
 * D23-27「代发」下拉的单元契约。
 *
 * store 被替换为受控替身：这里只验证**渲染与发送契约**（显隐、候选、默认值、emit 的第三个参数），
 * 数据来源（`selfOwned` 归约、fail-closed）在 `stores/__tests__/sessionParticipants.spec.ts` 里验证。
 */
const storeState = vi.hoisted(() => ({
    canSpeakAs: false,
    speakAsCandidates: [] as SessionParticipantView[],
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
        disabledAt: null,
        readCursor: null,
        selfOwned: true,
        ...overrides,
    };
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
    storeState.ensureLoaded.mockReset();
    storeState.ensureLoaded.mockResolvedValue(undefined);
});

describe("InputArea speak-as entry (PLAN-0623 D23-27)", () => {
    // 裁定 2：speakAs=false ⇒ **不渲染**（不是禁用）。渲染一个永远点不动的入口只会让人以为坏了。
    it("renders no speak-as entry at all when the capability is off", async () => {
        storeState.canSpeakAs = false;
        storeState.speakAsCandidates = [participant({ participantId: "self" })];
        const wrapper = mountInputArea();
        await flushPromises();

        expect(wrapper.find('[data-testid="speak-as-bar"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="speak-as-input"]').exists()).toBe(false);
    });

    // 2026-11-04 用户裁定：原生 select 换成「输入 + 候选浮层」，候选在打字/↓ 后才出现。
    it("lists only the candidates the store exposes", async () => {
        storeState.canSpeakAs = true;
        storeState.speakAsCandidates = [
            participant({ participantId: "self", displayName: "Ada Lovelace" }),
            participant({ participantId: "agent", principalKind: "AGENT", displayName: "Helper" }),
        ];
        const wrapper = mountInputArea();
        await flushPromises();

        const field = wrapper.get('[data-testid="speak-as-input"]');
        // 已选中的（默认 self）不进候选，避免把自己再选一次。
        await field.setValue("h");
        await flushPromises();
        expect(
            wrapper
                .findAll('[data-testid="speak-as-option"]')
                .map((option) => option.attributes("data-participant-id")),
        ).toEqual(["agent"]);

        await field.setValue("");
        await field.trigger("keydown", { key: "ArrowDown" });
        await flushPromises();
        expect(
            wrapper
                .findAll('[data-testid="speak-as-option"]')
                .map((option) => option.attributes("data-participant-id")),
        ).toEqual(["agent"]);
    });

    it("defaults to my own HUMAN row, never to somebody else", async () => {
        storeState.canSpeakAs = true;
        storeState.speakAsCandidates = [
            participant({ participantId: "agent", principalKind: "AGENT", displayName: "Helper" }),
            participant({ participantId: "self", displayName: "Ada Lovelace" }),
        ];
        const wrapper = mountInputArea();
        await flushPromises();

        const chip = wrapper.get('[data-testid="speak-as-chip"]');
        expect(chip.attributes("data-participant-id")).toBe("self");
        expect(chip.text()).toContain("Ada Lovelace");
    });

    it("sends the selected participant id as the third argument", async () => {
        storeState.canSpeakAs = true;
        storeState.speakAsCandidates = [
            participant({ participantId: "self", displayName: "Ada Lovelace" }),
            participant({ participantId: "agent", principalKind: "AGENT", displayName: "Helper" }),
        ];
        const wrapper = mountInputArea();
        await flushPromises();

        // 空格结束一个名字：不必点候选，敲完名字 + 空格即可换人。
        const field = wrapper.get('[data-testid="speak-as-input"]');
        await field.setValue("Helper");
        await field.trigger("keydown", { key: " " });
        await flushPromises();
        expect(wrapper.get('[data-testid="speak-as-chip"]').attributes("data-participant-id")).toBe(
            "agent",
        );

        await wrapper.get('[data-testid="chat-input"]').setValue("hello");
        await wrapper.get('[data-testid="chat-send-button"]').trigger("click");
        await flushPromises();

        const emitted = wrapper.emitted("send");
        expect(emitted).toBeTruthy();
        expect(emitted![0][2]).toBe("agent");
    });
});
