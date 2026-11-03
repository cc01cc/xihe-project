package com.cc01cc.p.xihe.cp.chat;

/**
 * PLAN-0649 M2: the closed vocabulary of CP-decided tool refusal codes (`refusalCode`).
 *
 * <p>Authority: {@code plans/PLAN-0649-XH-tool-result-observability/spec/tool-refusal-observability.md}
 * §3. The table lives here so a new code is a one-line change plus the doc row — the wire shape gate
 * ({@code ContextEventPayloadSafety.REFUSAL_CODE_PATTERN} and {@code ToolCallSnapshotService}) only
 * checks {@code ^[A-Z][A-Z0-9_]{0,63}$}, so a literal typo would otherwise be dropped silently at the
 * sanitizer instead of failing compilation.</p>
 *
 * <p>Semantics per invariant I2: a code is emitted only when CP itself decided the refusal. Runtime
 * errors from downstream (MCP/Runtime/Agent) carry no code — the card's {@code status=failed} is what
 * distinguishes "failed" from "refused".</p>
 */
public final class ToolRefusalCodes {

    /** Delegation budget refused ({@code depth_exceeded} / {@code count_exceeded}). */
    public static final String DELEGATION_LIMIT_EXCEEDED = "DELEGATION_LIMIT_EXCEEDED";

    /** Delegation policy/chain unusable — fail-closed refusal. */
    public static final String DELEGATION_POLICY_INVALID = "DELEGATION_POLICY_INVALID";

    /**
     * {@code spawn_agent} arguments rejected by CP validation before any child was created.
     *
     * <p>Added 2026-11-04 (user ruling): a real-stack walkthrough produced this code as a genuine
     * refusal reason, and PLAN-0649's premise is "a refusal must be visible and explainable" — a code
     * missing from the table degrades the UI to showing the raw string.</p>
     */
    public static final String SPAWN_ARGUMENTS_INVALID = "SPAWN_ARGUMENTS_INVALID";

    /** Spawn execution failed — the call never landed (child not created). */
    public static final String SPAWN_EXECUTION_FAILED = "SPAWN_EXECUTION_FAILED";

    /** Credential acquisition failed — the call never landed. */
    public static final String ACQUIRE_EXECUTION_FAILED = "ACQUIRE_EXECUTION_FAILED";

    /**
     * Pre-dispatch refusal: the caller holds no authorization grant for the tool, or the policy
     * verdict is {@code DENY}. Distinct from the codes above because nothing was dispatched at all.
     *
     * <p>Added 2026-11-04 (user ruling): this refusal used to answer with a bare
     * {@code 403 FORBIDDEN} problem. A bare HTTP error reaches the model as the SDK's generic
     * "Server returned an error response", so the card showed a failed tool call with no reason and
     * no code — exactly the opacity PLAN-0649 exists to remove. The audit action stays
     * {@code authorization_grant_denied} / {@code deny} (internal semantics); only the wire gains
     * this code.</p>
     */
    public static final String TOOL_GRANT_DENIED = "TOOL_GRANT_DENIED";

    private ToolRefusalCodes() {
    }
}
