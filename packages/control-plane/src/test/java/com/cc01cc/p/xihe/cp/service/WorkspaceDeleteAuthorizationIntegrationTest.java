package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AccessRolePermission;
import com.cc01cc.p.xihe.cp.entity.AuditLog;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.policy.PermissionAtomCatalog;
import com.cc01cc.p.xihe.cp.policy.RoleGrantMaterializer;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AuditLogRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * BL-174: workspace delete is authorized by <b>capability</b>, not by ownership alone.
 *
 * <p>Pre-BL-174 the gate was owner-only, so an instance super administrator (or any operator holding
 * only the administration capability) got 404 on a workspace whose Runtime sandbox had to be cleaned
 * up — operators fell back to editing the database, which loses the API audit trail and the Runtime
 * notification.</p>
 *
 * <p>Approved matrix (user decision 2026-11-01, "方案 A", narrowed the same day): owner, cross-owner
 * instance administrator (with {@code crossOwner=true} in the audit), a caller with neither attribute
 * (still denied), a custom role holding the <b>{@code workspace:admin} capability</b>, and the unchanged
 * best-effort Runtime notification (covered by {@link WorkspaceServiceTest}).</p>
 *
 * <p><b>v2 narrowing guardrails.</b> The first version accepted "holds a workspace-scoped
 * {@code delete} atom", which let every {@code WS_EDITOR} member delete the whole workspace — the
 * content delete atom is not a workspace-lifecycle credential. The gate is now
 * <i>owner ∪ {@code cap:workspace:admin}</i>; an editor, and a custom role that merely carries
 * {@code delete}, are both denied ({@link #workspaceEditorCannotDeleteWorkspace},
 * {@link #customRoleWithContentDeleteAtomCannotDeleteWorkspace}). Two further boundary cases are pinned
 * here: an authorized caller still gets {@code 404} for a workspace that does not exist, and the route
 * is decided by the service (not pre-rejected by the tenant interceptor's role gate).</p>
 */
class WorkspaceDeleteAuthorizationIntegrationTest extends AbstractH2Test {

    private static final String PASSWORD = TestDataFactory.PASSWORD;

    @Autowired
    private WorkspaceFixture workspaceFixture;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private AuditLogRepository auditLogRepository;

    @Autowired
    private AccessRoleRepository accessRoleRepository;

    @Autowired
    private AccessRolePermissionRepository accessRolePermissionRepository;

    @Autowired
    private AccessRoleBindingRepository accessRoleBindingRepository;

    @Autowired
    private RoleGrantMaterializer materializer;

    @Autowired
    private AuthzContext authzContext;

    /** Case 1 (regression): the owner may delete its own workspace. */
    @Test
    void ownerDeletesOwnWorkspace() {
        String email = "bl174-owner-" + UUID.randomUUID() + "@test.local";
        String token = register(email);
        String userId = userIdOf(email);
        Workspace workspace = workspaceFixture.ensureOwnedWorkspace(UUID.fromString(userId),
                "Owner delete workspace");

        assertEquals(HttpStatus.NO_CONTENT, delete(token, workspace.getId().toString()).getStatusCode());
        assertTrue(workspaceRepository.findByIdAndDeletedAtIsNull(workspace.getId()).isEmpty(),
                "the delete is a soft delete: the row is no longer active");
        assertTrue(workspaceDeletedAudit(workspace.getId()).isPresent(),
                "every delete writes a workspace_deleted audit row");
        String details = workspaceDeletedAudit(workspace.getId()).orElseThrow().getDetails();
        assertTrue(details.contains("actor=" + userId), details);
        assertTrue(details.contains("crossOwner=false"), details);
    }

    /** Case 2 (new behaviour): an instance administrator deletes someone else's workspace. */
    @Test
    void instanceAdministratorDeletesAnotherUsersWorkspace() {
        String ownerEmail = "bl174-target-" + UUID.randomUUID() + "@test.local";
        register(ownerEmail);
        String ownerId = userIdOf(ownerEmail);
        Workspace workspace = workspaceFixture.ensureOwnedWorkspace(UUID.fromString(ownerId),
                "Admin deletes this workspace");

        String adminEmail = "bl174-admin-" + UUID.randomUUID() + "@test.local";
        String adminToken = register(adminEmail);
        String adminId = userIdOf(adminEmail);
        grantInstanceAdmin(adminId);
        adminToken = login(adminEmail);

        assertEquals(HttpStatus.NO_CONTENT, delete(adminToken, workspace.getId().toString()).getStatusCode(),
                "cap:instance:admin must be able to clean up any workspace");
        assertTrue(workspaceRepository.findByIdAndDeletedAtIsNull(workspace.getId()).isEmpty());

        AuditLog audit = workspaceDeletedAudit(workspace.getId()).orElseThrow();
        assertTrue(audit.getDetails().contains("actor=" + adminId), audit.getDetails());
        assertTrue(audit.getDetails().contains("owner=" + ownerId), audit.getDetails());
        assertTrue(audit.getDetails().contains("crossOwner=true"), audit.getDetails());
        assertEquals(adminId, audit.getUserId(), "the audit names the acting administrator");
    }

    /** Case 3 (regression, not relaxed): neither owner nor administrator is still denied. */
    @Test
    void unrelatedCallerIsStillDenied() {
        String ownerEmail = "bl174-owner2-" + UUID.randomUUID() + "@test.local";
        register(ownerEmail);
        String ownerId = userIdOf(ownerEmail);
        Workspace workspace = workspaceFixture.ensureOwnedWorkspace(UUID.fromString(ownerId),
                "Protected workspace");

        String strangerEmail = "bl174-stranger-" + UUID.randomUUID() + "@test.local";
        String strangerToken = register(strangerEmail);

        assertEquals(HttpStatus.FORBIDDEN,
                delete(strangerToken, workspace.getId().toString()).getStatusCode(),
                "a caller with no ownership, delete atom or administration must stay denied");
        assertTrue(workspaceRepository.findByIdAndDeletedAtIsNull(workspace.getId()).isPresent(),
                "a denied delete must not touch the workspace");
        assertTrue(workspaceDeletedAudit(workspace.getId()).isEmpty(),
                "a denied delete writes no workspace_deleted audit row");
    }

    /** Case 4 (v2): a custom role holding the {@code workspace:admin} capability may delete. */
    @Test
    void customRoleWithWorkspaceAdminCapabilityCanDelete() {
        String ownerEmail = "bl174-owner3-" + UUID.randomUUID() + "@test.local";
        register(ownerEmail);
        String ownerId = userIdOf(ownerEmail);
        Workspace workspace = workspaceFixture.ensureOwnedWorkspace(UUID.fromString(ownerId),
                "Custom role workspace");

        String operatorEmail = "bl174-operator-" + UUID.randomUUID() + "@test.local";
        String operatorToken = register(operatorEmail);
        String operatorId = userIdOf(operatorEmail);

        // A custom (non-system) role carrying the workspace administration CAPABILITY atom, bound at
        // this workspace's scope — the supported way to let a non-owner manage one workspace.
        AccessRole customRole = accessRoleRepository.save(new AccessRole(UUID.randomUUID(),
                "bl174-ws-admin-" + UUID.randomUUID().toString().substring(0, 8),
                "BL-174 workspace admin", "workspace:admin only", false));
        accessRolePermissionRepository.save(new AccessRolePermission(customRole.getId(),
                PermissionAtomCatalog.CAP_WORKSPACE_ADMIN, "*"));
        accessRoleBindingRepository.save(new AccessRoleBinding(customRole.getId(),
                AuthzContext.SUBJECT_USER, UUID.fromString(operatorId), "workspace", workspace.getId(),
                UUID.fromString(operatorId)));
        accessRoleBindingRepository.flush();
        materializer.materializeSubject(AuthzContext.SUBJECT_USER, UUID.fromString(operatorId),
                UUID.fromString(operatorId), null);
        authzContext.invalidate(UUID.fromString(operatorId));

        assertEquals(HttpStatus.NO_CONTENT, delete(operatorToken, workspace.getId().toString()).getStatusCode(),
                "workspace:admin at this workspace's scope is a sufficient capability");
        assertTrue(workspaceRepository.findByIdAndDeletedAtIsNull(workspace.getId()).isEmpty());
        AuditLog audit = workspaceDeletedAudit(workspace.getId()).orElseThrow();
        assertTrue(audit.getDetails().contains("crossOwner=true"), audit.getDetails());
    }

    /**
     * v2 guardrail (the vulnerability): {@code WS_EDITOR} holds the <i>content</i> delete atom and must
     * NOT be able to delete the workspace itself.
     */
    @Test
    void workspaceEditorCannotDeleteWorkspace() {
        String ownerEmail = "bl174-ed-owner-" + UUID.randomUUID() + "@test.local";
        register(ownerEmail);
        String ownerId = userIdOf(ownerEmail);
        Workspace workspace = workspaceFixture.ensureOwnedWorkspace(UUID.fromString(ownerId),
                "Editor must not delete this");

        String editorEmail = "bl174-editor-" + UUID.randomUUID() + "@test.local";
        String editorToken = register(editorEmail);
        String editorId = userIdOf(editorEmail);
        workspaceFixture.bindWorkspaceRole(workspace.getId().toString(), editorId, WorkspaceRole.EDITOR);

        assertEquals(HttpStatus.FORBIDDEN,
                delete(editorToken, workspace.getId().toString()).getStatusCode(),
                "WS_EDITOR's content delete atom is not a workspace-lifecycle credential (BL-174 v2)");
        assertTrue(workspaceRepository.findByIdAndDeletedAtIsNull(workspace.getId()).isPresent(),
                "the editor's denied delete must not touch the workspace");
        assertTrue(workspaceDeletedAudit(workspace.getId()).isEmpty());
    }

    /** v2 guardrail: a custom role carrying only the content {@code delete} atom is still denied. */
    @Test
    void customRoleWithContentDeleteAtomCannotDeleteWorkspace() {
        String ownerEmail = "bl174-cd-owner-" + UUID.randomUUID() + "@test.local";
        register(ownerEmail);
        String ownerId = userIdOf(ownerEmail);
        Workspace workspace = workspaceFixture.ensureOwnedWorkspace(UUID.fromString(ownerId),
                "Content-delete role must not delete this");

        String operatorEmail = "bl174-cd-operator-" + UUID.randomUUID() + "@test.local";
        String operatorToken = register(operatorEmail);
        String operatorId = userIdOf(operatorEmail);
        AccessRole contentRole = accessRoleRepository.save(new AccessRole(UUID.randomUUID(),
                "bl174-content-deleter-" + UUID.randomUUID().toString().substring(0, 8),
                "BL-174 content deleter", "content delete only", false));
        accessRolePermissionRepository.save(new AccessRolePermission(contentRole.getId(), "delete", "*"));
        accessRoleBindingRepository.save(new AccessRoleBinding(contentRole.getId(),
                AuthzContext.SUBJECT_USER, UUID.fromString(operatorId), "workspace", workspace.getId(),
                UUID.fromString(operatorId)));
        accessRoleBindingRepository.flush();
        materializer.materializeSubject(AuthzContext.SUBJECT_USER, UUID.fromString(operatorId),
                UUID.fromString(operatorId), null);

        assertEquals(HttpStatus.FORBIDDEN,
                delete(operatorToken, workspace.getId().toString()).getStatusCode(),
                "the content delete atom must never authorize a workspace delete");
        assertTrue(workspaceRepository.findByIdAndDeletedAtIsNull(workspace.getId()).isPresent());
    }

    /** Boundary: an authorized caller still gets 404 (not 403) for a workspace that does not exist. */
    @Test
    void unknownWorkspaceStillReturnsNotFound() {
        String adminEmail = "bl174-404-admin-" + UUID.randomUUID() + "@test.local";
        register(adminEmail);
        String adminId = userIdOf(adminEmail);
        grantInstanceAdmin(adminId);
        String adminToken = login(adminEmail);

        ResponseEntity<String> response = delete(adminToken, UUID.randomUUID().toString());

        assertEquals(HttpStatus.NOT_FOUND, response.getStatusCode(),
                "existence stays a 404 WORKSPACE_NOT_FOUND, not folded into the authorization 403");
        assertTrue(response.getBody() != null && response.getBody().contains("WORKSPACE_NOT_FOUND"),
                String.valueOf(response.getBody()));
    }

    /**
     * Guardrail for the route classification: the tenant interceptor no longer pre-rejects this route
     * with its {@code MANAGE} gate, so a VIEWER member reaches the service and gets the service's own
     * 403. The two rejections are distinguishable by their detail text (interceptor: "Workspace access
     * denied"; service: "… requires ownership or workspace administration").
     */
    @Test
    void viewerDeleteIsDecidedByTheServiceNotTheTenantInterceptor() {
        String ownerEmail = "bl174-vw-owner-" + UUID.randomUUID() + "@test.local";
        register(ownerEmail);
        String ownerId = userIdOf(ownerEmail);
        Workspace workspace = workspaceFixture.ensureOwnedWorkspace(UUID.fromString(ownerId),
                "Viewer cannot delete this");

        String viewerEmail = "bl174-viewer-" + UUID.randomUUID() + "@test.local";
        String viewerToken = register(viewerEmail);
        String viewerId = userIdOf(viewerEmail);
        workspaceFixture.bindWorkspaceRole(workspace.getId().toString(), viewerId, WorkspaceRole.VIEWER);

        ResponseEntity<String> response = delete(viewerToken, workspace.getId().toString());

        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode());
        String body = String.valueOf(response.getBody());
        assertTrue(body.contains("WORKSPACE_FORBIDDEN"), body);
        assertTrue(body.contains("requires ownership or workspace administration"),
                "the service must be the decider (BL-174 SERVICE_CHECKED), got: " + body);
        assertTrue(!body.contains("Workspace access denied"),
                "the tenant interceptor must not pre-reject the delete route: " + body);
        assertTrue(workspaceRepository.findByIdAndDeletedAtIsNull(workspace.getId()).isPresent());
    }

    // ------------------------------------------------------------------ helpers

    private String register(String email) {
        ResponseEntity<Map> registered = restTemplate.postForEntity(url("/api/v1/auth/register"),
                jsonEntity(Map.of("email", email, "password", PASSWORD, "name", "BL-174"), null),
                Map.class);
        assertEquals(HttpStatus.CREATED, registered.getStatusCode(), String.valueOf(registered.getBody()));
        return (String) registered.getBody().get("accessToken");
    }

    private String login(String email) {
        ResponseEntity<Map> loggedIn = restTemplate.postForEntity(url("/api/v1/auth/login"),
                jsonEntity(Map.of("identifier", email, "password", PASSWORD), null), Map.class);
        assertEquals(HttpStatus.OK, loggedIn.getStatusCode(), String.valueOf(loggedIn.getBody()));
        return (String) loggedIn.getBody().get("accessToken");
    }

    private String userIdOf(String email) {
        Optional<User> user = userRepository.findByEmail(email);
        assertTrue(user.isPresent(), "fixture user must exist: " + email);
        return user.get().getId().toString();
    }

    private ResponseEntity<String> delete(String token, String workspaceId) {
        return restTemplate.exchange(url("/api/v1/workspaces/" + workspaceId), HttpMethod.DELETE,
                jsonEntity(null, token), String.class);
    }

    private void grantInstanceAdmin(String userId) {
        UUID adminRoleId = accessRoleRepository.findByName("ADMIN").orElseThrow().getId();
        accessRoleBindingRepository.deleteAll(accessRoleBindingRepository
                .findBySubjectTypeAndSubjectIdAndScopeType(AuthzContext.SUBJECT_USER,
                        UUID.fromString(userId), "instance"));
        accessRoleBindingRepository.flush();
        accessRoleBindingRepository.save(new AccessRoleBinding(adminRoleId, AuthzContext.SUBJECT_USER,
                UUID.fromString(userId), "instance", null, UUID.fromString(userId)));
        accessRoleBindingRepository.flush();
        materializer.materializeSubject(AuthzContext.SUBJECT_USER, UUID.fromString(userId),
                UUID.fromString(userId), null);
        authzContext.invalidate(UUID.fromString(userId));
        assertTrue(authzContext.isInstanceAdmin(UUID.fromString(userId)),
                "fixture precondition: the administrator holds cap:instance:admin");
    }

    private Optional<AuditLog> workspaceDeletedAudit(UUID workspaceId) {
        List<AuditLog> rows = auditLogRepository
                .findByWorkspaceIdOrderByCreatedAtDesc(workspaceId.toString());
        return rows.stream().filter(row -> "workspace_deleted".equals(row.getAction())).findFirst();
    }

    private static HttpEntity<?> jsonEntity(Object body, String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        if (token != null) {
            headers.setBearerAuth(token);
        }
        return new HttpEntity<>(body, headers);
    }
}
