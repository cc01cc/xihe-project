import { describe, expect, it } from "vitest";
import { i18n } from "../../i18n";
import {
    chatErrorToastText,
    errorCopyKey,
    humanizeErrorCode,
    mappedErrorCopy,
    normalizeRefusalCode,
    presentCauseError,
    presentError,
    presentLocalError,
    problemDetailText,
    PROBLEM_DETAIL_MAX_LENGTH,
    toolRefusalCopyKey,
    toolRefusalHintKey,
} from "../errorMessages";

/**
 * PLAN-0750 V10 (A1-lite)：toast 通道只给少数码开 i18n key，其余一律 null 走旧路径。
 * 这条 describe 同时是 BL-563 的边界说明 —— 白名单之外的全量硬编码中文问题不在本卡范围内。
 *
 * task-102 追加 `PARTICIPANT_SELF_TARGET`：它是 CP 侧的稳定 400 码（`ChatController:701`），
 * 必须给专门文案 —— 泛化的「操作失败，请稍后重试（CODE）」不告诉用户**该改哪一格**。
 */
describe("errorCopyKey (PLAN-0750 V10 / A1-lite)", () => {
    it("覆盖 AGENT_PRINCIPAL_* 与 task-102 的 PARTICIPANT_SELF_TARGET", () => {
        expect(errorCopyKey("AGENT_PRINCIPAL_MISSING")).toBe("chat.principalMissingToast");
        expect(errorCopyKey("AGENT_PRINCIPAL_DISABLED")).toBe("chat.principalDisabledToast");
        expect(errorCopyKey("PARTICIPANT_SELF_TARGET")).toBe("chat.participantSelfTargetToast");
        // 邻格：as=自己 + TO 缺席（task-110）。`as` 候选仍含自己 ⇒ 这条从 UI 真能触发。
        expect(errorCopyKey("AS_SELF_WITHOUT_TARGET")).toBe("chat.asSelfWithoutTargetToast");
    });

    it("白名单之外的码一律 null（旧路径逐字节不变，BL-563）", () => {
        // 取样必须包含「有 mappedErrorCopy 文案」的码 —— 否则证明不了 key 通道没有越界。
        expect(errorCopyKey("PROVIDER_REQUIRED")).toBeNull();
        expect(errorCopyKey("AGENT_TIMEOUT")).toBeNull();
        expect(errorCopyKey("RUNTIME_UNAVAILABLE")).toBeNull();
        expect(errorCopyKey("SOMETHING_NOT_MAPPED")).toBeNull();
        expect(errorCopyKey("")).toBeNull();
        expect(errorCopyKey(undefined)).toBeNull();
        expect(errorCopyKey(null)).toBeNull();
    });

    it("只做 trim，不改写码本身", () => {
        expect(errorCopyKey("  AGENT_PRINCIPAL_MISSING  ")).toBe("chat.principalMissingToast");
        expect(errorCopyKey("agent_principal_missing")).toBeNull();
    });
});

/**
 * task-102：`errorCopyKey` 返回的是**裸 key**，用户看到什么取决于 locale 里有没有它。
 * 少一侧的解法是「补文案」，但不是「映射回去」—— 所以这里把「映射指向的键两侧都存在」钉成判据：
 * 只加 `case` 忘了加文案时，用户看到的是 `chat.participantSelfTargetToast` 这串 key 名（静默降级）。
 * （`i18n-scan` 只查 `t("…")` 静态引用与两侧键差集，看不见 `errorCopyKey` 里拼出来的 key。）
 */
describe("errorCopyKey 指向的键在 zh/en 两侧都可解析（task-102）", () => {
    const KEYED_CODES = [
        "AGENT_PRINCIPAL_MISSING",
        "AGENT_PRINCIPAL_DISABLED",
        "PARTICIPANT_SELF_TARGET",
        "AS_SELF_WITHOUT_TARGET",
    ];

    it.each(KEYED_CODES)("%s 的键两侧都存在", (code) => {
        const key = errorCopyKey(code);
        expect(key, `${code} 没有 i18n 通道`).toBeTruthy();
        for (const locale of ["zh-CN", "en-US"]) {
            expect(i18n.global.te(key!, locale), `${locale} 缺 ${key}`).toBe(true);
        }
    });
});
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
        // task-54: the grant denial is the one refusal a user can act on, so it must not
        // fall through to the generic line.
        expect(toolRefusalCopyKey("TOOL_GRANT_DENIED")).toBe("chat.toolRefusalGrantDenied");
    });

    it("returns null for an unmapped code so the caller shows generic copy plus the code", () => {
        expect(toolRefusalCopyKey("SOME_FUTURE_CODE")).toBeNull();
        expect(toolRefusalCopyKey("")).toBeNull();
        expect(toolRefusalCopyKey(undefined)).toBeNull();
    });
});

