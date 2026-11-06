import { mount, flushPromises } from "@vue/test-utils";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../../../i18n";
import type { AttachmentFile } from "../../../../types";
import AttachmentPreviewDialog from "../components/AttachmentPreviewDialog.vue";

const { previewMock, remainderMock } = vi.hoisted(() => ({
    previewMock: vi.fn<(...args: unknown[]) => unknown>(),
    remainderMock: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock("../../composables/fileService", () => ({
    ATTACHMENT_PREVIEW_BUDGET_BYTES: 8 * 1024 * 1024,
    decodePreviewText: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
    fetchAttachmentPreview: (...args: unknown[]) => previewMock(...args),
    fetchAttachmentRemainder: (...args: unknown[]) => remainderMock(...args),
}));

function attachment(overrides: Partial<AttachmentFile> = {}): AttachmentFile {
    return {
        id: "att-1",
        name: "session-export-2026-11-07.csv",
        type: "text/csv",
        size: 12 * 1024 * 1024,
        url: "/api/v1/files/att-1",
        state: "done",
        ...overrides,
    };
}

function mountDialog(overrides: { open?: boolean; url?: string; file?: AttachmentFile } = {}) {
    return mount(AttachmentPreviewDialog, {
        props: {
            open: overrides.open ?? true,
            attachment: overrides.file ?? attachment(),
            url: overrides.url ?? "/api/v1/files/att-1",
        },
        global: { plugins: [i18n] },
    });
}

function textPreview(bytes: string, totalBytes = bytes.length, truncated = false) {
    return {
        bytes: new TextEncoder().encode(bytes),
        mimeType: "text/csv",
        totalBytes,
        truncated,
    };
}

beforeAll(() => {
    Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        writable: true,
        value: vi.fn<() => string>(() => "blob:preview"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        writable: true,
        value: vi.fn<() => void>(),
    });
});

beforeEach(() => {
    previewMock.mockReset();
    remainderMock.mockReset();
});

describe("AttachmentPreviewDialog", () => {
    it("reads the attachment once when opened and renders the text prefix", async () => {
        previewMock.mockResolvedValueOnce(textPreview("col_a,col_b\n1,2\n"));

        const wrapper = mountDialog();
        await flushPromises();

        expect(previewMock).toHaveBeenCalledTimes(1);
        const [url, options] = previewMock.mock.calls[0] as [string, { signal: AbortSignal }];
        expect(url).toBe("/api/v1/files/att-1");
        expect(options.signal).toBeInstanceOf(AbortSignal);
        expect(wrapper.find('[data-testid="attachment-preview-text"]').text()).toContain(
            "col_a,col_b",
        );
        expect(wrapper.find('[data-testid="attachment-preview-truncated"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it("shows the truncation prompt with both entries when the file exceeds the budget", async () => {
        previewMock.mockResolvedValueOnce(textPreview("head", 12, true));

        const wrapper = mountDialog();
        await flushPromises();

        const truncated = wrapper.find('[data-testid="attachment-preview-truncated"]');
        expect(truncated.exists()).toBe(true);
        expect(truncated.text()).toContain("预览预算 8.0 MiB");
        expect(wrapper.find('[data-testid="attachment-preview-load-rest"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="attachment-preview-download"]').exists()).toBe(true);
        wrapper.unmount();
    });

    it("loads the remainder only on explicit action and then clears the prompt", async () => {
        previewMock.mockResolvedValueOnce(textPreview("head", 12, true));
        remainderMock.mockResolvedValueOnce({
            bytes: new TextEncoder().encode("and-rest"),
            totalBytes: 12,
        });

        const wrapper = mountDialog();
        await flushPromises();

        await wrapper.get('[data-testid="attachment-preview-load-rest"]').trigger("click");
        await flushPromises();

        expect(remainderMock).toHaveBeenCalledTimes(1);
        const [url, offset] = remainderMock.mock.calls[0] as [string, number];
        expect(url).toBe("/api/v1/files/att-1");
        expect(offset).toBe(4);
        expect(wrapper.find('[data-testid="attachment-preview-truncated"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="attachment-preview-text"]').text()).toContain(
            "headand-rest",
        );
        wrapper.unmount();
    });

    it("keeps the prompt while a continue step is still short of the entity", async () => {
        // 20 bytes with an 8-byte budget mimics CP's clamp: the first continue returns only one
        // budgeted chunk, so the file is still incomplete and the prompt must stay visible.
        previewMock.mockResolvedValueOnce({
            bytes: new Uint8Array([1]),
            mimeType: "text/csv",
            totalBytes: 20,
            truncated: true,
        });
        remainderMock
            .mockResolvedValueOnce({ bytes: new Uint8Array(8), totalBytes: 20 })
            .mockResolvedValueOnce({ bytes: new Uint8Array(11), totalBytes: 20 });

        const wrapper = mountDialog();
        await flushPromises();

        await wrapper.get('[data-testid="attachment-preview-load-rest"]').trigger("click");
        await flushPromises();

        expect(remainderMock).toHaveBeenCalledTimes(1);
        expect(wrapper.find('[data-testid="attachment-preview-truncated"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="attachment-preview-load-rest"]').exists()).toBe(true);

        await wrapper.get('[data-testid="attachment-preview-load-rest"]').trigger("click");
        await flushPromises();

        expect(remainderMock).toHaveBeenCalledTimes(2);
        expect(remainderMock.mock.calls[1]![1]).toBe(9);
        expect(wrapper.find('[data-testid="attachment-preview-truncated"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it("keeps the prompt when the continued response still has no total", async () => {
        previewMock.mockResolvedValueOnce({
            bytes: new Uint8Array([1]),
            mimeType: "text/csv",
            totalBytes: null,
            truncated: true,
        });
        remainderMock.mockResolvedValueOnce({ bytes: new Uint8Array([2, 3]), totalBytes: null });

        const wrapper = mountDialog();
        await flushPromises();

        await wrapper.get('[data-testid="attachment-preview-load-rest"]').trigger("click");
        await flushPromises();

        // Unknown total can not prove completeness: stay conservative instead of claiming done.
        expect(wrapper.find('[data-testid="attachment-preview-truncated"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="attachment-preview-load-rest"]').exists()).toBe(true);
        wrapper.unmount();
    });

    it("renders an error with retry instead of the preview", async () => {
        previewMock.mockRejectedValueOnce(new Error("boom"));
        previewMock.mockResolvedValueOnce(textPreview("recovered"));

        const wrapper = mountDialog();
        await flushPromises();

        expect(wrapper.find('[data-testid="attachment-preview-error"]').exists()).toBe(true);
        expect(wrapper.text()).toContain("boom");

        const retry = wrapper.findAll("button").find((button) => button.text() === "重试");
        expect(retry).toBeDefined();
        await retry!.trigger("click");
        await flushPromises();

        expect(previewMock).toHaveBeenCalledTimes(2);
        expect(wrapper.find('[data-testid="attachment-preview-error"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="attachment-preview-text"]').text()).toContain(
            "recovered",
        );
        wrapper.unmount();
    });

    it("aborts the in-flight preview when the dialog closes", async () => {
        let receivedSignal: AbortSignal | undefined;
        previewMock.mockImplementation((...args: unknown[]) => {
            const [, options] = args as [string, { signal: AbortSignal }];
            return new Promise((_resolve, reject) => {
                receivedSignal = options.signal;
                options.signal.addEventListener("abort", () =>
                    reject(new DOMException("Aborted", "AbortError")),
                );
            });
        });

        const wrapper = mountDialog();
        await flushPromises();
        expect(receivedSignal?.aborted).toBe(false);

        await wrapper.setProps({ open: false });

        expect(receivedSignal?.aborted).toBe(true);
        wrapper.unmount();
    });

    it("downloads the original from the truncation prompt", async () => {
        previewMock.mockResolvedValueOnce(textPreview("head", 12, true));
        const anchorClick = vi
            .spyOn(HTMLAnchorElement.prototype, "click")
            .mockImplementation(() => {});

        const wrapper = mountDialog();
        await flushPromises();
        await wrapper.get('[data-testid="attachment-preview-download"]').trigger("click");

        expect(anchorClick).toHaveBeenCalledTimes(1);
        anchorClick.mockRestore();
        wrapper.unmount();
    });

    it("renders an in-budget image through the shared image preview", async () => {
        previewMock.mockResolvedValueOnce({
            bytes: new Uint8Array([137, 80, 78, 71]),
            mimeType: "image/png",
            totalBytes: 4,
            truncated: false,
        });

        const wrapper = mountDialog({
            file: attachment({ name: "screen.png", type: "image/png" }),
        });
        await flushPromises();

        expect(wrapper.find('[data-testid="attachment-preview-image"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="workspace-image-preview"]').exists()).toBe(true);
        expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
        wrapper.unmount();
    });
});
