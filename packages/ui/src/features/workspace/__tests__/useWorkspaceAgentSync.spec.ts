import { describe, it, expect, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

describe("useWorkspaceAgentSync", () => {
    it("returns handleToolCall function", async () => {
        setActivePinia(createPinia());
        const { useWorkspaceAgentSync } = await import("../composables/useWorkspaceAgentSync"),
            sync = useWorkspaceAgentSync();
        expect(typeof sync.handleToolCall).toBe("function");
    });

    it("handleToolCall handles read_file calls", async () => {
        setActivePinia(createPinia());
        const ws = await import("../stores/workspace");
        ws.useWorkspaceStore().highlightFile = vi.fn<(path: string) => void>();
        ws.useWorkspaceStore().openFile = vi.fn<(path: string) => void>();

        const { useWorkspaceAgentSync } = await import("../composables/useWorkspaceAgentSync");
        useWorkspaceAgentSync().handleToolCall("read_file", { path: "test.txt" });
        expect(ws.useWorkspaceStore().highlightFile).toHaveBeenCalledWith("test.txt");
        expect(ws.useWorkspaceStore().openFile).toHaveBeenCalledWith("test.txt");
    });

    it("handleToolCall handles write_file calls", async () => {
        setActivePinia(createPinia());
        const ws = await import("../stores/workspace");
        ws.useWorkspaceStore().refreshTree = vi.fn<() => void>();
        ws.useWorkspaceStore().openFile = vi.fn<(path: string) => void>();

        const { useWorkspaceAgentSync } = await import("../composables/useWorkspaceAgentSync");
        useWorkspaceAgentSync().handleToolCall("write_file", { file_path: "test.txt" });
        expect(ws.useWorkspaceStore().refreshTree).toHaveBeenCalled();
    });

    it("refreshes the tree after mutating tool results", async () => {
        setActivePinia(createPinia());
        const ws = await import("../stores/workspace"),
            { useWorkspaceAgentSync } = await import("../composables/useWorkspaceAgentSync");
        ws.useWorkspaceStore().refreshAfterMutation = vi.fn<() => Promise<void>>();

        useWorkspaceAgentSync().handleToolResult("write_file");
        expect(ws.useWorkspaceStore().refreshAfterMutation).toHaveBeenCalledOnce();
    });

    it("does not refresh for read-only tool results", async () => {
        setActivePinia(createPinia());
        const ws = await import("../stores/workspace"),
            { useWorkspaceAgentSync } = await import("../composables/useWorkspaceAgentSync");
        ws.useWorkspaceStore().refreshAfterMutation = vi.fn<() => Promise<void>>();

        useWorkspaceAgentSync().handleToolResult("read_file");
        expect(ws.useWorkspaceStore().refreshAfterMutation).not.toHaveBeenCalled();
    });

    it("ignores unknown tool calls", async () => {
        setActivePinia(createPinia());
        const ws = await import("../stores/workspace");
        ws.useWorkspaceStore().refreshTree = vi.fn<() => void>();
        ws.useWorkspaceStore().openFile = vi.fn<(path: string) => void>();

        const { useWorkspaceAgentSync } = await import("../composables/useWorkspaceAgentSync");
        useWorkspaceAgentSync().handleToolCall("unknown_tool", { path: "test.txt" });
        expect(ws.useWorkspaceStore().openFile).not.toHaveBeenCalled();
    });

    it("handleToolCall handles delete_file and delete_directory", async () => {
        setActivePinia(createPinia());
        const ws = await import("../stores/workspace");
        ws.useWorkspaceStore().refreshTree = vi.fn<() => void>();
        ws.useWorkspaceStore().closeFile = vi.fn<(path: string) => void>();

        const { useWorkspaceAgentSync } = await import("../composables/useWorkspaceAgentSync");
        useWorkspaceAgentSync().handleToolCall("delete_file", { path: "test.txt" });
        expect(ws.useWorkspaceStore().refreshTree).toHaveBeenCalled();
        expect(ws.useWorkspaceStore().closeFile).toHaveBeenCalledWith("test.txt");
    });

    it("handleToolCall handles move_file and copy_file", async () => {
        setActivePinia(createPinia());
        const ws = await import("../stores/workspace");
        ws.useWorkspaceStore().refreshTree = vi.fn<() => void>();
        ws.useWorkspaceStore().closeFile = vi.fn<(path: string) => void>();

        const { useWorkspaceAgentSync } = await import("../composables/useWorkspaceAgentSync");
        useWorkspaceAgentSync().handleToolCall("move_file", { path: "test.txt" });
        expect(ws.useWorkspaceStore().refreshTree).toHaveBeenCalled();
    });

    it("handleToolCall uses file_path and path arguments", async () => {
        setActivePinia(createPinia());
        const ws = await import("../stores/workspace");
        ws.useWorkspaceStore().highlightFile = vi.fn<(path: string) => void>();
        ws.useWorkspaceStore().openFile = vi.fn<(path: string) => void>();

        const { useWorkspaceAgentSync } = await import("../composables/useWorkspaceAgentSync");
        useWorkspaceAgentSync().handleToolCall("read_file", { file_path: "src/main.ts" });
        expect(ws.useWorkspaceStore().highlightFile).toHaveBeenCalledWith("src/main.ts");
    });
});
