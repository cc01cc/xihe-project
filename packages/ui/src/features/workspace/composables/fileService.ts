import { decideReadMode } from "../../../lib/fileSize";
import { api, apiAuthHeaders, apiErrorFromResponse } from "../../../composables/api";

/** PLAN-0683 B-1: one preview may read at most 8 MiB; the same number bounds a ranged
 * attachment response (CP clamps server-side too, see `ATTACHMENT_PREVIEW_BUDGET_BYTES`). */
export const PREVIEW_BYTE_BUDGET = 8 * 1024 * 1024;
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

/**
 * PLAN-0683 M2 / BL-381: attachment previews only ever fetch a bounded prefix of the
 * attachment through one HTTP range request. The preview flow never hands the whole
 * file URL to the browser: full open and download stay explicit user actions.
 *
 * The budget is bytes-on-wire per response; CP clamps a ranged response to the same
 * number (`WorkspaceFileController.ATTACHMENT_PREVIEW_BUDGET_BYTES`), so a preview can
 * not be inflated by a server that ignores the budget.
 */
export const ATTACHMENT_PREVIEW_BUDGET_BYTES = PREVIEW_BYTE_BUDGET;

export interface ParsedContentRange {
    start: number;
    end: number;
    /** Real entity length (`null` when the server answers `bytes a-b/*`). */
    total: number | null;
}

export interface AttachmentPreview {
    bytes: Uint8Array;
    mimeType: string;
    totalBytes: number | null;
    /** True when the entity (or the response) has more bytes than `bytes`. */
    truncated: boolean;
}

export interface AttachmentPreviewOptions {
    budget?: number;
    signal?: AbortSignal;
}

/** Parse `Content-Range: bytes <start>-<end>/<total|*>`; malformed values parse to null. */
export function parseContentRange(value: string | null | undefined): ParsedContentRange | null {
    if (!value) return null;
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim());
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = match[3] === "*" ? null : Number(match[3]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
    if (total !== null && !Number.isSafeInteger(total)) return null;
    return { start, end, total };
}

/**
 * Read at most `budget` bytes from a response body, so a server that ignores `Range`
 * still can not force an unbounded read. `complete` reports whether this response
 * delivered the full entity (no truncation by this cap).
 */
async function readBoundedBody(
    response: Response,
    budget: number,
): Promise<{ bytes: Uint8Array; complete: boolean }> {
    const body = response.body;
    if (!body) {
        const all = new Uint8Array(await response.arrayBuffer());
        return { bytes: all.slice(0, budget), complete: all.byteLength <= budget };
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    let complete = false;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                complete = true;
                break;
            }
            const remaining = budget - received;
            if (value.byteLength > remaining) {
                chunks.push(value.slice(0, remaining));
                received += remaining;
                break;
            }
            chunks.push(value);
            received += value.byteLength;
            if (received >= budget) {
                // One more read distinguishes "exactly the budget" from "more to come".
                const next = await reader.read();
                complete = next.done === true;
                break;
            }
        }
    } finally {
        try {
            await reader.cancel();
        } catch {
            /* stream already closed */
        }
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return { bytes, complete };
}

function totalFromContentLength(response: Response): number | null {
    const raw = response.headers.get("Content-Length");
    if (!raw) return null;
    const total = Number(raw);
    return Number.isSafeInteger(total) && total > 0 ? total : null;
}

