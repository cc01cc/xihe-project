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
import java.util.Comparator;
import java.util.List;
import java.util.LinkedHashSet;
import java.util.Objects;
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

    /**
     * PLAN-0629 (user ruling 2026-11-04): the default role an agent principal is bound to when a
     * workspace binding is created without an explicit role set. `WS_EDITOR` is the seeded workspace
     * role that keeps a fresh agent usable (read/write/delete/exec) without handing out management.
     */
    private static final String DEFAULT_AGENT_WORKSPACE_ROLE = "WS_EDITOR";
    /** D-174 (AGENT_USER seed): the instance role a fresh principal is bound to (no frozen ceiling). */
    private static final String DEFAULT_AGENT_INSTANCE_ROLE = "AGENT_USER";

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
    /** D-180: the structural default workspace binding passes the grant-side subset guard. */
    private final com.cc01cc.p.xihe.cp.policy.GrantabilityGuard grantability;
    /** D-180 锁序：instance mutex → role 行（稳定序）→ 主体/绑定/用户（RoleAdmin 同协议）。 */
    private final com.cc01cc.p.xihe.cp.repository.InstanceOwnerRepository owners;
    /** PLAN-0629: roles are the permission source, so bindings and materialization live here. */
    private final AccessRoleBindingRepository roleBindingRepository;
    private final AccessRoleRepository roleRepository;
    private final AccessRolePermissionRepository rolePermissionRepository;
    private final RoleGrantMaterializer roleMaterializer;
    /** PLAN-0773 M2-8b: the subject's org-unit governance grants join every evaluation read. */
    private final com.cc01cc.p.xihe.cp.policy.OrgUnitGrants orgUnitGrants;

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
                                 RequesterAuthority requesterAuthority,
                                 com.cc01cc.p.xihe.cp.policy.GrantabilityGuard grantability,
                                 com.cc01cc.p.xihe.cp.repository.InstanceOwnerRepository owners,
                                 com.cc01cc.p.xihe.cp.policy.OrgUnitGrants orgUnitGrants) {
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
        this.orgUnitGrants = orgUnitGrants;
        this.requesterAuthority = requesterAuthority;
        this.grantability = grantability;
        this.owners = owners;
    }
    /** Authorizes and creates the principal and its role bindings in one transaction. */
    @Transactional
    public AgentPrincipal createPrincipalFromTemplate(String actorUserId, String name, String templateId,
                                                      String defaultModelProvider,
                                                      String defaultModelName, JsonNode allowedModels, JsonNode hooks,
                                                      String origin, String presetId,
                                                      List<UUID> roleIds) {
        UUID actorId = parseUuid(actorUserId, "INVALID_ACTOR");
        requireUser(actorId);
        UUID workspaceContext = currentWorkspaceContext();
        // PLAN-0750 M1 (G1/G2): the gate reports the atom it authorized with, so the durable audit
        // names the real source instead of a hard-coded workspace-administration action.
        String authorizationAction = requireCreationAction(actorId, workspaceContext);
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
        return createPrincipal(actorUserId, name, resolvedTemplateId, resolved.snapshot(),
                defaultModelProvider, defaultModelName, allowedModels, effectiveHooks,
                builtinPreset ? AgentPrincipal.ORIGIN_SYSTEM_PRESET
                        : (origin == null || origin.isBlank() ? AgentPrincipal.ORIGIN_USER : origin),
                builtinPreset ? resolvedTemplateId : presetId, roleIds, authorizationAction);
    }

    /**
     * task-179 (PLAN-0771 M3, contract {@code d533613c}): the instance-layer create.
     *
     * <p>Two differences from {@link #createPrincipalFromTemplate}, both required by the contract
     * rather than by taste:</p>
     * <ol>
     *   <li>the authorizing atom is the instance-tier {@code MANAGE_AGENT_PRINCIPALS} (N1) evaluated
     *       at <b>instance scope</b> — {@code requireCreationAction} would demand
     *       {@code CREATE_OWN_AGENT} for a context-less request, which is the user door, not this
     *       one; and the atom string recorded in the durable audit is therefore N1, not a
     *       hard-coded workspace action;</li>
     *   <li>there is no workspace context at all: this prefix never reads
     *       {@code TenantContext.getWorkspaceId()} and never writes {@code workspace_agents}
     *       (PLAN-0771 2.4 — reach is granted later through the existing bind surface).</li>
     * </ol>
     *
     * <p>The row is created the same way every other principal is (owner column left null by
     * design, G2=(b)); pending decision #40 means the <b>path</b> is what makes it an instance
     * platform agent, not a stored discriminator, so this method deliberately writes no new
     * ownership state.</p>
     */
    @Transactional
    public AgentPrincipal createInstancePrincipal(String actorUserId, String name, String templateId,
                                                  String defaultModelProvider, String defaultModelName,
                                                  JsonNode allowedModels, JsonNode hooks, List<UUID> roleIds) {
        UUID actorId = parseUuid(actorUserId, "INVALID_ACTOR");
        requireUser(actorId);
        // N1 at instance scope (null workspace selects exactly the instance-scope grant rows).
        requireUserAction(actorId, ToolFaceRegistry.ACTION_MANAGE_AGENT_PRINCIPALS, "*", null);
        AgentTemplateService.ResolvedTemplate resolved = agentTemplateService.resolveForCreation(
                actorUserId, null, templateId);
        String resolvedTemplateId = optionalText(resolved.snapshot(), "templateId");
        boolean builtinPreset = "instance".equals(resolved.sourceLayer())
                && AgentPrincipal.BUILTIN_GUARD_PRESET_TEMPLATE_ID.equals(resolvedTemplateId);
        JsonNode templateHooks = resolved.snapshot().path("hooks");
        JsonNode effectiveHooks = hooks != null ? hooks
                : (templateHooks.isMissingNode() || templateHooks.isNull()) ? null : templateHooks.deepCopy();
        return createPrincipal(actorUserId, name, resolvedTemplateId, resolved.snapshot(),
                defaultModelProvider, defaultModelName, allowedModels, effectiveHooks,
                builtinPreset ? AgentPrincipal.ORIGIN_SYSTEM_PRESET : AgentPrincipal.ORIGIN_USER,
                builtinPreset ? resolvedTemplateId : null, roleIds,
                ToolFaceRegistry.ACTION_MANAGE_AGENT_PRINCIPALS);
    }

    /**
     * Authorizes a create and reports the atom that did it, so the audit records the real source
     * (PLAN-0750 M1, G1=(1a) + G2=(b), user ruling 2026-11-10).
     *
     * <p>The gate has <b>two independent doors</b> and they are never alias-merged:</p>
     * <ul>
     *   <li><b>user-level create</b> — no explicit workspace context (G3=(b): {@code source=default}
     *       counts as none) means "create a principal for myself": {@code CREATE_OWN_AGENT}, an
     *       instance-scope atom the human default set carries, so an ordinary account needs no
     *       workspace-administration right and needs no workspace at all. The created row carries
     *       no {@code owner_user_id} (G2=(b)) and no Workspace binding — reach is granted later by
     *       the explicit bind surface.</li>
     *   <li><b>workspace-tier create</b> — an explicit workspace context keeps the original
     *       D-174 requirement verbatim: {@code MANAGE_WORKSPACE_AGENTS} <em>in that workspace</em>.</li>
     * </ul>
     *
     * @return the action atom the caller was authorized with, for the durable audit
     */
    private String requireCreationAction(UUID actorId, UUID workspaceContext) {
        if (workspaceContext == null) {
            requireUserAction(actorId, ToolFaceRegistry.ACTION_CREATE_OWN_AGENT, "*", null);
            return ToolFaceRegistry.ACTION_CREATE_OWN_AGENT;
        }
        requireUserAction(actorId, ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS,
                workspaceContext.toString(), workspaceContext);
        return ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS;
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

    /** Persists a principal from an already authorized server-resolved snapshot. */
    @Transactional
    public AgentPrincipal createPrincipal(String actorUserId, String name, String templateId,
                                          JsonNode templateSnapshot) {
        return createPrincipal(actorUserId, name, templateId, templateSnapshot, null, null, null,
                null, AgentPrincipal.ORIGIN_USER, null, null);
    }

    /**
     * Validates and writes the principal and its instance role bindings atomically, recording the
     * caller-supplied authorizing atom in the durable audit.
     *
     * <p>The workspace-administration default keeps this overload's historical audit value for
     * server-internal callers that authorize the create themselves; the HTTP create path passes the
     * atom its gate actually used ({@code CREATE_OWN_AGENT} or {@code MANAGE_WORKSPACE_AGENTS}).</p>
     */
    @Transactional
    public AgentPrincipal createPrincipal(String actorUserId, String name, String templateId,
                                          JsonNode templateSnapshot,
                                          String defaultModelProvider, String defaultModelName,
                                          JsonNode allowedModels, JsonNode hooks,
                                          String origin, String presetId, List<UUID> roleIds) {
        return createPrincipal(actorUserId, name, templateId, templateSnapshot, defaultModelProvider,
                defaultModelName, allowedModels, hooks, origin, presetId, roleIds,
                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS);
    }

    /**
     * Same contract as the overload above, plus the atom the caller was actually authorized with.
     *
     * @param authorizationAction the authorizing action atom — {@code CREATE_OWN_AGENT} for a
     *     user-level create, {@code MANAGE_WORKSPACE_AGENTS} for a workspace-tier create. Recorded
     *     verbatim in {@code audit_logs.detail.authorizationAction}; a blank value falls back to the
     *     historical workspace value rather than writing an empty audit field.
     */
    @Transactional
    public AgentPrincipal createPrincipal(String actorUserId, String name, String templateId,
                                          JsonNode templateSnapshot,
                                          String defaultModelProvider, String defaultModelName,
                                          JsonNode allowedModels, JsonNode hooks,
                                          String origin, String presetId, List<UUID> roleIds,
                                          String authorizationAction) {
        // D-180 锁序：instance mutex 是第一把锁（RoleAdmin/BindingAdmin 同协议），之后才
        // ①锁角色行（validateGrantableRoles，稳定序）②写主体/绑定/用户。
        lockInstanceMutex();
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
        // PLAN-0750 M1 (G1/G2): the audit names the atom that actually authorized this create.
        // Hard-coding the workspace action would record a user-level create as an administrator
        // action — a security-relevant misattribution, not a wording problem.
        detail.put("authorizationAction", authorizationAction == null || authorizationAction.isBlank()
                ? ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS : authorizationAction);
        if (templateId != null) {
            detail.put("templateId", templateId);
        }
        detail.set("permissions", grantPermissions.deepCopy());
        auditLogger.recordDurableChange(actorId.toString(), null,
                "agent_principal_created", "agent_principal", savedPrincipal.getId().toString(), detail.toString());
        return savedPrincipal;
    }

    /**
     * The caller authorizes MANAGE_WORKSPACE_AGENTS; this service enforces membership and permission ceilings.
     *
     * <p>D-1109 (46A + 47A): {@code requestedPermissions == null} means "the caller omitted the
     * field" — the cap is then derived from the principal's ROLE BASELINE in this workspace and the
     * row records {@code cap_source='baseline'} (V161). A non-null array is explicit and frozen as
     * {@code cap_source='explicit'}; an empty array is an explicit ZERO cap, never "inherit"
     * (D-1109 guard 3 / 46C). Explicit atoms outside either ceiling are still refused with 403
     * {@code AGENT_PERMISSION_SCOPE_EXCEEDED} — nothing is silently truncated to the baseline
     * (D-1096). The read path ({@link #resolveCapFor}) is untouched: effective = role ∩ cap.</p>
     */
    @Transactional
    public WorkspaceAgent setWorkspaceCap(String actorUserId, UUID workspaceId, UUID principalId,
                                          JsonNode requestedPermissions) {
        UUID actorId = parseUuid(actorUserId, "INVALID_ACTOR");
        requireUser(actorId);
        // D-180 锁序：mutex 先于默认角色行锁与 binding/principal 写入（同 create）。
        lockInstanceMutex();
        workspaceService.requireActiveWorkspace(workspaceId.toString());
        requireWorkspaceMember(actorId, workspaceId);
        AgentPrincipal principal = requireActivePrincipal(principalId);
        // D25-02: a preset guard cap is fixed at the input side — the write side refuses.
        // Placed before the management check: the immutability is a property of the
        // TARGET principal, not of the actor's rights (origin is already member-visible).
        // resolveCapFor stays the single entry, untouched.
        requireMutableCap(principal);
        requireWorkspaceAgentManagement(actorId, workspaceId);
        requireBindingAuthority(actorId, principal);

        boolean inheritsBaseline = requestedPermissions == null;
        String capSource = inheritsBaseline
                ? WorkspaceAgent.CAP_SOURCE_BASELINE : WorkspaceAgent.CAP_SOURCE_EXPLICIT;
        Set<GrantIntersectionEvaluator.PermissionAtom> cap = inheritsBaseline
                ? roleBaselineAtoms(principalId, workspaceId)
                : parsePermissions(requestedPermissions);
        // D-174 + PLAN-0673 D-180: BOTH sides evaluate in the TARGET workspace (instance rows
        // participate everywhere, a workspace row only for its own workspace) — the pre-fix
        // unscoped reads let A's workspace-A write reach into workspace B.
        Set<GrantIntersectionEvaluator.PermissionAtom> principalPermissions =
                principalEffectiveAtoms(principalId, workspaceId);
        if (inheritsBaseline) {
            // D-1109: the baseline is read from the role the structural binding is about to
            // materialize, so it is inside the principal's ceiling by construction. Union it in
            // rather than skipping the gate: the ceiling stays "what this principal will hold",
            // and only the inherited path can reach these atoms (an explicit cap still answers to
            // the pre-write set, D-1096).
            Set<GrantIntersectionEvaluator.PermissionAtom> inheritedCeiling =
                    new LinkedHashSet<>(principalPermissions);
            inheritedCeiling.addAll(cap);
            principalPermissions = Set.copyOf(inheritedCeiling);
        }
        Set<GrantIntersectionEvaluator.PermissionAtom> actorPermissions = evaluator.union(
                grantRepository.findScopedGrants(GrantPrincipalPathResolver.USER, actorId,
                        GrantSources.EVALUATION_SOURCES, workspaceId));
        List<String> overPrincipal = exceeding(cap, principalPermissions);
        List<String> overActor = exceeding(cap, actorPermissions);
        if (!overPrincipal.isEmpty() || !overActor.isEmpty()) {
            // D-160 ③: the refusal names the exceeding atoms per side, in the 409 naming style
            // (atom@resource) — the grantor must already hold every atom it raises the cap to.
            throw new CpApiException(HttpStatus.FORBIDDEN, "AGENT_PERMISSION_SCOPE_EXCEEDED",
                    "Workspace cap exceeds held permissions: principal-exceeding="
                            + overPrincipal + " actor-exceeding=" + overActor);
        }

        WorkspaceAgentId bindingId = new WorkspaceAgentId(principalId, workspaceId);
        WorkspaceAgent binding = workspaceAgentRepository.findById(bindingId).orElse(null);
        boolean created = binding == null;
        Set<GrantIntersectionEvaluator.PermissionAtom> previous = Set.of();
        String previousSource = created ? null : binding.getCapSource();
        if (created) {
            binding = new WorkspaceAgent(principalId.toString(), workspaceId.toString(), toJson(cap),
                    capSource);
        } else {
            previous = parsePermissions(binding.getPermissionsSnapshot());
            // D-1109 guard 1: the same atom set under a different provenance is still a state
            // change (explicit -> baseline), otherwise "inherit" would leave no audit trace at all.
            if (previous.equals(cap) && capSource.equals(previousSource)) {
                return binding;
            }
            binding.setPermissionsSnapshot(toJson(cap));
            binding.setCapSource(capSource);
        }

        WorkspaceAgent savedBinding = workspaceAgentRepository.saveAndFlush(binding);
        // PLAN-0629: a binding materializes into a workspace role binding, so reachability has one
        // source of truth. Idempotent; the existing materializer writes the `source='role'` grants.
        ensureWorkspaceRoleBinding(principalId, workspaceId, actorId);
        ObjectNode detail = objectMapper.createObjectNode();
        detail.put("authorizationAction", "MANAGE_WORKSPACE_AGENTS");
        detail.put("principalId", principalId.toString());
        detail.put("capSource", capSource);
        if (previousSource != null) {
            detail.put("capSourceBefore", previousSource);
        }
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
     * BL-345 (user ruling 2026-11-06): true when {@code userId} owns {@code principalId}.
     *
     * <p>Two stable links exist on the principal row and both count as "mine": the PERSONAL
     * {@code owner_user_id} (the user-facing notion of ownership, set for PERSONAL principals) and
     * {@code created_by_user_id} (always set, the audit trail's creator). No second ownership table
     * is introduced — the relation is already persisted here.</p>
     */
    @Transactional(readOnly = true)
    public boolean isOwnedBy(UUID principalId, UUID userId) {
        if (principalId == null || userId == null) {
            return false;
        }
        AgentPrincipal principal = agentPrincipalRepository.findById(principalId).orElse(null);
        if (principal == null) {
            return false;
        }
        if (userId.equals(principal.getOwnerUserId())) {
            return true;
        }
        return principal.getCreatedByUserId() != null
                && principal.getCreatedByUserId().equalsIgnoreCase(userId.toString());
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
                                true, principal.getDisabledAt() != null,
                                principal.getHooks() == null ? null : principal.getHooks().deepCopy(),
                                principal.getContextPolicy() == null
                                        ? null : principal.getContextPolicy().deepCopy(),
                                rolesByPrincipal.getOrDefault(principal.getId(), List.of()),
                                binding.getCapSource()))
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
                        unboundView(principal, toJson(principalEffectiveAtoms(principal.getId(), workspaceId)),
                                rolesByPrincipal.getOrDefault(principal.getId(), List.of()))));
        // PLAN-0629 frozen semantics (kept under PLAN-0750 M2): the workspace union is
        // REACH-GATED — bindings ∪ workspace-role reach ∪ the caller's own legacy owner rows.
        // G13=(a) deliberately does NOT relax this arm to created_by: (1) instance principals
        // created by the caller would appear without any reach, and (2) unbind must keep
        // removing the row (RoleBindingIntegrationTest#unbindRevokesImmediately). A user-level
        // row carries no owner, so it is discovered through the personal view
        // (listPrincipals, G13=(a)) and enters a workspace only through the bind surface.
        agentPrincipalRepository.findByOwnerUserId(actorId).stream()
                .filter(principal -> !merged.containsKey(principal.getId()))
                .forEach(principal -> merged.put(principal.getId(),
                        unboundView(principal, toJson(principalEffectiveAtoms(principal.getId(), workspaceId)),
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

    static final java.util.Comparator<WorkspaceAgentView> WORKSPACE_AGENT_LIST_ORDER = java.util.Comparator
            .comparing((WorkspaceAgentView view) -> view.name() == null
                    ? "" : view.name().toLowerCase(java.util.Locale.ROOT))
            .thenComparing(view -> view.principalId().toString());

    private WorkspaceAgentView unboundView(AgentPrincipal principal, JsonNode cap,
                                           List<UUID> roleIds) {
        return new WorkspaceAgentView(principal.getId(), principal.getName(), principal.getTemplateId(),
                optionalText(principal.getTemplateSnapshot(), "templateName"), principal.getCreatedAt(), cap,
                false, principal.getDisabledAt() != null,
                principal.getHooks() == null ? null : principal.getHooks().deepCopy(),
                principal.getContextPolicy() == null ? null : principal.getContextPolicy().deepCopy(),
                roleIds,
                // no cap binding ⇒ no stored provenance; the view answers null (bound=false).
                null);
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

    /** Lists creator-visible principals, or all principals for instance management. */
    @Transactional(readOnly = true)
    public List<AgentPrincipalView> listPrincipals(String actorUserId, String workspaceIdValue) {
        UUID actorId = parseUuid(actorUserId, "INVALID_ACTOR");
        requireUser(actorId);
        if (workspaceIdValue == null || workspaceIdValue.isBlank()) {
            // PLAN-0750 M2 (G13=(a)): the personal view filters on created_by_user_id = self —
            // user-level principals carry no owner_user_id (G2=(b)), so the creator's visibility
            // rides on the audit creator column. Visibility only: the management atom still sees
            // everything, and the authorization surface (atoms + bindings) is unchanged.
            List<AgentPrincipal> visible = holdsAgentPrincipalManagementAtom(actorId)
                    ? agentPrincipalRepository.findAll()
                    : agentPrincipalRepository.findByCreatedByUserId(actorId.toString());
            return visible.stream().map(this::toPrincipalView).toList();
        }
        UUID workspaceId = parseUuid(workspaceIdValue, "INVALID_WORKSPACE_CONTEXT");
        return listWorkspaceAgents(actorUserId, workspaceId).stream()
                .map(view -> agentPrincipalRepository.findById(view.principalId()))
                .flatMap(java.util.Optional::stream)
                .map(this::toPrincipalView)
                .toList();
    }

    /**
     * task-179 (PLAN-0771 M3, contract {@code d533613c}): the instance-layer read face.
     *
     * <p>The contract is explicit that this list is <b>not</b> caller-scoped: "GET
     * /api/v1/agent-principals answers what this caller may use … this path answers what the
     * deployment installed — no owner filter, no created_by filter, no workspaceId query". So it
     * does not go through {@link #listPrincipals} (which filters by {@code created_by} for callers
     * without the management atom); every authenticated caller sees the same set.</p>
     *
     * <p>Honest limit (pending decision #40, option 40A "path 即归属"): {@code agent_principals}
     * carries no ownership column, so "the deployment installed" cannot be filtered from the row —
     * this returns the whole principal set, and the path is what makes the face an instance face.
     * When #40 lands as 40B/40C the filter arrives here, in one place.</p>
     */
    @Transactional(readOnly = true)
    public List<AgentPrincipalView> listInstancePrincipals() {
        return agentPrincipalRepository.findAll().stream().map(this::toPrincipalView).toList();
    }

    private AgentPrincipalView toPrincipalView(AgentPrincipal principal) {
        return new AgentPrincipalView(principal.getId(), principal.getName(), principal.getTemplateId(),
                optionalText(principal.getTemplateSnapshot(), "templateName"), principal.getCreatedAt(),
                principal.getOwnerUserId(), principal.getDefaultModelProvider(),
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
                ? evaluator.union(orgUnitGrants.merge(grantRepository.findScopedGrants(
                        GrantPrincipalPathResolver.AGENT_PRINCIPAL, principal.getId(),
                        GrantSources.EVALUATION_SOURCES, workspaceId),
                        orgUnitGrants.forPrincipal(GrantPrincipalPathResolver.AGENT_PRINCIPAL,
                                principal.getId())))
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
            // Lead ruling 2026-11-05: this is the creation-time DEFAULT grant ⇒ seed binding
            // (immutable via ROLE_BINDING_IMMUTABLE). API bindings created later stay deletable.
            AccessRoleBinding row = new AccessRoleBinding(roleId,
                    GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId, "instance", null, actorId);
            row.setSeed(true);
            roleBindingRepository.save(row);
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
        // D-180: ids null-checked first, then locked in STABLE (sorted) order — the mutex comes
        // from the create entry, so the order is mutex → role rows → principal/binding writes.
        List<UUID> effective = roleIds == null || roleIds.isEmpty()
                ? List.of(requireRole(DEFAULT_AGENT_INSTANCE_ROLE).getId())
                : roleIds;
        if (effective.stream().anyMatch(java.util.Objects::isNull)) {
            throw notGrantable("roleIds must not contain null");
        }
        for (UUID roleId : new java.util.LinkedHashSet<>(
                effective.stream().sorted().toList())) {
            AccessRole role = roleRepository.findByIdForUpdate(roleId)
                    .orElseThrow(() -> notGrantable("roleId is not bindable"));
            List<String> atomNames = roleAtomNames(roleId);
            String forbidden = PermissionAtomCatalog.firstForbiddenAgentPrincipalAtom(atomNames);
            if (forbidden != null) {
                throw notGrantable("instance-admin role cannot be bound to an agent principal ("
                        + forbidden + ")");
            }
            // PLAN-0673 ④: the subset decision is the shared guard at the INSTANCE target scope —
            // the caller's instance rows cover every workspace; a workspace-only hold does not
            // (workspace ⊉ instance). GRANT_ANY_ATOM bypasses with an audit (guard-side).
            grantabilityAs(actorId, new LinkedHashSet<>(atomNames),
                    com.cc01cc.p.xihe.cp.policy.AccessScope.instance());
        }
    }

    /**
     * D-180: run the shared guard with the explicit service actor (the C6 "no TenantContext in
     * service internals" contract keeps tests and non-request callers honest) — same subject, no
     * context smuggling; the caller's context is restored afterwards.
     */
    private void grantabilityAs(UUID actorId, Set<String> atoms,
                                com.cc01cc.p.xihe.cp.policy.AccessScope scope) {
        String previous = TenantContext.getUserId();
        try {
            TenantContext.setUserId(actorId.toString());
            grantability.assertGrantable(atoms, scope);
        } finally {
            if (previous == null || previous.isBlank()) {
                TenantContext.clear();
            } else {
                TenantContext.setUserId(previous);
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

    /**
     * D-180 锁序（与 RoleAdminService/BindingAdminService 同协议）：instance_owner 写互斥是第一把锁，
     * 其后才允许 role 行锁（稳定序）与主体/绑定/用户写入。
     */
    private void lockInstanceMutex() {
        owners.lockSingleton().orElseGet(() -> owners.save(new com.cc01cc.p.xihe.cp.entity.InstanceOwner()));
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
        java.util.Collection<AuthorizationGrant> expanded =
                orgUnitGrants.forPrincipal(GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId);
        if (!roleRows.isEmpty()) {
            return evaluator.union(orgUnitGrants.merge(roleRows, expanded));
        }
        return evaluator.union(orgUnitGrants.merge(grantRepository.findScopedGrants(
                GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId,
                GrantSources.EVALUATION_SOURCES, workspaceId), expanded));
    }

    /**
     * D-1109 (46A + 47A): the ROLE BASELINE of a principal in one workspace — what the write path
     * must copy into the cap when the caller omits {@code permissions}, so a fresh binding is born
     * with the same shape as a V160-repaired row instead of "grants have it, the snapshot does not".
     *
     * <p>Three sources, unioned:</p>
     * <ol>
     *   <li>the materialized {@code source='role'} grants for this subject in this workspace
     *       (PLAN-0629 read path — reach is a role binding);</li>
     *   <li>{@code source='credential_binding'} grants (PLAN-0494 active mechanism) — leaving them
     *       out would let this frozen cap silently drop a credential atom at evaluation time;</li>
     *   <li>when no workspace role binding exists yet, the atoms {@code ensureWorkspaceRoleBinding}
     *       is about to materialize from the seeded default role. Reading them here (rather than
     *       moving the binding write earlier) keeps the zero-write refusal guarantees of D-180 —
     *       a refused cap must leave role_bindings/grants at zero rows.</li>
     * </ol>
     * Capability atoms and agent-forbidden atoms are skipped: the materializer never turns them
     * into grants, so counting them would invent a capability the evaluator drops anyway.
     *
     * <p><b>PLAN-0773 M2-8b: org-unit grants are deliberately <i>not</i> merged here</b> — this is a
     * write-side baseline ({@code D-1109}: what the write path copies into a workspace agent cap),
     * not an evaluation gate. The org-unit rows are {@code instance}-scope governance grants;
     * copying them into a workspace cap would widen a snapshot beyond the scope it models, and a
     * boundary crossed by accident is harder to notice than one that is merely missing (an
     * under-grant shows up as a 403, an over-grant shows up as nothing at all). Registered as
     * {@code TODO(M2-8b follow-up)} rather than silently wired.</p>
     */
    private Set<GrantIntersectionEvaluator.PermissionAtom> roleBaselineAtoms(UUID principalId,
                                                                            UUID workspaceId) {
        Set<GrantIntersectionEvaluator.PermissionAtom> baseline = new LinkedHashSet<>(
                evaluator.union(grantRepository.findScopedGrants(
                        GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId,
                        List.of(GrantSources.ROLE, GrantSources.CREDENTIAL_BINDING), workspaceId)));
        if (workspaceRoleIds(principalId, workspaceId).isEmpty()) {
            AccessRole defaultRole = requireRole(DEFAULT_AGENT_WORKSPACE_ROLE);
            for (String name : roleAtomNames(defaultRole.getId())) {
                if (!PermissionAtomCatalog.isActionAtom(name)
                        || PermissionAtomCatalog.firstForbiddenAgentPrincipalAtom(List.of(name)) != null) {
                    continue;
                }
                baseline.add(new GrantIntersectionEvaluator.PermissionAtom(name,
                        PermissionAtomCatalog.atom(name).canonicalResource()));
            }
        }
        return Set.copyOf(baseline);
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
        // D-180 锁序：role 行锁在 mutex 之后（上层已取），写入前持锁防并发改原子（TOCTOU）。
        defaultRole = roleRepository.findByIdForUpdate(defaultRole.getId())
                .orElseThrow(() -> new CpApiException(HttpStatus.INTERNAL_SERVER_ERROR,
                        "ROLE_CATALOG_INCONSISTENT",
                        "Seeded role " + DEFAULT_AGENT_WORKSPACE_ROLE + " vanished under lock"));
        // D-180: the structural default binding must still clear BOTH gates before any write —
        // ① the agent-principal forbidden hard gate (GRANT_ANY_ATOM bypass never skips it) and
        // ② the grant-side subset guard in the TARGET scope (grantor must hold every atom of the
        //    default role here; instance rows cover all workspaces, a workspace row covers only its
        //    own). A refusal throws inside the transaction ⇒ binding/workspace_agents/grants stay
        //    at zero rows (403 grantor gate — never the cap's 409).
        List<String> defaultRoleAtoms = rolePermissionRepository.findByIdRoleId(defaultRole.getId())
                .stream().map(row -> row.getId().getActionClass()).toList();
        String forbidden = PermissionAtomCatalog.firstForbiddenAgentPrincipalAtom(defaultRoleAtoms);
        if (forbidden != null) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "ROLE_NOT_GRANTABLE",
                    "default workspace role carries an atom that cannot be granted to an agent: "
                            + forbidden);
        }
        grantabilityAs(actorId, new LinkedHashSet<>(defaultRoleAtoms),
                com.cc01cc.p.xihe.cp.policy.AccessScope.workspace(workspaceId));
        // Lead ruling 2026-11-05: workspace-binding default grant ⇒ seed binding (immutable).
        AccessRoleBinding row = new AccessRoleBinding(defaultRole.getId(),
                GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId, "workspace", workspaceId,
                actorId);
        row.setSeed(true);
        roleBindingRepository.save(row);
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
    @Transactional
    public boolean disablePrincipal(String actorUserId, UUID principalId) {
        return disable(actorUserId, principalId, true);
    }

    /**
     * task-179 (PLAN-0771 M3, contract {@code d533613c}): {@code DELETE /api/v1/instance/agent-principals/{id}}
     * is the <b>retire</b> spelling — {@code disabledAt} is set, the row is kept (principal rows are
     * never hard-deleted; FK {@code ON DELETE RESTRICT} keeps historical session/delegation
     * references intact), and it is idempotent (an already-retired row answers 204 again).
     *
     * <p>The only difference from {@link #disablePrincipal} is the deliberately skipped
     * {@code WORKSPACE_CONTEXT_REQUIRED} gate: that 409 exists to close a user-surface existence
     * oracle (D22/D-196), and on the instance prefix there is no workspace context to require —
     * the contract says the code is never raised here. The authority matrix underneath is
     * unchanged (an instance admin holds N1, so it passes on the first channel).</p>
     */
    @Transactional
    public boolean disableInstancePrincipal(String actorUserId, UUID principalId) {
        return disable(actorUserId, principalId, false);
    }

    private boolean disable(String actorUserId, UUID principalId, boolean requireWorkspaceContext) {
        UUID actorId = parseUuid(actorUserId, "INVALID_ACTOR");
        requireUser(actorId);
        AgentPrincipal principal = agentPrincipalRepository.findById(principalId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND,
                        "AGENT_PRINCIPAL_NOT_FOUND", "Agent principal not found"));
        // D-196/BL-336 order (revises D22): existence (404) → scope-aware context (409) → authority
        // (403). The lookup is here only to learn the subject's scope; nothing from it is echoed in
        // the 409 branch, and the residual 404-vs-409 oracle is documented on the method below.
        if (requireWorkspaceContext) {
            requireWorkspaceContextFor(principal);
        }
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

    /**
     * BL-326 (2026-11-05 Lead ruling, D22): every <b>agent-principal write</b> must be answered only
     * inside an explicit workspace context, and this check is deliberately the <b>first</b> thing a
     * mutation does — before {@code findById}.
     *
     * <p>Order matters for security, not style: with the lookup first, a caller without a context
     * could distinguish "no such principal" (404) from "exists but is not yours" (403) — an existence
     * oracle. Answering {@code 409 WORKSPACE_CONTEXT_REQUIRED} up front tells every out-of-context
     * caller exactly the same thing. The ratified order is therefore:
     * context (409) → existence (404) → owner/atom authority (403).</p>
     */
    /**
     * D-196 / BL-336 (2026-11-06 Lead ruling, <b>revises D22</b>): the workspace-context requirement is
     * <b>scope-aware</b>, not unconditional.
     *
     * <p>D22 answered {@code 409 WORKSPACE_CONTEXT_REQUIRED} before anything else, for every principal.
     * That closed the existence oracle but silently took a real capability away: an <b>instance-scope</b>
     * principal (a user's own agent, and preset guards) has no workspace by construction, so demanding a
     * workspace context makes its {@code disable} / {@code PATCH} unreachable from the API — a product
     * regression, not a test-only artifact.</p>
     *
     * <p>So the gate is now keyed on the <b>subject's scope</b>:</p>
     * <ul>
     *   <li><b>workspace-scope</b> principal ({@code owner_user_id} null, i.e. the D-174 "owner =
     *       workspace" rows; preset guards excluded — they are instance assets) ⇒ a context is required,
     *       because only then can "not found" and "not in your workspace" be told apart;</li>
     *   <li><b>instance-scope</b> principal (personal rows, preset guards) ⇒ <b>no</b> context required;
     *       authority is the owner / instance-atom matrix as before.</li>
     * </ul>
     *
     * <p><b>Residual oracle, stated instead of denied</b>: because existence is now resolved first (the
     * row must be read to learn its scope), a context-less caller can distinguish {@code 404} (no such
     * id) from {@code 409} (exists and is workspace-scoped). Accepted: ids are UUIDv4 and unguessable,
     * and before D22 the same caller could distinguish 404 from 403 anyway, which leaked strictly more
     * (existence <i>plus</i> ownership). What D22 bought — "never reveal a workspace-scoped row's
     * existence to a caller with no workspace" — would cost every personal principal its write surface,
     * so the trade goes the other way. See {@code docs/api/inventory.md} for the same statement on the
     * wire contract.</p>
     */
    private static void requireWorkspaceContextFor(AgentPrincipal principal) {
        if (!isWorkspaceScoped(principal)) {
            return;
        }
        String workspaceId = TenantContext.getWorkspaceId();
        if (workspaceId == null || workspaceId.isBlank()) {
            throw new CpApiException(HttpStatus.CONFLICT, "WORKSPACE_CONTEXT_REQUIRED",
                    "Changing a workspace-scoped agent principal requires a workspace context");
        }
    }

    /**
     * The D-174 scope rule, in one place: a principal is <b>workspace-scoped</b> when it has no owning
     * user (creation stopped writing {@code owner_user_id}; the workspace owns the row) and it is not a
     * preset guard (a system asset that lives at the instance level even though it has no owner either).
     */
    private static boolean isWorkspaceScoped(AgentPrincipal principal) {
        return principal.getOwnerUserId() == null
                && !AgentPrincipal.ORIGIN_SYSTEM_PRESET.equals(principal.getOrigin());
    }

    /**
     * BL-331 / D-206 (方案 A, 2026-11-05 user ruling): who may <b>change</b> an existing agent principal.
     *
     * <p>Three disjoint grants, evaluated as a <b>union</b> — none replaces another:</p>
     * <ol>
     *   <li><b>instance override</b> — a holder of {@code MANAGE_AGENT_PRINCIPALS} (N1) may manage any
     *       principal, in any workspace. This is the cross-workspace channel and stays exactly as
     *       before (not a replacement for the workspace channel below);</li>
     *   <li><b>legacy owner</b> — {@code agent_principals.owner_user_id} still authorizes its own row
     *       (PLAN-0622 rows). D-174 stopped writing the column, so this is a historical path only;</li>
     *   <li><b>workspace management</b> — an actor holding {@code MANAGE_WORKSPACE_AGENTS} in a
     *       workspace that <b>binds</b> this principal may manage it. This is the D-206 addition and it
     *       puts {@code disable}/{@code PATCH} in the same family as {@code setWorkspaceCap} /
     *       {@code unbindWorkspace}: a workspace that owns the binding also owns the lifecycle write.
     *       Before it, a workspace-scope principal (owner column null by design) could only be changed
     *       by an instance administrator — the P1 gap BL-331 recorded.</li>
     * </ol>
     *
     * <p>Deliberately <b>not</b> here: any {@code owner_user_id} snapshot write (方案 C was rejected)
     * and any change to "owner = workspace" semantics; the gate order stays
     * context (409) → existence (404) → authority (403) as ratified in D22.</p>
     */
    private void requireDisableAuthority(UUID actorId, AgentPrincipal principal) {
        if (holdsAgentPrincipalManagementAtom(actorId)) {
            // (1) instance override channel
            return;
        }
        if (actorId.equals(principal.getOwnerUserId())) {
            // (2) legacy owned row
            return;
        }
        for (UUID workspaceId : boundWorkspaceIds(principal.getId())) {
            // (3) the workspace that binds this principal manages it through its own atom
            if (requesterAuthority.holdsActionAtom(actorId,
                    ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS, workspaceId)) {
                return;
            }
        }
        // PLAN-0651 T1.5 (proposal B): the agent-principal-face denial joins the canonical
        // action_atom_denied stream (the instance atom; workspace channel misses are checked
        // per binding above, and none of the three channels matched — B4: atom layer only).
        requesterAuthority.logActionAtomDenied(
                ToolFaceRegistry.ACTION_MANAGE_AGENT_PRINCIPALS, actorId, null);
        throw new CpApiException(HttpStatus.FORBIDDEN, "AGENT_PRINCIPAL_OWNER_MISMATCH",
                "Only the owner, a holder of MANAGE_AGENT_PRINCIPALS, or an administrator of a "
                        + "workspace that binds this agent principal may change it");
    }

    /** The workspaces whose {@code workspace_agents} row binds this principal (D-206 authority set). */
    private List<UUID> boundWorkspaceIds(UUID principalId) {
        return workspaceAgentRepository.findByIdPrincipalId(principalId).stream()
                .map(binding -> binding.getId().getWorkspaceId())
                .filter(Objects::nonNull)
                .toList();
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
     * <p>Distinct code on purpose: {@code 403 AGENT_PRINCIPAL_OWNER_MISMATCH} tells the caller
     * which authority is missing without disclosing whether the principal exists (the caller
     * already reached this point with a valid workspace gate, so the principal id is theirs). The
     * denial is logged through {@code RequesterAuthority#logActionAtomDenied} (PLAN-0651 T1.5
     * proposal B).</p>
     */
    private void requireBindingAuthority(UUID actorId, AgentPrincipal principal) {
        if (principal.getOwnerUserId() != null && !actorId.equals(principal.getOwnerUserId())) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "AGENT_PRINCIPAL_OWNER_MISMATCH",
                    "An owned agent principal may only be bound by its owner");
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
        return applySettings(actorUserId, principalId, patch, true);
    }

    /**
     * task-179 (PLAN-0771 M3, contract {@code d533613c}): {@code PATCH /api/v1/instance/agent-principals/{id}}
     * keeps the subject-document semantics verbatim (at least one key, explicit null clears, absent
     * key untouched, echo the persisted documents) and only drops the
     * {@code WORKSPACE_CONTEXT_REQUIRED} gate — the contract states that code is never raised on
     * this prefix, which carries no workspace context at all (D22's gate belongs to the
     * non-instance surface). Gate order here stays existence (404) → authority (403).
     */
    @Transactional
    public PrincipalSettings applyInstancePrincipalSettings(String actorUserId, UUID principalId,
                                                            PrincipalSettingsPatch patch) {
        return applySettings(actorUserId, principalId, patch, false);
    }

    private PrincipalSettings applySettings(String actorUserId, UUID principalId,
                                            PrincipalSettingsPatch patch, boolean requireWorkspaceContext) {
        UUID actorId = parseUuid(actorUserId, "INVALID_ACTOR");
        requireUser(actorId);
        // Validate before the lookup: a malformed document must never need a row to be rejected
        // (the pre-0629 contract asserted by AgentPrincipalHooksServiceTest). D-196 keeps that order:
        // body shape is a 400 regardless of context, so this stays ahead of the scope-aware 409.
        JsonNode checkedHooks = patch.hooksPresent()
                ? HookAdvisorRegistry.validateSubscriptions(patch.hooks()) : null;
        JsonNode checkedPolicy = patch.contextPolicyPresent()
                ? ContextPolicyValidator.validate(patch.contextPolicy()) : null;
        JsonNode checkedDelegation = patch.delegationPolicyPresent()
                ? DelegationPolicyValidator.validate(patch.delegationPolicy()) : null;
        // task-413: the allow-list shape is a body-shape rule, so it is validated here (before the
        // lookup) exactly like the documents. The both-or-neither rule needs the STORED halves, so it
        // runs after the lookup on the merged pair — one rule function, no second copy.
        boolean modelIntentPresent = patch.defaultModelProviderPresent()
                || patch.defaultModelNamePresent() || patch.allowedModelsPresent();
        JsonNode checkedAllowedModels = patch.allowedModelsPresent()
                ? normalizeModelIntent(null, null, patch.allowedModels()) : null;
        AgentPrincipal principal = agentPrincipalRepository.findById(principalId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND,
                        "AGENT_PRINCIPAL_NOT_FOUND", "Agent principal not found"));
        // D-196/BL-336: same scope-aware gate as disable — a personal (instance-scope) principal stays
        // writable without a workspace context; a workspace-scoped one needs the explicit context.
        if (requireWorkspaceContext) {
            requireWorkspaceContextFor(principal);
        }
        if (patch.hooksPresent()) {
            requireMutableHooks(principal);
        }
        if (patch.contextPolicyPresent()) {
            requireMutableContextPolicy(principal);
        }
        if (patch.delegationPolicyPresent()) {
            requireMutableDelegationPolicy(principal);
        }
        if (modelIntentPresent) {
            requireMutableModelIntent(principal);
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
        if (modelIntentPresent) {
            // Merge-then-validate: a present key replaces, an absent key keeps the stored half, an
            // explicit null clears. Only the pair rule is re-checked here (the allow-list was already
            // shape-checked above), so "change just the model name" is legal while clearing one half
            // alone is the same 400 INVALID_AGENT_PRINCIPAL create answers.
            String mergedProvider = patch.defaultModelProviderPresent()
                    ? patch.defaultModelProvider() : principal.getDefaultModelProvider();
            String mergedModel = patch.defaultModelNamePresent()
                    ? patch.defaultModelName() : principal.getDefaultModelName();
            if (patch.defaultModelProviderPresent() || patch.defaultModelNamePresent()) {
                normalizeModelIntent(mergedProvider, mergedModel, null);
            }
            if (patch.defaultModelProviderPresent()) {
                principal.setDefaultModelProvider(blankToNull(mergedProvider));
            }
            if (patch.defaultModelNamePresent()) {
                principal.setDefaultModelName(blankToNull(mergedModel));
            }
            if (patch.allowedModelsPresent()) {
                principal.setAllowedModels(checkedAllowedModels);
            }
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
        if (modelIntentPresent) {
            ObjectNode detail = objectMapper.createObjectNode();
            detail.put("defaultModelProvider", principal.getDefaultModelProvider());
            detail.put("defaultModelName", principal.getDefaultModelName());
            detail.put("allowedModels", principal.getAllowedModels() == null
                    ? "null" : principal.getAllowedModels().toString());
            auditLogger.recordDurableChange(actorId.toString(), null,
                    "agent_principal_model_intent_updated", "agent_principal", principalId.toString(),
                    detail.toString());
        }
        return new PrincipalSettings(principal.getHooks(), principal.getContextPolicy(),
                principal.getDelegationPolicy(), principal.getDefaultModelProvider(),
                principal.getDefaultModelName(), principal.getAllowedModels());
    }

    /**
     * task-413: PATCH stores a blank provider/model as NULL, the same reading
     * {@link #normalizeModelIntent} already applies when it validates the pair. Create keeps the raw
     * value it was given (pre-existing behaviour, deliberately not changed here).
     */
    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }

    /**
     * One PATCH's parsed documents. The presence flags exist because a present-but-null document means
     * "clear the column" while an absent one means "leave it alone" — {@code JsonNode} alone cannot say both.
     */
    public record PrincipalSettingsPatch(JsonNode hooks, boolean hooksPresent,
                                         JsonNode contextPolicy, boolean contextPolicyPresent,
                                         JsonNode delegationPolicy, boolean delegationPolicyPresent,
                                         String defaultModelProvider, boolean defaultModelProviderPresent,
                                         String defaultModelName, boolean defaultModelNamePresent,
                                         JsonNode allowedModels, boolean allowedModelsPresent) {

        /** Documents-only patch (the pre-task-413 shape): every model-intent key is absent. */
        public PrincipalSettingsPatch(JsonNode hooks, boolean hooksPresent,
                                      JsonNode contextPolicy, boolean contextPolicyPresent,
                                      JsonNode delegationPolicy, boolean delegationPolicyPresent) {
            this(hooks, hooksPresent, contextPolicy, contextPolicyPresent, delegationPolicy,
                    delegationPolicyPresent, null, false, null, false, null, false);
        }
    }

    /**
     * The subject-level documents and model intent after a write, all read back from the persisted row
     * (task-413 added the triple so the edit face renders persisted state, including a kept half).
     */
    public record PrincipalSettings(JsonNode hooks, JsonNode contextPolicy, JsonNode delegationPolicy,
                                    String defaultModelProvider, String defaultModelName,
                                    JsonNode allowedModels) {}

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
    /**
     * task-413: a preset guard's model intent is preset-owned, the same D25-03 "a guard is a system
     * asset" reasoning as its cap / hooks / memory policy / delegation budget. The judge model decides
     * how a guard adjudicates, so letting the API swap it would be the same class of bypass D25-14
     * refused for hooks. Its own code ({@code GUARD_MODEL_INTENT_IMMUTABLE}) rather than a sibling's,
     * for the D25-14 reason: the refusals say different things.
     */
    private void requireMutableModelIntent(AgentPrincipal principal) {
        if (AgentPrincipal.ORIGIN_SYSTEM_PRESET.equals(principal.getOrigin())) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "GUARD_MODEL_INTENT_IMMUTABLE",
                    "A preset guard's model intent is fixed; a guard is a system asset, "
                            + "so its judge model is not a user setting");
        }
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

    /** D-160 ③: the exceeding atoms in the 409 naming style (`atom@resource`), sorted, deduped. */
    private List<String> exceeding(Set<GrantIntersectionEvaluator.PermissionAtom> cap,
                                   Set<GrantIntersectionEvaluator.PermissionAtom> ceiling) {
        return cap.stream().filter(atom -> !isCoveredBy(atom, ceiling))
                .map(atom -> atom.actionClass() + "@" + atom.resource())
                .distinct().sorted().toList();
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
                                     Instant createdAt, UUID ownerUserId,
                                     String defaultModelProvider, String defaultModelName,
                                     JsonNode allowedModels, Instant disabledAt, JsonNode hooks,
                                     JsonNode contextPolicy) {}

    public record WorkspaceAgentView(UUID principalId, String name, String templateId,
                                     String templateName, Instant createdAt, JsonNode permissions,
                                     boolean bound, boolean disabled, JsonNode hooks,
                                     JsonNode contextPolicy,
                                     // PLAN-0629: the workspace-scoped roles that authorize this row.
                                     java.util.List<UUID> roleIds,
                                     // D-1109: provenance of the frozen cap (null = no cap row).
                                     String capSource) {}

    private record ActiveWorkspaceBinding(AgentPrincipal principal, WorkspaceAgent workspaceAgent) {}
}
