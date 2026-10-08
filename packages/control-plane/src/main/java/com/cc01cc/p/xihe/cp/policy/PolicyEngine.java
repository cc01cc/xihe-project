package com.cc01cc.p.xihe.cp.policy;

import java.util.List;
import java.util.Set;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import com.cc01cc.p.xihe.cp.audit.AuditLogger;

/**
 * PolicyEngine evaluates whether a tool call should be allowed.
 *
 * <p>PLAN-0407 T2.8 (design #18/#19): rule adjudication is retired. Authorization is decided by
 * the grant lookup gate that runs before this engine ({@link GrantAuthorizationService}); this
 * engine owns the hard guard (decision #17 / #35) and the approval trigger — the
 * approval-policy ask list carried by {@link PolicyContext#askActionClasses()}. Persisted tool
 * faces still come from a {@link PolicyContextProvider}.</p>
 *
 * <ul>
 *   <li>{@code auto_allow}: action class not on the ask list, or ask list passed by auto mode</li>
 *   <li>{@code require_approval}: action class on the ask list under manual mode</li>
 *   <li>{@code ask}: unclassified tools (opaque, no automatic allow or reuse)</li>
 * </ul>
 */
@Component
public class PolicyEngine {

    private final AuditLogger audit;
    private final PolicyContextProvider contextProvider;
    private final GrantAuthorizationService grantAuthorizationService;
    private final ToolFaceRegistry builtinRegistry;
    private final HardGuard hardGuard;

    public PolicyEngine(AuditLogger audit, PolicyContextProvider contextProvider) {
        this(audit, contextProvider, null);
    }

    @Autowired
    public PolicyEngine(AuditLogger audit, PolicyContextProvider contextProvider,
                        GrantAuthorizationService grantAuthorizationService) {
        this.audit = audit;
        this.contextProvider = contextProvider;
        this.grantAuthorizationService = grantAuthorizationService;
        this.builtinRegistry = new ToolFaceRegistry();
        this.hardGuard = new HardGuard();
    }

    /** Checks hard guard and current grants before the approval resolver is allowed to run. */
    public boolean allowsByGrant(PolicyContext context, String toolName, String body, String sessionId,
                                 String userId, String workspaceId, boolean userPrincipalOnly) {
        if (grantAuthorizationService == null || context == null || toolName == null || toolName.isBlank()) {
            return false;
        }
        ToolFaceRegistry registry = context.extraFaces().isEmpty()
                ? builtinRegistry
                : new ToolFaceRegistry(context.extraFaces());
        ToolFaceRegistry.Face face = registry.faceOf(toolName);
        PolicyRequest request = new PolicyRequest(toolName, List.of(face.actionClass()),
                PolicyResourceExtractor.extract(body), face.shape(), userId, workspaceId, sessionId);
        var hardDeny = hardGuard.checkWorkspaceResources(toolName, request.resources())
                .or(() -> hardGuard.check(request));
        if (hardDeny.isPresent()) {
            audit.record(sessionId, toolName, "policy_hard_deny",
                    hardDeny.get().kind() + ":" + hardDeny.get().reason());
            return false;
        }
        return userPrincipalOnly
                ? grantAuthorizationService.allowsUserOnly(request)
                : grantAuthorizationService.allows(request);
    }