async function consumeAttachmentPreview(
    response: Response,
    budget: number,
): Promise<AttachmentPreview> {
    if (!response.ok) await apiErrorFromResponse(response);
    const mimeType = response.headers.get("Content-Type") ?? "application/octet-stream";
    if (response.status === 206) {
        const { bytes, complete } = await readBoundedBody(response, budget);
        const range = parseContentRange(response.headers.get("Content-Range"));
        if (!range || range.start !== 0) {
            // A 206 we can not interpret (missing/invalid `Content-Range`, or a range that does
            // not start at the requested offset) proves nothing about completeness; keep the
            // truncation prompt instead of presenting the body as the file prefix.
            return { bytes, mimeType, totalBytes: null, truncated: true };
        }
        const declared = range.end - range.start + 1;
        // Trust neither side alone: cap by the declared range AND by the budget.
        const bounded = declared < bytes.byteLength ? bytes.slice(0, declared) : bytes;
        const totalBytes = range.total;
        return {
            bytes: bounded,
            mimeType,
            totalBytes,
            truncated:
                declared > bytes.byteLength ||
                (totalBytes !== null ? totalBytes > bounded.byteLength : !complete),
        };
    }
    // 200 = server ignored Range (old CP / proxy); bound the body client-side.
    const { bytes, complete } = await readBoundedBody(response, budget);
    const totalBytes = totalFromContentLength(response);
    return {
        bytes,
        mimeType,
        totalBytes,
        truncated: !complete || (totalBytes !== null && totalBytes > bytes.byteLength),
    };
}

/**
 * Fetch the preview prefix of an attachment (`Range: bytes=0-<budget-1>`).
 *
 * A `416` means the bounded range can not be satisfied (for example a stale cached length).
 * The retry keeps a `Range` header (`bytes=0-`) so the server-side preview clamp stays the
 * only budget owner; falling back to a plain 200 would let the server stream the whole file
 * and move the budget into this client. A second `416` maps to `ApiError`, and the dialog
 * then offers the download entry instead of a preview.
 */
export async function fetchAttachmentPreview(
    url: string,
    options: AttachmentPreviewOptions = {},
): Promise<AttachmentPreview> {
    const budget = Math.max(1, Math.floor(options.budget ?? ATTACHMENT_PREVIEW_BUDGET_BYTES));
    const rangedHeaders = apiAuthHeaders({ Range: `bytes=0-${budget - 1}` }, false);
    let response = await fetch(url, { headers: rangedHeaders, signal: options.signal });
    if (response.status === 416) {
        // Still a ranged request: CP clamps the open-ended form to the same 8 MiB budget.
        response = await fetch(url, {
            headers: apiAuthHeaders({ Range: "bytes=0-" }, false),
            signal: options.signal,
        });
        if (response.status === 416) await apiErrorFromResponse(response);
    }
    return consumeAttachmentPreview(response, budget);
}

/**
 * Fetch the remainder after a preview prefix (`Range: bytes=<offset>-`), used by the
 * explicit "load the rest" action. Never called implicitly: full content is a user
 * decision, and the preview budget is not a full-file cap.
 *
 * Only a `206` whose `Content-Range` starts at `offset` is accepted, and the read is bounded
 * by both that declared length and the preview budget: a `200` (server ignored `Range`) would
 * append the whole entity on top of the prefix, and an unbounded `arrayBuffer()` would let a
 * single click re-download a 500 MiB attachment.
 */
export async function fetchAttachmentRemainder(
    url: string,
    offset: number,
    options: { signal?: AbortSignal } = {},
): Promise<{ bytes: Uint8Array; totalBytes: number | null }> {
    const response = await fetch(url, {
        headers: apiAuthHeaders({ Range: `bytes=${offset}-` }, false),
        signal: options.signal,
    });
    if (!response.ok) await apiErrorFromResponse(response);
    const range =
        response.status === 206 ? parseContentRange(response.headers.get("Content-Range")) : null;
    if (!range || range.start !== offset) {
        throw new Error(
            "Attachment remainder response is not a ranged response at the requested offset",
        );
    }
    const declared = range.end - range.start + 1;
    const { bytes, complete } = await readBoundedBody(
        response,
        Math.min(declared, ATTACHMENT_PREVIEW_BUDGET_BYTES),
    );
    if (!complete || bytes.byteLength !== declared) {
        throw new Error("Attachment remainder response does not match its declared range");
    }
    return { bytes, totalBytes: range.total };
}

/** Decode preview bytes as UTF-8, dropping an incomplete trailing code point. */
export function decodePreviewText(bytes: Uint8Array): string {
    return decodeUtf8WithinBudget(bytes, bytes.byteLength);
}
