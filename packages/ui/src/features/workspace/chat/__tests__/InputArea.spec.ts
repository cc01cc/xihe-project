import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import { toast } from "vue-sonner";
import { api, ApiError } from "../../../../composables/api";
import { useChatStore } from "../stores/chat.ts";
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

vi.mock("vue-sonner", () => ({
    toast: {
        error: vi.fn<(message: string) => void>(),
        success: vi.fn<(message: string) => void>(),
    },
}));

vi.mock("../composables/useSessionCommands", async () => {
    const { ref } = await import("vue");
    return {
        commandReasonKey: () => "chat.commands.reason.unknown",
        useSessionCommands: () => ({
            commands: ref([
                {
                    key: "/export",
                    descriptionKey: "chat.commands.description.export",
                    available: true,
                    reason: null,
                    disabled: false,
                },
            ]),
        }),
    };
});

vi.mock("../../../../services/attachmentService", () => ({
    uploadAttachments: mockedUpload,
    validateAttachment: () => ({ valid: true }),
}));

const messages = {
    "zh-CN": {
        chat: {
            placeholder: "输入消息...",
            commands: { failed: "命令执行失败", description: { export: "导出会话" } },
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
    LoaderCircle: { template: "<span />" },
    Image: { template: "<span />" },
    Camera: { template: "<span />" },
    Mic: { template: "<span />" },
    Send: { template: "<span />" },
};

function mountInputArea(props = {}, stubOverrides: Record<string, unknown> = {}) {
    return mount(InputArea, {
        props: { sessionId: "test-session", ...props },
        global: { plugins: [createI18nInstance()], stubs: { ...stubs, ...stubOverrides } },
    });
}

// BL-359：`setActivePinia` 是**全局单例**，写在 `describe("InputArea")` 内的 `beforeEach` 只对
// 该作用域生效；兄弟 `describe("BL-288 …")` 会"白蹭"前面用例设过的值 ⇒ 默认顺序绿、
// `--sequence.shuffle.tests` 红（`getActivePinia()` called but there was no active Pinia）。
// 因此把 Pinia 的建立提到文件级，任何用例（含兄弟 describe）都自带 active Pinia。
beforeEach(() => {
    setActivePinia(createPinia());
});

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

    it("BL-391: failed/cancelled run (isStreaming=false) restores the send button", async () => {
        const wrapper = mountInputArea({ isStreaming: true });
        await wrapper.find('[data-testid="chat-input"]').setValue("retry after failure");
        expect(wrapper.find('[data-testid="chat-stop-button"]').exists()).toBe(true);

        await wrapper.setProps({ isStreaming: false });

        expect(wrapper.find('[data-testid="chat-stop-button"]').exists()).toBe(false);
        const send = wrapper.find('[data-testid="chat-send-button"]');
        expect(send.exists()).toBe(true);
        expect(send.attributes("disabled")).toBeUndefined();
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

    it("creates one object URL per attachment and revokes it on remove/unmount (PLAN-0670 M2d.4)", async () => {
        const create = vi.fn<() => string>(() => "blob:preview");
        const revoke = vi.fn<(url: string) => void>();
        const originalCreate = globalThis.URL.createObjectURL;
        const originalRevoke = globalThis.URL.revokeObjectURL;
        globalThis.URL.createObjectURL = create;
        globalThis.URL.revokeObjectURL = revoke;
        mockedUpload.mockResolvedValue({ success: [], failed: [] });

        try {
            const wrapper = mountInputArea(
                {},
                {
                    ImageUpload: {
                        props: ["onUpload"],
                        setup() {
                            return {
                                files: [new File(["img"], "photo.png", { type: "image/png" })],
                            };
                        },
                        template:
                            '<button data-testid="mock-image-upload" @click="onUpload(files)" />',
                    },
                },
            );
            await wrapper.find('[data-testid="mock-image-upload"]').trigger("click");
            await flushPromises();
            expect(wrapper.findAll('[data-testid="selected-attachment"]')).toHaveLength(1);
            // 同一文件重复渲染不得重复创建（缓存按 File 命中）。
            wrapper.vm.$forceUpdate();
            await flushPromises();
            expect(create).toHaveBeenCalledTimes(1);

            await wrapper.find('[data-testid="remove-attachment-button"]').trigger("click");
            expect(revoke).toHaveBeenCalledWith("blob:preview");

            // 再次上传后组件卸载 ⇒ 仍未释放的 URL 必须 revoke（创建必配对释放）。
            await wrapper.find('[data-testid="mock-image-upload"]').trigger("click");
            await flushPromises();
            wrapper.unmount();
            expect(revoke).toHaveBeenCalledTimes(2);
        } finally {
            globalThis.URL.createObjectURL = originalCreate;
            globalThis.URL.revokeObjectURL = originalRevoke;
        }
    });
});
describe("BL-288 Problem detail for /export", () => {
    it("shows the 413 EXPORT_TOO_LARGE detail instead of the generic command copy", async () => {
        vi.mocked(toast.error).mockClear();
        const store = useChatStore();
        vi.spyOn(store, "getSelectedBranchId").mockReturnValue("branch-1");
        vi.spyOn(api, "exportSession").mockRejectedValue(
            new ApiError({
                status: 413,
                code: "EXPORT_TOO_LARGE",
                requestId: "req-288",
                detail: "会话 20001 条超过导出上限 20000；请先删除旧会话或分批导出",
            }),
        );
        const wrapper = mountInputArea();
        const textarea = wrapper.find('[data-testid="chat-input"]');
        await textarea.setValue("/export");
        await textarea.trigger("keydown", { key: "Enter", shiftKey: false, isComposing: false });
        await flushPromises();
        expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("20001"));
        vi.restoreAllMocks();
    });
});

/**
 * task-30 ①（用户报障「输入框有一圈黑框」）：判据必须是**类契约**，不是「有焦点环」——
 * 后者恒真（旧值 `ring-1` 也有环），正是它让这处孤例活了这么久。
 *
 * <p>本仓控件族的焦点环标准 = `focus-visible:ring-3` + `focus-visible:ring-ring/50`
 * （Button / Tabs / Switch / Checkbox / Select / Slider / Accordion / RadioGroup / Badge /
 * Toggle / ScrollArea 共 13 个文件）。`--ring` 在本主题下是 `--primary`（近黑）⇒ 旧值
 * `ring-1 + ring-ring/60` 就是 1px 60% 的近黑硬框，叠上容器 border 看着像渲染 bug。</p>
 *
 * <p>变异（已实测）：把 `ring-3` 改回 `ring-1`、或把 `ring-ring/50` 改回 `ring-ring/60`，
 * 这条都会红。另钉 `focus:outline-none`：全局 `*:focus-visible { outline: 2px solid var(--ring) }`
 * （`styles/main.css:225-226`）若不被压住，就会在环外面再套一圈 2px 纯色近黑 —— 比修前更糟。</p>
 */
describe("task-30 ① composer 焦点环形态", () => {
    it("输入框焦点环 = ring-3 + ring-ring/50（不是 1px/60% 硬框）", () => {
        const wrapper = mountInputArea();
        const classes = wrapper.get('[data-testid="chat-input"]').classes();
        expect(classes).toContain("focus-visible:ring-3");
        expect(classes).toContain("focus-visible:ring-ring/50");
        // 反向：旧的两条必须不在（只断言新值存在，等于允许"两个都留着"）
        expect(classes).not.toContain("focus-visible:ring-1");
        expect(classes).not.toContain("focus-visible:ring-ring/60");
        // 必须压住全局 outline，否则环外再套 2px 纯色近黑轮廓（实测那才是用户看到的"黑框"主体）
        expect(classes).toContain("focus:outline-none!");
        expect(
            classes,
            "少了 ! 就等于没压住：main.css 的 *:focus-visible 在 @layer 之外",
        ).not.toContain("focus:outline-none");
        wrapper.unmount();
    });
});
