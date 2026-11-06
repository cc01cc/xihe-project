import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useAuthStore } from "../../../stores/auth";
import { ApiError, api } from "../../../composables/api";
import {
    ATTACHMENT_PREVIEW_BUDGET_BYTES,
    decodePreviewText,
    fetchAttachmentPreview,
    fetchAttachmentRemainder,
    parseContentRange,
    readFilePreview,
} from "../composables/fileService";

beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
});

describe("readFilePreview", () => {
    it("handles intercept case with empty content", async () => {
        const result = await readFilePreview("/large/file", 200 * 1024 * 1024, "ws-1");
        expect(result).toEqual({ content: "", truncated: true });
    });

    it("loads a preview through bounded line ranges", async () => {
        const auth = useAuthStore();
        auth.$patch({ token: "mock", workspace: { id: "ws-1", name: "Default Workspace" } });
        const readRange = vi.spyOn(api, "readFileRange").mockResolvedValue({
            content: "1 | file content",
            total_lines: 1,
            is_binary: false,
        });
        const result = await readFilePreview("/small/file", 100, "ws-1");
        expect(result.content).toBe("file content");
        expect(result.truncated).toBe(false);
        expect(readRange).toHaveBeenCalledWith("/small/file", "ws-1", 1, 256, undefined);
    });

    it("stops at the 8 MiB preview budget and marks the result truncated", async () => {
        const auth = useAuthStore();
        auth.$patch({ token: "mock", workspace: { id: "ws-1", name: "Default Workspace" } });
        const maxBytes = 8 * 1024 * 1024;
        vi.spyOn(api, "readFileRange").mockResolvedValue({
            content: `1 | ${"a".repeat(maxBytes)}`,
            total_lines: 2,
            is_binary: false,
        });

        const result = await readFilePreview("/large/file", 12 * 1024 * 1024, "ws-1");

        expect(new TextEncoder().encode(result.content).byteLength).toBe(maxBytes);
        expect(result.truncated).toBe(true);
        expect(api.readFileRange).toHaveBeenCalledTimes(1);
    });

    it("allows a complete preview exactly at the 8 MiB budget", async () => {
        const auth = useAuthStore();
        auth.$patch({ token: "mock", workspace: { id: "ws-1", name: "Default Workspace" } });
        const maxBytes = 8 * 1024 * 1024;
        vi.spyOn(api, "readFileRange").mockResolvedValue({
            content: `1 | ${"a".repeat(maxBytes)}`,
            total_lines: 1,
            is_binary: false,
        });

        const result = await readFilePreview("/exact/file", 100, "ws-1");

        expect(new TextEncoder().encode(result.content).byteLength).toBe(maxBytes);
        expect(result.truncated).toBe(false);
    });

    it("throws on API error", async () => {
        const auth = useAuthStore();
        auth.$patch({ token: "mock", workspace: { id: "ws-1", name: "Default Workspace" } });
        vi.spyOn(globalThis, "fetch").mockResolvedValue({
            ok: false,
            status: 500,
        } as Response);
        await expect(readFilePreview("/bad/file", 100, "ws-1")).rejects.toThrow("API error 500");
    });
});

// PLAN-0683 T2.1: attachment previews are one bounded range request per preview, and
// the 8 MiB budget is bytes on the wire — never a silent whole-file download.
describe("parseContentRange", () => {
    it("parses start, end and total", () => {
        expect(parseContentRange("bytes 0-1048575/12582912")).toEqual({
            start: 0,
            end: 1048575,
            total: 12582912,
        });
    });

    it("parses an unknown total", () => {
        expect(parseContentRange("bytes 0-99/*")).toEqual({ start: 0, end: 99, total: null });
    });

    it("tolerates surrounding whitespace and casing", () => {
        expect(parseContentRange("  Bytes 10-19/200 ")).toEqual({
            start: 10,
            end: 19,
            total: 200,
        });
    });

    it("returns null for malformed values", () => {
        for (const value of [
            "",
            null,
            undefined,
            "bytes 0-1",
            "items 0-1/5",
            "bytes 9-1/10",
            "bytes 0-1/x",
        ]) {
            expect(parseContentRange(value)).toBeNull();
        }
    });
});

