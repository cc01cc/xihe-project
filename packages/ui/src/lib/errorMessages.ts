/**
 * Localized copy for a stable Problem/SSE error code (PLAN-290 A6/B1).
 *
 * `null` means "this code has no dedicated copy" — callers then choose their own wording
 * instead of surfacing the CP's raw English `detail` to the user.
 */
/** BL-288：Problem `detail` 展示上限（单行化后按 Unicode 码点截断）。 */
export const PROBLEM_DETAIL_MAX_LENGTH = 200;

/**
 * BL-288 —— 统一 error→用户文案：**优先后端 Problem `detail`**，没有才回退调用方的通用文案。
 *
 * - 只读 `problem.detail`（不展示 stack/内部字段；code 由日志/上报保留）；
 * - 换行/控制字符折叠为单空格 ⇒ 单行；
 * - 超过 `maxLength` 个码点截断并加省略号；
 * - detail 为空/非字符串 ⇒ `fallback`。
 *
 * 不 import `ApiError`（避免 lib ↔ composables 循环依赖）：按结构读取，任何带
 * `{ problem: { detail } }` 形状的错误都适用。
 */
export function problemDetailText(
    cause: unknown,
    fallback: string,
    maxLength = PROBLEM_DETAIL_MAX_LENGTH,
): string {
    const problem = (cause as { problem?: { detail?: unknown } } | null | undefined)?.problem;
    const raw = typeof problem?.detail === "string" ? problem.detail : "";
    const singleLine = raw
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!singleLine) return fallback;
    const chars = Array.from(singleLine);
    if (chars.length <= maxLength) return singleLine;
    const cut = Math.max(1, maxLength - 1);
    return `${chars.slice(0, cut).join("").trimEnd()}…`;
}

