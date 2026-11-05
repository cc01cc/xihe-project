package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AccessRolePermission;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.scheduled.ScheduledTaskApiService;
import com.cc01cc.p.xihe.cp.scheduled.ScheduledTaskRepository;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.PageRequest;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0610 W1c (round-3 P0-1): the two remaining <b>unscoped</b> grant reads in authorization
 * gates, pinned as negative cases.
 *
 * <p>Repro shape (from the implementation audit): one user is {@code WS_OWNER} in workspace A and
 * only {@code WS_VIEWER} in workspace B. The workspace-A binding materializes
 * {@code MANAGE_WORKSPACE_AGENTS} / {@code CREATE_SCHEDULED_TASK} (both are {@code
 * scope_class=both}) into {@code grants(source='role')}. Because the gates read every grant row of
 * the subject, the workspace-A atom satisfied the gate for a workspace-B mutation, while the
 * membership gate was already scoped — the two halves of the decision disagreed.</p>
 *
 * <p>Fixed by switching both gates to {@code findScopedGrants} (the same predicate the evaluation
 * kernel uses). Each test keeps the positive control so the fix cannot be mistaken for "the gate
 * now denies everything".</p>
 */
class CrossWorkspaceGrantGateTest extends AbstractH2Test {

    private static final String REFUSED_CODE = "FORBIDDEN";

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private AccessRoleRepository accessRoleRepository;
    @Autowired private AccessRolePermissionRepository permissionRepository;
    @Autowired private AccessRoleBindingRepository bindingRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private AgentPrincipalRepository agentPrincipalRepository;
    @Autowired private WorkspaceAgentRepository workspaceAgentRepository;
    @Autowired private RoleGrantMaterializer materializer;
    @Autowired private AgentPrincipalService agentPrincipalService;
    @Autowired private ScheduledTaskApiService scheduledTaskApiService;
    @Autowired private ScheduledTaskRepository scheduledTaskRepository;
    @Autowired private ObjectMapper objectMapper;

    @Test
    void workspaceOwnerInADoesNotManageAgentsOfB() {
        Fixture fixture = fixture("agents");
        UUID principalId = principalBoundTo(fixture.userId(), fixture.workspaceA());
        grantPrincipalAtom(principalId, fixture.userId(), ToolFaceRegistry.ACTION_READ);

        // Positive control (round-4 P2-4): inside A the same caller *succeeds* with a non-empty cap,
        // so the fix is "scoped", not "deny everything". A deny-all implementation cannot pass this.
        WorkspaceAgent updated = agentPrincipalService.setWorkspaceCap(fixture.userId().toString(),
                fixture.workspaceA(), principalId, atoms("read"));
        assertEquals(1, updated.getPermissionsSnapshot().size(),
                "WS_OWNER really can set the workspace-A agent cap it is allowed to set");
        assertEquals(ToolFaceRegistry.ACTION_READ,
                updated.getPermissionsSnapshot().get(0).get("actionClass").asText());

        // Negative: workspace B only granted WS_VIEWER → 403 at the authorization gate.
        CpApiException refusal = assertThrows(CpApiException.class,
                () -> agentPrincipalService.setWorkspaceCap(fixture.userId().toString(),
                        fixture.workspaceB(), principalId, atoms("read")));
        assertEquals(REFUSED_CODE, refusal.getCode(),
                "the workspace-A MANAGE_WORKSPACE_AGENTS atom must not authorize workspace B");
    }

