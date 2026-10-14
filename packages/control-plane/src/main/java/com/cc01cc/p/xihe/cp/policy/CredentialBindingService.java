package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.auth.AuthService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.credentials.CredentialService;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0496 M2 (T2.1; contract: 0494 #12/#13 + 0496 §方案 5 / decisions #3/#6/#8):
 * the Policy-owned direct-grant write path for credential bindings. Binding an
 * existing Agent principal to credentials adds {@code credential_use@credential:<id>}
 * to both the principal's direct grant and the Workspace cap in one transaction
 * (all-or-nothing), under the credential_manage@credential:&lt;id&gt; action gate,
 * the operator ceiling (only the newly added atoms must be covered by the actor)
 * and the reference-existence check (0496 I4). Unbinding removes the same atoms.
 *
 * <p>Scope (0494 #13): bindings apply to new sessions only — existing session
 * permission snapshots stay frozen because they were derived at creation time
 * via {@code AgentPrincipalService.resolveSessionCap}.</p>
 */
@Service
public class CredentialBindingService {

    private static final String SOURCE_DIRECT = "direct";
    private static final String ACTION_BINDING_ADDED = "credential_binding_added";
    private static final String ACTION_BINDING_REMOVED = "credential_binding_removed";

    private final AuthorizationGrantRepository grantRepository;
    private final WorkspaceAgentRepository workspaceAgentRepository;
    private final GrantIntersectionEvaluator evaluator;
    private final AuditLogger auditLogger;
    private final ObjectMapper objectMapper;
    private final CredentialService credentialService;
    private final AuthService authService;
    private final WorkspaceService workspaceService;

    public CredentialBindingService(AuthorizationGrantRepository grantRepository,
            WorkspaceAgentRepository workspaceAgentRepository,
            GrantIntersectionEvaluator evaluator,
            AuditLogger auditLogger,
            ObjectMapper objectMapper,
            CredentialService credentialService,
            AuthService authService,
            WorkspaceService workspaceService) {
        this.grantRepository = grantRepository;
        this.workspaceAgentRepository = workspaceAgentRepository;
        this.evaluator = evaluator;
        this.auditLogger = auditLogger;
        this.objectMapper = objectMapper;
        this.credentialService = credentialService;
        this.authService = authService;
        this.workspaceService = workspaceService;
    }

    /** Adds credential_use atoms for the given credentials to the principal grant and the cap. */
    @Transactional
    public void bindCredentialAtoms(String actorUserId, UUID workspaceId, UUID principalId,
            List<String> credentialResources) {
        BindingPlan plan = plan(actorUserId, workspaceId, principalId, credentialResources, true);
        Set<GrantIntersectionEvaluator.PermissionAtom> useAtoms = useAtoms(plan.resources());
        requireOperatorCeiling(plan.actorPermissions(), useAtoms);

        Set<GrantIntersectionEvaluator.PermissionAtom> principalNew = union(plan.principalPermissions(), useAtoms);
        Set<GrantIntersectionEvaluator.PermissionAtom> capNew = union(plan.cap(), useAtoms);
        for (GrantIntersectionEvaluator.PermissionAtom atom : capNew) {
            if (!coveredBy(atom, principalNew)) {
                throw new CpApiException(HttpStatus.FORBIDDEN, "AGENT_PERMISSION_SCOPE_EXCEEDED",
                        "Workspace cap would exceed the principal permissions");
            }
        }

        mergePrincipalDirectGrant(plan.principalId(), plan.actorId(), useAtoms, Set.of());
        writeCap(plan.binding(), capNew);
        recordBinding(plan.actorId(), plan.workspaceId(), plan.principalId(), plan.resources(),
                ACTION_BINDING_ADDED);
    }

    /**
     * Removes the credential_use atoms added by {@link #bindCredentialAtoms}.
     *
     * <p>Round-4 fix: unbinding skips the reference-existence check on purpose — I4
     * fences the creation of new references, while removal must stay possible for a
     * soft-deleted credential (otherwise the dangling atoms the delete report surfaces
     * could never be cleaned through the API).</p>
     */
    @Transactional
    public void unbindCredentialAtoms(String actorUserId, UUID workspaceId, UUID principalId,
            List<String> credentialResources) {
        BindingPlan plan = plan(actorUserId, workspaceId, principalId, credentialResources, false);
        Set<GrantIntersectionEvaluator.PermissionAtom> useAtoms = useAtoms(plan.resources());

        mergePrincipalDirectGrant(plan.principalId(), plan.actorId(), Set.of(), useAtoms);
        Set<GrantIntersectionEvaluator.PermissionAtom> capNew = new LinkedHashSet<>(plan.cap());
        capNew.removeAll(useAtoms);
        writeCap(plan.binding(), capNew);
        recordBinding(plan.actorId(), plan.workspaceId(), plan.principalId(), plan.resources(),
                ACTION_BINDING_REMOVED);
    }

    /** PLAN-0496 T3.1: batch bind across principals — all-or-nothing (single transaction). */
    @Transactional
    public void bindToPrincipals(String actorUserId, UUID workspaceId, List<UUID> principalIds,
            List<String> credentialResources) {
        if (principalIds == null || principalIds.isEmpty()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "agentPrincipalIds is required");
        }
        for (UUID principalId : principalIds) {
            bindCredentialAtoms(actorUserId, workspaceId, principalId, credentialResources);
        }
    }

    /** PLAN-0496 T3.1: batch unbind across principals — all-or-nothing (single transaction). */
    @Transactional
    public void unbindFromPrincipals(String actorUserId, UUID workspaceId, List<UUID> principalIds,
            List<String> credentialResources) {
        if (principalIds == null || principalIds.isEmpty()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "agentPrincipalIds is required");
        }
        for (UUID principalId : principalIds) {
            unbindCredentialAtoms(actorUserId, workspaceId, principalId, credentialResources);
        }
    }

    private BindingPlan plan(String actorUserId, UUID workspaceId, UUID principalId,
            List<String> credentialResources, boolean requireCredentialExists) {
        UUID actorId = parseUuid(actorUserId);
        if (!authService.userExists(actorId)) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "USER_NOT_FOUND", "Operator was not found");
        }
        if (workspaceId == null || principalId == null) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "workspaceId and principalId are required");
        }
        // B1 裁定（2026-10-13，round-4 R5）：bindings 对齐 setWorkspaceCap 的前置——
        // 目标 workspace 必须存在且活跃，且操作者必须是其成员（否则持有 manage@<id>
        // 的调用者知道他人 workspaceId 即可跨 workspace 写绑定）。
        workspaceService.requireActiveWorkspace(workspaceId.toString());
        if (!workspaceService.isWorkspaceMember(workspaceId.toString(), actorId.toString())) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "Workspace membership is required to manage bindings");
        }
        List<String> resources = normalizeResources(credentialResources);
        for (String resource : resources) {
            requireCredentialManage(actorId, resource);
            if (requireCredentialExists) {
                requireCredentialExists(actorId, workspaceId, resource);
            }
        }
        WorkspaceAgent binding = workspaceAgentRepository
                .findById(new WorkspaceAgentId(principalId, workspaceId))
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "AGENT_BINDING_NOT_FOUND",
                        "Agent principal is not bound to this Workspace"));
        Set<GrantIntersectionEvaluator.PermissionAtom> principalPermissions = evaluator.union(
                grantRepository.findBySubjectTypeAndSubjectId(
                        GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId));
        Set<GrantIntersectionEvaluator.PermissionAtom> actorPermissions = evaluator.union(
                grantRepository.findBySubjectTypeAndSubjectId(GrantPrincipalPathResolver.USER, actorId));
        Set<GrantIntersectionEvaluator.PermissionAtom> cap =
                evaluator.parse(binding.getPermissionsSnapshot());
        return new BindingPlan(actorId, workspaceId, principalId, resources, binding,
                principalPermissions, actorPermissions, cap);
    }

    private static List<String> normalizeResources(List<String> credentialResources) {
        if (credentialResources == null || credentialResources.isEmpty()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "credentialResources is required");
        }
        Set<String> normalized = new LinkedHashSet<>();
        for (String resource : credentialResources) {
            if (!ToolFaceRegistry.isConcreteCredentialResource(resource)) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_CREDENTIAL_RESOURCE",
                        "credential resource must be credential:<uuid>: " + resource);
            }
            normalized.add(resource);
        }
        return List.copyOf(normalized);
    }

    private void requireCredentialManage(UUID actorId, String resource) {
        PolicyRequest request = new PolicyRequest("credential_binding",
                List.of(ToolFaceRegistry.ACTION_CREDENTIAL_MANAGE), List.of(resource),
                ToolShape.OPAQUE, actorId.toString(), null, null);
        if (!evaluator.allows(request, List.of(evaluator.union(
                grantRepository.findBySubjectTypeAndSubjectId(GrantPrincipalPathResolver.USER, actorId))))) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "credential_manage permission is required for " + resource);
        }
    }

    /** PLAN-0496 I4: the referenced credential must exist for the operator or the workspace. */
    private void requireCredentialExists(UUID actorId, UUID workspaceId, String resource) {
        String credentialId = resource.substring(ToolFaceRegistry.CREDENTIAL_RESOURCE_PREFIX.length());
        boolean exists = credentialService.existsForOwner("USER", actorId.toString(), credentialId)
                || credentialService.existsForOwner("WORKSPACE", workspaceId.toString(), credentialId);
        if (!exists) {
            throw new CpApiException(HttpStatus.UNPROCESSABLE_ENTITY, "CREDENTIAL_NOT_FOUND",
                    "Credential does not exist for the operator or workspace: " + resource);
        }
    }

    /** 0494 #12: only the newly added atoms must be covered by the operator. */
    private static void requireOperatorCeiling(Set<GrantIntersectionEvaluator.PermissionAtom> actorPermissions,
            Set<GrantIntersectionEvaluator.PermissionAtom> newAtoms) {
        for (GrantIntersectionEvaluator.PermissionAtom atom : newAtoms) {
            if (!coveredBy(atom, actorPermissions)) {
                throw new CpApiException(HttpStatus.FORBIDDEN, "CREDENTIAL_ATOMS_NOT_OWNED_BY_OPERATOR",
                        "Operator does not hold " + atom.actionClass() + "@" + atom.resource());
            }
        }
    }

    private void mergePrincipalDirectGrant(UUID principalId, UUID actorId,
            Set<GrantIntersectionEvaluator.PermissionAtom> additions,
            Set<GrantIntersectionEvaluator.PermissionAtom> removals) {
        AuthorizationGrant direct = grantRepository.findBySubjectTypeAndSubjectId(
                        GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId).stream()
                .filter(grant -> SOURCE_DIRECT.equals(grant.getSource()))
                .findFirst()
                .orElse(null);
        Set<GrantIntersectionEvaluator.PermissionAtom> current = direct == null
                ? Set.of()
                : evaluator.parse(direct.getPermissions());
        Set<GrantIntersectionEvaluator.PermissionAtom> merged = new LinkedHashSet<>(current);
        merged.addAll(additions);
        merged.removeAll(removals);

        if (merged.isEmpty()) {
            if (direct != null) {
                grantRepository.delete(direct);
            }
            return;
        }
        if (direct == null) {
            direct = new AuthorizationGrant();
            direct.setId(UUID.randomUUID());
            direct.setSubjectType(GrantPrincipalPathResolver.AGENT_PRINCIPAL);
            direct.setSubjectId(principalId);
            direct.setGranterType(GrantPrincipalPathResolver.USER);
            direct.setGranterId(actorId);
            direct.setSource(SOURCE_DIRECT);
            direct.setReadState("read");
        }
        direct.setPermissions(toJson(merged));
        try {
            grantRepository.saveAndFlush(direct);
        } catch (org.springframework.dao.DataIntegrityViolationException e) {
            // Round-4: the V64 partial unique index raced a concurrent first-time bind.
            // Fail loud with an idempotent retry path instead of leaving two direct rows
            // behind (a duplicate would make findFirst non-deterministic and an unbind
            // could leave the atom in the other row).
            throw new CpApiException(HttpStatus.CONFLICT, "DIRECT_GRANT_CONFLICT",
                    "The direct grant changed concurrently; retry the binding", e);
        }
    }

    private void writeCap(WorkspaceAgent binding, Set<GrantIntersectionEvaluator.PermissionAtom> cap) {
        binding.setPermissionsSnapshot(toJson(cap));
        workspaceAgentRepository.saveAndFlush(binding);
    }

    private void recordBinding(UUID actorId, UUID workspaceId, UUID principalId,
            List<String> resources, String action) {
        ObjectNode detail = objectMapper.createObjectNode();
        detail.put("authorizationAction", ToolFaceRegistry.ACTION_CREDENTIAL_MANAGE);
        detail.put("principalId", principalId.toString());
        ArrayNode resourceArray = objectMapper.createArrayNode();
        resources.forEach(resourceArray::add);
        detail.set("credentialResources", resourceArray);
        auditLogger.recordDurableChange(actorId.toString(), workspaceId.toString(),
                action, "agent_principal", principalId.toString(), detail.toString());
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

    private static Set<GrantIntersectionEvaluator.PermissionAtom> useAtoms(List<String> resources) {
        Set<GrantIntersectionEvaluator.PermissionAtom> atoms = new LinkedHashSet<>();
        for (String resource : resources) {
            atoms.add(new GrantIntersectionEvaluator.PermissionAtom(
                    ToolFaceRegistry.ACTION_CREDENTIAL_USE, resource));
        }
        return atoms;
    }

    private static Set<GrantIntersectionEvaluator.PermissionAtom> union(
            Set<GrantIntersectionEvaluator.PermissionAtom> base,
            Set<GrantIntersectionEvaluator.PermissionAtom> extra) {
        Set<GrantIntersectionEvaluator.PermissionAtom> merged = new LinkedHashSet<>(base);
        merged.addAll(extra);
        return merged;
    }

    private static boolean coveredBy(GrantIntersectionEvaluator.PermissionAtom candidate,
            Set<GrantIntersectionEvaluator.PermissionAtom> ceiling) {
        return ceiling.stream().anyMatch(atom -> atom.actionClass().equals(candidate.actionClass())
                && ToolFaceRegistry.resourceCovers(candidate.actionClass(), atom.resource(),
                        candidate.resource()));
    }

    private static UUID parseUuid(String value) {
        if (value == null || value.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_ACTOR", "A valid UUID is required");
        }
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_ACTOR", "A valid UUID is required", e);
        }
    }

    private record BindingPlan(
            UUID actorId,
            UUID workspaceId,
            UUID principalId,
            List<String> resources,
            WorkspaceAgent binding,
            Set<GrantIntersectionEvaluator.PermissionAtom> principalPermissions,
            Set<GrantIntersectionEvaluator.PermissionAtom> actorPermissions,
            Set<GrantIntersectionEvaluator.PermissionAtom> cap) {}
}