export function mappedErrorCopy(code: string | undefined | null): string | null {
    const key = (code ?? "").trim();
    switch (key) {
        case "RUNTIME_ERROR":
        case "RUNTIME_UNAVAILABLE":
            return "工作区运行时未就绪（Runtime 不可达），请确认服务已启动后重试；若持续失败请联系管理员";
        case "MCP_STREAM_UNAVAILABLE":
        case "MCP_DISCONNECT_UNAVAILABLE":
            return "沙盒未就绪，请启动 Docker 后重试（Runtime 不可达）";
        case "UNKNOWN_TOOL":
            return "工具不存在或未启用，请刷新工作区后重试";
        case "AGENT_UNAVAILABLE":
            return "Agent 服务暂不可达，请稍后重试";
        case "PATH_TRAVERSAL":
        case "FORBIDDEN":
            return "路径不合法：仅允许工作区相对路径";
        case "APPROVAL_REJECTED":
            return "已取消：本次文件修改未执行";
        case "APPROVAL_EXPIRED":
            return "审批已过期，请重新发起操作";
        case "APPROVAL_NOT_FOUND":
            return "审批请求不存在或已被处理";
        case "CHAT_IN_PROGRESS":
            return "上一条消息仍在处理中，请等待完成或取消后再发送";
        case "SSE_SUBSCRIPTION_REQUIRED":
            return "实时连接未就绪，请刷新页面后重试";
        case "LLM_MISSING_CREDENTIALS":
        case "LLM_INVALID_CREDENTIALS":
            return "模型凭据不可用，请在设置中检查 LLM Provider";
        case "LLM_MODEL_UNAVAILABLE":
            return "所选模型当前不可用，请更换模型或稍后重试";
        case "LLM_TOOL_ROUTE_UNSUPPORTED":
            return "当前模型路由不支持工具调用：请改用 OpenAI 兼容连接或更换模型";
        case "LLM_BASE_URL_MISSING":
            return "模型连接缺少 Base URL：请在设置中为该连接填写地址";
        case "LLM_REQUEST_REJECTED":
            return "模型提供方拒绝了该请求（消息格式或参数不被接受）";
        case "AGENT_TIMEOUT":
            return "AI 响应超时，请重试";
        case "AGENT_STREAM_FAILED":
            return "对话流中断，请重试";
        case "SESSION_NOT_FOUND":
            return "会话不存在或已删除";
        // PLAN-0750 / G8 (task-155): dedicated code for a Session with no active Agent
        // principal binding. MessageItem branches this code to actionable binding guidance;
        // this line is the generic-code fallback for the toast/SSE copy channel.
        case "AGENT_PRINCIPAL_MISSING":
            return "此会话尚未绑定可用的智能体（Agent principal）：请在工作区设置 → 智能体管理绑定，或联系工作区管理员";
        case "PATH_OUT_OF_SCOPE":
            return "路径超出工作区范围，操作已拒绝";
        case "CAPABILITY_UNAVAILABLE":
            return "执行能力当前不可用，请检查 Runtime 或后端状态";
        case "PROCESS_TIMEOUT":
            return "进程执行超时，任务已终止";
        case "PROCESS_CANCELLED":
            return "进程已取消";
        case "JOB_BACKEND_LAUNCH_PENDING":
            return "当前执行后端尚未提供 Job 启动器，暂不可用";
        case "PROVIDER_REQUIRED":
            return "会话尚未绑定模型，无法发送：请先绑定 provider 连接（可在发送时选择自动绑定）";
        case "PROVIDER_CONNECTION_AMBIGUOUS":
            return "有多个可用的 provider 连接，无法自动选择：请在设置中指定默认模型或连接";
        case "LLM_PROFILE_CONFLICT":
            return "生效的 LLM Provider 配置没有可用连接：请在设置中检查 Provider 与连接状态";
        case "UNMAPPED_ERROR":
            return "执行失败，后端未映射具体错误";
        // PLAN-0706 / BL-152: codes whose CP used to ship an English `detail`; CP now emits only
        // the stable code, so the UI owns the copy (code names are the CP names).
        case "LLM_NOT_CONFIGURED":
            return "模型凭据未配置，请在设置中检查 LLM Provider";
        case "LLM_CREDENTIALS_INVALID":
            return "模型凭据被拒绝，请在设置中重新填写密钥";
        case "LLM_PROVIDER_UNREACHABLE":
            return "模型提供方暂不可达，请稍后重试";
        case "AGENT_CIRCUIT_OPEN":
            return "Agent 服务暂不可用，请稍后重试";
        case "IDEMPOTENCY_KEY_CONFLICT":
            return "该请求已处理过（幂等键冲突），请刷新后重试";
        case "APPROVAL_EXECUTOR_UNSUPPORTED":
            return "当前 Agent 执行器不支持审批";
        case "APPROVAL_DECISION_CONFLICT":
            return "审批请求已有不同决定";
        case "AGENT_EVENT_ID_MISMATCH":
            return "Agent 事件与当前运行不匹配，请重试";
        case "CONTEXT_OVERFLOW":
            return "上下文超限，已压缩并重试一次，仍超出限制";
        case "RUN_BUDGET_EXHAUSTED":
            return "本次运行已达到累计预算上限";
        case "RUN_NO_PROGRESS":
            return "检测到重复或无进展动作，运行已停止";
        case "RAG_PROFILE_UNAVAILABLE":
            return "本次运行的 embedding 配置不可用";
        case "RAG_LEASE_INVALID":
            return "embedding 凭据租约无效";
        case "RAG_LEASE_UNAVAILABLE":
            return "embedding 凭据租约不可用";
        case "RAG_LEASE_MISMATCH":
            return "embedding 凭据租约与本次运行不匹配";
        case "RAG_QUERY_FAILED":
            return "向量检索提供方拒绝了查询，请稍后重试";
        case "BASELINE_UNAUTHORIZED":
            return "Agent 指令基线缺失，请联系管理员";
        case "WORKSPACE_NOT_FOUND":
            return "工作区不存在或已删除";
        case "WORKSPACE_DESTROYING":
            return "工作区正在销毁，暂不可用";
        case "WORKSPACE_BUSY":
            return "工作区繁忙，请稍后重试";
        case "WORKSPACE_MATERIALIZATION_FAILED":
            return "工作区初始化失败，请稍后重试";
        default:
            break;
    }
    return null;
}

