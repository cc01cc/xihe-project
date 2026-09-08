package com.cc01cc.p.xihe.cp.policy;

import java.util.Set;
import org.springframework.stereotype.Component;
import com.cc01cc.p.xihe.cp.audit.AuditLogger;

/**
 * PolicyEngine evaluates whether a tool call should be allowed.
 * Implements PLAN-275 §3.2 tool classification:
 * - auto_allow: read-only tools (no workspace mutation)
 * - require_approval: mutation tools (write/edit/delete/command)
 * - deny: unknown tools (fail-closed)
 *
 * Per-workspace policy overrides deferred to v2.
 */
@Component
public class PolicyEngine {

    private final AuditLogger audit;

    public PolicyEngine(AuditLogger audit) {
        this.audit = audit;
    }

    public static class PolicyDecision {
        private final PolicyResult result;
        private final String reason;

        public enum PolicyResult { ALLOW, DENY, REQUIRE_APPROVAL }

        public PolicyDecision(PolicyResult result, String reason) {
            this.result = result;
            this.reason = reason;
        }

        public PolicyResult getResult() { return result; }
        public String getReason() { return reason; }

        public static PolicyDecision allow() {
            return new PolicyDecision(PolicyResult.ALLOW, "auto_allow");
        }

        public static PolicyDecision requireApproval(String reason) {
            return new PolicyDecision(PolicyResult.REQUIRE_APPROVAL, reason);
        }

        public static PolicyDecision deny(String reason) {
            return new PolicyDecision(PolicyResult.DENY, reason);
        }
    }

    private static final Set<String> AUTO_ALLOW_TOOLS = Set.of(
        "read_file", "read_file_range", "list_directory", "glob", "grep",
        "get_file_info", "watch_directory", "extract_pdf_text",
        "read_command_output", "list_background_processes",
        "get_background_process"
    );

    private static final Set<String> REQUIRE_APPROVAL_TOOLS = Set.of(
        "write_file", "write_file_binary", "edit_file", "delete_file",
        "delete_directory", "move_file", "copy_file", "mkdir",
        "execute_command", "start_background_process", "cancel_background_process",
        "apply_patch", "snapshot", "revert"
    );

    public PolicyDecision evaluate(String toolName, String body, String sessionId) {
        if (toolName == null || toolName.isBlank()) {
            audit.record(sessionId, toolName, "policy_check", "deny_empty_tool");
            return PolicyDecision.deny("tool name is required");
        }

        if (AUTO_ALLOW_TOOLS.contains(toolName)) {
            audit.record(sessionId, toolName, "policy_check", "auto_allow");
            return PolicyDecision.allow();
        }

        if (REQUIRE_APPROVAL_TOOLS.contains(toolName)) {
            audit.record(sessionId, toolName, "policy_check", "require_approval");
            return PolicyDecision.requireApproval("mutation tool requires approval: " + toolName);
        }

        audit.record(sessionId, toolName, "policy_check", "deny_unknown");
        return PolicyDecision.deny("unknown tool (fail-closed): " + toolName);
    }
}