describe("fetchAttachmentPreview", () => {
    const fetchMock = vi.fn<typeof fetch>();

    function previewUrl() {
        return "/api/v1/files/preview";
    }

    beforeEach(() => {
        fetchMock.mockReset();
        vi.stubGlobal("fetch", fetchMock);
        localStorage.setItem("xihe-token", "preview-token");
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        localStorage.clear();
    });

    it("sends one bounded range request and reports the real total", async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(new Uint8Array([1, 2, 3, 4]), {
                status: 206,
                headers: {
                    "Content-Range": "bytes 0-3/100",
                    "Content-Type": "image/png",
                },
            }),
        );

        const preview = await fetchAttachmentPreview(previewUrl());

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(previewUrl());
        const headers = init.headers as Record<string, string>;
        expect(headers.Range).toBe(`bytes=0-${ATTACHMENT_PREVIEW_BUDGET_BYTES - 1}`);
        expect(headers.Authorization).toBe("Bearer preview-token");
        expect(preview.totalBytes).toBe(100);
        expect(preview.truncated).toBe(true);
        expect(preview.mimeType).toBe("image/png");
        expect(Array.from(preview.bytes)).toEqual([1, 2, 3, 4]);
    });

    it("treats a file exactly at the budget as complete", async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(new Uint8Array(16).fill(7), {
                status: 206,
                headers: { "Content-Range": "bytes 0-15/16" },
            }),
        );

        const preview = await fetchAttachmentPreview(previewUrl(), { budget: 16 });

        expect(preview.bytes.byteLength).toBe(16);
        expect(preview.totalBytes).toBe(16);
        expect(preview.truncated).toBe(false);
    });

    it("marks budget+1 as truncated", async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(new Uint8Array(16).fill(7), {
                status: 206,
                headers: { "Content-Range": "bytes 0-15/17" },
            }),
        );

        const preview = await fetchAttachmentPreview(previewUrl(), { budget: 16 });

        expect(preview.bytes.byteLength).toBe(16);
        expect(preview.totalBytes).toBe(17);
        expect(preview.truncated).toBe(true);
    });

    it("caps a 200 response that ignored Range, without a Content-Length", async () => {
        fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(64).fill(3)));

        const preview = await fetchAttachmentPreview(previewUrl(), { budget: 16 });

        expect(preview.bytes.byteLength).toBe(16);
        expect(preview.totalBytes).toBeNull();
        expect(preview.truncated).toBe(true);
    });

    it("does not report truncation when a 200 response ends exactly at the budget", async () => {
        fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(16).fill(3)));

        const preview = await fetchAttachmentPreview(previewUrl(), { budget: 16 });

        expect(preview.bytes.byteLength).toBe(16);
        expect(preview.truncated).toBe(false);
    });

    it("falls back to a plain request when the range is not satisfiable (416)", async () => {
        fetchMock
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        status: 416,
                        code: "RANGE_NOT_SATISFIABLE",
                        detail: "range outside the entity",
                        requestId: "req-416",
                    }),
                    { status: 416, headers: { "Content-Type": "application/problem+json" } },
                ),
            )
            .mockResolvedValueOnce(
                new Response(new Uint8Array([9, 8, 7, 6]), {
                    headers: { "Content-Length": "4", "Content-Type": "text/plain" },
                }),
            );

        const preview = await fetchAttachmentPreview(previewUrl());

        expect(fetchMock).toHaveBeenCalledTimes(2);
        const secondInit = fetchMock.mock.calls[1]![1] as RequestInit;
        const secondHeaders = secondInit.headers as Record<string, string>;
        expect(secondHeaders.Range).toBeUndefined();
        expect(preview.bytes.byteLength).toBe(4);
        expect(preview.totalBytes).toBe(4);
        expect(preview.truncated).toBe(false);
    });

    it("maps a 400 INVALID_RANGE problem to ApiError", async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    status: 400,
                    code: "INVALID_RANGE",
                    detail: "malformed Range header",
                    requestId: "req-400",
                }),
                { status: 400, headers: { "Content-Type": "application/problem+json" } },
            ),
        );

        const error = await fetchAttachmentPreview(previewUrl()).catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).problem.code).toBe("INVALID_RANGE");
    });

    it("aborts the in-flight request through the provided signal", async () => {
        const controller = new AbortController();
        fetchMock.mockImplementation(
            (_url: string, init?: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () =>
                        reject(new DOMException("Aborted", "AbortError")),
                    );
                }),
        );

        const pending = fetchAttachmentPreview(previewUrl(), { signal: controller.signal });
        controller.abort();

        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    });
});

describe("fetchAttachmentRemainder", () => {
    const fetchMock = vi.fn<typeof fetch>();

    beforeEach(() => {
        fetchMock.mockReset();
        vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("requests bytes from the offset and returns the merged total", async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(new Uint8Array([5, 6]), {
                status: 206,
                headers: { "Content-Range": "bytes 4-5/6" },
            }),
        );

        const rest = await fetchAttachmentRemainder("/api/v1/files/preview", 4);

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("/api/v1/files/preview");
        expect((init.headers as Record<string, string>).Range).toBe("bytes=4-");
        expect(Array.from(rest.bytes)).toEqual([5, 6]);
        expect(rest.totalBytes).toBe(6);
    });
});

describe("decodePreviewText", () => {
    it("decodes UTF-8 text and drops an incomplete trailing code point", () => {
        const encoded = new TextEncoder().encode("你好");
        expect(decodePreviewText(encoded)).toBe("你好");
        expect(decodePreviewText(encoded.slice(0, 4))).toBe("你");
    });
});
