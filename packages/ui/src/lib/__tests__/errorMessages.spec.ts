import { describe, expect, it } from "vitest";
import {
    chatErrorToastText,
    humanizeErrorCode,
    mappedErrorCopy,
    normalizeRefusalCode,
    problemDetailText,
    PROBLEM_DETAIL_MAX_LENGTH,
    toolRefusalCopyKey,
} from "../errorMessages";

describe("mappedErrorCopy", () => {
    it("returns dedicated copy only for codes it actually maps", () => {
        expect(mappedErrorCopy("AGENT_TIMEOUT")).toContain("超时");
        // PLAN-0706: the code now has a dedicated mapping (CP keeps only the stable code for it).
        expect(mappedErrorCopy("RUN_BUDGET_EXHAUSTED")).toContain("预算");
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

    it("maps the CP codes whose English detail was removed (PLAN-0706)", () => {
        const cases: Record<string, string> = {
            LLM_NOT_CONFIGURED: "凭据未配置",
            LLM_CREDENTIALS_INVALID: "凭据被拒绝",
            LLM_PROVIDER_UNREACHABLE: "暂不可达",
            AGENT_CIRCUIT_OPEN: "暂不可用",
            IDEMPOTENCY_KEY_CONFLICT: "幂等键冲突",
            APPROVAL_EXECUTOR_UNSUPPORTED: "不支持审批",
            APPROVAL_DECISION_CONFLICT: "不同决定",
            AGENT_EVENT_ID_MISMATCH: "不匹配",
            CONTEXT_OVERFLOW: "上下文超限",
            RUN_BUDGET_EXHAUSTED: "累计预算上限",
            RUN_NO_PROGRESS: "无进展",
            RAG_PROFILE_UNAVAILABLE: "embedding 配置不可用",
            RAG_LEASE_INVALID: "租约无效",
            RAG_LEASE_UNAVAILABLE: "租约不可用",
            RAG_LEASE_MISMATCH: "不匹配",
            RAG_QUERY_FAILED: "拒绝了查询",
            BASELINE_UNAUTHORIZED: "指令基线缺失",
        };
        for (const [code, copy] of Object.entries(cases)) {
            expect(humanizeErrorCode(code), code).toContain(copy);
        }
    });

    it("never surfaces an English backend detail for an unknown code", () => {
        const copy = humanizeErrorCode("SOMETHING_NEW", "Provider credentials are not configured");
        expect(copy).not.toContain("Provider credentials");
        expect(copy).toContain("SOMETHING_NEW");
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

describe("problemDetailText (BL-288)", () => {
    const problem = (detail?: string) => ({
        problem: { status: 413, code: "EXPORT_TOO_LARGE", requestId: "req-1", detail },
    });

    it("prefers the server Problem detail over the generic fallback", () => {
        const text = problemDetailText(
            problem("会话 20001 条，超过 20000 条上限；请先删除旧会话或分批导出"),
            "导出失败",
        );
        expect(text).toContain("20001");
        expect(text).toContain("20000");
        expect(text).not.toBe("导出失败");
    });

    it("falls back to the caller's generic copy when the Problem has no detail", () => {
        expect(problemDetailText(problem(undefined), "导出失败")).toBe("导出失败");
        expect(problemDetailText(problem("   "), "导出失败")).toBe("导出失败");
        expect(problemDetailText(new Error("boom"), "导出失败")).toBe("导出失败");
    });

    it("truncates an over-long detail at 200 code points with an ellipsis", () => {
        const text = problemDetailText(problem("x".repeat(500)), "导出失败");
        expect(text).toHaveLength(PROBLEM_DETAIL_MAX_LENGTH);
        expect(text.endsWith("…")).toBe(true);
        expect(problemDetailText(problem("y".repeat(150)), "导出失败")).toHaveLength(150);
    });

    it("collapses newlines/tabs into one line and never leaks extra fields", () => {
        const text = problemDetailText(
            {
                problem: {
                    status: 409,
                    code: "ROLE_BINDING_EXCEEDS_CAP",
                    requestId: "req-1",
                    detail: "超过上限：\n\tCREATE_ACCOUNT, MANAGE_WORKSPACE_AGENTS\r\n最多 3 个",
                    stack: "at secret.Internal",
                },
            },
            "绑定失败",
        );
        expect(text).toBe("超过上限： CREATE_ACCOUNT, MANAGE_WORKSPACE_AGENTS 最多 3 个");
        expect(text).not.toContain("secret.Internal");
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
