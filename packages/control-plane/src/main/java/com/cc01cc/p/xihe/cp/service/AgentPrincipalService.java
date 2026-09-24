package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.policy.PolicyRequest;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.policy.ToolShape;
import com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator;
import com.cc01cc.p.xihe.cp.policy.GrantPrincipalPathResolver;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Lifecycle writes for stable Agent principals and Workspace-local permission caps. */
@Service
public class AgentPrincipalService {

    private final AgentPrincipalRepository agentPrincipalRepository;
    private final AuthorizationGrantRepository grantRepository;
    private final UserRepository userRepository;
    private final WorkspaceRepository workspaceRepository;
    private final WorkspaceUserRepository workspaceUserRepository;
    private final WorkspaceAgentRepository workspaceAgentRepository;
    private final GrantIntersectionEvaluator evaluator;
    private final AuditLogger auditLogger;
    private final ObjectMapper objectMapper;
    private final AgentTemplateService agentTemplateService;

    public AgentPrincipalService(AgentPrincipalRepository agentPrincipalRepository,
                                 AuthorizationGrantRepository grantRepository,
                                 UserRepository userRepository,
                                 WorkspaceRepository workspaceRepository,
                                 WorkspaceUserRepository workspaceUserRepository,
                                  WorkspaceAgentRepository workspaceAgentRepository,
                                  GrantIntersectionEvaluator evaluator,
                                  AuditLogger auditLogger,
                                  ObjectMapper objectMapper,
                                  AgentTemplateService agentTemplateService) {
        this.agentPrincipalRepository = agentPrincipalRepository;
        this.grantRepository = grantRepository;
        this.userRepository = userRepository;
        this.workspaceRepository = workspaceRepository;
        this.workspaceUserRepository = workspaceUserRepository;
        this.workspaceAgentRepository = workspaceAgentRepository;
        this.evaluator = evaluator;
        this.auditLogger = auditLogger;
        this.objectMapper = objectMapper;
        this.agentTemplateService = agentTemplateService;
    }

    /** Authorizes, resolves a caller-readable snapshot, and creates a principal atomically. */
    @Transactional
    public AgentPrincipal createPrincipalFromTemplate(String actorUserId, String name, String templateId) {
        UUID actorId = parseUuid(actorUserId, "INVALID_ACTOR");
        requireUser(actorId);
        requireUserAction(actorId, ToolFaceRegistry.ACTION_CREATE_ACCOUNT, "*");
        AgentTemplateService.ResolvedTemplate resolved = agentTemplateService.resolveForCreation(
                actorUserId, null, templateId);
        String resolvedTemplateId = optionalText(resolved.snapshot(), "templateId");
        return createPrincipal(actorUserId, name, resolvedTemplateId, resolved.snapshot());
    }

