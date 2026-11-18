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
    /**
     * task-129：稿代次（第 6 个 emit 参数）**只增不减**，「改回原样」也前进。
     *
     * <p>幂等键槽用它区分「同一份稿重发」与「改过又改回的新动作」：只比内容会把后者误判成重放。</p>
     */
    it("task-129: 稿代次随内容变化递增，改回原样也递增", async () => {
        const wrapper = mountInputArea({ isStreaming: true, queueMode: true }),
            textarea = wrapper.find('[data-testid="chat-input"]');
        await textarea.setValue("A");
        await textarea.trigger("keydown", { key: "Enter", shiftKey: false, isComposing: false });
        await textarea.setValue("B");
        await textarea.setValue("A");
        await textarea.trigger("keydown", { key: "Enter", shiftKey: false, isComposing: false });

        const queue = wrapper.emitted("queue");
        expect(queue).toHaveLength(2);
        const first = queue?.[0]?.[5] as number | undefined;
        const second = queue?.[1]?.[5] as number | undefined;
        expect(typeof first).toBe("number");
        expect(second).toBeGreaterThan(first!);
        // 内容回到原样，代次仍前进 ⇒ 下游不会把它当成同一份稿。
        expect(queue?.[1]?.[0]).toBe(queue?.[0]?.[0]);
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
 * <p><b>2026-11-19 task-38 C4 改判（本段原结论「内层画 ring-3」已被取代，不删以免读者按旧判据复现）</b>：
 * 用户第二次报障「光标旁还有第二个矩形框」，实测是**内层自绘环与外层容器各自画了一套**（内层
 * `box-shadow … oklab(0.205 0 0 / 0.5) 0 0 0 3px` + 外层 1px 边框）⇒ 现行判据是**只许一套**：
 * 焦点视觉由**外层容器**用 `has-[textarea:focus-visible]:ring-2` 画，内层 textarea **什么都不画**
 * （`outline-style` 与 `box-shadow` 在真机结算后都必须为 `none`，见 DEV-011 §13.3）。
 * 因此本条现在钉两件事：① 内层**没有任何** ring 声明；② 外层容器**恰好一条** ring 声明且是
 * `ring-2 + ring-ring/50`（`--ring = --primary` 的刻意定制，不得改回官方 oklch(0.708 0 0)）。</p>
 *
 * <p>变异（已实测）：把外层 `ring-2` 改回 `ring-1` / 把内层 ring 加回来 / 把 `ring-ring/50`
 * 改成 `ring-ring/60`，这三条任一都会红。内层 `focus-visible:outline-none` 仍必须留着：
 * 全局 `*:focus-visible { outline: 2px solid var(--ring) }`（`styles/main.css`）不被压住就会
 * 在环外再套一圈 2px 纯色近黑 —— 这正是 task-38 修 vendor `TabsTrigger` 时踩到的「删 utility 反而
 * 让 base 层补位」（D-1880）。</p>
 */
describe("task-30 ① / task-38 C4 composer 焦点指示只许一套", () => {
    it("内层不画环（outline-none + 无 ring），外层容器画唯一一套 ring-2", () => {
        const wrapper = mountInputArea();
        const inner = wrapper.get('[data-testid="chat-input"]');
        const innerClasses = inner.classes();
        // ① 内层不许有任何 ring（三档旧值全钉，防「两个都留着」）
        expect(innerClasses).not.toContain("focus-visible:ring-1");
        expect(innerClasses).not.toContain("focus-visible:ring-3");
        expect(innerClasses).not.toContain("focus-visible:ring-ring/50");
        expect(innerClasses).not.toContain("focus-visible:ring-ring/60");
        // 内层仍须压住全局 outline，否则 base 层补位成第二个框（D-1880）
        expect(innerClasses).toContain("focus-visible:outline-none");
        // ② 外层容器持有唯一一套环
        const container = inner.element.parentElement as HTMLElement | null;
        expect(container).not.toBeNull();
        const containerClasses = Array.from((container as HTMLElement).classList);
        expect(containerClasses).toContain("has-[textarea:focus-visible]:ring-2");
        expect(containerClasses).toContain("has-[textarea:focus-visible]:ring-ring/50");
        // 反向锚点：容器不得自己再叠 outline（base 层补位的另一半）
        expect(containerClasses.filter((c) => c.startsWith("focus-visible:outline")).length).toBe(
            0,
        );
        wrapper.unmount();
    });
});

/**
 * task-58（用户报障「输入框右下两个按钮看起来没有图标」，P1）：**primary 底色按钮的前景必须是
 * primary-foreground** —— 底色是 `bg-primary` 时，`text-primary` 与底色是**同一个 token 值**
 * （当前默认主题 light `--primary` = `--ring` = `oklch(0.205 0 0)`，`--primary-foreground` = `oklch(0.985 0 0)`）
 * ⇒ 图标与文案被底色完全吃掉，按钮看起来是空的（但点得到）。
 *
 * <p>实测读数（mock 车道 5199，`getComputedStyle`）：修前 `chat-delegate-button` 的 `color` 与
 * `backgroundColor` 都是 `oklch(0.205 0 0)`；`chat-send-button` 是 `color: oklch(0.985 0 0)`
 * vs `backgroundColor: oklch(0.205 0 0)`（正常）。</p>
 *
 * <p>为什么钉**类契约**而不是「有没有颜色」：`text-primary` 本身也是有颜色的（就是背景那个颜色），
 * 只断言"class 里有 text-*"等于恒真 —— 这正是这处缺陷活下来的原因。判据写成一条**互斥**：
 * 同一个 class 列表里 `bg-primary` 与 `text-primary` 不得共存（前者只允许配 `text-primary-foreground`）。
 * **变异自检（已实测）**：把 InputArea.vue 的委派按钮改回 `text-primary`，第一条用例必红。</p>
 */
describe("task-58 bg-primary 按钮的前景用 primary-foreground（防同色回归）", () => {
    /** 类契约判据：任意一串 class 里，`bg-primary` 与 `text-primary` 不得共存。 */
    function assertPrimaryForegroundOnly(classes: string[], where: string) {
        const tokens = new Set(classes);
        expect(tokens.has("bg-primary"), where + "：本用例只对 primary 底色按钮有判别力").toBe(
            true,
        );
        expect(
            tokens.has("text-primary-foreground"),
            where + "：前景必须是 primary-foreground",
        ).toBe(true);
        // 反向：把前景写回 text-primary 就等于把字/图标刷成底色 —— 这条是本次缺陷的原始形态。
        expect(
            tokens.has("text-primary"),
            where + "：text-primary 与 bg-primary 同色，视觉上等于隐藏",
        ).toBe(false);
    }

    it("委派按钮（InputArea.vue:891）：bg-primary 配 text-primary-foreground", () => {
        const wrapper = mountInputArea();
        const delegate = wrapper.get('[data-testid="chat-delegate-button"]');
        assertPrimaryForegroundOnly(delegate.classes(), "chat-delegate-button");
        wrapper.unmount();
    });

    it("发送按钮（对照，未受影响的正确写法）：同一条判据照样绿", () => {
        const wrapper = mountInputArea();
        const send = wrapper.get('[data-testid="chat-send-button"]');
        assertPrimaryForegroundOnly(send.classes(), "chat-send-button");
        wrapper.unmount();
    });
});
