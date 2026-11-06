import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useAuthStore } from "../../../stores/auth";
import { api } from "../../../composables/api";
import { readFilePreview } from "../composables/fileService";

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
