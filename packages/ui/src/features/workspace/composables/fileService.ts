import { decideReadMode, FILE_SIZE_THRESHOLDS } from "../../../lib/fileSize";
import { api } from "../../../composables/api";

export interface ReadFilePreviewResult {
    content: string;
    truncated: boolean;
}

async function runtimeReadFile(
    path: string,
    workspaceId: string,
    opts?: { max_bytes?: number; rootId?: string },
): Promise<ReadFilePreviewResult> {
    const { content } = await api.readFile(path, workspaceId, opts?.rootId),
        maxBytes = opts?.max_bytes;
    return maxBytes !== undefined && content.length > maxBytes
        ? { content: content.slice(0, maxBytes), truncated: true }
        : { content, truncated: false };
}

/** PLAN-0639 M2: `rootId` scopes the read to one declared root of a multi-root workspace. */
export async function readFilePreview(
    path: string,
    size: number | undefined,
    workspaceId: string,
    rootId?: string,
): Promise<ReadFilePreviewResult> {
    const decision = decideReadMode(size);
    switch (decision.action) {
        case "intercept":
            return { content: "", truncated: true };
        case "truncate":
            return runtimeReadFile(path, workspaceId, {
                max_bytes: FILE_SIZE_THRESHOLDS.TRUNCATE_BYTES,
                rootId,
            });
        case "full":
        default:
            return runtimeReadFile(path, workspaceId, { rootId });
    }
}