    public boolean hasCurrentAgentToolCall(String userId, String workspaceId, String sessionId,
                                           String runId, String toolCallId,
                                           String toolName) {
        return grantAuthorizationService != null
                && grantAuthorizationService.hasCurrentAgentToolCall(
                        userId, workspaceId, sessionId, runId, toolCallId, toolName);
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

    // PLAN-290 M0.2: Gateway public set is the single source of truth
    // (packages/runtime/src/main.rs #[tool_router]). AUTO_ALLOW covers Gateway
    // read-only tools; web_fetch added per PLAN-290 §3.6-B minimal fix (was
    // Gateway-public but unregistered → fail-closed unknown deny).
    private static final Set<String> AUTO_ALLOW_TOOLS = Set.of(
        "read_file", "read_file_range", "list_directory", "glob", "grep",
        "get_file_info", "watch_directory", "extract_pdf_text",
        "read_command_output", "list_background_processes",
        "get_background_process", "web_fetch"
    );

    // PLAN-292 M2 (T2/T4): names aligned with container_runtime implementations
    // and the dead write_file_binary entry removed — it is not a Gateway tool, not
    // an Agent tool, and REST binary write does not travel through MCP policy.
    // apply_patch is Gateway-public and remains require_approval (PLAN-0328
    // T3.2); the legacy snapshot operations were retired in PLAN-0357.
    private static final Set<String> REQUIRE_APPROVAL_TOOLS = Set.of(
        "write_file", "edit_file", "delete_file",
        "delete_directory", "move_file", "copy_file", "mkdir",
        "execute_command", "start_background_process", "cancel_background_process",
        "apply_patch"
    );

    /** Package-private for contract tests (PLAN-290 M0.2); not a public API. */
    static Set<String> autoAllowTools() {
        return AUTO_ALLOW_TOOLS;
    }

    /** Package-private for contract tests (PLAN-290 M0.2); not a public API. */
    static Set<String> requireApprovalTools() {
        return REQUIRE_APPROVAL_TOOLS;
    }

    /**
     * Approval decision (PLAN-0407 T2.8, design #18/#19): after the grant gate, the action class
     * is either on the approval-policy ask list or it is not — no rule adjudication remains.
     * On-list asks under {@code manual} and auto-passes under {@code auto} (recorded as
     * {@code allowed_by}); off-list passes directly. Deny never comes from here: the grant gate
     * and the hard guard own it.
     */
    private PolicyVerdict approvalVerdict(ToolFaceRegistry.Face face, PolicyContext context,
                                          String effectiveMode, PolicyLayer modeLayer) {
        PolicyLayer source = context.askLayer();
        if (!context.askActionClasses().contains(face.actionClass())) {
            return PolicyVerdict.of(PolicyEffect.ALLOW, null, source, effectiveMode,
                    "action class not on the approval ask list");
        }
        if (LayeredPolicyResolver.MODE_AUTO.equals(effectiveMode)) {
            PolicyLayer bypassLayer = modeLayer == null ? PolicyLayer.BUILTIN : modeLayer;
            return PolicyVerdict.of(PolicyEffect.ASK, null, source, effectiveMode,
                    "action class on the approval ask list")
                    .allowedByMode(LayeredPolicyResolver.MODE_AUTO + "@" + bypassLayer);
        }
        return PolicyVerdict.of(PolicyEffect.ASK, null, source, effectiveMode,
                "action class on the approval ask list");
    }

    /**
     * Action class of one tool as resolved by the registry (built-ins + persisted faces), used by
     * the approval-grant path (PLAN-0328 M1 batch 4b) so grants cannot invent their own class.
     * Unclassified tools resolve to {@link PolicyLayer#UNCLASSIFIED_ACTION}.
     */
    public String actionClassOf(String toolName, String userId, String workspaceId) {
        return faceOf(toolName, userId, workspaceId).actionClass();
    }

    /**
     * Resolves the complete tool face from the same built-in and persisted registry used by policy
     * evaluation. Callers that need both the action class and shape must use this accessor rather
     * than maintaining a second tool classification map.
     */
    public ToolFaceRegistry.Face faceOf(String toolName, String userId, String workspaceId) {
        return faceOf(loadContext(userId, workspaceId, null), toolName);
    }

    /** Resolves a face from a context already loaded for the current decision. */
    public ToolFaceRegistry.Face faceOf(PolicyContext context, String toolName) {
        ToolFaceRegistry registry = context.extraFaces().isEmpty()
                ? builtinRegistry
                : new ToolFaceRegistry(context.extraFaces());
        return registry.faceOf(toolName);
    }

    /**
     * Rich evaluation used by the gate (spec §4.2 step 7): the verdict carries the effective layer
     * and matched rule for audit and UI. Persisted layers come from {@link PolicyContextProvider}.
     */
    public PolicyVerdict evaluateVerdict(String toolName, String body, String sessionId, String mode,
                                         String userId, String workspaceId) {
        return evaluateVerdict(contextProvider.load(userId, workspaceId, sessionId),
                toolName, body, sessionId, mode, userId, workspaceId);
    }

    /**
     * Evaluation against an already-loaded context (PLAN-0328 M1 propagation): callers that resolve
     * many requests in one batch load the context once instead of once per request.
     */
    public PolicyVerdict evaluateVerdict(PolicyContext context, String toolName, String body,
                                         String sessionId, String mode) {
        return evaluateVerdict(context, toolName, body, sessionId, mode, null, null);
    }

    /** Loads the policy context for one identity; callers may reuse it for a batch of verdicts. */
    public PolicyContext loadContext(String userId, String workspaceId, String sessionId) {
        return contextProvider.load(userId, workspaceId, sessionId);
    }

    public PolicyVerdict evaluateVerdict(PolicyContext context, String toolName, String body,
                                         String sessionId, String mode, String userId, String workspaceId) {
        if (toolName == null || toolName.isBlank()) {
            audit.record(sessionId, toolName, "policy_check", "deny_empty_tool");
            return PolicyVerdict.of(PolicyEffect.DENY, null, PolicyLayer.BUILTIN, mode, "tool name is required");
        }

        ToolFaceRegistry registry = context.extraFaces().isEmpty()
                ? builtinRegistry
                : new ToolFaceRegistry(context.extraFaces());

        ToolFaceRegistry.Face face = registry.faceOf(toolName);
        PolicyRequest request = new PolicyRequest(toolName, List.of(face.actionClass()),
                PolicyResourceExtractor.extract(body), face.shape(), userId, workspaceId, sessionId);

        var hardDeny = hardGuard.check(request);
        if (hardDeny.isPresent()) {
            audit.record(sessionId, toolName, "policy_hard_deny", hardDeny.get().kind() + ":" + hardDeny.get().reason());
            return PolicyVerdict.of(PolicyEffect.DENY, null, PolicyLayer.BUILTIN, mode,
                    "hard guard: " + hardDeny.get().reason());
        }

        // Explicit argument wins; otherwise the session/workspace mode applies.
        String effectiveMode = mode != null ? mode : context.mode();
        if (effectiveMode == null) {
            effectiveMode = LayeredPolicyResolver.MODE_MANUAL;
        }
        PolicyLayer modeLayer = mode != null ? PolicyLayer.BUILTIN
                : (context.modeLayer() == null ? PolicyLayer.BUILTIN : context.modeLayer());

        // An unclassified tool is deliberately visible to the approval workflow, but it can never
        // inherit an allow rule or a mode-based automatic allow. The approval grant writer still
        // rejects session/saved rule materialization until an owner/admin classifies the face.
        if (PolicyLayer.UNCLASSIFIED_ACTION.equals(face.actionClass())) {
            PolicyVerdict verdict = PolicyVerdict.of(PolicyEffect.ASK, null, PolicyLayer.BUILTIN,
                    effectiveMode, "unclassified tool requires explicit classification: " + toolName);
            audit.record(sessionId, toolName, "policy_check", "require_approval");
            audit.record(sessionId, toolName, "policy_verdict",
                    verdict.effect() + ":" + verdict.sourceLayer() + ":-");
            return verdict;
        }

        PolicyVerdict verdict = approvalVerdict(face, context, effectiveMode, modeLayer);

        String legacyDetail = verdict.effect() == PolicyEffect.ALLOW ? "auto_allow" : "require_approval";
        audit.record(sessionId, toolName, "policy_check", legacyDetail);
        audit.record(sessionId, toolName, "policy_verdict",
                verdict.effect() + ":" + verdict.sourceLayer() + ":" + (verdict.matchedRule() == null ? "-" : verdict.matchedRule()));
        if (verdict.allowedBy() != null) {
            audit.record(sessionId, toolName, "policy_allowed_by_mode", verdict.allowedBy());
        }
        return verdict;
    }
}
