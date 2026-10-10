import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LogLevel } from "../../lib/logger";

type MockLogEntry = {
    id?: number;
    timestamp: number;
    level: LogLevel;
    message: string;
    data?: unknown;
};

type MockLogCollection = {
    limit: (count: number) => MockLogCollection;
    toArray: () => Promise<MockLogEntry[]>;
};

// Mock Dexie
const mockTable = vi.hoisted(() => ({
    add: vi.fn<(entry: MockLogEntry) => Promise<number>>().mockResolvedValue(1),
    count: vi.fn<() => Promise<number>>().mockResolvedValue(0),
    orderBy: vi.fn<(index: string) => MockLogCollection>().mockReturnThis(),
    toArray: vi.fn<() => Promise<MockLogEntry[]>>().mockResolvedValue([]),
    bulkDelete: vi.fn<(ids: number[]) => Promise<void>>().mockResolvedValue(undefined),
    clear: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    limit: vi.fn<(count: number) => MockLogCollection>().mockReturnThis(),
}));
type MockDexie = {
    logs: typeof mockTable;
    version: (version: number) => MockDexie;
    stores: (schema: Record<string, string>) => MockDexie;
};
vi.mock("dexie", () => {
    class Dexie {
        logs!: typeof mockTable;
        version = vi.fn<(version: number) => MockDexie>().mockReturnThis();
        stores = vi
            .fn<(schema: Record<string, string>) => MockDexie>()
            .mockImplementation(function (this: MockDexie) {
                this.logs = mockTable;
                return this;
            });
    }
    return { default: Dexie };
});

describe("logger", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("should export logger singleton", async () => {
        const { logger } = await import("../../lib/logger");
        expect(logger).toBeDefined();
        expect(typeof logger.info).toBe("function");
        expect(typeof logger.warn).toBe("function");
        expect(typeof logger.error).toBe("function");
        expect(typeof logger.debug).toBe("function");
    });

    it("should provide useLogger composable", async () => {
        const { useLogger } = await import("../../lib/logger"),
            l = useLogger();
        expect(l).toBeDefined();
    });

    it("should have getLogs and exportLogs methods", async () => {
        const { logger } = await import("../../lib/logger");
        expect(typeof logger.getLogs).toBe("function");
        expect(typeof logger.exportLogs).toBe("function");
        expect(typeof logger.download).toBe("function");
        expect(typeof logger.clearLogs).toBe("function");
    });

    it("should redact sensitive keys and secret patterns in persisted data", async () => {
        const { logger } = await import("../../lib/logger");
        mockTable.add.mockClear();

        logger.info("auth ok", {
            token: "secret-token-value",
            nested: { authorization: "Bearer abc.def.ghi", keep: "visible" },
            list: [{ refreshToken: "refresh-secret" }],
        });
        logger.info(
            "Bearer sk-live-1234567890abcdef and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dGVzdHNpZw",
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(mockTable.add).toHaveBeenCalled();
        const persisted = JSON.stringify(mockTable.add.mock.calls.map((call) => call[0]));
        expect(persisted).not.toContain("secret-token-value");
        expect(persisted).not.toContain("abc.def.ghi");
        expect(persisted).not.toContain("refresh-secret");
        expect(persisted).not.toContain("sk-live-1234567890abcdef");
        expect(persisted).not.toContain("eyJhbGciOiJIUzI1NiJ9");
        expect(persisted).toContain("visible");
        expect(persisted).toContain("***redacted***");
    });
});