    @Test
    void workspaceOwnerInADoesNotCreateScheduledTasksInB() {
        Fixture fixture = fixture("scheduled");
        bindAtomInWorkspace(fixture.userId(), fixture.workspaceA(),
                ToolFaceRegistry.ACTION_CREATE_SCHEDULED_TASK);

        // delay_once + job_dispatch is the one shape that needs no pre-existing Session, so the
        // positive control can assert a real success instead of "failed for another reason".
        ScheduledTaskApiService.CreateRequest request = new ScheduledTaskApiService.CreateRequest(
                "delay_once", null, "UTC", "job_dispatch", null, null,
                objectMapper.createObjectNode().put("command", "echo gate-positive-control"),
                java.time.Instant.now().plusSeconds(600).toString(), null);

        // Positive control (round-4 P2-4): A holds CREATE_SCHEDULED_TASK and the task is created.
        ScheduledTaskApiService.TaskView created = scheduledTaskApiService.create(
                fixture.workspaceA().toString(), fixture.userId().toString(), request);
        assertNotNull(created.id(), "WS_OWNER-in-A really can create a scheduled task in A");
        assertEquals(1, scheduledTaskRepository.findByWorkspaceIdOrderByCreatedAtDesc(
                fixture.workspaceA(), PageRequest.of(0, 10)).size(),
                "the task was persisted in workspace A");

        // Negative: B holds only WS_VIEWER → the scoped read must refuse it.
        CpApiException inB = assertThrows(CpApiException.class,
                () -> scheduledTaskApiService.create(fixture.workspaceB().toString(),
                        fixture.userId().toString(), request));
        assertEquals(ToolFaceRegistry.ACTION_CREATE_SCHEDULED_TASK + " grant is required",
                inB.getMessage(),
                "the workspace-A CREATE_SCHEDULED_TASK atom must not authorize workspace B");
        assertEquals(REFUSED_CODE, inB.getCode());
        assertTrue(scheduledTaskRepository.findByWorkspaceIdOrderByCreatedAtDesc(
                fixture.workspaceB(), PageRequest.of(0, 10)).isEmpty(),
                "nothing was written into workspace B");
    }

    @Test
    void scopedRowsAreVisibleInSqlSoTheFixIsProvable() {
        Fixture fixture = fixture("sql");
        UUID ownerRoleId = accessRoleRepository.findByName(SystemAccessRoleCatalog.WS_OWNER)
                .orElseThrow().getId();
        bindingRepository.save(new AccessRoleBinding(ownerRoleId, "user", fixture.userId(),
                AccessScope.WORKSPACE, fixture.workspaceA(), fixture.userId()));
        materializer.materializeSubject("user", fixture.userId(), fixture.userId(), null);

        List<AuthorizationGrant> inA = grantRepository.findScopedGrants("user", fixture.userId(),
                GrantSources.EVALUATION_SOURCES, fixture.workspaceA());
        List<AuthorizationGrant> inB = grantRepository.findScopedGrants("user", fixture.userId(),
                GrantSources.EVALUATION_SOURCES, fixture.workspaceB());
        assertTrue(inA.stream().anyMatch(row -> ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS
                        .equals(row.getPermissions().get(0).get("actionClass").asText())),
                "workspace A sees the materialized agent-management atom");
        assertFalse(inB.stream().anyMatch(row -> ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS
                        .equals(row.getPermissions().get(0).get("actionClass").asText())),
                "workspace B sees no agent-management row (only its own WS_VIEWER read)");
        // PLAN-0651 M2 T2.1: WS_VIEWER also carries USE_WORKSPACE_RUNTIME, so "B only sees read"
        // became "B only sees WS_VIEWER atoms". Derive the set from the catalog: the assertion is
        // about the workspace scope, not about the exact atom count.
        java.util.Set<String> viewerAtoms = RoleAtomExpectations.materializedAtoms(
                SystemAccessRoleCatalog.WS_VIEWER);
        assertTrue(inB.stream().allMatch(row -> viewerAtoms.contains(
                        row.getPermissions().get(0).get("actionClass").asText())),
                "everything workspace B sees comes from its own WS_VIEWER binding: " + viewerAtoms);
    }

    // ---------------------------------------------------------------- helpers

    private record Fixture(UUID userId, UUID workspaceA, UUID workspaceB) {
    }

