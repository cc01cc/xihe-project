import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import InputArea from "../components/InputArea.vue";
import type { AttachmentFile } from "../../../../types";

const mockedUpload = vi.hoisted(() =>
    vi.fn<
        (
            sessionId: string,
            files: File[],
        ) => Promise<{
            success: AttachmentFile[];
            failed: { name: string; reason: string }[];
        }>
    >(),
);

vi.mock("../../../../services/attachmentService", () => ({
    uploadAttachments: mockedUpload,
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
        multimodal: { image: "图片", screenshot: "截图", voice: "语音" },
        common: { cancel: "取消" },
    },
};

function createI18nInstance() {
    return createI18n({ legacy: false, locale: "zh-CN", fallbackLocale: "zh-CN", messages });
}

const stubs = {
    ImageUpload: {
        props: ["onUpload"],
        setup() {
            return {
                files: [
                    new File(["test"], "retry.txt", { type: "text/plain" }),
                    new File(["later"], "failed.txt", { type: "text/plain" }),
                ],
            };
        },
        template: '<button data-testid="mock-image-upload" @click="onUpload(files)" />',
    },
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

function mountInputArea(props = {}) {
    return mount(InputArea, {
        props: { sessionId: "test-session", ...props },
        global: { plugins: [createI18nInstance()], stubs },
    });
}

describe("InputArea", () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        mockedUpload.mockReset();
    });
    it("renders textarea for input", () => {
        const wrapper = mountInputArea();
        expect(wrapper.find("textarea").exists()).toBe(true);
    });

    it("renders multimodal action buttons", () => {
        const wrapper = mountInputArea();
        expect(wrapper.find("textarea").exists()).toBe(true);
    });

    it("textarea has placeholder text", () => {
        const wrapper = mountInputArea(),
            textarea = wrapper.find("textarea");
        expect(textarea.attributes("placeholder")).toBeDefined();
    });

    it("renders send button", () => {
        const wrapper = mountInputArea();
        expect(wrapper.find("button").exists()).toBe(true);
    });

    it("queues with Enter while streaming and keeps Stop separate", async () => {
        const wrapper = mountInputArea({ isStreaming: true, queueMode: true }),
            textarea = wrapper.find('[data-testid="chat-input"]');
        await textarea.setValue("run this after the active task");
        await textarea.trigger("keydown", { key: "Enter", shiftKey: false, isComposing: false });

        expect(wrapper.emitted("queue")?.[0]?.[0]).toBe("run this after the active task");
        expect(wrapper.emitted("send")).toBeUndefined();
        expect(wrapper.find('[data-testid="chat-stop-button"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="chat-queue-button"]').exists()).toBe(true);
    });

    it("keeps the draft disabled when the Follow-up queue is full", async () => {
        const wrapper = mountInputArea({ queueMode: true, queueFull: true });
        await wrapper.find('[data-testid="chat-input"]').setValue("keep this draft");

        expect(
            wrapper.find('[data-testid="chat-queue-button"]').attributes("disabled"),
        ).toBeDefined();
    });

    it("preserves failed Follow-up attachments and retries only uploads not already cached", async () => {
        const uploaded: AttachmentFile = {
                id: "local-file-id",
                fileId: "server-file-id",
                name: "retry.txt",
                type: "text/plain",
                size: 4,
                url: "",
                state: "done",
            },
            retried: AttachmentFile = {
                id: "local-failed-id",
                fileId: "server-failed-id",
                name: "failed.txt",
                type: "text/plain",
                size: 5,
                url: "",
                state: "done",
            };
        mockedUpload
            .mockResolvedValueOnce({
                success: [uploaded],
                failed: [{ name: "failed.txt", reason: "temporary upload failure" }],
            })
            .mockResolvedValueOnce({ success: [retried], failed: [] });
        const wrapper = mountInputArea({ queueMode: true });
        await wrapper.find('[data-testid="chat-input"]').setValue("run with this file");
        await wrapper.find('[data-testid="mock-image-upload"]').trigger("click");

        await wrapper.find('[data-testid="chat-queue-button"]').trigger("click");
        await flushPromises();
        expect(wrapper.find('[data-testid="chat-input"]').element.value).toBe("run with this file");
        expect(
            wrapper.find('[data-testid="chat-queue-button"]').attributes("disabled"),
        ).toBeUndefined();
        expect(wrapper.emitted("queue")).toBeUndefined();
        expect(wrapper.find('[data-testid="attachment-upload-error"]').exists()).toBe(true);

        await wrapper.find('[data-testid="chat-queue-button"]').trigger("click");
        await flushPromises();

        expect(mockedUpload).toHaveBeenCalledTimes(2);
        expect(mockedUpload.mock.calls[0]?.[1].map((file) => file.name)).toEqual([
            "retry.txt",
            "failed.txt",
        ]);
        expect(mockedUpload.mock.calls[1]?.[1].map((file) => file.name)).toEqual(["failed.txt"]);
        expect(wrapper.emitted("queue")).toHaveLength(1);
        expect(wrapper.emitted("queue")?.[0]?.[1]?.map((file) => file.fileId)).toEqual([
            "server-file-id",
            "server-failed-id",
        ]);
    });

    it("reuploads attachments for each ordinary Chat send attempt", async () => {
        const uploaded: AttachmentFile = {
                id: "local-file-id",
                fileId: "server-file-id",
                name: "retry.txt",
                type: "text/plain",
                size: 4,
                url: "",
                state: "done",
            },
            secondUploaded: AttachmentFile = {
                id: "local-file-id-2",
                fileId: "server-file-id-2",
                name: "failed.txt",
                type: "text/plain",
                size: 5,
                url: "",
                state: "done",
            };
        mockedUpload.mockResolvedValue({ success: [uploaded, secondUploaded], failed: [] });
        const wrapper = mountInputArea();
        await wrapper.find('[data-testid="chat-input"]').setValue("send with this file");
        await wrapper.find('[data-testid="mock-image-upload"]').trigger("click");

        await wrapper.find('[data-testid="chat-send-button"]').trigger("click");
        await flushPromises();
        await wrapper.find('[data-testid="chat-send-button"]').trigger("click");
        await flushPromises();

        expect(mockedUpload).toHaveBeenCalledTimes(2);
    });
});
