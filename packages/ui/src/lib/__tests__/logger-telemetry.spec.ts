import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "test-jwt-token";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(status = 200): Response {
    return { ok: status < 400, status, json: async () => ({}) } as Response;
}

function okFetch() {
    return vi.fn<FetchLike>().mockResolvedValue(jsonResponse());
}

describe("logger telemetry (PLAN-0522)", () => {
    beforeEach(() => {
        localStorage.setItem("xihe-token", TOKEN);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        localStorage.clear();
        sessionStorage.clear();
    });

    it("flush posts a camelCase batch to the local CP endpoint with the JWT", async () => {
        const fetchSpy = okFetch();
        vi.stubGlobal("fetch", fetchSpy);
        const { logger } = await import("../logger");

        logger.info("local note");
        await logger.flush();

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [endpoint, options] = fetchSpy.mock.calls[0];
        expect(endpoint).toBe("/api/v1/telemetry/logs");
        expect(options?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
        const body = JSON.parse(options?.body as string);
        expect(typeof body.batchId).toBe("string");
        expect(body.deviceId).toBe("unknown");
        expect(body.entries[0].message).toBe("local note");
        expect(body.entries[0].eventId).toBeUndefined();
    });

    it("structured events carry eventId/eventType/errorCode instead of free text", async () => {
        const fetchSpy = okFetch();
        vi.stubGlobal("fetch", fetchSpy);
        const { logger } = await import("../logger");

        logger.recordEvent("ui.unhandled_error", "error", "TypeError");
        await logger.flush();

        const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
        const [entry] = body.entries;
        expect(entry.eventType).toBe("ui.unhandled_error");
        expect(entry.errorCode).toBe("TypeError");
        expect(entry.eventId).toMatch(/^[0-9a-f-]{36}$/);
        expect(entry.message).toBeUndefined();
    });

    it("drops the batch without sending when no token is present", async () => {
        localStorage.clear();
        const fetchSpy = okFetch();
        vi.stubGlobal("fetch", fetchSpy);
        const { logger } = await import("../logger");

        logger.info("logged out");
        await logger.flush();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("keeps at most one in-flight flush and drains the next batch afterwards", async () => {
        const pending: Array<(value: Response) => void> = [];
        const fetchSpy = vi.fn<FetchLike>(
            () => new Promise<Response>((resolve) => pending.push(resolve)),
        );
        vi.stubGlobal("fetch", fetchSpy);
        const { logger } = await import("../logger");

        logger.info("first");
        const first = logger.flush();
        logger.info("second");
        const second = logger.flush();
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        pending[0](jsonResponse());
        await first;
        await second;

        const third = logger.flush();
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        pending[1](jsonResponse());
        await third;
    });

    it("caps the payload at UTF-8 64 KiB by truncating oldest entries", async () => {
        const fetchSpy = okFetch();
        vi.stubGlobal("fetch", fetchSpy);
        const { logger } = await import("../logger");

        logger.info("oversized", { blob: "x".repeat(70 * 1024) });
        logger.info("kept");
        await logger.flush();

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const body = fetchSpy.mock.calls[0][1]?.body as string;
        expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(64 * 1024);
        const parsed = JSON.parse(body);
        expect(parsed.entries).toHaveLength(1);
        expect(parsed.entries[0].message).toBe("kept");
    });

    it("maps unhandled errors/rejections to the closed error-code enum", async () => {
        const fetchSpy = okFetch();
        vi.stubGlobal("fetch", fetchSpy);
        const { installGlobalErrorTelemetry, logger } = await import("../logger");
        installGlobalErrorTelemetry();

        window.dispatchEvent(new ErrorEvent("error", { error: new TypeError("boom") }));
        const rejection = new Event("unhandledrejection");
        Object.assign(rejection, { reason: new RangeError("bad") });
        window.dispatchEvent(rejection);
        await logger.flush();

        const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
        const kinds = body.entries.map(
            (entry: { eventType: string; errorCode: string }) =>
                [entry.eventType, entry.errorCode] as const,
        );
        expect(kinds).toContainEqual(["ui.unhandled_error", "TypeError"]);
        expect(kinds).toContainEqual(["ui.unhandled_rejection", "RangeError"]);
    });

    it("attaches coarsened environment dimensions to structured events (PLAN-0527)", async () => {
        const fetchSpy = okFetch();
        vi.stubGlobal("fetch", fetchSpy);
        const { logger } = await import("../logger");

        logger.recordEvent("ui.unhandled_error", "error", "TypeError");
        await logger.flush();

        const [entry] = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string).entries;
        expect(["windows", "macos", "linux", "ios", "android", "other"]).toContain(entry.osFamily);
        expect(["chrome", "edge", "firefox", "safari", "other"]).toContain(entry.browserFamily);
        expect(["stable", "beta", "dev"]).toContain(entry.releaseChannel);
        expect(["xs", "sm", "md", "lg", "xl"]).toContain(entry.screenBucket);
        expect(entry.anonSessionId).toMatch(/^[A-Za-z0-9_-]{22,64}$/);
        // never the raw user-agent or any free text
        expect(entry.message).toBeUndefined();
        expect(entry.data).toBeUndefined();
        expect(JSON.stringify(entry)).not.toContain(navigator.userAgent);
    });

    it("rotates the anonymous session id on login and clears it on logout (PLAN-0527)", async () => {
        const fetchSpy = okFetch();
        vi.stubGlobal("fetch", fetchSpy);
        const { logger, rotateAnonSessionId, clearAnonSessionId } = await import("../logger");

        const readSent = (call: number) =>
            JSON.parse(fetchSpy.mock.calls[call][1]?.body as string).entries[0].anonSessionId;

        logger.recordEvent("ui.unhandled_error", "error", "TypeError");
        await logger.flush();
        const first = readSent(0);
        expect(first).toMatch(/^[A-Za-z0-9_-]{22,64}$/);

        rotateAnonSessionId();
        logger.recordEvent("ui.unhandled_error", "error", "TypeError");
        await logger.flush();
        const second = readSent(1);
        expect(second).toMatch(/^[A-Za-z0-9_-]{22,64}$/);
        expect(second).not.toBe(first);

        clearAnonSessionId();
        logger.recordEvent("ui.unhandled_error", "error", "TypeError");
        await logger.flush();
        const third = readSent(2);
        expect(third).toMatch(/^[A-Za-z0-9_-]{22,64}$/);
        expect(third).not.toBe(second);
    });
});