    /**
     * One caller, two workspaces: {@code WS_OWNER} binding in A, {@code WS_VIEWER} binding in B, and
     * a plain membership row in both (the tenant gate runs before the authorization gate).
     */
    private Fixture fixture(String tag) {
        User user = userRepository.save(new User("gate-" + tag + "-" + UUID.randomUUID() + "@test.local",
                "hash", "Gate " + tag));
        String owner = user.getId().toString();
        Workspace workspaceA = workspaceFixture.createOwnedWorkspace("gate-" + tag + "-a", owner);
        Workspace workspaceB = workspaceFixture.createOwnedWorkspace("gate-" + tag + "-b", owner);
        workspaceFixture.bindWorkspaceRole(workspaceA.getId().toString(), owner, WorkspaceRole.OWNER);
        workspaceFixture.bindWorkspaceRole(workspaceB.getId().toString(), owner, WorkspaceRole.VIEWER);

        UUID ownerRoleId = accessRoleRepository.findByName(SystemAccessRoleCatalog.WS_OWNER)
                .orElseThrow().getId();
        UUID viewerRoleId = accessRoleRepository.findByName(SystemAccessRoleCatalog.WS_VIEWER)
                .orElseThrow().getId();
        bindingRepository.save(new AccessRoleBinding(ownerRoleId, "user", user.getId(),
                AccessScope.WORKSPACE, workspaceA.getId(), user.getId()));
        bindingRepository.save(new AccessRoleBinding(viewerRoleId, "user", user.getId(),
                AccessScope.WORKSPACE, workspaceB.getId(), user.getId()));
        materializer.materializeSubject("user", user.getId(), user.getId(), null);

        assertFalse(grantRepository.findScopedGrants("user", user.getId(),
                GrantSources.EVALUATION_SOURCES, workspaceB.getId()).stream()
                .anyMatch(row -> ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS
                        .equals(row.getPermissions().get(0).get("actionClass").asText())),
                "precondition: workspace B holds no agent-management atom");
        return new Fixture(user.getId(), workspaceA.getId(), workspaceB.getId());
    }

    private void bindAtomInWorkspace(UUID userId, UUID workspaceId, String actionClass) {
        UUID roleId = UUID.randomUUID();
        accessRoleRepository.save(new AccessRole(roleId, "GATE_" + actionClass + "_" + roleId,
                "Gate test role", "test-only role carrying one 'both' atom", false));
        permissionRepository.save(new AccessRolePermission(roleId, actionClass,
                PermissionAtomCatalog.WILDCARD));
        bindingRepository.save(new AccessRoleBinding(roleId, "user", userId,
                AccessScope.WORKSPACE, workspaceId, userId));
        materializer.materializeSubject("user", userId, userId, null);
    }

    private UUID principalBoundTo(UUID userId, UUID workspaceId) {
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("gate-principal");
        principal.setCreatedByUserId(userId.toString());
        principal.setTemplateSnapshot(objectMapper.createObjectNode());
        UUID principalId = agentPrincipalRepository.saveAndFlush(principal).getId();
        workspaceAgentRepository.saveAndFlush(
                new WorkspaceAgent(principalId.toString(), workspaceId.toString(), atoms()));
        return principalId;
    }

    /**
     * Gives an agent principal one atom so a non-empty workspace cap can pass the separate
     * "cap ⊆ principal permissions" ceiling check (that check is the accepted P1-1 family and still
     * reads unscoped rows). {@code source='template'} is one of the evaluation sources, so the row is
     * a realistic principal snapshot rather than a test-only shortcut.
     */
    private void grantPrincipalAtom(UUID principalId, UUID granterId, String actionClass) {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setId(UUID.randomUUID());
        grant.setSubjectType("agent_principal");
        grant.setSubjectId(principalId);
        grant.setGranterType("user");
        grant.setGranterId(granterId);
        grant.setSource(GrantSources.TEMPLATE);
        grant.setScopeType(AccessScope.INSTANCE);
        grant.setReadState("read");
        grant.setPermissions(atoms(actionClass));
        grantRepository.saveAndFlush(grant);
    }

    private com.fasterxml.jackson.databind.node.ArrayNode atoms(String... actionClasses) {
        com.fasterxml.jackson.databind.node.ArrayNode array = objectMapper.createArrayNode();
        for (String actionClass : actionClasses) {
            array.addObject().put("actionClass", actionClass);
        }
        return array;
    }
}
