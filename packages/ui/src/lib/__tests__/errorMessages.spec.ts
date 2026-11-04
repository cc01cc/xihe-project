import { describe, expect, it } from "vitest";
import {
    chatErrorToastText,
    humanizeErrorCode,
    mappedErrorCopy,
    normalizeRefusalCode,
    toolRefusalCopyKey,
} from "../errorMessages";

describe("mappedErrorCopy", () => {
    it("returns dedicated copy only for codes it actually maps", () => {
        expect(mappedErrorCopy("AGENT_TIMEOUT")).toContain("超时");
        expect(mappedErrorCopy("RUN_BUDGET_EXHAUSTED")).toBeNull();
        expect(mappedErrorCopy("PROVIDER_TEMPORARY")).toBeNull();
        expect(mappedErrorCopy(undefined)).toBeNull();
    });
});

describe("humanizeErrorCode", () => {
    it("maps runtime unavailable to human copy without assuming Docker", () => {
        const runtimeCopy = humanizeErrorCode("RUNTIME_UNAVAILABLE");
        expect(runtimeCopy).toContain("运行时未就绪");
        expect(runtimeCopy).not.toContain("Docker");
        expect(humanizeErrorCode("RUNTIME_ERROR")).toContain("运行时未就绪");
        expect(humanizeErrorCode("MCP_STREAM_UNAVAILABLE")).toContain("Docker");
    });

    it("separates an unknown tool from dependency unavailability", () => {
        expect(humanizeErrorCode("UNKNOWN_TOOL")).toContain("工具不存在");
        expect(humanizeErrorCode("UNKNOWN_TOOL")).not.toContain("运行时");
        expect(humanizeErrorCode("AGENT_UNAVAILABLE")).toContain("Agent");
    });

    it("maps approval terminal states", () => {
        expect(humanizeErrorCode("APPROVAL_REJECTED")).toContain("取消");
        expect(humanizeErrorCode("APPROVAL_EXPIRED")).toContain("过期");
    });

    it("keeps unknown codes visible", () => {
        expect(humanizeErrorCode("SOMETHING", "boom")).toContain("SOMETHING");
        expect(chatErrorToastText("RUNTIME_ERROR")).toContain("RUNTIME_ERROR");
        expect(chatErrorToastText("RUNTIME_ERROR")).toContain("运行时");
    });

    it("maps Workspace Job execution codes to stable UI copy", () => {
        const cases: Record<string, string> = {
            PATH_OUT_OF_SCOPE: "超出工作区范围",
            CAPABILITY_UNAVAILABLE: "能力当前不可用",
            PROCESS_TIMEOUT: "进程执行超时",
            PROCESS_CANCELLED: "进程已取消",
            JOB_BACKEND_LAUNCH_PENDING: "尚未提供 Job 启动器",
            UNMAPPED_ERROR: "未映射具体错误",
        };

        for (const [code, copy] of Object.entries(cases)) {
            expect(humanizeErrorCode(code), code).toContain(copy);
        }
    });
});

describe("normalizeRefusalCode (PLAN-0649 M3)", () => {
    it("accepts only the frozen enum shape", () => {
        expect(normalizeRefusalCode("DELEGATION_LIMIT_EXCEEDED")).toBe("DELEGATION_LIMIT_EXCEEDED");
        expect(normalizeRefusalCode("A")).toBe("A");
        expect(normalizeRefusalCode("X".repeat(64))).toBe("X".repeat(64));
    });

    it("drops everything else so a malformed value can never read as a reason", () => {
        for (const value of [
            "delegation_limit_exceeded",
            "DELEGATION LIMIT",
            "DELEGATION:LIMIT",
            "拒绝",
            "X".repeat(65),
            "1DELEGATION",
            "",
            undefined,
            null,
            123,
            { code: "DELEGATION_LIMIT_EXCEEDED" },
        ]) {
            expect(normalizeRefusalCode(value)).toBeUndefined();
        }
    });
});

describe("toolRefusalCopyKey (PLAN-0649 M3 / B5)", () => {
    it("maps the CP refusal codes to i18n keys", () => {
        expect(toolRefusalCopyKey("DELEGATION_LIMIT_EXCEEDED")).toBe(
            "chat.toolRefusalDelegationLimit",
        );
        expect(toolRefusalCopyKey("DELEGATION_POLICY_INVALID")).toBe(
            "chat.toolRefusalDelegationPolicy",
        );
        expect(toolRefusalCopyKey("SPAWN_EXECUTION_FAILED")).toBe("chat.toolRefusalSpawnFailed");
        expect(toolRefusalCopyKey("ACQUIRE_EXECUTION_FAILED")).toBe(
            "chat.toolRefusalAcquireFailed",
        );
    });

    it("returns null for an unmapped code so the caller shows generic copy plus the code", () => {
        expect(toolRefusalCopyKey("SOME_FUTURE_CODE")).toBeNull();
        expect(toolRefusalCopyKey("")).toBeNull();
        expect(toolRefusalCopyKey(undefined)).toBeNull();
    });
});

describe("provider binding errors (C1 / BL-204)", () => {
    it("maps the three provider-binding codes to actionable Chinese copy", () => {
        expect(mappedErrorCopy("PROVIDER_REQUIRED")).toContain("尚未绑定");
        expect(mappedErrorCopy("PROVIDER_CONNECTION_AMBIGUOUS")).toContain("多个");
        expect(mappedErrorCopy("LLM_PROFILE_CONFLICT")).toContain("没有可用连接");
    });

    it("keeps the raw code visible in the toast so support can identify it", () => {
        const text = chatErrorToastText("PROVIDER_REQUIRED", "some detail");
        expect(text).toContain("PROVIDER_REQUIRED");
        expect(text).toContain("尚未绑定");
    });
});
