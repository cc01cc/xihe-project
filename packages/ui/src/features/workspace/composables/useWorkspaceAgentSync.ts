import { useWorkspaceStore } from "../stores/workspace";

const mutatingTools = new Set([
    "write_file",
    "edit_file",
    "apply_patch",
    "delete_file",
    "delete_directory",
    "move_file",
    "copy_file",
    "create_directory",
]);

/**
 * Syncs Agent tool calls with workspace UI:
 * - read_file → highlight file in tree + open tab
 * - write_file → update the open tab and refresh the tree again after its result
 * - delete_file → remove from tree
 */
export function useWorkspaceAgentSync() {
    const ws = useWorkspaceStore();

    function handleToolCall(name: string, args: Record<string, unknown>) {
        const filePath = (args.file_path || args.path) as string | undefined;
        if (!filePath) return;

        switch (name) {
            case "read_file":
            case "read_file_range":
                ws.highlightFile(filePath);
                ws.openFile(filePath);
                break;
            case "write_file":
            case "edit_file":
                ws.refreshTree();
                ws.openFile(filePath);
                break;
            case "apply_patch":
                ws.refreshTree();
                break;
            case "delete_file":
            case "delete_directory":
                ws.refreshTree();
                ws.closeFile(filePath);
                break;
            case "move_file":
            case "copy_file":
                ws.refreshTree();
                break;
        }
    }

    function handleToolResult(name: string) {
        if (mutatingTools.has(name)) void ws.refreshAfterMutation();
    }

    return { handleToolCall, handleToolResult };
}
