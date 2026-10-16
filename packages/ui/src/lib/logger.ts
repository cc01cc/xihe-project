import Dexie, { type Table } from "dexie";

const MAX_BATCH = 50,
    MAX_BATCH_BYTES = 64 * 1024,
    MAX_BATCH_QUEUE = MAX_BATCH * 4,
    FLUSH_INTERVAL = 5000,
    TELEMETRY_ENDPOINT = "/api/v1/telemetry/logs";

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Closed structured event types shared with the TLM ingest contract
 * (PLAN-0522). Only these explicitly-constructed events are eligible for the
 * instance-gated central relay; free-text log entries stay local.
 */
export type TelemetryEventType = "ui.unhandled_error" | "ui.unhandled_rejection";

const STRUCTURED_ERROR_CODES = ["TypeError", "ReferenceError", "RangeError", "SyntaxError"],
    UNKNOWN_ERROR_CODE = "UnknownError";

interface LogEntry {
    id?: number;
    timestamp: number;
    level: LogLevel;
    message: string;
    data?: unknown;
}

interface TelemetryEntry {
    timestamp: number;
    level: LogLevel;
    message?: string;
    data?: unknown;
    eventId?: string;
    eventType?: TelemetryEventType;
    errorCode?: string;
}

const SENSITIVE_KEY_PATTERN =
    /^(token|key|secret|password|passwd|authorization|auth|cookie|accesstoken|refreshtoken|apikey|api_key|servicetoken|clientsecret|client_secret|pkce|verifier)$/i;
const REDACTED = "***redacted***",
    SECRET_VALUE_PATTERNS: RegExp[] = [
        /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
        /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
        /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    ];

let encoder: TextEncoder | null = null;

function utf8Length(value: string): number {
    try {
        encoder ??= new TextEncoder();
        return encoder.encode(value).length;
    } catch {
        // Environments without TextEncoder (older jsdom) fall back to code units.
        return value.length;
    }
}

function randomId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
        crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function redactString(value: string): string {
    let result = value;
    for (const pattern of SECRET_VALUE_PATTERNS) {
        result = result.replace(pattern, REDACTED);
    }
    return result;
}

function redactDeep(value: unknown, depth: number): unknown {
    if (depth > 6) return value;
    if (typeof value === "string") return redactString(value);
    if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
    if (value && typeof value === "object") {
        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            result[k] = SENSITIVE_KEY_PATTERN.test(k) ? REDACTED : redactDeep(v, depth + 1);
        }
        return result;
    }
    return value;
}

class LogDatabase extends Dexie {
    logs!: Table<LogEntry, number>;

    constructor() {
        super("XiheLogDB");
        this.version(1).stores({
            logs: "++id, timestamp, level",
        });
    }
}

const db = new LogDatabase(),
    MAX_LOGS = 10000;

class Logger {
    private isEnabled = true;
    private context: Record<string, unknown> = {};
    private batch: TelemetryEntry[] = [];
    private batchTimer: ReturnType<typeof setTimeout> | null = null;
    private rateLimitedUntil = 0;
    private inFlight = false;

    constructor() {
        this.startFlushTimer();
        this.installPagehideHook();
    }

    setContext(ctx: Record<string, unknown>): void {
        this.context = ctx;
    }

    private async persist(entry: LogEntry): Promise<void> {
        try {
            await db.logs.add(entry);
            const count = await db.logs.count();
            if (count > MAX_LOGS) {
                const toDelete = await db.logs
                    .orderBy("id")
                    .limit(count - MAX_LOGS)
                    .toArray();
                if (toDelete.length > 0) await db.logs.bulkDelete(toDelete.map((l) => l.id!));
            }
        } catch {
            /* storage failure is non-critical */
        }
    }

    private sanitizeData(data: unknown): unknown {
        if (data && typeof data === "object") {
            const isDomException =
                typeof DOMException !== "undefined" && data instanceof DOMException;
            if (data instanceof Error || isDomException) {
                return {
                    name: (data as Error).name,
                    message: redactString((data as Error).message),
                    stack: redactString((data as Error).stack ?? ""),
                    ...(isDomException ? { code: (data as DOMException).code } : {}),
                };
            }
            return redactDeep(data, 0);
        }
        if (typeof data === "string") return redactString(data);
        return data;
    }

    private sanitizeMessage(msg: string): string {
        return msg.replace(/\n/g, " ").replace(/\r/g, "");
    }

    private startFlushTimer(): void {
        if (this.batchTimer) clearTimeout(this.batchTimer);
        this.batchTimer = setTimeout(() => {
            this.flush().catch(() => {});
            this.startFlushTimer();
        }, FLUSH_INTERVAL);
    }

    private installPagehideHook(): void {
        if (typeof window === "undefined") return;
        window.addEventListener("pagehide", () => {
            if (this.batch.length === 0) return;
            this.clearBatchOnPageHide();
        });
    }

    /**
     * Sends one batch per call to the same-instance CP telemetry endpoint.
     * Frozen semantics (PLAN-0522): at most one in-flight request, drained
     * entries are dropped on failure (central copies are best-effort; the
     * Console/IndexedDB and CP local sink remain the durable local paths).
     */
    async flush(): Promise<void> {
        if (this.batch.length === 0 || this.inFlight) return;
        if (this.rateLimitedUntil > Date.now()) {
            if (this.batch.length > MAX_BATCH_QUEUE)
                this.batch = this.batch.slice(-MAX_BATCH_QUEUE);
            return;
        }

        this.inFlight = true;
        try {
            const entries = this.batch.splice(0, MAX_BATCH),
                deviceId = (this.context.deviceId as string) || "unknown",
                batchId = randomId(),
                serialize = (list: TelemetryEntry[]) =>
                    JSON.stringify({ batchId, deviceId, entries: list }),
                payload = serialize(entries);

            if (utf8Length(payload) > MAX_BATCH_BYTES) {
                const truncated = this.truncateBatch(entries, serialize);
                if (truncated.length === 0) return;
                await this.sendTelemetry(serialize(truncated));
                return;
            }

            await this.sendTelemetry(payload);
        } finally {
            this.inFlight = false;
        }
    }

