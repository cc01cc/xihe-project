package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.springframework.http.HttpStatus;

import java.util.Locale;

/**
 * One approval decision (PLAN-0328 M1, spec/approval.md §14).
 *
 * <p>Three grant tiers ({@code once} / {@code session} / {@code saved}), plain rejection with
 * optional feedback, and the persistent {@code reject_always} deny (decision #25). The legacy
 * boolean body maps to {@code once} / {@code reject}, so the pre-0328 UI keeps working.</p>
 *
 * <p>Validation is deliberately fail-closed: an unknown kind, feedback on an approval, a layer
 * on a non-persistent kind, or a rule override on a non-granting kind is a 400 — never a silent
 * coercion (spec §12 "未知/解析失败的选项 → fail-closed").</p>
 */
public record ApprovalDecision(Kind kind, String feedback, String layer, String actionClass, String resource) {

    public static final String LAYER_WORKSPACE = "workspace";
    public static final String LAYER_USER = "user";
    static final String DEFAULT_RESOURCE = "*";
    static final int MAX_FEEDBACK_LENGTH = 512;
    static final int MAX_RESOURCE_LENGTH = 512;
    static final int MAX_ACTION_CLASS_LENGTH = 64;

    public enum Kind {
        ONCE("once", true, false),
        SESSION("session", true, true),
        SAVED("saved", true, true),
        REJECT("reject", false, false),
        REJECT_ALWAYS("reject_always", false, true);

        private final String wireName;
        private final boolean approved;
        private final boolean grantsRule;

        Kind(String wireName, boolean approved, boolean grantsRule) {
            this.wireName = wireName;
            this.approved = approved;
            this.grantsRule = grantsRule;
        }

        /** Wire value used by the UI request and the Agent respond payload. */
        public String wireName() {
            return wireName;
        }

        public boolean isApproved() {
            return approved;
        }

        /** True when the decision materializes a rule (session L4 / persistent L3–L2 / persistent deny). */
        public boolean grantsRule() {
            return grantsRule;
        }

        public static Kind fromWire(String raw) {
            if (raw == null || raw.isBlank()) {
                throw invalid("decision is required");
            }
            String normalized = raw.trim().toLowerCase(Locale.ROOT).replace('-', '_');
            for (Kind kind : values()) {
                if (kind.wireName.equals(normalized)) {
                    return kind;
                }
            }
            throw invalid("unsupported decision: " + raw + " (expected one of once/session/saved/reject/reject_always)");
        }
    }

    public ApprovalDecision {
        if (kind == null) {
            throw invalid("decision is required");
        }
        feedback = normalizeText(feedback, MAX_FEEDBACK_LENGTH, "feedback");
        if (feedback != null && kind.isApproved()) {
            throw invalid("feedback is only valid for reject decisions");
        }
        layer = normalizeText(layer, 16, "layer");
        if (layer != null) {
            layer = layer.toLowerCase(Locale.ROOT);
            if (!LAYER_WORKSPACE.equals(layer) && !LAYER_USER.equals(layer)) {
                throw invalid("layer must be workspace or user");
            }
            if (kind != Kind.SAVED && kind != Kind.REJECT_ALWAYS) {
                throw invalid("layer is only valid for saved/reject_always decisions");
            }
        }
        actionClass = normalizeText(actionClass, MAX_ACTION_CLASS_LENGTH, "actionClass");
        resource = normalizeText(resource, MAX_RESOURCE_LENGTH, "resource");
        if ((actionClass != null || resource != null) && !kind.grantsRule()) {
            throw invalid("rule overrides are only valid for session/saved/reject_always decisions");
        }
    }

    public static ApprovalDecision once() {
        return new ApprovalDecision(Kind.ONCE, null, null, null, null);
    }

    public static ApprovalDecision reject(String feedback) {
        return new ApprovalDecision(Kind.REJECT, feedback, null, null, null);
    }

    public static ApprovalDecision fromApproved(boolean approved) {
        return approved ? once() : reject(null);
    }

    public static ApprovalDecision of(Kind kind, String feedback, String layer, String actionClass, String resource) {
        return new ApprovalDecision(kind, feedback, layer, actionClass, resource);
    }

    /** Target layer of a persistent grant; workspace is the default (spec §9, decision #58). */
    public String effectiveLayer() {
        if (kind != Kind.SAVED && kind != Kind.REJECT_ALWAYS) {
            return null;
        }
        return layer == null ? LAYER_WORKSPACE : layer;
    }

    /** Resource to grant; {@code *} (whole domain) when the caller did not narrow it. */
    public String effectiveResource() {
        return resource == null ? DEFAULT_RESOURCE : resource;
    }

    private static String normalizeText(String value, int maxLength, String field) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        if (trimmed.isEmpty()) {
            throw invalid(field + " must not be blank");
        }
        if (trimmed.length() > maxLength) {
            throw invalid(field + " exceeds " + maxLength + " characters");
        }
        return trimmed;
    }

    private static CpApiException invalid(String message) {
        return new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", message);
    }
}
