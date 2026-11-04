package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.auth.AuthService;
import com.cc01cc.p.xihe.cp.auth.NameFormat;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.policy.RequesterAuthority;
import com.cc01cc.p.xihe.cp.policy.ContextPolicyValidator;
import com.cc01cc.p.xihe.cp.policy.DelegationPolicyValidator;
import com.cc01cc.p.xihe.cp.policy.PolicyRequest;
import com.cc01cc.p.xihe.cp.policy.RoleGrantMaterializer;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.policy.ToolShape;
import com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator;
import com.cc01cc.p.xihe.cp.policy.GrantPrincipalPathResolver;
import com.cc01cc.p.xihe.cp.policy.HookAdvisorRegistry;
import com.cc01cc.p.xihe.cp.policy.PermissionAtomCatalog;
import com.cc01cc.p.xihe.cp.policy.GrantSources;
import com.cc01cc.p.xihe.cp.policy.GrantDefaultService;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * Lifecycle writes for stable Agent principals and Workspace-local permission caps.
 *
 * <p>PLAN-0470 #22: User/Workspace identity reads go through the Auth and
 * Workspace narrow entries; the agent-principal default grant write is owned
 * by Policy ({@link GrantDefaultService#createAgentPrincipalGrant}). Direct
 * User/Workspace/Grant-repository access (not the retired workspace_users table, dropped by V89) is limited to this
 * service's own AgentPrincipal/WorkspaceAgent tables plus the Policy grant
 * <em>reads</em> used for permission ceilings (reads stay until a dedicated
 * Policy query seam is approved).
 */
@Service
public class AgentPrincipalService {

    /** PLAN-0622: the three sharing tiers (frozen wire vocabulary). */
    public static final String SCOPE_PERSONAL = "PERSONAL";
    public static final String SCOPE_WORKSPACE = "WORKSPACE";
    public static final String SCOPE_INSTANCE = "INSTANCE";
    /**
     * PLAN-0629 (user ruling 2026-11-04): the default role an agent principal is bound to when a
     * workspace binding is created without an explicit role set. `WS_EDITOR` is the seeded workspace
     * role that keeps a fresh agent usable (read/write/delete/exec) without handing out management.
     */
    private static final String DEFAULT_AGENT_WORKSPACE_ROLE = "WS_EDITOR";
    /** PLAN-0629: the instance-scope role a fresh principal is bound to (no frozen ceiling anymore). */
    private static final String DEFAULT_AGENT_INSTANCE_ROLE = "USER";

    private final AgentPrincipalRepository agentPrincipalRepository;
    private final AuthorizationGrantRepository grantRepository;
    private final AuthService authService;
    private final WorkspaceService workspaceService;
    private final GrantDefaultService grantDefaultService;
    private final WorkspaceAgentRepository workspaceAgentRepository;
    private final GrantIntersectionEvaluator evaluator;
    private final AuditLogger auditLogger;
    private final ObjectMapper objectMapper;
    private final AgentTemplateService agentTemplateService;
    private final AuthzContext authzContext;
    /** PLAN-0651 T1.4 (A21/A22): the instance-administrator bypass is an action atom (N1). */
    private final RequesterAuthority requesterAuthority;
    /** PLAN-0629: roles are the permission source, so bindings and materialization live here. */
    private final AccessRoleBindingRepository roleBindingRepository;
    private final AccessRoleRepository roleRepository;
    private final AccessRolePermissionRepository rolePermissionRepository;
    private final RoleGrantMaterializer roleMaterializer;

    public AgentPrincipalService(AgentPrincipalRepository agentPrincipalRepository,
                                 AuthorizationGrantRepository grantRepository,
                                 AuthService authService,
                                 WorkspaceService workspaceService,
                                 GrantDefaultService grantDefaultService,
                                 WorkspaceAgentRepository workspaceAgentRepository,
                                 GrantIntersectionEvaluator evaluator,
                                 AuditLogger auditLogger,
                                 ObjectMapper objectMapper,
                                 AgentTemplateService agentTemplateService,
                                 AuthzContext authzContext,
                                 AccessRoleBindingRepository roleBindingRepository,
                                 AccessRoleRepository roleRepository,
                                 AccessRolePermissionRepository rolePermissionRepository,
                                 RoleGrantMaterializer roleMaterializer,
                                 RequesterAuthority requesterAuthority) {
        this.agentPrincipalRepository = agentPrincipalRepository;
        this.grantRepository = grantRepository;
        this.authService = authService;
        this.workspaceService = workspaceService;
        this.grantDefaultService = grantDefaultService;
        this.workspaceAgentRepository = workspaceAgentRepository;
        this.evaluator = evaluator;
        this.auditLogger = auditLogger;
        this.objectMapper = objectMapper;
        this.agentTemplateService = agentTemplateService;
        this.authzContext = authzContext;
        this.roleBindingRepository = roleBindingRepository;
        this.roleRepository = roleRepository;
        this.rolePermissionRepository = rolePermissionRepository;
        this.roleMaterializer = roleMaterializer;
        this.requesterAuthority = requesterAuthority;
    }
    /** Authorizes, resolves a caller-readable snapshot, and creates a principal atomically. */
    @Transactional
    /**
     * PLAN-0622 M1.1: creation is one of three tiers, and each tier has its **own** action atom
     * (D8: never alias-merged).
     *
     * <ul>
     *   <li>{@code PERSONAL} — user tier, {@code CREATE_OWN_AGENT}; the owner is always the caller
     *       (the frozen body has no {@code ownerUserId}, so an admin can never mint one "for
     *       somebody else");</li>
     *   <li>{@code WORKSPACE} — workspace tier, {@code MANAGE_WORKSPACE_AGENTS} for the request
     *       workspace; without a workspace context this fails explicitly with
     *       {@code 409 WORKSPACE_CONTEXT_REQUIRED} instead of guessing;</li>
     *   <li>{@code INSTANCE} — instance tier, {@code CREATE_ACCOUNT}.</li>
     * </ul>
     *
     * <p>An omitted {@code scope} keeps the pre-0622 behaviour: instance-wide creation when the
     * caller has no workspace context, workspace-tier creation when it does. The wire contract
     * documents {@code WORKSPACE} as the DB default, but the historical callers (UI before M3,
     * e2e helpers) create principals with an instance token and no scope field.</p>
     */
    public AgentPrincipal createPrincipalFromTemplate(String actorUserId, String name, String templateId,
                                                      String requestedScope, String defaultModelProvider,
                                                      String defaultModelName, JsonNode allowedModels) {
        return createPrincipalFromTemplate(actorUserId, name, templateId, requestedScope,
                defaultModelProvider, defaultModelName, allowedModels, null,
                AgentPrincipal.ORIGIN_USER, null);
    }

    /** PLAN-0625 M2: caller-supplied subscriptions; provenance still derives from the template. */
    public AgentPrincipal createPrincipalFromTemplate(String actorUserId, String name, String templateId,
                                                      String requestedScope, String defaultModelProvider,
                                                      String defaultModelName, JsonNode allowedModels, JsonNode hooks) {
        return createPrincipalFromTemplate(actorUserId, name, templateId, requestedScope,
                defaultModelProvider, defaultModelName, allowedModels, hooks,
                AgentPrincipal.ORIGIN_USER, null);
    }

    public AgentPrincipal createPrincipalFromTemplate(String actorUserId, String name, String templateId,
                                                      String requestedScope, String defaultModelProvider,
                                                      String defaultModelName, JsonNode allowedModels, JsonNode hooks,
                                                      String origin, String presetId) {
        return createPrincipalFromTemplate(actorUserId, name, templateId, requestedScope,
                defaultModelProvider, defaultModelName, allowedModels, hooks, origin, presetId, null);
    }

    /**
     * PLAN-0629 task-12: the same create, plus the roles the new principal is bound to.
     *
     * <p>{@code roleIds} is the only permission input now — a null/empty list means "use the default
     * role", i.e. the instance-scope {@code USER} role here and {@code WS_EDITOR} when the principal
     * is bound to a workspace later. Every id is validated once, before the row is written
     * ({@code 403 ROLE_NOT_GRANTABLE} on failure), and the binding goes through the existing
     * materializer so there is exactly one write path.</p>
     */
    public AgentPrincipal createPrincipalFromTemplate(String actorUserId, String name, String templateId,
                                                      String requestedScope, String defaultModelProvider,
                                                      String defaultModelName, JsonNode allowedModels, JsonNode hooks,
                                                      String origin, String presetId,
                                                      List<UUID> roleIds) {
        UUID actorId = parseUuid(actorUserId, "INVALID_ACTOR");
        requireUser(actorId);
        UUID workspaceContext = currentWorkspaceContext();
        String scope = resolveCreationScope(requestedScope);
        requireCreationAction(actorId, scope, workspaceContext);
        AgentTemplateService.ResolvedTemplate resolved = agentTemplateService.resolveForCreation(
                actorUserId, null, templateId);
        String resolvedTemplateId = optionalText(resolved.snapshot(), "templateId");
        // PLAN-0625 task-92 (D25-09): creating from the builtin preset template is what makes a row a
        // preset guard (origin + preset_id), and the template's own hooks document is the DEFAULT
        // subscription — the caller may override it per request.
        boolean builtinPreset = "instance".equals(resolved.sourceLayer())
                && AgentPrincipal.BUILTIN_GUARD_PRESET_TEMPLATE_ID.equals(resolvedTemplateId);
        JsonNode templateHooks = resolved.snapshot().path("hooks");
        JsonNode effectiveHooks = hooks != null ? hooks
                : (templateHooks.isMissingNode() || templateHooks.isNull()) ? null : templateHooks.deepCopy();
        return createPrincipal(actorUserId, name, resolvedTemplateId, resolved.snapshot(), scope,
                "PERSONAL".equals(scope) ? actorId : null,
                defaultModelProvider, defaultModelName, allowedModels, effectiveHooks,
                builtinPreset ? AgentPrincipal.ORIGIN_SYSTEM_PRESET
                        : (origin == null || origin.isBlank() ? AgentPrincipal.ORIGIN_USER : origin),
                builtinPreset ? resolvedTemplateId : presetId, roleIds);
    }

    /** Legacy signature kept for the pre-0622 callers; same semantics as an omitted scope. */
    public AgentPrincipal createPrincipalFromTemplate(String actorUserId, String name, String templateId) {
        return createPrincipalFromTemplate(actorUserId, name, templateId, null, null, null, null);
    }

    /**
     * Omitted {@code scope} resolves to {@code WORKSPACE} — the same default M0's migration applied
     * to every pre-existing row (V90 backfill). The legacy authorization (CREATE_ACCOUNT) is kept
     * separately in {@link #requireCreationAction} so a pre-0622 caller keeps its old gate.
     */
    private String resolveCreationScope(String requestedScope) {
        if (requestedScope == null || requestedScope.isBlank()) {
            return SCOPE_WORKSPACE;
        }
        String normalized = requestedScope.trim().toUpperCase(java.util.Locale.ROOT);
        if (!SCOPE_PERSONAL.equals(normalized) && !SCOPE_WORKSPACE.equals(normalized)
                && !SCOPE_INSTANCE.equals(normalized)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_AGENT_SCOPE",
                    "scope must be one of PERSONAL, WORKSPACE, INSTANCE");
        }
        return normalized;
    }

    /**
     * D21 (Lead ruling 2026-11-02): an omitted {@code scope} is the WORKSPACE tier and takes the
     * <b>same</b> authorization path as an explicit {@code scope=WORKSPACE}. There is deliberately no
     * second, legacy {@code CREATE_ACCOUNT} path: one tier, one authority.
     */
    private void requireCreationAction(UUID actorId, String scope, UUID workspaceContext) {
        if (SCOPE_PERSONAL.equals(scope)) {
            requireUserAction(actorId, ToolFaceRegistry.ACTION_OWN_AGENT, "*", null);
            return;
        }
        if (SCOPE_WORKSPACE.equals(scope)) {
            if (workspaceContext == null) {
                // Never guess a workspace: an ambiguous create would land in the wrong tenant.
                // The status distinguishes "you may create in some workspace but did not name one"
                // (409, actionable: send X-Workspace-Id) from "you have no workspace-tier authority
                // at all" (403) — the capability projection decides, never an unscoped grant read.
                AuthzContext.Capabilities capabilities = authzContext.capabilitiesFor(actorId);
                boolean adminsSomeWorkspace = capabilities.workspaceAdminAll()
                        || !capabilities.workspaceAdminWorkspaces().isEmpty();
                throw new CpApiException(
                        adminsSomeWorkspace ? HttpStatus.CONFLICT : HttpStatus.FORBIDDEN,
                        adminsSomeWorkspace ? "WORKSPACE_CONTEXT_REQUIRED" : "FORBIDDEN",
                        adminsSomeWorkspace
                                ? "Creating a WORKSPACE-scope agent principal requires a workspace context"
                                : ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS
                                        + " permission is required");
            }
            requireUserAction(actorId, ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS,
                    workspaceContext.toString(), workspaceContext);
            return;
        }
        requireUserAction(actorId, ToolFaceRegistry.ACTION_CREATE_ACCOUNT, "*", null);
    }

    /**
     * The workspace context of this request, or {@code null} when the caller only has the implicit
     * "first active membership" fallback.
     *
     * <p>{@code TenantContextInterceptor} resolves header → legacy token claim → first active
     * membership ({@code workspaceSource=default}). The last one is a convenience for reads; a
     * WORKSPACE-scope <b>write</b> must be explicit, otherwise a create lands in whichever workspace
     * happens to be first (test: {@code workspaceScopeNeedsWorkspaceContext...}).</p>
     */
    private UUID currentWorkspaceContext() {
        String workspaceId = TenantContext.getWorkspaceId();
        if (workspaceId == null || workspaceId.isBlank()) {
            return null;
        }
        String source = TenantContext.getWorkspaceSource();
        if (source == null || "default".equals(source)) {
            return null;
        }
        return parseUuid(workspaceId, "INVALID_WORKSPACE_CONTEXT");
    }

    /**
     * PLAN-0622 §2: the principal declares a model <b>intent</b> ({@code provider + model}) plus an
     * optional allow-list; it never holds a connection. Provider and model are both-or-neither and
     * every allow-list entry needs both halves — a half-filled intent would silently fall back to
     * the workspace default, which is exactly the ambiguity this contract removes.
     */
    private JsonNode normalizeModelIntent(String provider, String model, JsonNode allowedModels) {
        String normalizedProvider = provider == null || provider.isBlank() ? null : provider.trim();
        String normalizedModel = model == null || model.isBlank() ? null : model.trim();
        if ((normalizedProvider == null) != (normalizedModel == null)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_AGENT_PRINCIPAL",
                    "defaultModelProvider and defaultModelName must be set together");
        }
        if (allowedModels == null || allowedModels.isNull()) {
            return null;
        }
        if (!allowedModels.isArray()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_AGENT_PRINCIPAL",
                    "allowedModels must be an array of {provider, model}");
        }
        ArrayNode normalized = objectMapper.createArrayNode();
        for (JsonNode entry : allowedModels) {
            String entryProvider = optionalText(entry, "provider");
            String entryModel = optionalText(entry, "model");
            if (entryProvider == null || entryModel == null) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_AGENT_PRINCIPAL",
                        "Every allowedModels entry needs both provider and model");
            }
            ObjectNode node = objectMapper.createObjectNode();
            node.put("provider", entryProvider.trim());
            node.put("model", entryModel.trim());
            normalized.add(node);
        }
        return normalized.isEmpty() ? null : normalized;
    }

    /**
     * Returns only the selected Agent's model instructions. Principal IDs,
     * permission atoms, and the full template snapshot remain CP-owned.
     */
    @Transactional(readOnly = true)
    public String resolveSystemInstructionsForRun(String principalId) {
        UUID id = parseUuid(principalId, "INVALID_AGENT_PRINCIPAL");
        AgentPrincipal principal = agentPrincipalRepository.findById(id)
                .orElseThrow(() -> new CpApiException(
                        HttpStatus.NOT_FOUND, "AGENT_PRINCIPAL_NOT_FOUND", "Agent principal not found"));
        JsonNode snapshot = principal.getTemplateSnapshot();
        JsonNode instructions = snapshot == null ? null : snapshot.get("systemPrompt");
        return instructions != null && instructions.isTextual() && !instructions.asText().isBlank()
                ? instructions.asText() : null;
    }

    /**
     * The caller authorizes CREATE_ACCOUNT and supplies a server-resolved immutable template
     * snapshot. The tier defaults to {@code WORKSPACE} (M0's backfill default); a caller that wants
     * an INSTANCE principal passes the scope through {@link #createPrincipalFromTemplate}.
     */
    @Transactional
    public AgentPrincipal createPrincipal(String actorUserId, String name, String templateId,
                                          JsonNode templateSnapshot) {
        return createPrincipal(actorUserId, name, templateId, templateSnapshot, SCOPE_WORKSPACE, null,
                null, null, null);
    }

    /**
     * PLAN-0622 M1.1: the tier, the owner and the model intent are decided by
     * {@link #createPrincipalFromTemplate} (authorization) and written here; this method only
     * enforces the invariants that must hold for **every** write path.
     */
    @Transactional
    public AgentPrincipal createPrincipal(String actorUserId, String name, String templateId,
                                          JsonNode templateSnapshot, String scope, UUID ownerUserId,
                                          String defaultModelProvider, String defaultModelName,
                                          JsonNode allowedModels) {
        return createPrincipal(actorUserId, name, templateId, templateSnapshot, scope, ownerUserId,
                defaultModelProvider, defaultModelName, allowedModels, null);
    }

    /** PLAN-0625 M2: hooks variant — validation happens in this one write-side gate. */
    public AgentPrincipal createPrincipal(String actorUserId, String name, String templateId,
                                          JsonNode templateSnapshot, String scope, UUID ownerUserId,
                                          String defaultModelProvider, String defaultModelName,
                                          JsonNode allowedModels, JsonNode hooks) {
        return createPrincipal(actorUserId, name, templateId, templateSnapshot, scope, ownerUserId,
                defaultModelProvider, defaultModelName, allowedModels, hooks,
                AgentPrincipal.ORIGIN_USER, null);
    }

    /**
     * PLAN-0625 task-92: the full write path carries template provenance — {@code origin} +
     * {@code presetId} come from the resolved template (builtin preset ⇒ SYSTEM_PRESET + preset_id,
     * everything else USER + null), matching the V95 CHECK contract.
     */
    public AgentPrincipal createPrincipal(String actorUserId, String name, String templateId,
                                          JsonNode templateSnapshot, String scope, UUID ownerUserId,
                                          String defaultModelProvider, String defaultModelName,
                                          JsonNode allowedModels, JsonNode hooks,
                                          String origin, String presetId) {
        return createPrincipal(actorUserId, name, templateId, templateSnapshot, scope, ownerUserId,
                defaultModelProvider, defaultModelName, allowedModels, hooks, origin, presetId, null);
    }

    /**
     * PLAN-0629 task-12 core: {@code roleIds} is validated once up front and then bound through
     * {@link #bindInstanceRoles}, i.e. the only permission source this method has.
     */
    public AgentPrincipal createPrincipal(String actorUserId, String name, String templateId,
                                          JsonNode templateSnapshot, String scope, UUID ownerUserId,
                                          String defaultModelProvider, String defaultModelName,
                                          JsonNode allowedModels, JsonNode hooks,
                                          String origin, String presetId, List<UUID> roleIds) {
        JsonNode checkedHooks = HookAdvisorRegistry.validateSubscriptions(hooks);
        UUID actorId = parseUuid(actorUserId, "INVALID_ACTOR");
        if (!authService.userExists(actorId)) {
            throw new CpApiException(
                    HttpStatus.NOT_FOUND, "USER_NOT_FOUND", "Agent principal creator was not found");
        }
        if (name == null || name.isBlank() || templateSnapshot == null || !templateSnapshot.isObject()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_AGENT_PRINCIPAL",
                    "A name and server-resolved template snapshot are required");
        }
        // 用户 2026-11-03 裁定：主体名只允许 字母/汉字/数字 且不得数字开头、不得含空格与符号。
        NameFormat.require(name, "name");
        if (!java.util.Objects.equals(templateId, optionalText(templateSnapshot, "templateId"))) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_TEMPLATE_SNAPSHOT",
                    "Template ID does not match the frozen snapshot");
        }
        String resolvedScope = scope == null || scope.isBlank() ? SCOPE_WORKSPACE : scope;
        // Invariant mirror of ck_agent_principals_owner: PERSONAL owns exactly one human, every
        // other tier owns nobody. The DB constraint is the backstop, not the only guard.
        if (SCOPE_PERSONAL.equals(resolvedScope) && ownerUserId == null) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_AGENT_PRINCIPAL",
                    "A PERSONAL agent principal requires an owner");
        }
        if (!SCOPE_PERSONAL.equals(resolvedScope) && ownerUserId != null) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_AGENT_PRINCIPAL",
                    "Only PERSONAL agent principals carry an owner");
        }
        JsonNode modelIntent = normalizeModelIntent(defaultModelProvider, defaultModelName, allowedModels);

        Set<GrantIntersectionEvaluator.PermissionAtom> templatePermissions =
                parsePermissions(templateSnapshot.get("permissions"));
        Set<GrantIntersectionEvaluator.PermissionAtom> creatorPermissions = evaluator.union(
                grantRepository.findBySubjectTypeAndSubjectId(GrantPrincipalPathResolver.USER, actorId));
        // PLAN-0496 #2: credential atoms are reported explicitly instead of being
        // silently narrowed (422 lists the uncovered ids); other atoms keep narrowing.
        List<String> uncoveredCredentialAtoms =
                uncoveredCredentialAtoms(templatePermissions, creatorPermissions);
        if (!uncoveredCredentialAtoms.isEmpty()) {
            throw new CpApiException(HttpStatus.UNPROCESSABLE_ENTITY, "CREDENTIAL_ATOMS_NOT_COVERED",
                    "Credential atoms are not covered by the creator's permissions: "
                            + String.join(", ", uncoveredCredentialAtoms));
        }
        // LEGACY-ONLY（2026-11-04 裁定「role 行是唯一权威源」）：这里算出的 template 交集**不再落库**
        // —— createAgentPrincipalGrant 的 snapshot 写在 PLAN-0629 已删除，老库残留的
        // template/agent_default 行只在"主体还没有 source='role' 行"时作为回退被求值。
        // 新增能力请走角色原子；反向契约见
        // AgentPrincipalCredentialBoundaryTest#legacySnapshotAtomDoesNotAuthorizeAWorkspaceCap。
        Set<GrantIntersectionEvaluator.PermissionAtom> effectivePermissions =
                retainCovered(templatePermissions, creatorPermissions);
        ArrayNode grantPermissions = toJson(effectivePermissions);

        // PLAN-0629 task-12: the one-time grant check for exactly the roles the caller asked for.
        // It runs before any row is written, so a refusal leaves no half-created principal.
        validateGrantableRoles(actorId, roleIds);

        AgentPrincipal principal = new AgentPrincipal();
        principal.setName(name.trim());
        principal.setTemplateId(templateId);
        principal.setTemplateSnapshot(templateSnapshot.deepCopy());
        principal.setCreatedByUserId(actorId.toString());
        principal.setScope(resolvedScope);
        principal.setOwnerUserId(ownerUserId);
        principal.setDefaultModelProvider(defaultModelProvider);
        principal.setDefaultModelName(defaultModelName);
        principal.setAllowedModels(modelIntent);
        // PLAN-0625 M2: the runtime subscription surface (templates stay the declaration source).
        principal.setHooks(checkedHooks);
        // PLAN-0625 task-92: template provenance — the builtin preset template makes the row a
        // preset guard (SYSTEM_PRESET + preset_id); everything else stays a USER principal.
        principal.setOrigin(origin == null || origin.isBlank() ? AgentPrincipal.ORIGIN_USER : origin);
        principal.setPresetId(presetId);
        AgentPrincipal savedPrincipal = agentPrincipalRepository.saveAndFlush(principal);

        // PLAN-0629 (user ruling 2026-11-04, option A): the frozen ceiling is retired. Permissions of
        // an agent principal come from bound roles only — "the creator's rights at creation time" is
        // exactly the ownership coupling the ruling removed. The old `createAgentPrincipalGrant`
        // snapshot write is intentionally gone; rows already in the database are left untouched
        // (deprecated, kept for rollback) and evaluation falls back to them only while a subject has
        // no `source='role'` rows yet.
        //
        // Accepted risk, on purpose: if the creator is demoted later, roles they granted keep working.
        // That is the point of the ruling — a role is an independent object; to revoke, edit the role
        // or unbind it. Do not "fix" this by re-checking the creator later: that would reintroduce
        // the ownership coupling. The one-time authority check happened above (the action atom that
        // authorized this create), and it is the only creator-scoped check.
        bindInstanceRoles(savedPrincipal.getId(), actorId, roleIds);

        ObjectNode detail = objectMapper.createObjectNode();
        // PLAN-0622 M1.1: the audit record carries the tier (checklist risk #7) and the action that
        // authorized it, so a reviewer can tell a PERSONAL create from an INSTANCE one.
        detail.put("authorizationAction", switch (resolvedScope) {
            case SCOPE_PERSONAL -> ToolFaceRegistry.ACTION_OWN_AGENT;
            case SCOPE_WORKSPACE -> ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS;
            default -> ToolFaceRegistry.ACTION_CREATE_ACCOUNT;
        });
        detail.put("scope", resolvedScope);
        if (templateId != null) {
            detail.put("templateId", templateId);
        }
        detail.set("permissions", grantPermissions.deepCopy());
        auditLogger.recordDurableChange(actorId.toString(), null,
                "agent_principal_created", "agent_principal", savedPrincipal.getId().toString(), detail.toString());
        return savedPrincipal;
    }

    /** The caller authorizes MANAGE_WORKSPACE_AGENTS; this service enforces membership and permission ceilings. */
    @Transactional
    public WorkspaceAgent setWorkspaceCap(String actorUserId, UUID workspaceId, UUID principalId,
                                          JsonNode requestedPermissions) {
        UUID actorId = parseUuid(actorUserId, "INVALID_ACTOR");
        requireUser(actorId);
        workspaceService.requireActiveWorkspace(workspaceId.toString());
        requireWorkspaceMember(actorId, workspaceId);
        AgentPrincipal principal = requireActivePrincipal(principalId);
        // D25-02: a preset guard cap is fixed at the input side — the write side refuses.
        // Placed before the management check: the immutability is a property of the
        // TARGET principal, not of the actor's rights (origin is already member-visible).
        // resolveCapFor stays the single entry, untouched.
        requireMutableCap(principal);
        requireWorkspaceAgentManagement(actorId, workspaceId);
        requireBindingAuthorityForScope(actorId, principal);

        Set<GrantIntersectionEvaluator.PermissionAtom> cap = parsePermissions(requestedPermissions);
        Set<GrantIntersectionEvaluator.PermissionAtom> principalPermissions = evaluator.union(
                grantRepository.findBySubjectTypeAndSubjectId(
                        GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId));
        Set<GrantIntersectionEvaluator.PermissionAtom> actorPermissions = evaluator.union(
                grantRepository.findBySubjectTypeAndSubjectId(GrantPrincipalPathResolver.USER, actorId));
        if (!isSubset(cap, principalPermissions) || !isSubset(cap, actorPermissions)) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "AGENT_PERMISSION_SCOPE_EXCEEDED",
                    "Workspace cap exceeds current principal or operator permissions");
        }

        WorkspaceAgentId bindingId = new WorkspaceAgentId(principalId, workspaceId);
        WorkspaceAgent binding = workspaceAgentRepository.findById(bindingId).orElse(null);
        boolean created = binding == null;
        Set<GrantIntersectionEvaluator.PermissionAtom> previous = Set.of();
        if (created) {
            binding = new WorkspaceAgent(principalId.toString(), workspaceId.toString(), toJson(cap));
        } else {
            previous = parsePermissions(binding.getPermissionsSnapshot());
            if (previous.equals(cap)) {
                return binding;
            }
            binding.setPermissionsSnapshot(toJson(cap));
        }

        WorkspaceAgent savedBinding = workspaceAgentRepository.saveAndFlush(binding);
        // PLAN-0629: a binding materializes into a workspace role binding, so reachability has one
        // source of truth. Idempotent; the existing materializer writes the `source='role'` grants.
        ensureWorkspaceRoleBinding(principalId, workspaceId, actorId);
        ObjectNode detail = objectMapper.createObjectNode();
        detail.put("authorizationAction", "MANAGE_WORKSPACE_AGENTS");
        detail.put("principalId", principalId.toString());
        detail.set("permissionsBefore", toJson(previous));
        detail.set("permissionsAfter", toJson(cap));
        auditLogger.recordDurableChange(actorId.toString(), workspaceId.toString(),
                created ? "workspace_agent_bound" : "workspace_agent_cap_updated",
                "agent_principal", principal.getId().toString(), detail.toString());
        return savedBinding;
    }

    /** Removing a binding revokes only this Workspace; Session history and other bindings remain. */
    @Transactional
    public boolean unbindWorkspace(String actorUserId, UUID workspaceId, UUID principalId) {
        UUID actorId = parseUuid(actorUserId, "INVALID_ACTOR");
        requireUser(actorId);
        workspaceService.requireActiveWorkspace(workspaceId.toString());
        requireWorkspaceMember(actorId, workspaceId);
        requireWorkspaceAgentManagement(actorId, workspaceId);
        AgentPrincipal principal = agentPrincipalRepository.findById(principalId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND,
                        "AGENT_PRINCIPAL_NOT_FOUND", "Agent principal not found"));
        WorkspaceAgent binding = workspaceAgentRepository.findById(
                new WorkspaceAgentId(principalId, workspaceId)).orElse(null);
        if (binding == null) {
            return false;
        }

        ObjectNode detail = objectMapper.createObjectNode();
        detail.put("authorizationAction", "MANAGE_WORKSPACE_AGENTS");
        detail.put("principalId", principalId.toString());
        detail.set("permissionsBefore", binding.getPermissionsSnapshot().deepCopy());
        workspaceAgentRepository.delete(binding);
        // PLAN-0629: revoking the binding revokes the role binding too — otherwise the read path
        // would keep reporting reach for a principal that was just unbound.
        revokeWorkspaceRoleBinding(principalId, workspaceId, actorId);
        auditLogger.recordDurableChange(actorId.toString(), workspaceId.toString(),
                "workspace_agent_unbound", "agent_principal", principal.getId().toString(), detail.toString());
        return true;
    }

    /**
     * PLAN-0622 M1.2 / V4 / D26: the union of the workspace's bindings, the caller's own PERSONAL
     * principals and every INSTANCE principal. Every row carries {@code source} (what the principal
     * <i>is</i>) and {@code bound} (whether it is bound to this workspace).
     *
     * <p>{@code bound=false} means "visible here, but not yet usable in this workspace": a Session
     * still needs an active binding, so a session picker must filter on it. PERSONAL/INSTANCE are
     * visible without a binding — they are not <b>session-usable</b> without one.</p>
     */
    @Transactional(readOnly = true)
    public List<WorkspaceAgentView> listWorkspaceAgents(String actorUserId, UUID workspaceId) {
        UUID actorId = parseUuid(actorUserId, "INVALID_ACTOR");
        requireUser(actorId);
        workspaceService.requireActiveWorkspace(workspaceId.toString());
        requireWorkspaceMember(actorId, workspaceId);

        java.util.Map<UUID, WorkspaceAgentView> merged = new java.util.LinkedHashMap<>();
        // One query for the whole list: the role bindings of this workspace, grouped per principal.
        java.util.Map<UUID, List<UUID>> rolesByPrincipal = roleBindingsByPrincipal(workspaceId);
        workspaceAgentRepository.findByIdWorkspaceId(workspaceId).stream()
                .map(binding -> agentPrincipalRepository.findById(binding.getId().getPrincipalId())
                        .map(principal -> new WorkspaceAgentView(principal.getId(), principal.getName(),
                                principal.getTemplateId(), optionalText(principal.getTemplateSnapshot(), "templateName"),
                                principal.getCreatedAt(), binding.getPermissionsSnapshot().deepCopy(),
                                sourceOf(principal), true, principal.getDisabledAt() != null,
                                principal.getHooks() == null ? null : principal.getHooks().deepCopy(),
                                principal.getContextPolicy() == null
                                        ? null : principal.getContextPolicy().deepCopy(),
                                rolesByPrincipal.getOrDefault(principal.getId(), List.of())))
                        .orElseThrow(() -> new CpApiException(HttpStatus.INTERNAL_SERVER_ERROR,
                                "AGENT_PRINCIPAL_INCONSISTENT", "Workspace Agent binding has no principal")))
                .forEach(view -> merged.put(view.principalId(), view));
        // PLAN-0629 (user ruling 2026-11-04): reach is a role binding, not the `scope` field. The
        // list is "bound here" ∪ "bound to a workspace role here"; the legacy scope queries are gone,
        // so a PERSONAL/INSTANCE principal shows up only in workspaces it actually holds access to.
        rolesByPrincipal.keySet().stream()
                .filter(principalId -> !merged.containsKey(principalId))
                .map(agentPrincipalRepository::findById)
                .flatMap(java.util.Optional::stream)
                .forEach(principal -> merged.put(principal.getId(),
                        unboundView(principal, principalOnlyCap(principal.getId()),
                                rolesByPrincipal.getOrDefault(principal.getId(), List.of()))));
        return merged.values().stream().sorted(WORKSPACE_AGENT_LIST_ORDER).toList();
    }

    /** PLAN-0629: principals holding a role binding in this workspace, resolved in one query. */
    private java.util.Set<UUID> roleBoundPrincipalIds(UUID workspaceId) {
        return roleBindingRepository
                .findBySubjectTypeAndScopeTypeAndScopeId(GrantPrincipalPathResolver.AGENT_PRINCIPAL,
                        "workspace", workspaceId)
                .stream()
                .map(AccessRoleBinding::getSubjectId)
                .collect(java.util.stream.Collectors.toCollection(LinkedHashSet::new));
    }

    /** Stable list order: workspace → personal → instance, then name, then id (D24). */
    private static final java.util.Map<String, Integer> SOURCE_ORDER =
            java.util.Map.of("workspace", 0, "personal", 1, "instance", 2);

    static final java.util.Comparator<WorkspaceAgentView> WORKSPACE_AGENT_LIST_ORDER = java.util.Comparator
            .comparingInt((WorkspaceAgentView view) -> SOURCE_ORDER.getOrDefault(view.source(), 9))
            .thenComparing(view -> view.name() == null ? "" : view.name().toLowerCase(java.util.Locale.ROOT))
            .thenComparing(view -> view.principalId().toString());

    private WorkspaceAgentView unboundView(AgentPrincipal principal, JsonNode cap,
                                           List<UUID> roleIds) {
        return new WorkspaceAgentView(principal.getId(), principal.getName(), principal.getTemplateId(),
                optionalText(principal.getTemplateSnapshot(), "templateName"), principal.getCreatedAt(), cap,
                sourceOf(principal), false, principal.getDisabledAt() != null,
                principal.getHooks() == null ? null : principal.getHooks().deepCopy(),
                principal.getContextPolicy() == null ? null : principal.getContextPolicy().deepCopy(),
                roleIds);
    }

    /** PLAN-0629: one query per list call — workspace role bindings grouped by principal. */
    private java.util.Map<UUID, List<UUID>> roleBindingsByPrincipal(UUID workspaceId) {
        return roleBindingRepository
                .findBySubjectTypeAndScopeTypeAndScopeId(GrantPrincipalPathResolver.AGENT_PRINCIPAL,
                        "workspace", workspaceId)
                .stream()
                .collect(java.util.stream.Collectors.groupingBy(AccessRoleBinding::getSubjectId,
                        java.util.LinkedHashMap::new,
                        java.util.stream.Collectors.mapping(AccessRoleBinding::getRoleId,
                                java.util.stream.Collectors.toList())));
    }

    /** Without a binding there is no narrowing cap: the principal's own atoms are the whole cap. */
    private JsonNode principalOnlyCap(UUID principalId) {
        return toJson(evaluator.union(grantRepository.findBySubjectTypeAndSubjectId(
                GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId)));
    }

    /** Wire vocabulary of the list projection: {@code workspace|personal|instance}. */
    private String sourceOf(AgentPrincipal principal) {
        String scope = principal.getScope() == null ? SCOPE_WORKSPACE : principal.getScope();
        return switch (scope) {
            case SCOPE_PERSONAL -> "personal";
            case SCOPE_INSTANCE -> "instance";
            default -> "workspace";
        };
    }

    /**
     * PLAN-0622 M1.2 / O5: {@code GET /agent-principals?scope=…}.
     *
     * <ul>
     *   <li>{@code PERSONAL} — only the caller's own principals (never somebody else's name or
     *       template);</li>
     *   <li>{@code INSTANCE} — visible instance-wide, so every authenticated caller sees them;</li>
     *   <li>{@code WORKSPACE} — requires a workspace id and membership; returns the principals bound
     *       in that workspace.</li>
     * </ul>
     */
    @Transactional(readOnly = true)
    public List<AgentPrincipalView> listPrincipals(String actorUserId, String scope, String workspaceIdValue) {
        UUID actorId = parseUuid(actorUserId, "INVALID_ACTOR");
        requireUser(actorId);
        String requested = scope == null || scope.isBlank() ? null : scope.trim().toUpperCase(java.util.Locale.ROOT);
        if (requested == null) {
            List<AgentPrincipalView> all = new ArrayList<>();
            agentPrincipalRepository.findByScopeAndOwnerUserId(SCOPE_PERSONAL, actorId)
                    .forEach(principal -> all.add(toPrincipalView(principal)));
            agentPrincipalRepository.findByScope(SCOPE_INSTANCE)
                    .forEach(principal -> all.add(toPrincipalView(principal)));
            return all;
        }
        if (SCOPE_PERSONAL.equals(requested)) {
            return agentPrincipalRepository.findByScopeAndOwnerUserId(SCOPE_PERSONAL, actorId).stream()
                    .map(this::toPrincipalView).toList();
        }
        if (SCOPE_INSTANCE.equals(requested)) {
            return agentPrincipalRepository.findByScope(SCOPE_INSTANCE).stream()
                    .map(this::toPrincipalView).toList();
        }
        if (!SCOPE_WORKSPACE.equals(requested)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_AGENT_SCOPE",
                    "scope must be one of PERSONAL, WORKSPACE, INSTANCE");
        }
        if (workspaceIdValue == null || workspaceIdValue.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "scope=WORKSPACE requires a workspaceId");
        }
        UUID workspaceId = parseUuid(workspaceIdValue, "INVALID_WORKSPACE_CONTEXT");
        workspaceService.requireActiveWorkspace(workspaceId.toString());
        requireWorkspaceMember(actorId, workspaceId);
        return workspaceAgentRepository.findByIdWorkspaceId(workspaceId).stream()
                .map(binding -> agentPrincipalRepository.findById(binding.getId().getPrincipalId()))
                .flatMap(java.util.Optional::stream)
                .filter(principal -> SCOPE_WORKSPACE.equals(principal.getScope()))
                .map(this::toPrincipalView)
                .toList();
    }

    private AgentPrincipalView toPrincipalView(AgentPrincipal principal) {
        return new AgentPrincipalView(principal.getId(), principal.getName(), principal.getTemplateId(),
                optionalText(principal.getTemplateSnapshot(), "templateName"), principal.getCreatedAt(),
                principal.getScope(), principal.getOwnerUserId(), principal.getDefaultModelProvider(),
                principal.getDefaultModelName(),
                principal.getAllowedModels() == null ? null : principal.getAllowedModels().deepCopy(),
                principal.getDisabledAt(),
                principal.getHooks() == null ? null : principal.getHooks().deepCopy(),
                principal.getContextPolicy() == null ? null : principal.getContextPolicy().deepCopy());
    }

    /**
     * PLAN-0622 M1.3 (checklist C1–C6): <b>the single computation entry</b> for "what may this
     * principal do in this workspace".
     *
     * <p>Contract:</p>
     * <ul>
     *   <li>explicit ids only — no {@code TenantContext} read, so 0623 can call it from a run
     *       worker thread outside any request (C6);</li>
     *   <li>no caching (V16): every call re-reads the binding and the principal's grants, so a
     *       revoked or narrowed binding takes effect on the next submission;</li>
     *   <li>scoped: an unbound workspace answers {@code 403}, it never falls back to another
     *       workspace's binding (C5);</li>
     *   <li>a disabled principal answers {@code 409 AGENT_PRINCIPAL_DISABLED} (state conflict, not
     *       a permission problem).</li>
     * </ul>
     */
    @Transactional(readOnly = true)
    public JsonNode resolveCapFor(UUID principalId, UUID workspaceId) {
        ActiveWorkspaceBinding binding = requireActiveWorkspaceBinding(principalId, workspaceId);
        AgentPrincipal principal = binding.principal();
        Set<GrantIntersectionEvaluator.PermissionAtom> principalPermissions =
                principalEffectiveAtoms(principal.getId(), workspaceId);
        Set<GrantIntersectionEvaluator.PermissionAtom> bindingPermissions = binding.workspaceAgent() == null
                // PLAN-0629: access granted by a workspace role binding, no binding row involved.
                ? evaluator.union(grantRepository.findScopedGrants(
                        GrantPrincipalPathResolver.AGENT_PRINCIPAL, principal.getId(),
                        GrantSources.EVALUATION_SOURCES, workspaceId))
                : parsePermissions(binding.workspaceAgent().getPermissionsSnapshot());
        return toJson(retainCovered(bindingPermissions, principalPermissions));
    }

    /** 2026-11-04 P0（task-24）：主体的默认模型身份；未设置时两个字段都为 null。 */
    public record DefaultModel(String provider, String model) {}

    /**
     * 会话创建/重绑的默认值来源之一（唯一入口 {@code chat.SessionProviderDefaults}）：
     * 先按既有可见性规则校验主体在本工作区可用，再返回它自己的默认模型。
     */
    @Transactional(readOnly = true)
    public DefaultModel defaultModel(UUID principalId, UUID workspaceId) {
        AgentPrincipal principal = requireActiveWorkspaceBinding(principalId, workspaceId).principal();
        return new DefaultModel(principal.getDefaultModelProvider(), principal.getDefaultModelName());
    }

    /** String adapter for wire-facing callers; parsing only, one computation (C1). */
    @Transactional(readOnly = true)
    public JsonNode resolveCapFor(String principalIdValue, String workspaceIdValue) {
        return resolveCapFor(parseUuid(principalIdValue, "INVALID_AGENT_PRINCIPAL"),
                parseUuid(workspaceIdValue, "INVALID_WORKSPACE"));
    }

    /**
     * Pre-0622 name. It only parses the wire strings and delegates — keeping it as a second
     * implementation would be exactly the "two computation points" the checklist forbids (C1).
     */
    @Transactional(readOnly = true)
    public JsonNode resolveSessionCap(String principalIdValue, String workspaceIdValue) {
        return resolveCapFor(principalIdValue, workspaceIdValue);
    }

    /**
     * PLAN-0622 M1.3: existence check expressed through the single entry — the binding/active
     * invariants are resolved once, in {@link #resolveCapFor(UUID, UUID)}.
     */
    @Transactional(readOnly = true)
    public void requireActiveWorkspaceBinding(String principalIdValue, String workspaceIdValue) {
        resolveCapFor(parseUuid(principalIdValue, "INVALID_AGENT_PRINCIPAL"),
                parseUuid(workspaceIdValue, "INVALID_WORKSPACE"));
    }

    /**
     * PLAN-0629 (scope→roles): reachability is decided by a role binding, not by the legacy `scope`
     * column. A principal may act in a workspace when it holds a workspace-scoped role binding there;
     * the binding table stays accepted because it carries the optional narrowing cap (`permissions
     * _snapshot`) and is the row V107 backfills from, so no access is lost mid-upgrade.
     */
    private ActiveWorkspaceBinding requireActiveWorkspaceBinding(UUID principalId, UUID workspaceId) {
        AgentPrincipal principal = requireActivePrincipal(principalId);
        WorkspaceAgent binding = workspaceAgentRepository
                .findById(new WorkspaceAgentId(principalId, workspaceId))
                .orElse(null);
        if (binding == null && !roleBoundPrincipalIds(workspaceId).contains(principalId)) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "Agent principal holds no role binding for this Workspace");
        }
        return new ActiveWorkspaceBinding(principal, binding);
    }

    /** PLAN-0629: a freshly created principal gets instance-scope role bindings (roleIds or default). */
    private void bindInstanceRoles(UUID principalId, UUID actorId, List<UUID> roleIds) {        List<UUID> effective = roleIds == null || roleIds.isEmpty()
                ? List.of(requireRole(DEFAULT_AGENT_INSTANCE_ROLE).getId())
                : roleIds;
        List<UUID> existing = roleBindingRepository
                .findBySubjectTypeAndSubjectIdAndScopeType(
                        GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId, "instance")
                .stream()
                .map(AccessRoleBinding::getRoleId)
                .toList();
        for (UUID roleId : effective) {
            if (existing.contains(roleId)) {
                continue;
            }
            roleBindingRepository.save(new AccessRoleBinding(roleId,
                    GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId, "instance", null, actorId));
        }
        roleMaterializer.materializeSubject(GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId,
                actorId, null);
    }

    /**
     * PLAN-0629 task-12: the one-time grant check for {@code roleIds}. It answers three questions in
     * a fixed order and always refuses with {@code 403 ROLE_NOT_GRANTABLE} plus a reason in the
     * detail (the code stays stable, the prose may change):
     *
     * <ol>
     *   <li>does the role exist — a missing id is not a permission problem, but reporting it as 404
     *       would leak which roles exist to callers that may not see them;</li>
     *   <li>may this role be bound to an <b>agent principal</b> at all — administrator and
     *       management atoms are refused ({@link PermissionAtomCatalog#canBindToAgentPrincipal}),
     *       because an agent is a grantee, never an administrator;</li>
     *   <li>does the actor hold everything the role grants — "you cannot grant what you do not
     *       hold" — evaluated with the same atom union the rest of the service uses.</li>
     * </ol>
     *
     * <p>Deliberately one-time: once bound, the role takes effect immediately and stays until the
     * role is edited or the binding removed. Re-checking the original grantor later would
     * reintroduce the creator coupling the 2026-11-04 ruling removed.</p>
     */
    private void validateGrantableRoles(UUID actorId, List<UUID> roleIds) {
        if (roleIds == null || roleIds.isEmpty()) {
            return;
        }
        Set<GrantIntersectionEvaluator.PermissionAtom> actorAtoms = evaluator.union(
                grantRepository.findBySubjectTypeAndSubjectId(GrantPrincipalPathResolver.USER, actorId));
        for (UUID roleId : new java.util.LinkedHashSet<>(roleIds)) {
            if (roleId == null) {
                throw notGrantable("roleIds must not contain null");
            }
            AccessRole role = roleRepository.findById(roleId)
                    .orElseThrow(() -> notGrantable("roleId is not bindable"));
            List<String> atomNames = roleAtomNames(roleId);
            String forbidden = PermissionAtomCatalog.firstForbiddenAgentPrincipalAtom(atomNames);
            if (forbidden != null) {
                throw notGrantable("instance-admin role cannot be bound to an agent principal ("
                        + forbidden + ")");
            }
            Set<GrantIntersectionEvaluator.PermissionAtom> roleAtoms = new LinkedHashSet<>();
            for (String atomName : atomNames) {
                if (PermissionAtomCatalog.isActionAtom(atomName)) {
                    roleAtoms.add(new GrantIntersectionEvaluator.PermissionAtom(atomName, "*"));
                }
            }
            if (!isSubset(roleAtoms, actorAtoms)) {
                throw notGrantable("actor cannot grant role " + role.getName()
                        + ": it grants more than the actor holds");
            }
        }
    }

    /** The atom names of one role, straight from the role materialization table. */
    private List<String> roleAtomNames(UUID roleId) {
        return rolePermissionRepository.findByIdRoleId(roleId).stream()
                .map(row -> row.getId().getActionClass())
                .toList();
    }

    private static CpApiException notGrantable(String detail) {
        return new CpApiException(HttpStatus.FORBIDDEN, "ROLE_NOT_GRANTABLE", detail);
    }

    private AccessRole requireRole(String name) {
        return roleRepository.findByName(name)
                .orElseThrow(() -> new CpApiException(HttpStatus.INTERNAL_SERVER_ERROR,
                        "ROLE_CATALOG_INCONSISTENT", "Seeded role " + name + " is missing"));
    }

    /**
     * PLAN-0629: the permission source is the bound roles. A subject that already materialized
     * {@code source='role'} rows is evaluated from those only; a legacy subject (no role rows yet,
     * e.g. rows written before the migration) keeps the pre-ruling behaviour — the frozen
     * {@code agent_default}/{@code template} snapshots — so nothing becomes unusable mid-upgrade and
     * the change stays reversible.
     */
    private Set<GrantIntersectionEvaluator.PermissionAtom> principalEffectiveAtoms(UUID principalId,
                                                                                  UUID workspaceId) {
        // role 行是模板/默认能力的唯一权威源（2026-11-04 裁定），但 credential_binding 是**活跃**机制
        // （PLAN-0494 把凭证原子合并到主体上），不是 legacy 快照 —— 它必须与 role 一起参与求值，
        // 否则"绑了凭证但主体已有角色行"会让凭证原子永远进不了会话 cap（本单 task-29 实测）。
        List<AuthorizationGrant> roleRows = grantRepository.findScopedGrants(
                GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId,
                List.of(GrantSources.ROLE, GrantSources.CREDENTIAL_BINDING), workspaceId);
        if (!roleRows.isEmpty()) {
            return evaluator.union(roleRows);
        }
        return evaluator.union(grantRepository.findBySubjectTypeAndSubjectId(
                GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId));
    }

    /** PLAN-0629: the workspace-scoped role ids bound to this principal (read-only view field). */
    private List<UUID> workspaceRoleIds(UUID principalId, UUID workspaceId) {
        return roleBindingRepository
                .findBySubjectTypeAndScopeTypeAndScopeId(GrantPrincipalPathResolver.AGENT_PRINCIPAL,
                        "workspace", workspaceId)
                .stream()
                .filter(row -> principalId.equals(row.getSubjectId()))
                .map(AccessRoleBinding::getRoleId)
                .toList();
    }

    /**
     * PLAN-0629: binding a role is what grants access. The role binding is written first and the
     * existing {@link RoleGrantMaterializer} then materializes `source='role'` grants, so the runtime
     * path and the V107 backfill produce the same rows — one materialization implementation, not two.
     */
    private void ensureWorkspaceRoleBinding(UUID principalId, UUID workspaceId, UUID actorId) {
        if (!workspaceRoleIds(principalId, workspaceId).isEmpty()) {
            return;
        }
        AccessRole defaultRole = roleRepository.findByName(DEFAULT_AGENT_WORKSPACE_ROLE)
                .orElseThrow(() -> new CpApiException(HttpStatus.INTERNAL_SERVER_ERROR,
                        "ROLE_CATALOG_INCONSISTENT",
                        "Seeded role " + DEFAULT_AGENT_WORKSPACE_ROLE + " is missing"));
        roleBindingRepository.save(new AccessRoleBinding(defaultRole.getId(),
                GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId, "workspace", workspaceId,
                actorId));
        roleMaterializer.materializeSubject(GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId,
                actorId, workspaceId.toString());
    }

    /** PLAN-0629: revoking the binding revokes the role binding and its materialized atoms. */
    private void revokeWorkspaceRoleBinding(UUID principalId, UUID workspaceId, UUID actorId) {
        List<AccessRoleBinding> rows = roleBindingRepository
                .findBySubjectTypeAndScopeTypeAndScopeId(GrantPrincipalPathResolver.AGENT_PRINCIPAL,
                        "workspace", workspaceId)
                .stream()
                .filter(row -> principalId.equals(row.getSubjectId()))
                .toList();
        if (rows.isEmpty()) {
            return;
        }
        roleBindingRepository.deleteAll(rows);
        roleMaterializer.materializeSubject(GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId,
                actorId, workspaceId.toString());
    }

    @Transactional(readOnly = true)
    public JsonNode deriveSpawnChildCap(JsonNode parentSessionSnapshot, String principalId, String workspaceId) {
        Set<GrantIntersectionEvaluator.PermissionAtom> parentPermissions = parsePermissions(parentSessionSnapshot);
        Set<GrantIntersectionEvaluator.PermissionAtom> currentCap = parsePermissions(
                resolveCapFor(parseUuid(principalId, "INVALID_AGENT_PRINCIPAL"),
                        parseUuid(workspaceId, "INVALID_WORKSPACE")));
        Set<GrantIntersectionEvaluator.PermissionAtom> intersection = new LinkedHashSet<>();
        for (GrantIntersectionEvaluator.PermissionAtom atom : parentPermissions) {
            if (isCoveredBy(atom, currentCap)) {
                intersection.add(atom);
            }
        }
        for (GrantIntersectionEvaluator.PermissionAtom atom : currentCap) {
            if (isCoveredBy(atom, parentPermissions)) {
                intersection.add(atom);
            }
        }
        return toJson(intersection);
    }

    /** Global account disable; the caller must authorize the account-lifecycle operation. */
    @Transactional
    /**
     * PLAN-0622 M1.2 / O6: disable is tier-authorized, and a refusal is a {@code 403}, never a
     * {@code 404} that pretends the row does not exist.
     *
     * <ul>
     *   <li>{@code PERSONAL} — its owner, or instance administration;</li>
     *   <li>{@code WORKSPACE} — {@code MANAGE_WORKSPACE_AGENTS} in the request workspace, or
     *       instance administration;</li>
     *   <li>{@code INSTANCE} — instance administration only.</li>
     * </ul>
     */
    public boolean disablePrincipal(String actorUserId, UUID principalId) {
        UUID actorId = parseUuid(actorUserId, "INVALID_ACTOR");
        requireUser(actorId);
        AgentPrincipal principal = agentPrincipalRepository.findById(principalId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND,
                        "AGENT_PRINCIPAL_NOT_FOUND", "Agent principal not found"));
        requireDisableAuthority(actorId, principal);
        if (principal.getDisabledAt() != null) {
            // Idempotent: disabling twice is not an error, and it must not add a second audit row.
            return false;
        }

        Instant disabledAt = Instant.now();
        principal.setDisabledAt(disabledAt);
        agentPrincipalRepository.saveAndFlush(principal);
        ObjectNode detail = objectMapper.createObjectNode();
        detail.put("authorizationAction", "CREATE_ACCOUNT");
        detail.put("disabledAt", disabledAt.toString());
        auditLogger.recordDurableChange(actorId.toString(), null,
                "agent_principal_disabled", "agent_principal", principalId.toString(), detail.toString());
        return true;
    }

    private void requireDisableAuthority(UUID actorId, AgentPrincipal principal) {
        // PLAN-0651 T1.4 (D51-26): the instance-administrator bypass is the instance-scope
        // MANAGE_AGENT_PRINCIPALS atom (ADMIN/SUPER_ADMIN hold it through the seeded role, V111).
        boolean instanceAdministrator = holdsAgentPrincipalManagementAtom(actorId);
        String scope = principal.getScope() == null ? SCOPE_WORKSPACE : principal.getScope();
        if (SCOPE_PERSONAL.equals(scope)) {
            if (instanceAdministrator || actorId.equals(principal.getOwnerUserId())) {
                return;
            }
            throw new CpApiException(HttpStatus.FORBIDDEN, "AGENT_PRINCIPAL_OWNER_MISMATCH",
                    "Only the owner or instance administration may disable a PERSONAL agent principal");
        }
        if (instanceAdministrator) {
            return;
        }
        if (SCOPE_INSTANCE.equals(scope)) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "INSTANCE_ADMIN_REQUIRED",
                    "An INSTANCE-scope agent principal may only be disabled by instance administration");
        }
        UUID workspaceContext = currentWorkspaceContext();
        if (workspaceContext == null) {
            throw new CpApiException(HttpStatus.CONFLICT, "WORKSPACE_CONTEXT_REQUIRED",
                    "Disabling a WORKSPACE-scope agent principal requires a workspace context");
        }
        requireUserAction(actorId, ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS,
                workspaceContext.toString(), workspaceContext);
    }

    private void requireUser(UUID userId) {
        if (!authService.userExists(userId)) {
            throw new CpApiException(
                    HttpStatus.NOT_FOUND, "USER_NOT_FOUND", "User not found");
        }
    }

    private void requireWorkspaceMember(UUID userId, UUID workspaceId) {
        if (!workspaceService.isWorkspaceMember(workspaceId.toString(), userId.toString())) {
            throw new CpApiException(HttpStatus.FORBIDDEN,
                    "WORKSPACE_ACCESS_DENIED", "Workspace membership is required");
        }
    }

    private void requireWorkspaceAgentManagement(UUID actorId, UUID workspaceId) {
        requireUserAction(actorId, ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS,
                workspaceId.toString(), workspaceId);
    }

    /**
     * PLAN-0622 M1.1 (O4): {@code MANAGE_WORKSPACE_AGENTS} is necessary but no longer sufficient.
     *
     * <ul>
     *   <li>{@code PERSONAL} — only its owner may bind it; otherwise A could drag B's private agent
     *       into A's workspace (and 0623 would then run B's agent under A's approval chain).</li>
     *   <li>{@code INSTANCE} — only instance administration may bind it; a workspace owner is not
     *       automatically instance administration.</li>
     *   <li>{@code WORKSPACE} — the existing workspace gate is the whole rule.</li>
     * </ul>
     *
     * <p>Distinct codes on purpose: {@code 403 AGENT_PRINCIPAL_OWNER_MISMATCH} and
     * {@code 403 INSTANCE_ADMIN_REQUIRED} tell the caller which authority is missing without
     * disclosing whether the principal exists (the caller already reached this point with a valid
     * workspace gate, so the principal id is theirs).</p>
     */
    private void requireBindingAuthorityForScope(UUID actorId, AgentPrincipal principal) {
        String scope = principal.getScope() == null ? SCOPE_WORKSPACE : principal.getScope();
        if (SCOPE_PERSONAL.equals(scope)) {
            if (!actorId.equals(principal.getOwnerUserId())) {
                throw new CpApiException(HttpStatus.FORBIDDEN, "AGENT_PRINCIPAL_OWNER_MISMATCH",
                        "A PERSONAL agent principal may only be bound by its owner");
            }
            return;
        }
        if (SCOPE_INSTANCE.equals(scope) && !holdsAgentPrincipalManagementAtom(actorId)) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "INSTANCE_ADMIN_REQUIRED",
                    "An INSTANCE-scope agent principal may only be bound by instance administration");
        }
    }

    /**
     * PLAN-0651 T1.4 (A21/A22, D51-26): whether the actor holds the instance-scope
     * {@code MANAGE_AGENT_PRINCIPALS} atom (N1). ADMIN and SUPER_ADMIN hold it through the seeded
     * roles (V111). N1 is instance-only by construction, so evaluating it with a {@code null}
     * workspace selects exactly the instance-scope grant rows.
     */
    private boolean holdsAgentPrincipalManagementAtom(UUID actorId) {
        return actorId != null && requesterAuthority.holdsActionAtom(actorId,
                ToolFaceRegistry.ACTION_MANAGE_AGENT_PRINCIPALS, null);
    }

    /**
     * PLAN-0610 W1c (round-3 P0-1): the caller's permission set is the <b>scoped</b> union for the
     * request workspace, not every grant row the subject owns.
     *
     * <p>Reading the unscoped set let a user who is {@code WS_OWNER} in workspace A (which
     * materializes {@code MANAGE_WORKSPACE_AGENTS@*}) pass this gate for workspace B, where they are
     * only {@code WS_VIEWER}: the membership gate at {@code setWorkspaceCap} is scoped, this
     * authorization gate was not. {@code findScopedGrants} applies the same predicate as the
     * evaluation kernel ({@code GrantAuthorizationService}): instance rows always participate,
     * workspace rows only for the request workspace, and the retired {@code default}/{@code direct}
     * sources are excluded by {@link GrantSources#EVALUATION_SOURCES}.</p>
     *
     * @param workspaceId the request workspace, or {@code null} for an instance-wide action
     *     ({@code CREATE_ACCOUNT}); a null scope means "instance rows only", which is exactly the
     *     authorization basis of an instance-level atom.
     */
    private void requireUserAction(UUID actorId, String actionClass, String resource,
                                   UUID workspaceId) {
        PolicyRequest request = new PolicyRequest(actionClass.toLowerCase(),
                List.of(actionClass), List.of(resource), ToolShape.OPAQUE,
                actorId.toString(), null, null);
        // PLAN-0651 T1.5 (A1): shared kernel entry (RequesterAuthority#allowsForUser). The scope is
        // passed explicitly because this request carries a null workspace by design; the decision
        // itself is unchanged (same findScopedGrants + same evaluator.allows resource/shape matching).
        if (!requesterAuthority.allowsForUser(request, workspaceId)) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", actionClass + " permission is required");
        }
    }

    /**
     * PLAN-0625 M2 (D25-14): re-subscribing a principal's hooks is a principal-lifecycle mutation
     * with the same tier authority as disable — owner for PERSONAL, workspace management for
     * WORKSPACE, instance administration for INSTANCE. A preset guard's subscriptions are
     * template-owned data and refuse with their own code (kept distinct from GUARD_CAP_IMMUTABLE:
     * one code carrying two semantics is more expensive than a second code).
     *
     * @return the validated document that was stored ({@code null} = every subscription cleared), so
     *     the wire can echo exactly what was persisted instead of the caller's raw input
     */
    @Transactional
    public JsonNode updatePrincipalHooks(String actorUserId, UUID principalId, JsonNode hooks) {
        return applyPrincipalSettings(actorUserId, principalId,
                new PrincipalSettingsPatch(hooks, true, null, false, null, false)).hooks();
    }

    /**
     * PLAN-0629 M1 (D29-21): one PATCH may carry either or both subject-level documents —
     * {@code hooks} (PLAN-0625 D25-14) and {@code contextPolicy} (the memory policy of V92's
     * {@code agent_principals.context_policy}). Both are validated here, in one write-side gate, before
     * the row is even looked up; the caller's presence flags decide what gets overwritten, so
     * "absent" and "explicit null (= clear)" stay distinguishable.
     *
     * <p>Authority is the same tier matrix as {@code disable}. A preset guard is a system asset (the
     * same ground as D25-03), so <b>both</b> of its subject documents are preset-owned at the write
     * side: subscriptions refuse with {@code GUARD_HOOKS_IMMUTABLE} and the memory policy refuses with
     * {@code GUARD_CONTEXT_POLICY_IMMUTABLE} (Lead ruling 2026-11-02). The codes stay distinct because
     * the semantics differ — one says "subscriptions come from the template", the other says "a
     * guard's memory policy is not a user setting"; letting the API write it would be a bypass that can
     * pollute the guard's adjudication independence (D25-14: an ambiguous reuse is more expensive than
     * a second code).</p>
     *
     * @return the documents now stored, read back from the row, so the wire echoes persisted state
     *     (never the caller's raw input, and never a stale {@code null} for an untouched field)
     */
    @Transactional
    public PrincipalSettings applyPrincipalSettings(String actorUserId, UUID principalId,
                                                    PrincipalSettingsPatch patch) {
        UUID actorId = parseUuid(actorUserId, "INVALID_ACTOR");
        requireUser(actorId);
        // Validate before the lookup: a malformed document must never need a row to be rejected
        // (the pre-0629 contract asserted by AgentPrincipalHooksServiceTest).
        JsonNode checkedHooks = patch.hooksPresent()
                ? HookAdvisorRegistry.validateSubscriptions(patch.hooks()) : null;
        JsonNode checkedPolicy = patch.contextPolicyPresent()
                ? ContextPolicyValidator.validate(patch.contextPolicy()) : null;
        JsonNode checkedDelegation = patch.delegationPolicyPresent()
                ? DelegationPolicyValidator.validate(patch.delegationPolicy()) : null;
        AgentPrincipal principal = agentPrincipalRepository.findById(principalId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND,
                        "AGENT_PRINCIPAL_NOT_FOUND", "Agent principal not found"));
        if (patch.hooksPresent()) {
            requireMutableHooks(principal);
        }
        if (patch.contextPolicyPresent()) {
            requireMutableContextPolicy(principal);
        }
        if (patch.delegationPolicyPresent()) {
            requireMutableDelegationPolicy(principal);
        }
        requireDisableAuthority(actorId, principal);
        if (patch.hooksPresent()) {
            principal.setHooks(checkedHooks);
        }
        if (patch.contextPolicyPresent()) {
            principal.setContextPolicy(checkedPolicy);
        }
        if (patch.delegationPolicyPresent()) {
            principal.setDelegationPolicy(checkedDelegation);
        }
        agentPrincipalRepository.saveAndFlush(principal);
        if (patch.hooksPresent()) {
            ObjectNode detail = objectMapper.createObjectNode();
            detail.put("hooks", checkedHooks == null ? "null" : checkedHooks.toString());
            auditLogger.recordDurableChange(actorId.toString(), null,
                    "agent_principal_hooks_updated", "agent_principal", principalId.toString(),
                    detail.toString());
        }
        if (patch.contextPolicyPresent()) {
            ObjectNode detail = objectMapper.createObjectNode();
            detail.put("contextPolicy", checkedPolicy == null ? "null" : checkedPolicy.toString());
            auditLogger.recordDurableChange(actorId.toString(), null,
                    "agent_principal_context_policy_updated", "agent_principal", principalId.toString(),
                    detail.toString());
        }
        if (patch.delegationPolicyPresent()) {
            ObjectNode detail = objectMapper.createObjectNode();
            detail.put("delegationPolicy", checkedDelegation == null ? "null" : checkedDelegation.toString());
            auditLogger.recordDurableChange(actorId.toString(), null,
                    "agent_principal_delegation_policy_updated", "agent_principal", principalId.toString(),
                    detail.toString());
        }
        return new PrincipalSettings(principal.getHooks(), principal.getContextPolicy(),
                principal.getDelegationPolicy());
    }

    /**
     * One PATCH's parsed documents. The presence flags exist because a present-but-null document means
     * "clear the column" while an absent one means "leave it alone" — {@code JsonNode} alone cannot say both.
     */
    public record PrincipalSettingsPatch(JsonNode hooks, boolean hooksPresent,
                                         JsonNode contextPolicy, boolean contextPolicyPresent,
                                         JsonNode delegationPolicy, boolean delegationPolicyPresent) {}

    /** The subject-level documents after a write, all read back from the persisted row. */
    public record PrincipalSettings(JsonNode hooks, JsonNode contextPolicy, JsonNode delegationPolicy) {}

    /** D25-14: a preset guard's hook subscriptions are fixed at the write side, like its cap. */
    private void requireMutableHooks(AgentPrincipal principal) {
        if (AgentPrincipal.ORIGIN_SYSTEM_PRESET.equals(principal.getOrigin())) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "GUARD_HOOKS_IMMUTABLE",
                    "A preset guard's hook subscriptions are fixed; they come from the template, not the API");
        }
    }

    /**
     * PLAN-0629 M1 (Lead ruling 2026-11-02): a preset guard's memory policy is preset-owned too.
     *
     * <p><b>Why a guard is locked here</b> (do not read this as a copy-paste of the hooks refusal): a
     * preset guard is a <b>system asset</b> — the same ground as D25-03 — so its behaviour must be
     * decided by its template, not by whoever holds the API token. Letting the API write its memory
     * would be a <b>bypass path</b>: memory is exactly what the guard "knows" when it judges, so
     * unvetted memory written through this surface can pollute the guard's adjudication independence
     * (an injected fact/profile can steer the verdict that feeds the approval policy summary). The
     * refusal therefore gets its own code — {@code GUARD_CONTEXT_POLICY_IMMUTABLE} — instead of
     * borrowing {@code GUARD_HOOKS_IMMUTABLE}, because the two say different things (D25-14: an
     * ambiguous reuse is more expensive than a new code).</p>
     */
    private void requireMutableContextPolicy(AgentPrincipal principal) {
        if (AgentPrincipal.ORIGIN_SYSTEM_PRESET.equals(principal.getOrigin())) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "GUARD_CONTEXT_POLICY_IMMUTABLE",
                    "A preset guard's memory policy is fixed; a guard is a system asset, "
                            + "so its context policy is not a user setting");
        }
    }

    /**
     * PLAN-0630 M1: a preset guard's delegation budget is preset-owned too.
     *
     * <p>Ground: the same D25-03 "a guard is a system asset" reasoning as its cap / hooks / memory
     * policy. A delegation budget decides how many further agents the subject may create, so letting the
     * API rewrite it would let anyone holding the token fan out from a guard identity. The code is its
     * own value ({@code GUARD_DELEGATION_POLICY_IMMUTABLE}) rather than a reuse of the two siblings'
     * codes, for the D25-14 reason: the three refusals say different things.</p>
     */
    private void requireMutableDelegationPolicy(AgentPrincipal principal) {
        if (AgentPrincipal.ORIGIN_SYSTEM_PRESET.equals(principal.getOrigin())) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "GUARD_DELEGATION_POLICY_IMMUTABLE",
                    "A preset guard's delegation budget is fixed; a guard is a system asset, "
                            + "so its delegation policy is not a user setting");
        }
    }

    /**
     * PLAN-0630 M1: the subject's delegation budget document (raw, unvalidated).
     *
     * <p>Only the <b>root</b> subject of a delegation tree is ever read (frozen ruling #2: a sub-agent's
     * own limits are inert while it acts as a subagent). Shape validation belongs to the caller's single
     * parser — {@code policy.DelegationPolicyValidator} — so this stays a pure read.</p>
     */
    // Deliberately NOT @Transactional: this read is called from inside the spawn transaction, and a
    // participating (readOnly) transaction that throws would mark the CALLER's transaction
    // rollback-only. The gate catches "principal row missing" on purpose (see DelegationBudgetService),
    // so annotation-induced rollback-only state would poison every spawn that follows a missing row —
    // observed as "Transaction silently rolled back because it has been marked as rollback-only" in
    // SpawnLifecycleTest. A single repository read needs no surrounding transaction.
    public JsonNode readDelegationPolicy(String principalIdValue) {
        return agentPrincipalRepository.findById(parseUuid(principalIdValue, "INVALID_AGENT_PRINCIPAL"))
                .map(AgentPrincipal::getDelegationPolicy)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND,
                        "AGENT_PRINCIPAL_NOT_FOUND", "Agent principal not found"));
    }
    /** PLAN-0655 read view: best-effort display name for a principal id (null when missing). */
    @org.springframework.transaction.annotation.Transactional(readOnly = true)
    public String readPrincipalName(String principalIdValue) {
        return agentPrincipalRepository.findById(parseUuid(principalIdValue, "INVALID_AGENT_PRINCIPAL"))
                .map(AgentPrincipal::getName)
                .orElse(null);
    }
    /** D25-02/D25-08: preset guards (and any future hook-only preset) never get their cap rewritten. */
    private void requireMutableCap(AgentPrincipal principal) {
        if (com.cc01cc.p.xihe.cp.entity.AgentPrincipal.ORIGIN_SYSTEM_PRESET.equals(principal.getOrigin())) {
            throw new CpApiException(org.springframework.http.HttpStatus.FORBIDDEN, "GUARD_CAP_IMMUTABLE",
                    "A preset guard's capability is fixed; it cannot be narrowed or widened through a binding");
        }
    }

    private AgentPrincipal requireActivePrincipal(UUID principalId) {
        AgentPrincipal principal = agentPrincipalRepository.findById(principalId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND,
                        "AGENT_PRINCIPAL_NOT_FOUND", "Agent principal not found"));
        if (principal.getDisabledAt() != null) {
            throw new CpApiException(HttpStatus.CONFLICT,
                    "AGENT_PRINCIPAL_DISABLED", "Agent principal is disabled");
        }
        return principal;
    }

    private Set<GrantIntersectionEvaluator.PermissionAtom> parsePermissions(JsonNode permissions) {
        try {
            return evaluator.parse(permissions);
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_PERMISSION_ATOMS",
                    "Permission atoms are invalid", e);
        }
    }

    private Set<GrantIntersectionEvaluator.PermissionAtom> retainCovered(
            Set<GrantIntersectionEvaluator.PermissionAtom> candidate,
            Set<GrantIntersectionEvaluator.PermissionAtom> ceiling) {
        Set<GrantIntersectionEvaluator.PermissionAtom> result = new LinkedHashSet<>();
        for (GrantIntersectionEvaluator.PermissionAtom atom : candidate) {
            if (isCoveredBy(atom, ceiling)) {
                result.add(atom);
            }
        }
        return Set.copyOf(result);
    }

    private boolean isSubset(Set<GrantIntersectionEvaluator.PermissionAtom> candidate,
                             Set<GrantIntersectionEvaluator.PermissionAtom> ceiling) {
        return candidate.stream().allMatch(atom -> isCoveredBy(atom, ceiling));
    }

    private boolean isCoveredBy(GrantIntersectionEvaluator.PermissionAtom candidate,
                                Set<GrantIntersectionEvaluator.PermissionAtom> ceiling) {
        return ceiling.stream().anyMatch(atom -> atom.actionClass().equals(candidate.actionClass())
                && ToolFaceRegistry.resourceCovers(candidate.actionClass(), atom.resource(),
                        candidate.resource()));
    }

    /** PLAN-0496 #2: credential atoms in the candidate that the ceiling does not cover. */
    private List<String> uncoveredCredentialAtoms(
            Set<GrantIntersectionEvaluator.PermissionAtom> candidate,
            Set<GrantIntersectionEvaluator.PermissionAtom> ceiling) {
        return candidate.stream()
                .filter(atom -> ToolFaceRegistry.isCredentialActionClass(atom.actionClass()))
                .filter(atom -> !isCoveredBy(atom, ceiling))
                .map(GrantIntersectionEvaluator.PermissionAtom::resource)
                .distinct()
                .sorted()
                .toList();
    }

    private ArrayNode toJson(Set<GrantIntersectionEvaluator.PermissionAtom> permissions) {
        ArrayNode result = objectMapper.createArrayNode();
        permissions.stream()
                .sorted(Comparator.comparing(GrantIntersectionEvaluator.PermissionAtom::actionClass)
                        .thenComparing(GrantIntersectionEvaluator.PermissionAtom::resource))
                .forEach(permission -> {
                    ObjectNode atom = objectMapper.createObjectNode();
                    atom.put("actionClass", permission.actionClass());
                    if (!"*".equals(permission.resource())) {
                        atom.put("resource", permission.resource());
                    }
                    result.add(atom);
                });
        return result;
    }

    private String optionalText(JsonNode node, String field) {
        if (node == null) {
            return null;
        }
        JsonNode value = node.get(field);
        return value != null && value.isTextual() && !value.asText().isBlank() ? value.asText() : null;
    }

    private UUID parseUuid(String value, String code) {
        if (value == null || value.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, code, "A valid UUID is required");
        }
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, code, "A valid UUID is required", e);
        }
    }

    /** PLAN-0622 M1.2 wire projection of a principal (list route, not the workspace binding). */
    public record AgentPrincipalView(UUID principalId, String name, String templateId, String templateName,
                                     Instant createdAt, String scope, UUID ownerUserId,
                                     String defaultModelProvider, String defaultModelName,
                                     JsonNode allowedModels, Instant disabledAt, JsonNode hooks,
                                     JsonNode contextPolicy) {}

    public record WorkspaceAgentView(UUID principalId, String name, String templateId,
                                     String templateName, Instant createdAt, JsonNode permissions,
                                     String source, boolean bound, boolean disabled, JsonNode hooks,
                                     JsonNode contextPolicy,
                                     // PLAN-0629: the workspace-scoped roles that authorize this row.
                                     java.util.List<UUID> roleIds) {}

    private record ActiveWorkspaceBinding(AgentPrincipal principal, WorkspaceAgent workspaceAgent) {}
}
