package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.ConfigEntity;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.ConfigJpaRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.cc01cc.p.xihe.cp.service.AgentTemplateService;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class GrantAuthorizationServiceIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private GrantAuthorizationService grantAuthorizationService;

    @Autowired
    private PolicyEngine policyEngine;

    @Autowired
    private AgentPrincipalRepository agentPrincipalRepository;

    @Autowired
    private AuthorizationGrantRepository grantRepository;

    @Autowired
    private WorkspaceAgentRepository workspaceAgentRepository;

    @Autowired
    private ChatRunRepository chatRunRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private WorkspaceUserRepository workspaceUserRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private AgentPrincipalService agentPrincipalService;

    @Autowired
    private AgentTemplateService agentTemplateService;

    @Autowired
    private ConfigJpaRepository configJpaRepository;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    private String userId;
    private UUID workspaceId;
    private UUID unjoinedWorkspaceId;
    private UUID principalId;
    private UUID parentRunId;
    private final List<UUID> sessionIds = new ArrayList<>();
    private final List<UUID> grantIds = new ArrayList<>();
    private final List<WorkspaceAgentId> workspaceAgentIds = new ArrayList<>();
    private final List<UUID> configIds = new ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        configJpaRepository.deleteAllById(configIds);
        grantRepository.deleteAllById(grantIds);
        if (parentRunId != null) {
            chatRunRepository.deleteById(parentRunId);
        }
        sessionIds.forEach(sessionRepository::deleteById);
        workspaceAgentRepository.deleteAllById(workspaceAgentIds);
        if (principalId != null) {
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                    GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId));
            agentPrincipalRepository.deleteById(principalId);
        }
        if (unjoinedWorkspaceId != null) {
            workspaceRepository.deleteById(unjoinedWorkspaceId);
        }
        if (workspaceId != null) {
            workspaceUserRepository.deleteAll(workspaceUserRepository.findByIdWorkspaceId(workspaceId));
            workspaceRepository.deleteById(workspaceId);
        }
        if (userId != null) {
            userRepository.deleteById(UUID.fromString(userId));
        }
    }

    @Test
    void stablePrincipalCapsAndWorkspaceBindingControlAgentActions() throws Exception {
        User user = userRepository.save(new User("grant-path-" + UUID.randomUUID() + "@test.com",
                "hash", UserRole.USER, "Grant path test"));
        userId = user.getId().toString();
        Workspace workspace = workspaceRepository.save(new Workspace("Grant path test", userId));
        workspaceId = workspace.getId();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId.toString(), userId, WorkspaceRole.OWNER));

        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("Grant path test agent");
        principal.setCreatedByUserId(userId);
        principal.setTemplateSnapshot(objectMapper.createObjectNode());
        principalId = agentPrincipalRepository.saveAndFlush(principal).getId();
        bindPrincipal(workspaceId, atoms("read"));

        Session rootSession = saveAgentSession(workspaceId, userId, "Root agent", atoms("read", "write"));
        Session unboundSession = new Session(workspaceId.toString(), userId, "Unbound agent session");
        unboundSession.setId(UUID.randomUUID());
        unboundSession.setAgentPermissionsSnapshot(atoms("read", "write"));
        sessionRepository.saveAndFlush(unboundSession);
        sessionIds.add(unboundSession.getId());
        assertFalse(grantAuthorizationService.allows(request(workspaceId, userId,
                        unboundSession, "read", "src/main.java")),
                "principal-null Sessions cannot enter the Agent authorization path");

        String writeBody = "{\"params\":{\"arguments\":{\"path\":\"src/main.java\"}}}";
        parentRunId = UUID.randomUUID();
        ChatRun parentRun = chatRunRepository.saveAndFlush(new ChatRun(
                parentRunId.toString(), rootSession.getId().toString(), userId, workspaceId.toString(),
                "root-run", "root-hash", "provider", "model", "workspace", "running"));

        addGrant("user", UUID.fromString(userId), "default", null, null, atoms("read", "write"));
        UUID agentDefaultGrantId = addGrant(GrantPrincipalPathResolver.AGENT_PRINCIPAL,
                principalId, "default", null, null, atoms("read", "write"));
        assertTrue(policyEngine.allowsByGrant(PolicyContext.EMPTY, "write_file", writeBody,
                rootSession.getId().toString(), userId, workspaceId.toString(), true),
                "a member's own user grant permits a user-direct mutation");
        assertFalse(grantAuthorizationService.allows(request(workspaceId, userId, rootSession,
                        "write", "src/main.java")),
                "the Workspace binding cap constrains the stable principal grant set");
        assertFalse(policyEngine.allowsByGrant(PolicyContext.EMPTY, "write_file", writeBody,
                rootSession.getId().toString(), userId, workspaceId.toString(), false),
                "Agent actions use the stable principal and per-Session cap");
        assertFalse(policyEngine.allowsByGrant(PolicyContext.EMPTY, "write_file",
                "{\"params\":{\"arguments\":{\"path\":\"C:\\\\outside\\\\secret\"}}}",
                rootSession.getId().toString(), userId, workspaceId.toString(), true),
                "a wildcard grant cannot authorize an absolute host path");
        assertTrue(policyEngine.allowsByGrant(PolicyContext.EMPTY, "apply_patch",
                "{\"params\":{\"arguments\":{\"patches\":[{\"path\":\"src/main.java\"}]}}}",
                rootSession.getId().toString(), userId, workspaceId.toString(), true),
                "structured patch paths are extracted and scoped to the workspace");
        assertFalse(policyEngine.allowsByGrant(PolicyContext.EMPTY, "apply_patch",
                "{\"params\":{\"arguments\":{\"patches\":[{\"path\":\"../outside.java\"}]}}}",
                rootSession.getId().toString(), userId, workspaceId.toString(), true),
                "structured patch paths cannot escape the workspace");

        setBindingCap(workspaceId, atoms("read", "write"));
        assertTrue(grantAuthorizationService.allows(request(workspaceId, userId, rootSession,
                        "write", "src/main.java")),
                "principal grant, Workspace binding cap, and Session cap jointly permit the action");
        rootSession.setAgentPermissionsSnapshot(atoms("read"));
        sessionRepository.saveAndFlush(rootSession);
        assertFalse(grantAuthorizationService.allows(request(workspaceId, userId, rootSession,
                        "write", "src/main.java")),
                "the Session instance cap further narrows the Workspace binding cap");
        rootSession.setAgentPermissionsSnapshot(atoms("read", "write"));
        sessionRepository.saveAndFlush(rootSession);
        AgentPrincipal activePrincipal = agentPrincipalRepository.findById(principalId).orElseThrow();
        activePrincipal.setDisabledAt(Instant.now());
        agentPrincipalRepository.saveAndFlush(activePrincipal);
        assertFalse(grantAuthorizationService.allows(request(workspaceId, userId, rootSession,
                        "write", "src/main.java")),
                "disabled principals cannot authorize new actions");
        activePrincipal.setDisabledAt(null);
        agentPrincipalRepository.saveAndFlush(activePrincipal);
        grantRepository.deleteById(agentDefaultGrantId);
        grantIds.remove(agentDefaultGrantId);
        assertTrue(grantAuthorizationService.allowsUserOnly(request(workspaceId, userId, rootSession,
                        "write", "src/main.java")),
                "User grants remain available to user-only operations");
        assertFalse(grantAuthorizationService.allows(request(workspaceId, userId, rootSession,
                        "write", "src/main.java")),
                "User grants cannot authorize an Agent when its stable principal has no grant");
        addGrant(GrantPrincipalPathResolver.AGENT_PRINCIPAL,
                principalId, "default", null, null, atoms("read", "write"));
        setBindingCap(workspaceId, atomWithResource("write", "src/*"));
        assertTrue(grantAuthorizationService.allows(request(workspaceId, userId,
                        rootSession, "write", "src/main.java")));
        assertFalse(grantAuthorizationService.allows(request(workspaceId, userId,
                        rootSession, "write", "docs/private.txt")),
                "Workspace cap resource patterns constrain concrete tool targets");
        setBindingCap(workspaceId, atoms("read", "write"));

        Workspace unjoinedWorkspace = workspaceRepository.save(
                new Workspace("Unjoined grant path test", userId));
        unjoinedWorkspaceId = unjoinedWorkspace.getId();
        Session unboundWorkspaceSession = saveAgentSession(unjoinedWorkspaceId, userId,
                "Unbound workspace agent", atoms("read", "write"));
        assertFalse(grantAuthorizationService.allows(request(unjoinedWorkspaceId, userId,
                        unboundWorkspaceSession, "write", "src/main.java")),
                "a stable principal without a Workspace binding cannot act there");
        bindPrincipal(unjoinedWorkspaceId, atoms("read"));
        assertFalse(grantAuthorizationService.allows(request(unjoinedWorkspaceId, userId,
                        unboundWorkspaceSession, "write", "src/main.java")),
                "the binding cap independently narrows principal-wide grants");
        assertTrue(grantAuthorizationService.allows(request(unjoinedWorkspaceId, userId,
                        unboundWorkspaceSession, "read", "src/main.java")));
        setBindingCap(unjoinedWorkspaceId, atoms("read", "write"));
        assertTrue(grantAuthorizationService.allows(request(unjoinedWorkspaceId, userId,
                        unboundWorkspaceSession, "write", "src/main.java")),
                "Agent Workspace binding is authoritative independently of human workspace membership");
        setBindingCap(workspaceId, atoms("read"));
        assertFalse(grantAuthorizationService.allows(request(workspaceId, userId,
                        rootSession, "write", "src/main.java")),
                "updating Workspace B cannot broaden Workspace A's binding cap");
        assertTrue(grantAuthorizationService.allows(request(unjoinedWorkspaceId, userId,
                        unboundWorkspaceSession, "write", "src/main.java")),
                "narrowing Workspace A's cap must not narrow Workspace B's independent cap");
        assertFalse(grantAuthorizationService.allowsUserOnly(new PolicyRequest(
                "write_file", List.of("write"), List.of("src/main.java"), ToolShape.STRUCTURED,
                userId, unjoinedWorkspaceId.toString(), null)),
                "wildcard grants cannot cross into a workspace where the user has no membership");
        workspaceAgentRepository.deleteById(new WorkspaceAgentId(principalId, unjoinedWorkspaceId));
        workspaceAgentIds.remove(new WorkspaceAgentId(principalId, unjoinedWorkspaceId));
        assertFalse(grantAuthorizationService.allows(request(unjoinedWorkspaceId, userId,
                        unboundWorkspaceSession, "write", "src/main.java")),
                "removing Workspace binding denies the next Agent action");

        UUID malformedGrantId = addGrant("user", UUID.fromString(userId), "direct",
                "admin", UUID.randomUUID(), atoms("unknown-action"));
        assertFalse(policyEngine.allowsByGrant(PolicyContext.EMPTY, "write_file", writeBody,
                rootSession.getId().toString(), userId, workspaceId.toString(), true),
                "a malformed or out-of-vocabulary grant fails closed");
        grantRepository.deleteById(malformedGrantId);

        setBindingCap(workspaceId, atoms("read", "write"));
        rootSession.setAgentPermissionsSnapshot(atoms("read"));
        sessionRepository.saveAndFlush(rootSession);
        Session spawnSession = saveDerivedSession(workspaceId, userId, rootSession, parentRun,
                Session.KIND_SPAWN, atoms("write"));
        PolicyRequest spawnWrite = request(workspaceId, userId, spawnSession, "write", "src/main.java");

        boolean inFlightDecision = grantAuthorizationService.allows(spawnWrite);
        assertFalse(inFlightDecision, "the parent agent's narrower set constrains its spawned child");

        Session forkSession = saveDerivedSession(workspaceId, userId, rootSession, parentRun,
                Session.KIND_FORK, atoms("write"));
        assertTrue(grantAuthorizationService.allows(
                request(workspaceId, userId, forkSession, "write", "src/main.java")),
                "a fork points to its source but does not inherit the source agent grant path");

        rootSession.setAgentPermissionsSnapshot(atoms("read", "write"));
        sessionRepository.saveAndFlush(rootSession);
        assertFalse(inFlightDecision, "a committed capability change does not revise an already returned decision");
        assertTrue(grantAuthorizationService.allows(spawnWrite),
                "the next tool-boundary evaluation must re-read the spawn ancestor Session cap");

        rootSession.setKind(Session.KIND_SPAWN);
        rootSession.setSpawnedFromSessionId(rootSession.getId());
        rootSession.setSpawnedFromRunId(parentRun.getId());
        rootSession.setSpawnedAt(Instant.now());
        sessionRepository.saveAndFlush(rootSession);
        assertFalse(grantAuthorizationService.allows(
                request(workspaceId, userId, rootSession, "write", "src/main.java")),
                "cyclic or inconsistent principal paths fail closed");
    }

    @Test
    void principalLifecycleAndWorkspaceCapsAreAuditedWithoutChangingGlobalGrants() {
        User user = userRepository.save(new User("principal-lifecycle-" + UUID.randomUUID() + "@test.com",
                "hash", UserRole.USER, "Principal lifecycle test"));
        userId = user.getId().toString();
        Workspace workspace = workspaceRepository.save(new Workspace("Principal lifecycle", userId));
        workspaceId = workspace.getId();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId.toString(), userId, WorkspaceRole.OWNER));
        addGrant("user", UUID.fromString(userId), "default", null, null, atoms("read", "write"));

        ObjectNode snapshot = objectMapper.createObjectNode();
        snapshot.put("templateId", "template-code");
        snapshot.put("templateName", "Code");
        snapshot.put("roleName", "USER");
        snapshot.put("systemPrompt", "internal template prompt");
        snapshot.set("permissions", atoms("read", "write", "network"));
        AgentPrincipal principal = agentPrincipalService.createPrincipal(
                userId, "Scoped agent", "template-code", snapshot);
        principalId = principal.getId();

        AuthorizationGrant baseGrant = grantRepository.findBySubjectTypeAndSubjectId(
                GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId).getFirst();
        assertEquals(atoms("read", "write"), baseGrant.getPermissions(),
                "principal creation intersects template capabilities with creator grants");
        assertEquals(1, jdbcTemplate.queryForObject("SELECT count(*) FROM audit_logs "
                + "WHERE action = 'agent_principal_created' AND user_id = ? AND resource_id = ?",
                Integer.class, UUID.fromString(userId), principalId.toString()));
        String createAuditDetail = jdbcTemplate.queryForObject("SELECT details FROM audit_logs "
                + "WHERE action = 'agent_principal_created' AND user_id = ? AND resource_id = ?",
                String.class, UUID.fromString(userId), principalId.toString());
        assertFalse(createAuditDetail.contains("internal template prompt"),
                "principal audit records permission facts, not template prompt contents");
        assertFalse(workspaceAgentRepository.existsById(new WorkspaceAgentId(principalId, workspaceId)),
                "creating a principal must not implicitly bind it to a Workspace");

        WorkspaceAgent binding = agentPrincipalService.setWorkspaceCap(
                userId, workspaceId, principalId, atoms("read"));
        workspaceAgentIds.add(binding.getId());
        Session session = saveAgentSession(workspaceId, userId, "Bound agent", atoms("read", "write"));
        assertFalse(grantAuthorizationService.allows(request(workspaceId, userId,
                        session, "write", "src/main.java")),
                "the Workspace binding cap narrows the principal's global grants");
        assertEquals(1, jdbcTemplate.queryForObject("SELECT count(*) FROM audit_logs "
                + "WHERE action = 'workspace_agent_bound' AND workspace_id = ? AND resource_id = ?",
                Integer.class, workspaceId, principalId.toString()));

        agentPrincipalService.setWorkspaceCap(userId, workspaceId, principalId, atoms("read"));
        assertEquals(0, jdbcTemplate.queryForObject("SELECT count(*) FROM audit_logs "
                + "WHERE action = 'workspace_agent_cap_updated' AND workspace_id = ? AND resource_id = ?",
                Integer.class, workspaceId, principalId.toString()),
                "repeating the same cap is idempotent and does not duplicate audit");
        agentPrincipalService.setWorkspaceCap(userId, workspaceId, principalId, atoms("read", "write"));
        assertTrue(grantAuthorizationService.allows(request(workspaceId, userId,
                        session, "write", "src/main.java")));
        assertEquals(atoms("read", "write"), grantRepository
                        .findBySubjectTypeAndSubjectId(GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId)
                        .getFirst().getPermissions(),
                "changing a Workspace cap must not mutate global principal grants");
        assertEquals(1, jdbcTemplate.queryForObject("SELECT count(*) FROM audit_logs "
                + "WHERE action = 'workspace_agent_cap_updated' AND workspace_id = ? AND resource_id = ?",
                Integer.class, workspaceId, principalId.toString()));

        assertThrows(CpApiException.class, () -> agentPrincipalService.setWorkspaceCap(
                userId, workspaceId, principalId, atoms("network")),
                "binding caps cannot exceed the principal or operator's current grants");
        assertTrue(grantAuthorizationService.allows(request(workspaceId, userId,
                        session, "write", "src/main.java")),
                "a rejected cap update must leave the prior binding unchanged");

        assertTrue(agentPrincipalService.unbindWorkspace(userId, workspaceId, principalId));
        assertTrue(sessionRepository.findById(session.getId()).isPresent(),
                "Workspace unbind must preserve historical Session rows");
        assertFalse(grantAuthorizationService.allows(request(workspaceId, userId,
                        session, "write", "src/main.java")),
                "unbinding revokes new actions in this Workspace");
        workspaceAgentIds.remove(binding.getId());
        assertEquals(1, jdbcTemplate.queryForObject("SELECT count(*) FROM audit_logs "
                + "WHERE action = 'workspace_agent_unbound' AND workspace_id = ? AND resource_id = ?",
                Integer.class, workspaceId, principalId.toString()));

        assertTrue(agentPrincipalService.disablePrincipal(userId, principalId));
        AgentPrincipal disabled = agentPrincipalRepository.findById(principalId).orElseThrow();
        assertTrue(disabled.getDisabledAt() != null);
        assertEquals(1, jdbcTemplate.queryForObject("SELECT count(*) FROM audit_logs "
                + "WHERE action = 'agent_principal_disabled' AND user_id = ? AND resource_id = ?",
                Integer.class, UUID.fromString(userId), principalId.toString()));
    }

    @Test
    void agentTemplateResolverUsesAuthorizedRawLayersAndFreezesTheResolvedSnapshot() throws Exception {
        User user = userRepository.save(new User("template-scope-" + UUID.randomUUID() + "@test.com",
                "hash", UserRole.USER, "Template scope test"));
        userId = user.getId().toString();
        Workspace workspace = workspaceRepository.save(new Workspace("Template scope workspace", userId));
        workspaceId = workspace.getId();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId.toString(), userId, WorkspaceRole.OWNER));
        addGrant("user", UUID.fromString(userId), "default", null, null, atoms("read", "write"));

        String userRoleId = UUID.randomUUID().toString();
        String workspaceRoleId = UUID.randomUUID().toString();
        String instanceRoleId = UUID.randomUUID().toString();
        String userTemplateId = UUID.randomUUID().toString();
        String workspaceTemplateId = UUID.randomUUID().toString();
        String instanceTemplateId = UUID.randomUUID().toString();
        ConfigEntity userRoles = saveTemplateConfig("user", UUID.fromString(userId), null, "roles",
                roleConfig(userRoleId, "User role", atoms("read", "write")).toString());
        ConfigEntity userTemplates = saveTemplateConfig("user", UUID.fromString(userId), null, "templates",
                templateConfig(userTemplateId, "User template", userRoleId, "user prompt v1").toString());
        saveTemplateConfig("workspace", null, workspaceId, "roles",
                roleConfig(workspaceRoleId, "Workspace role", atoms("read")).toString());
        saveTemplateConfig("workspace", null, workspaceId, "templates",
                templateConfig(workspaceTemplateId, "Workspace template", workspaceRoleId, "workspace prompt").toString());
        saveTemplateConfig("instance", null, null, "roles",
                roleConfig(instanceRoleId, "Instance role", atoms("read")).toString());
        saveTemplateConfig("instance", null, null, "templates",
                templateConfig(instanceTemplateId, "Instance template", instanceRoleId, "instance prompt").toString());

        AgentTemplateService.ResolvedTemplate userTemplate = agentTemplateService.resolveForCreation(
                userId, workspaceId.toString(), userTemplateId);
        assertEquals("user", userTemplate.sourceLayer());
        assertEquals("User role", userTemplate.snapshot().path("roleName").asText());
        assertEquals("user prompt v1", userTemplate.snapshot().path("systemPrompt").asText());
        assertEquals("openai", userTemplate.snapshot().path("provider").asText());
        assertEquals("test-model", userTemplate.snapshot().path("model").asText());
        AgentTemplateService.ResolvedTemplate workspaceTemplate = agentTemplateService.resolveForCreation(
                userId, workspaceId.toString(), workspaceTemplateId);
        assertEquals("workspace", workspaceTemplate.sourceLayer());
        assertEquals("Workspace role", workspaceTemplate.snapshot().path("roleName").asText());
        assertThrows(CpApiException.class, () -> agentTemplateService.resolveForCreation(
                        userId, workspaceId.toString(), instanceTemplateId),
                "non-admin users cannot enumerate or select instance templates");
        AgentTemplateService.ResolvedTemplate defaultTemplate = agentTemplateService.resolveForCreation(
                userId, workspaceId.toString(), null);
        assertEquals("default", defaultTemplate.sourceLayer());
        assertEquals(atoms("read", "write"), defaultTemplate.snapshot().path("permissions"),
                "no selected template preserves the bare-default grant behavior");

        AgentPrincipal principal = agentPrincipalService.createPrincipal(
                userId, "Template-bound principal", userTemplateId, userTemplate.snapshot());
        principalId = principal.getId();
        ConfigEntity updatedUserTemplates = configJpaRepository.findById(userTemplates.getId()).orElseThrow();
        updatedUserTemplates.setConfigValue(templateConfig(
                userTemplateId, "User template", userRoleId, "user prompt v2").toString());
        configJpaRepository.saveAndFlush(updatedUserTemplates);
        assertEquals("user prompt v2", agentTemplateService.resolveForCreation(
                userId, workspaceId.toString(), userTemplateId).snapshot().path("systemPrompt").asText());
        assertEquals("user prompt v1", agentPrincipalRepository.findById(principalId).orElseThrow()
                        .getTemplateSnapshot().path("systemPrompt").asText(),
                "existing principal snapshots must not follow later ConfigService changes");

        ConfigEntity updatedUserRoles = configJpaRepository.findById(userRoles.getId()).orElseThrow();
        updatedUserRoles.setConfigValue(roleConfig(userRoleId, "Updated user role", atoms("read")).toString());
        configJpaRepository.saveAndFlush(updatedUserRoles);
        AgentTemplateService.ResolvedTemplate changedRole = agentTemplateService.resolveForCreation(
                userId, workspaceId.toString(), userTemplateId);
        assertEquals("Updated user role", changedRole.snapshot().path("roleName").asText());
        assertEquals(atoms("read"), changedRole.snapshot().path("permissions"));
        assertEquals("User role", agentPrincipalRepository.findById(principalId).orElseThrow()
                        .getTemplateSnapshot().path("roleName").asText(),
                "existing principal role snapshots must not follow later role config changes");
        updatedUserRoles.setConfigValue(roleConfig(userRoleId, "User role", atoms("read", "write")).toString());
        configJpaRepository.saveAndFlush(updatedUserRoles);

        updatedUserTemplates.setConfigValue(templateConfig(
                userTemplateId, "User template", workspaceRoleId, "invalid cross-layer role reference").toString());
        configJpaRepository.saveAndFlush(updatedUserTemplates);
        assertThrows(CpApiException.class, () -> agentTemplateService.resolveForCreation(
                        userId, workspaceId.toString(), userTemplateId),
                "template role references must resolve within the template's own config layer");
        updatedUserTemplates.setConfigValue(templateConfig(
                userTemplateId, "User template", userRoleId, "user prompt v2").toString());
        configJpaRepository.saveAndFlush(updatedUserTemplates);

        ArrayNode invalidTemplates = templateConfig(userTemplateId, "User template", userRoleId, "user prompt v2");
        ((ObjectNode) invalidTemplates.get(0)).put("unexpected", true);
        updatedUserTemplates.setConfigValue(invalidTemplates.toString());
        configJpaRepository.saveAndFlush(updatedUserTemplates);
        assertThrows(CpApiException.class, () -> agentTemplateService.resolveForCreation(
                        userId, workspaceId.toString(), userTemplateId),
                "template config with unknown fields must fail schema validation");
        updatedUserTemplates.setConfigValue(templateConfig(
                userTemplateId, "User template", userRoleId, "user prompt v2").toString());
        configJpaRepository.saveAndFlush(updatedUserTemplates);

        ArrayNode duplicatedTemplates = (ArrayNode) objectMapper.readTree(updatedUserTemplates.getConfigValue());
        duplicatedTemplates.add(duplicatedTemplates.get(0).deepCopy());
        updatedUserTemplates.setConfigValue(duplicatedTemplates.toString());
        configJpaRepository.saveAndFlush(updatedUserTemplates);
        assertThrows(CpApiException.class, () -> agentTemplateService.resolveForCreation(
                        userId, workspaceId.toString(), userTemplateId),
                "template IDs must be unique within each readable config layer");
        updatedUserTemplates.setConfigValue(templateConfig(
                userTemplateId, "User template", userRoleId, "user prompt v2").toString());
        configJpaRepository.saveAndFlush(updatedUserTemplates);

        ArrayNode duplicatedRoles = (ArrayNode) objectMapper.readTree(updatedUserRoles.getConfigValue());
        duplicatedRoles.add(duplicatedRoles.get(0).deepCopy());
        updatedUserRoles.setConfigValue(duplicatedRoles.toString());
        configJpaRepository.saveAndFlush(updatedUserRoles);
        assertThrows(CpApiException.class, () -> agentTemplateService.resolveForCreation(
                        userId, workspaceId.toString(), userTemplateId),
                "role IDs must be unique within the template's config layer");
        updatedUserRoles.setConfigValue(roleConfig(userRoleId, "User role", atoms("read", "write")).toString());
        configJpaRepository.saveAndFlush(updatedUserRoles);

        ArrayNode shadowingTemplates = (ArrayNode) objectMapper.readTree(
                configJpaRepository.findByWorkspaceIdAndDomainAndConfigKey(workspaceId, "agent-templates", "templates")
                        .orElseThrow().getConfigValue());
        shadowingTemplates.add(templateConfig(
                userTemplateId, "Shadow template", workspaceRoleId, "shadow prompt").get(0));
        ConfigEntity workspaceTemplates = configJpaRepository.findByWorkspaceIdAndDomainAndConfigKey(
                workspaceId, "agent-templates", "templates").orElseThrow();
        workspaceTemplates.setConfigValue(shadowingTemplates.toString());
        configJpaRepository.saveAndFlush(workspaceTemplates);
        assertThrows(CpApiException.class, () -> agentTemplateService.resolveForCreation(
                        userId, workspaceId.toString(), userTemplateId),
                "visible duplicate template IDs must fail rather than silently choose a layer");

        User admin = userRepository.findById(UUID.fromString(userId)).orElseThrow();
        admin.setRole(UserRole.ADMIN);
        userRepository.saveAndFlush(admin);
        AgentTemplateService.ResolvedTemplate instanceTemplate = agentTemplateService.resolveForCreation(
                userId, null, instanceTemplateId);
        assertEquals("instance", instanceTemplate.sourceLayer());
    }

    private ArrayNode roleConfig(String id, String name, ArrayNode permissions) {
        ObjectNode role = objectMapper.createObjectNode();
        role.put("id", id);
        role.put("name", name);
        role.set("permissions", permissions);
        ArrayNode result = objectMapper.createArrayNode();
        result.add(role);
        return result;
    }

    private ArrayNode templateConfig(String id, String name, String roleId, String systemPrompt) {
        ObjectNode template = objectMapper.createObjectNode();
        template.put("id", id);
        template.put("name", name);
        template.put("description", name + " description");
        template.put("systemPrompt", systemPrompt);
        template.put("toolMode", "workspace");
        template.put("provider", "openai");
        template.put("model", "test-model");
        template.put("roleId", roleId);
        ArrayNode result = objectMapper.createArrayNode();
        result.add(template);
        return result;
    }

    private Session saveAgentSession(UUID wsId, String ownerId, String title, ArrayNode cap) {
        Session session = new Session(wsId.toString(), ownerId, title);
        session.setId(UUID.randomUUID());
        session.setAgentPrincipalId(principalId.toString());
        session.setAgentPermissionsSnapshot(cap);
        Session saved = sessionRepository.save(session);
        sessionIds.add(saved.getId());
        return saved;
    }

    private Session saveDerivedSession(UUID wsId, String ownerId, Session parent, ChatRun parentRun,
                                       String kind, ArrayNode cap) {
        Session session = new Session(wsId.toString(), ownerId, kind + " agent");
        session.setId(UUID.randomUUID());
        session.setSpawnedFromSessionId(parent.getId());
        session.setSpawnedFromRunId(parentRun.getId());
        session.setSpawnedAt(Instant.now());
        session.setKind(kind);
        session.setAgentPrincipalId(principalId.toString());
        session.setAgentPermissionsSnapshot(cap);
        Session saved = sessionRepository.save(session);
        sessionIds.add(saved.getId());
        return saved;
    }

    private void bindPrincipal(UUID workspace, ArrayNode cap) {
        WorkspaceAgent binding = workspaceAgentRepository.saveAndFlush(
                new WorkspaceAgent(principalId.toString(), workspace.toString(), cap));
        workspaceAgentIds.add(binding.getId());
    }

    private void setBindingCap(UUID workspace, ArrayNode cap) {
        WorkspaceAgent binding = workspaceAgentRepository.findById(
                new WorkspaceAgentId(principalId, workspace)).orElseThrow();
        binding.setPermissionsSnapshot(cap);
        workspaceAgentRepository.saveAndFlush(binding);
    }

    private ConfigEntity saveTemplateConfig(String layer, UUID ownerUserId, UUID ownerWorkspaceId,
                                            String key, String value) {
        ConfigEntity entity = new ConfigEntity();
        entity.setLayer(layer);
        entity.setUserId(ownerUserId);
        entity.setWorkspaceId(ownerWorkspaceId);
        entity.setDomain("agent-templates");
        entity.setConfigKey(key);
        entity.setConfigValue(value);
        entity.setUpdatedBy("test-fixture");
        ConfigEntity saved = configJpaRepository.saveAndFlush(entity);
        configIds.add(saved.getId());
        return saved;
    }

    private UUID addGrant(String subjectType, UUID subjectId, String source,
                          String granterType, UUID granterId, ArrayNode permissions) {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setId(UUID.randomUUID());
        grant.setSubjectType(subjectType);
        grant.setSubjectId(subjectId);
        grant.setGranterType(granterType);
        grant.setGranterId(granterId);
        grant.setSource(source);
        grant.setPermissions(permissions);
        UUID savedId = grantRepository.save(grant).getId();
        grantIds.add(savedId);
        return savedId;
    }

    private ArrayNode atoms(String... actionClasses) {
        ArrayNode permissions = objectMapper.createArrayNode();
        for (String actionClass : actionClasses) {
            ObjectNode atom = objectMapper.createObjectNode();
            atom.put("actionClass", actionClass);
            permissions.add(atom);
        }
        return permissions;
    }

    private ArrayNode atomWithResource(String actionClass, String resource) {
        ArrayNode permissions = objectMapper.createArrayNode();
        ObjectNode atom = objectMapper.createObjectNode();
        atom.put("actionClass", actionClass);
        atom.put("resource", resource);
        permissions.add(atom);
        return permissions;
    }

    private static PolicyRequest request(UUID wsId, String ownerId, Session session,
                                         String actionClass, String resource) {
        return new PolicyRequest("write_file", List.of(actionClass), List.of(resource), ToolShape.STRUCTURED,
                ownerId, wsId.toString(), session.getId().toString());
    }
}