    /** The caller authorizes CREATE_ACCOUNT and supplies a server-resolved immutable template snapshot. */
    @Transactional
    public AgentPrincipal createPrincipal(String actorUserId, String name, String templateId,
                                          JsonNode templateSnapshot) {
        UUID actorId = parseUuid(actorUserId, "INVALID_ACTOR");
        userRepository.findById(actorId).orElseThrow(() -> new CpApiException(
                HttpStatus.NOT_FOUND, "USER_NOT_FOUND", "Agent principal creator was not found"));
        if (name == null || name.isBlank() || templateSnapshot == null || !templateSnapshot.isObject()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_AGENT_PRINCIPAL",
                    "A name and server-resolved template snapshot are required");
        }
        if (!java.util.Objects.equals(templateId, optionalText(templateSnapshot, "templateId"))) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_TEMPLATE_SNAPSHOT",
                    "Template ID does not match the frozen snapshot");
        }

        Set<GrantIntersectionEvaluator.PermissionAtom> templatePermissions =
                parsePermissions(templateSnapshot.get("permissions"));
        Set<GrantIntersectionEvaluator.PermissionAtom> creatorPermissions = evaluator.union(
                grantRepository.findBySubjectTypeAndSubjectId(GrantPrincipalPathResolver.USER, actorId));
        Set<GrantIntersectionEvaluator.PermissionAtom> effectivePermissions =
                retainCovered(templatePermissions, creatorPermissions);
        ArrayNode grantPermissions = toJson(effectivePermissions);

        AgentPrincipal principal = new AgentPrincipal();
        principal.setName(name.trim());
        principal.setTemplateId(templateId);
        principal.setTemplateSnapshot(templateSnapshot.deepCopy());
        principal.setCreatedByUserId(actorId.toString());
        AgentPrincipal savedPrincipal = agentPrincipalRepository.saveAndFlush(principal);

        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setId(UUID.randomUUID());
        grant.setSubjectType(GrantPrincipalPathResolver.AGENT_PRINCIPAL);
        grant.setSubjectId(savedPrincipal.getId());
        grant.setGranterType(GrantPrincipalPathResolver.USER);
        grant.setGranterId(actorId);
        grant.setSource(templateId == null ? "default" : "template");
        grant.setRoleName(optionalText(templateSnapshot, "roleName"));
        grant.setTemplateName(optionalText(templateSnapshot, "templateName"));
        grant.setReadState("read");
        grant.setPermissions(grantPermissions);
        grantRepository.saveAndFlush(grant);

        ObjectNode detail = objectMapper.createObjectNode();
        detail.put("authorizationAction", "CREATE_ACCOUNT");
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
        workspaceRepository.findByIdAndDeletedAtIsNull(workspaceId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND,
                        "WORKSPACE_NOT_FOUND", "Workspace not found"));
        requireWorkspaceMember(actorId, workspaceId);
        requireWorkspaceAgentManagement(actorId, workspaceId);
        AgentPrincipal principal = requireActivePrincipal(principalId);

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
        workspaceRepository.findByIdAndDeletedAtIsNull(workspaceId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND,
                        "WORKSPACE_NOT_FOUND", "Workspace not found"));
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
        auditLogger.recordDurableChange(actorId.toString(), workspaceId.toString(),
                "workspace_agent_unbound", "agent_principal", principal.getId().toString(), detail.toString());
        return true;
    }

    @Transactional(readOnly = true)
    public List<WorkspaceAgentView> listWorkspaceAgents(String actorUserId, UUID workspaceId) {
        UUID actorId = parseUuid(actorUserId, "INVALID_ACTOR");
        requireUser(actorId);
        workspaceRepository.findByIdAndDeletedAtIsNull(workspaceId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND,
                        "WORKSPACE_NOT_FOUND", "Workspace not found"));
        requireWorkspaceMember(actorId, workspaceId);

        return workspaceAgentRepository.findByIdWorkspaceId(workspaceId).stream()
                .map(binding -> agentPrincipalRepository.findById(binding.getId().getPrincipalId())
                        .map(principal -> new WorkspaceAgentView(principal.getId(), principal.getName(),
                                principal.getTemplateId(), optionalText(principal.getTemplateSnapshot(), "templateName"),
                                principal.getCreatedAt(), binding.getPermissionsSnapshot().deepCopy()))
                        .orElseThrow(() -> new CpApiException(HttpStatus.INTERNAL_SERVER_ERROR,
                                "AGENT_PRINCIPAL_INCONSISTENT", "Workspace Agent binding has no principal")))
                .toList();
    }

    @Transactional(readOnly = true)
    public JsonNode resolveSessionCap(String principalIdValue, String workspaceIdValue) {
        UUID principalId = parseUuid(principalIdValue, "INVALID_AGENT_PRINCIPAL");
        UUID workspaceId = parseUuid(workspaceIdValue, "INVALID_WORKSPACE");
        AgentPrincipal principal = requireActivePrincipal(principalId);
        WorkspaceAgent binding = workspaceAgentRepository.findById(new WorkspaceAgentId(principalId, workspaceId))
                .orElseThrow(() -> new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                        "Agent principal is not bound to this Workspace"));
        Set<GrantIntersectionEvaluator.PermissionAtom> principalPermissions = evaluator.union(
                grantRepository.findBySubjectTypeAndSubjectId(
                        GrantPrincipalPathResolver.AGENT_PRINCIPAL, principal.getId()));
        Set<GrantIntersectionEvaluator.PermissionAtom> bindingPermissions = parsePermissions(
                binding.getPermissionsSnapshot());
        return toJson(retainCovered(bindingPermissions, principalPermissions));
    }

    /** Global account disable; the caller must authorize the account-lifecycle operation. */
    @Transactional
    public boolean disablePrincipal(String actorUserId, UUID principalId) {
        UUID actorId = parseUuid(actorUserId, "INVALID_ACTOR");
        requireUser(actorId);
        AgentPrincipal principal = agentPrincipalRepository.findById(principalId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND,
                        "AGENT_PRINCIPAL_NOT_FOUND", "Agent principal not found"));
        if (principal.getDisabledAt() != null) {
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

    private void requireUser(UUID userId) {
        userRepository.findById(userId).orElseThrow(() -> new CpApiException(
                HttpStatus.NOT_FOUND, "USER_NOT_FOUND", "User not found"));
    }

    private void requireWorkspaceMember(UUID userId, UUID workspaceId) {
        workspaceUserRepository.findByIdWorkspaceIdAndIdUserId(workspaceId, userId)
                .orElseThrow(() -> new CpApiException(HttpStatus.FORBIDDEN,
                        "WORKSPACE_ACCESS_DENIED", "Workspace membership is required"));
    }

    private void requireWorkspaceAgentManagement(UUID actorId, UUID workspaceId) {
        requireUserAction(actorId, ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS, workspaceId.toString());
    }

    private void requireUserAction(UUID actorId, String actionClass, String resource) {
        PolicyRequest request = new PolicyRequest(actionClass.toLowerCase(),
                List.of(actionClass), List.of(resource), ToolShape.OPAQUE,
                actorId.toString(), null, null);
        if (!evaluator.allows(request, List.of(evaluator.union(
                grantRepository.findBySubjectTypeAndSubjectId(GrantPrincipalPathResolver.USER, actorId))))) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", actionClass + " permission is required");
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
                && ("*".equals(atom.resource()) || atom.resource().equals(candidate.resource())));
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

    public record WorkspaceAgentView(UUID principalId, String name, String templateId,
                                     String templateName, Instant createdAt, JsonNode permissions) {}
}