    private truncateBatch(
        entries: TelemetryEntry[],
        serialize: (list: TelemetryEntry[]) => string,
    ): TelemetryEntry[] {
        let result = [...entries];
        while (result.length > 0) {
            if (utf8Length(serialize(result)) <= MAX_BATCH_BYTES) return result;
            result = result.slice(1);
        }
        return result;
    }

    private readAuthToken(): string | null {
        try {
            if (typeof localStorage === "undefined") return null;
            return localStorage.getItem("xihe-token");
        } catch {
            return null;
        }
    }

    private async sendTelemetry(payload: string): Promise<void> {
        if (typeof fetch === "undefined") return;
        const token = this.readAuthToken();
        if (!token) return; // logged out: keep telemetry local-only
        try {
            const response = await fetch(TELEMETRY_ENDPOINT, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
                body: payload,
            });
            if (response.status === 429) this.rateLimitedUntil = Date.now() + 60000;
        } catch {
            /* best-effort: never block callers, never fall back to unbounded retry */
        }
    }

    private clearBatchOnPageHide(): void {
        // Best-effort unload policy (PLAN-0522): queued telemetry is dropped on
        // unload; Console/IndexedDB remain the local record.
        this.batch.splice(0, this.batch.length);
    }

    /**
     * Records an explicitly-typed structured event (closed enum). The eventId
     * is assigned here and reused for every retry/re-batch of the same event.
     */
    recordEvent(eventType: TelemetryEventType, level: LogLevel, errorCode: string): void {
        this.batch.push({
            timestamp: Date.now(),
            level,
            eventId: randomId(),
            eventType,
            errorCode: errorCode.slice(0, 128),
        });
        if (this.batch.length > MAX_BATCH_QUEUE) this.batch = this.batch.slice(-MAX_BATCH_QUEUE);
    }

    private emit(level: LogLevel, message: string, data?: unknown) {
        if (!this.isEnabled) return;

        const deviceTag = this.context.deviceId ? ` [${this.context.deviceId}]` : "";

        const entry: LogEntry = {
            timestamp: Date.now(),
            level,
            message: redactString(message),
            data: data ? this.sanitizeData(data) : undefined,
        };

        const ts = new Date(entry.timestamp).toLocaleTimeString("zh-CN"),
            prefix = `[${ts}] [${level.toUpperCase()}]${deviceTag}`;
        // oxlint-disable-next-line no-console
        const cfn =
            level === "error"
                ? console.error
                : // oxlint-disable-next-line no-console
                  level === "warn"
                  ? console.warn
                  : // oxlint-disable-next-line no-console
                    level === "debug"
                    ? console.debug
                    : // oxlint-disable-next-line no-console
                      console.log;
        cfn(prefix, entry.message, entry.data, this.context);

        this.persist(entry).catch(() => {});

        // Telemetry batch: info+ in prod, debug+ in dev
        const shouldTelemetry = import.meta.env.DEV ? true : level !== "debug";
        if (shouldTelemetry) {
            this.batch.push({
                timestamp: entry.timestamp,
                level,
                message: this.sanitizeMessage(message),
                data: entry.data as Record<string, unknown> | undefined,
            });
        }
    }

    info(message: string, data?: unknown) {
        this.emit("info", message, data);
    }
    warn(message: string, data?: unknown) {
        this.emit("warn", message, data);
    }
    error(message: string, data?: unknown) {
        this.emit("error", message, data);
    }
    debug(message: string, data?: unknown) {
        this.emit("debug", message, data);
    }

    async getLogs(): Promise<LogEntry[]> {
        return await db.logs.orderBy("timestamp").toArray();
    }

    async exportLogs(): Promise<string> {
        return JSON.stringify(await this.getLogs(), null, 2);
    }

    async download(): Promise<void> {
        const all = await db.logs.orderBy("timestamp").toArray(),
            blob = new Blob([JSON.stringify(all, null, 2)], { type: "application/json" }),
            url = URL.createObjectURL(blob),
            a = document.createElement("a");
        a.href = url;
        a.download = `xihe-logs-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    async clearLogs() {
        await db.logs.clear();
    }
}

export const logger = new Logger();

export function useLogger() {
    return logger;
}

function structuredErrorCode(value: unknown): string {
    if (
        value instanceof Error &&
        (STRUCTURED_ERROR_CODES as readonly string[]).includes(value.name)
    ) {
        return value.name;
    }
    return UNKNOWN_ERROR_CODE;
}

/**
 * Installs the V1 structured-event producers. Only the error *name* (closed
 * enum) is recorded — never messages, stacks, or rejection payloads.
 */
export function installGlobalErrorTelemetry(): void {
    if (typeof window === "undefined") return;
    window.addEventListener("error", (event) => {
        logger.recordEvent("ui.unhandled_error", "error", structuredErrorCode(event.error));
    });
    window.addEventListener("unhandledrejection", (event) => {
        logger.recordEvent("ui.unhandled_rejection", "error", structuredErrorCode(event.reason));
    });
}
