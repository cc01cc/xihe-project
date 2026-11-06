export const MB = 1024 * 1024;

/**
 * Read-mode thresholds aligned with the runtime file worker's 32 MiB capture cap
 * (`packages/runtime/src/executor.rs:357`). Intercepting at that limit protects the UI
 * main thread from the extra buffers created when a large file is read in full.
 */
export const FILE_SIZE_THRESHOLDS = {
    /** Files below this are loaded fully */
    FULL_LOAD: 10 * MB,
    /** Files at or above the runtime capture cap are intercepted */
    INTERCEPT: 32 * MB,
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
