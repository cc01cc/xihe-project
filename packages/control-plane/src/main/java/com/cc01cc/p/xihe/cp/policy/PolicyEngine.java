package com.cc01cc.p.xihe.cp.policy;

import java.util.LinkedHashSet;
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

    /** task-533: 声明键生产者；缺失时资源原样透传（旧行为逐字不变）。 */
    private FsResourceKeys fsResourceKeys;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    public void setFsResourceKeys(FsResourceKeys producer) {
        this.fsResourceKeys = producer;
    }

    /**
     * Q-d 第 2 步（task-533；请求侧补完见 task-81 / G-2）：把请求资源换成 {@code fs:} 声明键。
     *
     * <p>两种形态都收：①宿主绝对路径走 {@link FsResourceKeys#declarationKeyFor}；②<b>工作区相对
     * 路径</b>（工具实际收到的形态）走 {@link FsResourceKeys#declarationKeyForRelative}。相对形态
     * 只对 {@link HardGuard#workspaceFileTools()} 里的工具做：其它工具提取到的 {@code command}/
     * {@code url} 不是路径，硬转成 {@code fs:} 键会在「授予覆盖某前缀」时把拒绝变成允许。</p>
     *
     * <p>两种形态都换不出时原样保留 ⇒ 求交侧对非声明键返回拒绝（fail-closed），且
     * {@code HardGuard} 仍能看到原始 {@code ..} 并硬拒。</p>
     */
    private List<String> declarationResources(String toolName, String workspaceId,
                                              List<String> resources) {
        if (fsResourceKeys == null || resources == null || resources.isEmpty()) {
            return resources;
        }
        boolean relativeAllowed = HardGuard.workspaceFileTools().contains(toolName);
        return resources.stream()
                .map(resource -> declarationResource(workspaceId, resource, relativeAllowed))
                .toList();
    }

    private String declarationResource(String workspaceId, String resource, boolean relativeAllowed) {
        String declaration = fsResourceKeys.declarationKeyFor(workspaceId, resource);
        if (declaration == null && relativeAllowed) {
            declaration = fsResourceKeys.declarationKeyForRelative(workspaceId, resource);
        }
        return declaration == null ? resource : declaration;
    }

    /** Checks hard guard and current grants before the approval resolver is allowed to run. */
    public boolean allowsByGrant(PolicyContext context, String toolName, String body, String sessionId,
                                 String userId, String workspaceId, boolean userPrincipalOnly) {
        return allowsByGrant(context, toolName, body, sessionId, userId, workspaceId,
                userPrincipalOnly, List.of());
    }

    /**
     * task-870 / D-1921: {@code additionalResources} are appended to (never substituted for) the
     * resources extracted from the tool arguments. The MCP gateway passes {@code mcp:<serverId>}
     * here, so a gateway call is authorized only when the principal holds every
     * {@code (actionClass × resource)} pair — the object resource and the channel resource.
     */
    public boolean allowsByGrant(PolicyContext context, String toolName, String body, String sessionId,
                                 String userId, String workspaceId, boolean userPrincipalOnly,
                                 List<String> additionalResources) {
        return allowsByGrant(context, toolName, body, sessionId, userId, workspaceId,
                userPrincipalOnly, additionalResources, List.of());
    }

    /**
     * task-966 / D-1942: {@code additionalActionClasses} are appended to the face's own action
     * classes, the same "append, never substitute" shape as {@code additionalResources}. The
     * self-spawn arm passes {@code clone} here so {@code action:clone} is actually evaluated on
     * the spawn path; the human delegation arm passes nothing, because human presets do not carry
     * {@code clone} and requiring it there would deny every delegation.
     */
    public boolean allowsByGrant(PolicyContext context, String toolName, String body, String sessionId,
                                 String userId, String workspaceId, boolean userPrincipalOnly,
                                 List<String> additionalResources,
                                 List<String> additionalActionClasses) {
        if (grantAuthorizationService == null || context == null || toolName == null || toolName.isBlank()) {
            return false;
        }
        ToolFaceRegistry registry = context.extraFaces().isEmpty()
                ? builtinRegistry
                : new ToolFaceRegistry(context.extraFaces());
        ToolFaceRegistry.Face face = registry.faceOf(toolName);
        // DSD-1500 R1 (task-115): the request carries every domain the tool touches, not just the
        // face's primary class -- a delete must reach HardGuard as "delete", a move as both.
        PolicyRequest request = new PolicyRequest(toolName,
                mergeActionClasses(registry.actionClassesOf(toolName), additionalActionClasses),
                mergeResources(
                        declarationResources(toolName, workspaceId, PolicyResourceExtractor.extract(body)),
                        additionalResources),
                face.shape(), userId, workspaceId, sessionId);
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

    /**
     * task-870: a single {@code (actionClass × resource)} probe used by {@code tools/list}
     * visibility filtering. It deliberately shares the request/guard path with
     * {@link #allowsByGrant} instead of growing a second visibility matrix.
     */
    public boolean allowsResource(PolicyContext context, String actionClass, String resource,
                                  String sessionId, String userId, String workspaceId,
                                  boolean userPrincipalOnly) {
        if (grantAuthorizationService == null || context == null
                || actionClass == null || actionClass.isBlank()
                || resource == null || resource.isBlank()) {
            return false;
        }
        PolicyRequest request = new PolicyRequest("tools/list", List.of(actionClass),
                List.of(resource), ToolShape.STRUCTURED, userId, workspaceId, sessionId);
        var hardDeny = hardGuard.checkWorkspaceResources(request.tool(), request.resources())
                .or(() -> hardGuard.check(request));
        if (hardDeny.isPresent()) {
            audit.record(sessionId, request.tool(), "policy_hard_deny",
                    hardDeny.get().kind() + ":" + hardDeny.get().reason());
            return false;
        }
        return userPrincipalOnly
                ? grantAuthorizationService.allowsUserOnly(request)
                : grantAuthorizationService.allows(request);
    }

    /** Appends extra resources without dropping or replacing any extracted resource. */
    private static List<String> mergeResources(List<String> extracted, List<String> additional) {
        if (additional == null || additional.isEmpty()) {
            return extracted;
        }
        LinkedHashSet<String> merged = new LinkedHashSet<>(extracted);
        merged.addAll(additional);
        return List.copyOf(merged);
    }

    /** task-966: appends extra action classes without dropping the face's own classes. */
    private static List<String> mergeActionClasses(List<String> declared, List<String> additional) {
        if (additional == null || additional.isEmpty()) {
            return declared;
        }
        LinkedHashSet<String> merged = new LinkedHashSet<>(declared);
        merged.addAll(additional);
        return List.copyOf(merged);
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
                                          String effectiveMode, PolicyLayer modeLayer,
                                          List<String> resources) {
        PolicyLayer source = context.askLayer();
        if (!context.askActionClasses().contains(face.actionClass())) {
            return PolicyVerdict.of(PolicyEffect.ALLOW, null, source, effectiveMode,
                    "action class not on the approval ask list");
        }
        if (LayeredPolicyResolver.MODE_AUTO.equals(effectiveMode)) {
            PolicyLayer bypassLayer = modeLayer == null ? PolicyLayer.BUILTIN : modeLayer;
            // task-859: the ask names the request's resource too, so the eventual decision is
            // (action:approve, that resource) instead of the action class alone.
            return PolicyVerdict.of(PolicyEffect.ASK, null, source, effectiveMode,
                    "action class on the approval ask list", resources)
                    .allowedByMode(LayeredPolicyResolver.MODE_AUTO + "@" + bypassLayer);
        }
        return PolicyVerdict.of(PolicyEffect.ASK, null, source, effectiveMode,
                "action class on the approval ask list", resources);
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
        return evaluateVerdict(context, toolName, body, sessionId, mode, userId, workspaceId,
                List.of());
    }

    /**
     * task-870: the verdict twin of the four-argument-plus overload above. The gate
     * ({@link #allowsByGrant}) is the decisive check; passing the same extra resources here keeps
     * the protected-file / approval surfaces reading one resource list.
     */
    public PolicyVerdict evaluateVerdict(PolicyContext context, String toolName, String body,
                                         String sessionId, String mode, String userId,
                                         String workspaceId, List<String> additionalResources) {
        if (toolName == null || toolName.isBlank()) {
            audit.record(sessionId, toolName, "policy_check", "deny_empty_tool");
            return PolicyVerdict.of(PolicyEffect.DENY, null, PolicyLayer.BUILTIN, mode, "tool name is required");
        }

        ToolFaceRegistry registry = context.extraFaces().isEmpty()
                ? builtinRegistry
                : new ToolFaceRegistry(context.extraFaces());

        ToolFaceRegistry.Face face = registry.faceOf(toolName);
        PolicyRequest request = new PolicyRequest(toolName, registry.actionClassesOf(toolName),
                mergeResources(
                        declarationResources(toolName, workspaceId, PolicyResourceExtractor.extract(body)),
                        additionalResources),
                face.shape(), userId, workspaceId, sessionId);

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
            recordTierAudit(sessionId, toolName, context);
            return verdict;
        }

        PolicyVerdict verdict = approvalVerdict(face, context, effectiveMode, modeLayer,
                request.resources());

        // task-993 (verdict-989 option B): browser control is interactive, not a read. It must
        // never inherit an automatic allow — not from the ask list, and not from `auto` mode's
        // "allowed_by" bypass. Rebuild the verdict as a plain ASK so the approval writer cannot
        // materialize a session/saved rule from this call either.
        if (ToolFaceRegistry.isBrowserTool(toolName) && verdict.effect() != PolicyEffect.DENY) {
            verdict = PolicyVerdict.of(PolicyEffect.ASK, null, PolicyLayer.BUILTIN, effectiveMode,
                    "browser control always requires approval", request.resources());
        }

        // PLAN-0627 D27-20 (Q2 = C′): path-conditional tier for protected files, expressed
        // with the existing vocabulary instead of a new enum:
        //   deny  -> owned upstream by the grant gate + hard guard (this branch never denies);
        //   ask   -> default for a mutation of a protected file name (AGENTS.md), and
        //            `auto` mode deliberately does NOT bypass it;
        //   allow -> every other path keeps its existing verdict. A "trusted editor"
        //            principal is expressed as an ordinary `write` grant scoped to
        //            `**/AGENTS.md`; the grant gate already evaluated it, and the write still
        //            asks here (D27-20 ③: the dedicated principal remains approval-gated).
        // The browser write path (WorkspaceFileController -> Runtime) never runs this engine,
        // so a user editing their own AGENTS.md in the UI is unaffected by this branch.
        // task-115: the mutation vocabulary is write OR delete -- reclassifying the delete tools
        // must not open a quieter path to AGENTS.md (delete AGENTS.md asks exactly like rewriting
        // it; the hard guard still owns .git-style paths upstream).
        if (verdict.effect() == PolicyEffect.ALLOW
                && ToolFaceRegistry.isMutationActionClass(face.actionClass())
                && ToolFaceRegistry.mutatesProtectedFile(request.resources())) {
            verdict = PolicyVerdict.of(PolicyEffect.ASK, null, PolicyLayer.BUILTIN, effectiveMode,
                    "protected file requires approval: " + ToolFaceRegistry.PROTECTED_WRITE_FILENAMES,
                    request.resources());
        }

        String legacyDetail = verdict.effect() == PolicyEffect.ALLOW ? "auto_allow" : "require_approval";
        audit.record(sessionId, toolName, "policy_check", legacyDetail);
        audit.record(sessionId, toolName, "policy_verdict",
                verdict.effect() + ":" + verdict.sourceLayer() + ":" + (verdict.matchedRule() == null ? "-" : verdict.matchedRule()));
        if (verdict.allowedBy() != null) {
            audit.record(sessionId, toolName, "policy_allowed_by_mode", verdict.allowedBy());
        }
        recordTierAudit(sessionId, toolName, context);
        return verdict;
    }

    /**
     * Records the effective permission tier and its source layer next to the verdict (D-1908 §6,
     * task-107). A non-null fallback means the tier is the fail-closed value, not an inherited one —
     * operators must be able to see that difference instead of reading a silent fallback as a normal
     * workspace setting.
     */
    private void recordTierAudit(String sessionId, String toolName, PolicyContext context) {
        if (context.tier() != null) {
            audit.record(sessionId, toolName, "policy_tier",
                    "tier=" + context.tier() + ":layer="
                            + (context.tierSourceLayer() == null ? "-" : context.tierSourceLayer()));
        }
        if (context.tierFallback() != null) {
            audit.record(sessionId, toolName, "policy_tier_fallback", context.tierFallback());
        }
    }
}
