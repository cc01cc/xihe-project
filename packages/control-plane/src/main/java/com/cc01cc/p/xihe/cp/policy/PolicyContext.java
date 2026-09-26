package com.cc01cc.p.xihe.cp.policy;

import java.util.List;
import java.util.Map;

/**
 * Per-request policy context: the approval-policy ask list plus tool faces declared outside the
 * code built-ins (PLAN-0328 M1 decision #38; PLAN-0407 T2.8 removed the persisted rule layers —
 * adjudication retired, design #18/#21).
 *
 * <p><b>askActionClasses</b> (design #19): the approval-policy "ask list" that drives the approval
 * trigger. {@code null} means "not configured" and resolves to
 * {@link #DEFAULT_ASK_ACTION_CLASSES}; an explicitly configured empty list means nothing asks.</p>
 *
 * @param extraFaces       tool → face declarations from persistence; may be empty
 * @param mode             session mode when one is set (manual / auto); null = manual
 * @param modeLayer        layer that supplied {@code mode} (audit field `allowed_by=auto@Lx`)
 * @param sessionMode      coherent session mode retained for fail-closed evidence; not applied to resolution
 * @param askActionClasses approval-policy ask list; null = use {@link #DEFAULT_ASK_ACTION_CLASSES}
 * @param askLayer         layer that supplied the ask list (audit/UI `sourceLayer`)
 */
public record PolicyContext(Map<String, ToolFaceRegistry.Face> extraFaces,
                            String mode,
                            PolicyLayer modeLayer,
                            String sessionMode,
                            List<String> askActionClasses,
                            PolicyLayer askLayer) {

    /**
     * Approval-policy ask-list default (PLAN-0407 T2.8 ①, evidence
     * `policy-rules-retired-export.md` §6.2): preserves the pre-retirement ask set — the builtin
     * ask tool faces plus the in-vocabulary domains that previously fell through to the
     * "no rule → ask" default — and adds `delete` (HardGuard companion, T0.5 §2).
     * A missing/unreadable config falls back here, never to an empty list.
     */
    public static final List<String> DEFAULT_ASK_ACTION_CLASSES = List.of(
            "write", "exec", "delete", "credential",
            "CREATE_ACCOUNT", "CREATE_TEMPLATE", "MANAGE_WORKSPACE_AGENTS", "SPAWN_AGENT");

    public PolicyContext(Map<String, ToolFaceRegistry.Face> extraFaces,
                         String mode,
                         PolicyLayer modeLayer) {
        this(extraFaces, mode, modeLayer, mode, null, null);
    }

    public PolicyContext(Map<String, ToolFaceRegistry.Face> extraFaces,
                         String mode,
                         PolicyLayer modeLayer,
                         String sessionMode) {
        this(extraFaces, mode, modeLayer, sessionMode, null, null);
    }

    public static final PolicyContext EMPTY = new PolicyContext(Map.of(), null, null);

    /**
     * Fail-closed context: every builtin action class is on the ask list so no unreadable
     * context can relax the decision to an automatic allow (spec §4.3). Used when persisted
     * context cannot be read.
     */
    public static PolicyContext failedClosed() {
        return failedClosed(null);
    }

    /** Fail-closed context retaining session mode for evidence without applying bypass semantics. */
    public static PolicyContext failedClosed(String sessionMode) {
        return new PolicyContext(Map.of(), null, null, sessionMode,
                List.copyOf(ToolFaceRegistry.builtinActionClasses()), PolicyLayer.INSTANCE);
    }

    public PolicyContext {
        extraFaces = Map.copyOf(extraFaces == null ? Map.of() : extraFaces);
        askActionClasses = askActionClasses == null
                ? DEFAULT_ASK_ACTION_CLASSES
                : List.copyOf(askActionClasses);
        askLayer = askLayer == null ? PolicyLayer.BUILTIN : askLayer;
    }
}
