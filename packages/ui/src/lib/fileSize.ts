export const MB = 1024 * 1024;

/**
 * Read-mode thresholds. **These are the UI's intent, not the current capability** (BL-372,
 * 2026-11-06): the runtime reads the file worker's stdout with a hard 1 MiB cap
 * (`A03:packages/runtime/src/executor.rs:588`), so any file at or above 1 MiB currently fails to
 * open with a JSON parse error at column 1048576 — even though this table says such files are
 * loaded fully.
 *
 * Deliberately NOT lowered to 1 MiB: that would freeze a transport limitation as if it were the
 * design. The real fix is chunked/streamed reading on the runtime side (BL-372 option ①); until
 * then the numbers below stay as the target, and this comment is the pointer that keeps the
 * mismatch visible instead of silently wrong.
 */
export const FILE_SIZE_THRESHOLDS = {
    /** Files below this are loaded fully (target; see the 1 MiB transport cap above) */
    FULL_LOAD: 10 * MB,
    /** Files at or above this are intercepted with a toast */
    INTERCEPT: 100 * MB,
    /** Truncation size passed to REST max_bytes */
    TRUNCATE_BYTES: 1 * MB,
} as const;

export function formatFileSize(bytes: number): string {
    if (bytes >= MB) return (bytes / MB).toFixed(1) + " MB";
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + " KB";
    return bytes + " B";
}

export type ReadDecision =
    | { action: "full" }
    | { action: "truncate"; maxBytes: number }
    | { action: "intercept" };

export function decideReadMode(size: number | undefined): ReadDecision {
    if (size === undefined) return { action: "full" };
    if (size >= FILE_SIZE_THRESHOLDS.INTERCEPT) return { action: "intercept" };
    if (size >= FILE_SIZE_THRESHOLDS.FULL_LOAD) {
        return { action: "truncate", maxBytes: FILE_SIZE_THRESHOLDS.TRUNCATE_BYTES };
    }
    return { action: "full" };
}
