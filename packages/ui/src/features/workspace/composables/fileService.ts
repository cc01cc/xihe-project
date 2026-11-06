import { decideReadMode } from "../../../lib/fileSize";
import { api } from "../../../composables/api";

const PREVIEW_BYTE_BUDGET = 8 * 1024 * 1024;
const PREVIEW_LINES_PER_RANGE = 256;

function decodeUtf8WithinBudget(bytes: Uint8Array, budget: number): string {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let end = Math.min(bytes.byteLength, budget);
    while (end > 0) {
        try {
            return decoder.decode(bytes.slice(0, end));
        } catch (error) {
            if (!(error instanceof TypeError)) throw error;
            end -= 1;
        }
    }
    return "";
}

export interface ReadFilePreviewResult {
    content: string;
    truncated: boolean;
}

async function runtimeReadFilePreview(
    path: string,
    workspaceId: string,
    rootId?: string,
): Promise<ReadFilePreviewResult> {
    const parts: string[] = [];
    let offset = 1,
        loadedBytes = 0,
        truncated = false,
        reachedEnd = false;

    while (loadedBytes < PREVIEW_BYTE_BUDGET) {
        const result = await api.readFileRange(
            path,
            workspaceId,
            offset,
            PREVIEW_LINES_PER_RANGE,
            rootId,
        );
        if (result.is_binary) {
            throw new Error("Binary files cannot be opened as text previews");
        }
        if (!result.content) {
            reachedEnd = true;
            break;
        }

        const content = result.content.replace(/^\d+ \| /gm, ""),
            separator = parts.length > 0 ? "\n" : "",
            next = separator + content,
            nextBytes = new TextEncoder().encode(next).byteLength;
        if (loadedBytes + nextBytes > PREVIEW_BYTE_BUDGET) {
            const remaining = PREVIEW_BYTE_BUDGET - loadedBytes,
                encoded = new TextEncoder().encode(next),
                bounded = decodeUtf8WithinBudget(encoded, remaining);
            if (bounded) parts.push(bounded);
            loadedBytes = PREVIEW_BYTE_BUDGET;
            truncated = true;
            break;
        }

        parts.push(next);
        loadedBytes += nextBytes;
        const returnedLines = content.split("\n").length;
        offset += returnedLines;
        if (offset > result.total_lines) {
            reachedEnd = true;
            break;
        }
    }

    if (loadedBytes >= PREVIEW_BYTE_BUDGET && !reachedEnd) truncated = true;
    return { content: parts.join(""), truncated };
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
            return runtimeReadFilePreview(path, workspaceId, rootId);
        case "full":
        default:
            return runtimeReadFilePreview(path, workspaceId, rootId);
    }
}