describe("toolRefusalHintKey (task-54)", () => {
    it("gives the grant denial an actionable exit naming the real UI entry", () => {
        expect(toolRefusalHintKey("TOOL_GRANT_DENIED")).toBe("chat.toolRefusalGrantDeniedHint");
    });

    it("returns null for codes with no actionable entry, so the generic hint stays", () => {
        expect(toolRefusalHintKey("DELEGATION_LIMIT_EXCEEDED")).toBeNull();
        expect(toolRefusalHintKey("SOME_FUTURE_CODE")).toBeNull();
        expect(toolRefusalHintKey(undefined)).toBeNull();
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

/**
 * task-45：错误面**单一入口** `presentError`。
 *
 * <p>缺陷形态（不是某个具体码）：任何**后端没登记**的码都会走到
 * `api.ts:2549-2550` 的 `code ?? "API_ERROR"` / `detail || 'API error <status>'`，
 * 而 21 处渲染点各自拼 `<code>: <detail>` ⇒ 用户看到 `AUDIT_ERROR: API error 500`
 * 这种「英文码 + 英文兜底」。本入口把三件事分开：可读文案（本地化、含下一步动作）、
 * 供支持引用的稳定码、**只给诊断面**用的原始 detail（toast 面只 console.warn）。</p>
 */
describe("presentError（task-45：错误面单一入口）", () => {
    const t = (key: string) => i18n.global.t(key) as string;

    it("未知码 + 客户端兜底 detail ⇒ 文案不含英文 detail、也不含英文码", () => {
        const p = presentError(t, { code: "AUDIT_ERROR", detail: "API error 500" });
        expect(p.code).toBe("AUDIT_ERROR");
        expect(p.copy).not.toMatch(/API error \d+/);
        expect(p.copy).not.toContain("AUDIT_ERROR");
        expect(p.copy).toBe(t("errors.unknownCode"));
        // 可诊断性不丢：原文留在技术详情里（默认折叠由渲染面负责）
        expect(p.technicalDetail).toBe("API error 500");
    });

    it("API_ERROR 兜底码走同一句可读文案（形状修复，不是逐码糊）", () => {
        const p = presentError(t, { code: "API_ERROR", detail: "API error 500" });
        expect(p.copy).toBe(t("errors.requestFailed"));
        expect(p.copy).not.toMatch(/API error \d+/);
    });

    it("已有 mappedErrorCopy 的码沿用旧文案（不新造第二套）", () => {
        const p = presentError(t, { code: "AGENT_TIMEOUT", detail: "API error 504" });
        expect(p.copy).toBe(mappedErrorCopy("AGENT_TIMEOUT"));
        expect(p.copy).not.toMatch(/API error \d+/);
    });

    it("无 detail ⇒ technicalDetail 为 null（不渲染空折叠区）", () => {
        expect(presentError(t, { code: "AUDIT_ERROR", detail: "" }).technicalDetail).toBeNull();
        expect(presentError(t, { code: "AUDIT_ERROR" }).technicalDetail).toBeNull();
    });

    it("detail 单行化并按既有上限截断（复用 PROBLEM_DETAIL_MAX_LENGTH）", () => {
        const p = presentError(t, { code: "AUDIT_ERROR", detail: "line1\nline2   line3" });
        expect(p.technicalDetail).toBe("line1 line2 line3");
        const long = presentError(t, {
            code: "AUDIT_ERROR",
            detail: "x".repeat(PROBLEM_DETAIL_MAX_LENGTH + 50),
        });
        expect(Array.from(long.technicalDetail ?? "").length).toBe(PROBLEM_DETAIL_MAX_LENGTH);
    });

    it("码为空（非 ApiError 调用方）⇒ requestFailed，且码不外泄", () => {
        const p = presentError(t, { detail: "API error 500" });
        expect(p.code).toBeNull();
        expect(p.copy).toBe(t("errors.requestFailed"));
        expect(p.technicalDetail).toBe("API error 500");
    });

    it("无码 + 本面文案 ⇒ 用本面文案（fallback 不是第四个分叉，仍走本入口）", () => {
        const p = presentError(t, { fallback: "本页自己的失败文案" });
        expect(p.copy).toBe("本页自己的失败文案");
        expect(p.code).toBeNull();
        expect(p.technicalDetail).toBeNull();
    });

    it("presentCauseError 按 cause.problem 结构取码（不依赖 instanceof ApiError）", () => {
        const p = presentCauseError(
            t,
            { problem: { code: "AUDIT_ERROR", detail: "API error 500" } },
            "兜底",
        );
        expect(p.code).toBe("AUDIT_ERROR");
        expect(p.copy).toBe(t("errors.unknownCode"));
        expect(p.technicalDetail).toBe("API error 500");
        // 没有 problem 形状的普通错误 ⇒ 本面文案，不泄露英文
        const plain = presentCauseError(t, new Error("boom: socket hang up"), "本面文案");
        expect(plain.copy).toBe("本面文案");
        expect(plain.technicalDetail).toBeNull();
    });

    it("presentLocalError 只包形状，不改文案", () => {
        const p = presentLocalError("请填写动作类");
        expect(p).toEqual({ copy: "请填写动作类", code: null, technicalDetail: null });
    });

    it("文案键两侧都可解析（静态 i18n 扫描看不见拼出来的键）", () => {
        for (const locale of ["zh-CN", "en-US"]) {
            for (const key of [
                "errors.requestFailed",
                "errors.unknownCode",
                "errors.technicalDetail",
            ]) {
                expect(i18n.global.te(key, locale), locale + " 缺 " + key).toBe(true);
            }
        }
    });
});