/** Human-readable copy for stable Problem/SSE error codes (PLAN-290 A6/B1). */
export function humanizeErrorCode(code: string | undefined | null, detail?: string | null): string {
    const mapped = mappedErrorCopy(code);
    if (mapped !== null) return mapped;
    // PLAN-0706: the raw backend detail is deliberately not surfaced (it may be English);
    // keep the parameter for callers but make the intent explicit.
    void detail;
    const key = (code ?? "").trim();
    // PLAN-0706 / BL-152: never surface a raw (English) backend `detail` to the user. Unknown
    // codes keep the code visible for support but the copy stays Chinese.
    return key ? `操作失败，请稍后重试（${key}）` : "操作失败，请稍后重试";
}

export function chatErrorToastText(code: string | undefined, detail?: string | null): string {
    const mapped = humanizeErrorCode(code, detail);
    // When we have a dedicated mapping without embedding raw detail, still show code for support.
    if (mapped !== `${code}: ${detail}` && code) {
        return `${code} — ${mapped}`;
    }
    return mapped;
}

/**
 * PLAN-0750 V10 (A1-lite) —— 少数码的 **i18n key**，让 toast 通道跟随当前 locale。
 *
 * 为什么需要：`mappedErrorCopy` 是**故意**硬编码中文的（HTTP/SSE 错误通道，理由见
 * `toolRefusalCopyKey` 的注释）。于是 en 语系用户在 toast 里看到的是中文 —— 对
 * `AGENT_PRINCIPAL_MISSING` 这类「必须给出可操作指引」的码，等于**判据在 en 下不成立**。
 *
 * 调用点写法（两处，仅 toast）：
 * ```ts
 * const key = errorCopyKey(code);
 * toast.error(key ? t(key) : chatErrorToastText(code, detail));
 * ```
 *
 * **刻意只覆盖 V10 涉及的两个码**：把 `mappedErrorCopy` 的几十个码全量搬进 i18n 是独立
 * 工作量，已登记 BL-563（本卡不合入）。返回 `null` = 该码没有 key，调用点走原路径，
 * 行为逐字节不变 —— 所以这条通道是**加法**，不动既有文案与顺序。
 */
export function errorCopyKey(code: string | undefined | null): string | null {
    switch ((code ?? "").trim()) {
        case "AGENT_PRINCIPAL_MISSING":
            return "chat.principalMissingToast";
        case "AGENT_PRINCIPAL_DISABLED":
            return "chat.principalDisabledToast";
        default:
            return null;
    }
}

/**
 * PLAN-0649 M3 (spec `tool-refusal-observability.md` §1/§2): the frozen shape of
 * a `refusalCode`. The UI re-validates instead of trusting the wire, so a value
 * that is not a bare enum token can never reach the card as "a reason".
 */
const REFUSAL_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Returns the code only when it matches the frozen shape, else `undefined` (fail-closed). */
export function normalizeRefusalCode(value: unknown): string | undefined {
    return typeof value === "string" && REFUSAL_CODE_RE.test(value) ? value : undefined;
}

/**
 * PLAN-0649 M3 / B5: i18n **key** for a tool-refusal code, or `null` when the code
 * has no dedicated copy — callers then render the generic refusal line **plus the
 * raw code** so support can identify it.
 *
 * Deliberately a key rather than text: unlike `mappedErrorCopy` (hardcoded
 * Chinese, HTTP/SSE error channel), this copy is user-facing in both locales and
 * lives in `i18n/index.ts`.
 */
export function toolRefusalCopyKey(code: string | undefined | null): string | null {
    switch ((code ?? "").trim()) {
        case "DELEGATION_LIMIT_EXCEEDED":
            return "chat.toolRefusalDelegationLimit";
        case "DELEGATION_POLICY_INVALID":
            return "chat.toolRefusalDelegationPolicy";
        case "SPAWN_EXECUTION_FAILED":
            return "chat.toolRefusalSpawnFailed";
        case "ACQUIRE_EXECUTION_FAILED":
            return "chat.toolRefusalAcquireFailed";
        default:
            return null;
    }
}
