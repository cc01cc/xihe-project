/* task-1032：自 composables/api.ts 拆出的 file 段（逐字节搬运）。 */
import { callRuntimeTool } from "./_core";

export const fileApi = {
    async listDirectory(path: string, workspaceId: string, rootId?: string) {
        const raw = await callRuntimeTool<{
                entries?: Array<{
                    name: string;
                    path: string;
                    is_dir?: boolean;
                    type?: string;
                    size?: number;
                    modified?: string;
                }>;
            }>("list_directory", rootId ? { path, rootId } : { path }, workspaceId),
            entries = (raw?.entries ?? []).map((e) => ({
                name: e.name,
                path: e.path,
                type: e.type ?? (e.is_dir ? "directory" : "file"),
                size: e.size,
                modified: e.modified,
            }));
        return { entries };
    },
    async readFile(path: string, workspaceId: string, rootId?: string) {
        const content = await callRuntimeTool<string>(
            "read_file",
            rootId ? { path, rootId } : { path },
            workspaceId,
        );
        return { content: typeof content === "string" ? content : String(content) };
    },
    async readFileRange(
        path: string,
        workspaceId: string,
        offset?: number,
        limit?: number,
        rootId?: string,
    ) {
        const args: Record<string, unknown> = rootId ? { path, rootId } : { path };
        if (offset !== undefined) args.offset = offset;
        if (limit !== undefined) args.limit = limit;
        return callRuntimeTool<{ content: string; total_lines: number; is_binary: boolean }>(
            "read_file_range",
            args,
            workspaceId,
        );
    },
    async writeFile(path: string, content: string, workspaceId: string, rootId?: string) {
        await callRuntimeTool<string>(
            "write_file",
            rootId ? { path, content, rootId } : { path, content },
            workspaceId,
        );
        return { success: true };
    },
    async deleteFile(path: string, workspaceId: string, rootId?: string) {
        await callRuntimeTool<string>(
            "delete_file",
            rootId ? { path, rootId } : { path },
            workspaceId,
        );
        return { success: true };
    },
    async moveFile(from: string, to: string, workspaceId: string, rootId?: string) {
        await callRuntimeTool<string>(
            "move_file",
            rootId ? { from, to, rootId } : { from, to },
            workspaceId,
        );
        return { success: true };
    },
    async copyFile(from: string, to: string, workspaceId: string, rootId?: string) {
        await callRuntimeTool<string>(
            "copy_file",
            rootId ? { from, to, rootId } : { from, to },
            workspaceId,
        );
        return { success: true };
    },
    async createDirectory(path: string, workspaceId: string, rootId?: string) {
        await callRuntimeTool<string>("mkdir", rootId ? { path, rootId } : { path }, workspaceId);
        return { success: true };
    },
};
