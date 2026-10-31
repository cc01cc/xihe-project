package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.client.DefaultResponseErrorHandler;
import org.springframework.web.client.RestTemplate;

import java.io.IOException;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0585 T1.1/T1.2/T1.3: the admin-only principal-grant surface over real HTTP + PostgreSQL.
 *
 * <p>Covers the read view (no {@code self} on the wire), the PATCH difference set, the idempotent
 * replay, the audit row contract, the rejection matrix (403/404/400), preservation of unrelated
 * direct atoms, the target-user row lock that serializes two concurrent writers, and the V65
 * insert race that maps to 409 only for {@code uq_grants_direct_subject}.</p>
 */
class PrincipalGrantAdminControllerContractTest extends AbstractIntegrationTest {

    private static final String CREATE_ACCOUNT = "CREATE_ACCOUNT";
    private static final String MANAGE_WORKSPACE_AGENTS = "MANAGE_WORKSPACE_AGENTS";

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private JdbcTemplate jdbcTemplate;
    @Autowired private DataSource dataSource;

    private UUID adminId;
    private UUID targetId;
    private UUID workspaceId;
    private String adminUsername;
    private String targetUsername;
    private String adminToken;
    private String targetToken;
    private RestTemplate patchClient;

    @AfterEach
    void cleanFixtures() {
        // The workspace (owned by the target user) must go before its owner: fk_workspaces_owner.
        if (workspaceId != null) {
            jdbcTemplate.update("DELETE FROM audit_logs WHERE CAST(workspace_id AS VARCHAR) = ?",
                    workspaceId.toString());
            workspaceRepository.deleteById(workspaceId);
        }
        for (UUID id : new UUID[] {targetId, adminId}) {
            if (id != null) {
                jdbcTemplate.update("DELETE FROM audit_logs WHERE resource_type = 'principal_grant' "
                        + "AND resource_id = ?", id.toString());
                grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("user", id));
                jdbcTemplate.update("DELETE FROM users WHERE id = ?::uuid", id.toString());
            }
        }
        adminId = null;
        targetId = null;
        workspaceId = null;
        adminUsername = null;
        targetUsername = null;
        adminToken = null;
        targetToken = null;
    }

    @BeforeEach
    void usePatchCapableClient() {
        // The shared RestTemplate's default factory (HttpURLConnection) rejects PATCH.
        patchClient = new RestTemplate(new JdkClientHttpRequestFactory());
        patchClient.setErrorHandler(new DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(ClientHttpResponse response) throws IOException {
                return response.getStatusCode().is5xxServerError();
            }
        });
    }

    @Test
    void grantThenRevokeIsAuditedAndIdempotent() {
        fixture();

        ResponseEntity<Map> before = get(adminToken, targetUsername);
        assertEquals(HttpStatus.OK, before.getStatusCode(), String.valueOf(before.getBody()));
        assertEquals(targetId.toString(), before.getBody().get("userId"));
        assertEquals(targetUsername, before.getBody().get("username"));
        assertFalse(before.getBody().containsKey("self"), "the read view carries no self field");
        assertEquals(List.of(), before.getBody().get("grants"));

        ResponseEntity<Map> granted = patch(adminToken, targetUsername,
                Map.of("add", List.of(Map.of("actionClass", CREATE_ACCOUNT))));
        assertEquals(HttpStatus.OK, granted.getStatusCode(), String.valueOf(granted.getBody()));
        assertEquals(true, granted.getBody().get("changed"));
        assertEquals(List.of(Map.of("actionClass", CREATE_ACCOUNT, "resource", "*")),
                grantsOf(granted));
        assertEquals(1, directRowCount(targetId));
        assertEquals(1, auditCount(targetId, "principal_grant_added"));

        Map<String, Object> auditRow = jdbcTemplate.queryForMap(
                "SELECT user_id, workspace_id, resource_id, details FROM audit_logs "
                        + "WHERE resource_type = 'principal_grant' AND action = 'principal_grant_added' "
                        + "AND resource_id = ?", targetId.toString());
        assertEquals(adminId.toString(), String.valueOf(auditRow.get("user_id")));
        assertNull(auditRow.get("workspace_id"));
        assertEquals(targetId.toString(), auditRow.get("resource_id"));
        String details = String.valueOf(auditRow.get("details"));
        assertTrue(details.contains("subjectType=user"), details);
        assertTrue(details.contains("subjectId=" + targetId), details);
        assertTrue(details.contains("atom=" + CREATE_ACCOUNT + "@*"), details);
        assertTrue(details.contains("self=false"), details);
        assertFalse(details.toLowerCase().contains("token"), details);
        assertFalse(details.toLowerCase().contains("password"), details);

        // Idempotent replay: same atom again (explicit wildcard) changes nothing and re-audits nothing.
        ResponseEntity<Map> replay = patch(adminToken, targetUsername,
                Map.of("add", List.of(Map.of("actionClass", CREATE_ACCOUNT, "resource", "*"))));
        assertEquals(HttpStatus.OK, replay.getStatusCode(), String.valueOf(replay.getBody()));
        assertEquals(false, replay.getBody().get("changed"));
        assertEquals(1, auditCount(targetId, "principal_grant_added"));
        assertEquals(1, directRowCount(targetId));

        ResponseEntity<Map> revoked = patch(adminToken, targetUsername,
                Map.of("remove", List.of(Map.of("actionClass", CREATE_ACCOUNT))));
        assertEquals(HttpStatus.OK, revoked.getStatusCode(), String.valueOf(revoked.getBody()));
        assertEquals(true, revoked.getBody().get("changed"));
        assertEquals(List.of(), grantsOf(revoked));
        assertEquals(0, directRowCount(targetId));
        assertEquals(1, auditCount(targetId, "principal_grant_removed"));

        ResponseEntity<Map> revokedAgain = patch(adminToken, targetUsername,
                Map.of("remove", List.of(Map.of("actionClass", CREATE_ACCOUNT))));
        assertEquals(HttpStatus.OK, revokedAgain.getStatusCode());
        assertEquals(false, revokedAgain.getBody().get("changed"));
        assertEquals(1, auditCount(targetId, "principal_grant_removed"));

        ResponseEntity<Map> after = get(adminToken, targetUsername);
        assertEquals(List.of(), after.getBody().get("grants"));
    }

    @Test
    void workspaceScopedAtomIsStoredAsCanonicalUuid() {
        fixture();
        UUID grantWorkspaceId = workspaceRepository.saveAndFlush(
                new Workspace("Grant target workspace", targetId.toString())).getId();
        workspaceId = grantWorkspaceId;

        ResponseEntity<Map> granted = patch(adminToken, targetUsername, Map.of("add",
                List.of(Map.of("actionClass", MANAGE_WORKSPACE_AGENTS,
                        "resource", grantWorkspaceId.toString().toUpperCase()))));
        assertEquals(HttpStatus.OK, granted.getStatusCode(), String.valueOf(granted.getBody()));
        assertEquals(List.of(Map.of("actionClass", MANAGE_WORKSPACE_AGENTS,
                "resource", grantWorkspaceId.toString())), grantsOf(granted));

        String permissions = permissionsJson(targetId);
        assertTrue(permissions.contains("\"actionClass\":\"MANAGE_WORKSPACE_AGENTS\""), permissions);
        assertTrue(permissions.contains("\"resource\":\"" + grantWorkspaceId + "\""), permissions);
        Map<String, Object> auditRow = jdbcTemplate.queryForMap(
                "SELECT workspace_id, details FROM audit_logs WHERE resource_type = 'principal_grant' "
                        + "AND action = 'principal_grant_added' AND resource_id = ?",
                targetId.toString());
        assertEquals(grantWorkspaceId.toString(), String.valueOf(auditRow.get("workspace_id")));
        assertTrue(String.valueOf(auditRow.get("details"))
                .contains("atom=" + MANAGE_WORKSPACE_AGENTS + "@" + grantWorkspaceId));
    }

    @Test
    void selfGrantIsAllowedAndAudited() {
        fixture();

        ResponseEntity<Map> granted = patch(adminToken, adminUsername,
                Map.of("add", List.of(Map.of("actionClass", CREATE_ACCOUNT))));
        assertEquals(HttpStatus.OK, granted.getStatusCode(), String.valueOf(granted.getBody()));
        assertEquals(true, granted.getBody().get("changed"));
        assertFalse(granted.getBody().containsKey("self"),
                "self-grant is allowed but the response carries no self field (audit only)");
        assertEquals(adminId.toString(), granted.getBody().get("userId"));
        assertEquals(List.of(Map.of("actionClass", CREATE_ACCOUNT, "resource", "*")),
                grantsOf(granted));

        Map<String, Object> auditRow = jdbcTemplate.queryForMap(
                "SELECT user_id, workspace_id, resource_id, details FROM audit_logs "
                        + "WHERE resource_type = 'principal_grant' AND action = 'principal_grant_added' "
                        + "AND resource_id = ?", adminId.toString());
        assertEquals(adminId.toString(), String.valueOf(auditRow.get("user_id")));
        assertEquals(adminId.toString(), auditRow.get("resource_id"));
        assertNull(auditRow.get("workspace_id"));
        assertTrue(String.valueOf(auditRow.get("details")).contains("self=true"),
                String.valueOf(auditRow.get("details")));
        assertEquals(1, directRowCount(adminId));

        // The grant is a normal direct row: revoking it round-trips like any other target.
        ResponseEntity<Map> revoked = patch(adminToken, adminUsername,
                Map.of("remove", List.of(Map.of("actionClass", CREATE_ACCOUNT))));
        assertEquals(HttpStatus.OK, revoked.getStatusCode());
        assertEquals(true, revoked.getBody().get("changed"));
        assertEquals(1, auditCount(adminId, "principal_grant_removed"));
        assertEquals(0, directRowCount(adminId));
    }

    @Test
    void nonAdminIsForbiddenWithoutTargetInformation() {
        fixture();

        for (ResponseEntity<Map> response : List.of(
                get(targetToken, targetUsername),
                patch(targetToken, targetUsername, Map.of("add",
                        List.of(Map.of("actionClass", CREATE_ACCOUNT)))))) {
            assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode(), String.valueOf(response.getBody()));
            String body = String.valueOf(response.getBody());
            assertFalse(body.contains(targetUsername), body);
            assertFalse(body.contains(CREATE_ACCOUNT), body);
        }
        assertEquals(0, directRowCount(targetId));
        assertEquals(0, auditCount(targetId, "principal_grant_added"));
    }

    @Test
    void unknownUsernameIsNotFound() {
        fixture();

        ResponseEntity<Map> read = get(adminToken, "no-such-user-" + UUID.randomUUID());
        assertEquals(HttpStatus.NOT_FOUND, read.getStatusCode());
        assertEquals("USER_NOT_FOUND", read.getBody().get("code"));

        ResponseEntity<Map> write = patch(adminToken, "no-such-user-" + UUID.randomUUID(),
                Map.of("add", List.of(Map.of("actionClass", CREATE_ACCOUNT))));
        assertEquals(HttpStatus.NOT_FOUND, write.getStatusCode());
        assertEquals("USER_NOT_FOUND", write.getBody().get("code"));
    }

    @Test
    void uppercasedUsernameIsNotFound() {
        fixture();
        // Decision #12: exact match, no case folding — an upper-case spelling is an unknown user
        // (login already normalizes to lower case), never a silent hit on the real account.
        String uppercased = targetUsername.toUpperCase(java.util.Locale.ROOT);
        ResponseEntity<Map> read = get(adminToken, uppercased);
        assertEquals(HttpStatus.NOT_FOUND, read.getStatusCode(), String.valueOf(read.getBody()));
        assertEquals("USER_NOT_FOUND", read.getBody().get("code"));

        ResponseEntity<Map> write = patch(adminToken, uppercased,
                Map.of("add", List.of(Map.of("actionClass", CREATE_ACCOUNT))));
        assertEquals(HttpStatus.NOT_FOUND, write.getStatusCode(), String.valueOf(write.getBody()));
        assertEquals(0, directRowCount(targetId));
    }

    @Test
    void unmanageableActionsAndMalformedResourcesAreRejected() {
        fixture();
        UUID probeWorkspaceId = UUID.randomUUID();

        assertRejected(patch(adminToken, targetUsername,
                Map.of("add", List.of(Map.of("actionClass", "CREATE_TEMPLATE")))),
                "UNMANAGEABLE_ACTION_CLASS");
        assertRejected(patch(adminToken, targetUsername,
                Map.of("add", List.of(Map.of("actionClass", "NOT_AN_ACTION")))),
                "UNKNOWN_ACTION_CLASS");
        assertRejected(patch(adminToken, targetUsername,
                Map.of("add", List.of(Map.of("actionClass", CREATE_ACCOUNT,
                        "resource", probeWorkspaceId.toString())))),
                "INVALID_GRANT_RESOURCE");
        assertRejected(patch(adminToken, targetUsername,
                Map.of("add", List.of(Map.of("actionClass", MANAGE_WORKSPACE_AGENTS,
                        "resource", "*")))),
                "INVALID_GRANT_RESOURCE");
        assertRejected(patch(adminToken, targetUsername,
                Map.of("add", List.of(Map.of("actionClass", MANAGE_WORKSPACE_AGENTS)))),
                "INVALID_GRANT_RESOURCE");
        // UUID#fromString tolerates shorthand spellings; the surface must not store them.
        assertRejected(patch(adminToken, targetUsername,
                Map.of("add", List.of(Map.of("actionClass", MANAGE_WORKSPACE_AGENTS,
                        "resource", "1-2-3-4-5")))),
                "INVALID_GRANT_RESOURCE");
        // A workspace that does not exist can never take effect (and would break the audit FK).
        assertRejected(patch(adminToken, targetUsername,
                Map.of("add", List.of(Map.of("actionClass", MANAGE_WORKSPACE_AGENTS,
                        "resource", UUID.randomUUID().toString())))),
                "INVALID_GRANT_RESOURCE");
        assertRejected(patch(adminToken, targetUsername, Map.of()), "INVALID_REQUEST");
        assertRejected(patch(adminToken, targetUsername,
                Map.of("add", List.of(Map.of("actionClass", CREATE_ACCOUNT)),
                        "remove", List.of(Map.of("actionClass", CREATE_ACCOUNT)))),
                "INVALID_REQUEST");

        assertEquals(0, directRowCount(targetId));
        assertEquals(0, auditCount(targetId, "principal_grant_added"));
        assertEquals(0, auditCount(targetId, "principal_grant_removed"));
    }

    @Test
    void deletedWorkspaceCannotBeGrantedAgainButCanBeRevoked() {
        fixture();
        UUID grantWorkspaceId = workspaceRepository.saveAndFlush(
                new Workspace("Grant target deleted workspace", targetId.toString())).getId();
        workspaceId = grantWorkspaceId;

        ResponseEntity<Map> granted = patch(adminToken, targetUsername, Map.of("add",
                List.of(Map.of("actionClass", MANAGE_WORKSPACE_AGENTS,
                        "resource", grantWorkspaceId.toString()))));
        assertEquals(HttpStatus.OK, granted.getStatusCode(), String.valueOf(granted.getBody()));

        // Soft delete: the atom is now stale but stays on the user's direct row.
        jdbcTemplate.update("UPDATE workspaces SET deleted_at = NOW() WHERE id = ?::uuid",
                grantWorkspaceId.toString());

        assertRejected(patch(adminToken, targetUsername, Map.of("add",
                List.of(Map.of("actionClass", MANAGE_WORKSPACE_AGENTS,
                        "resource", grantWorkspaceId.toString())))),
                "INVALID_GRANT_RESOURCE");

        // Revocation stays permissive: cleanup must never be blocked by a deleted workspace, and
        // the audit row falls back to workspace_id=null because the FK target is gone.
        ResponseEntity<Map> revoked = patch(adminToken, targetUsername, Map.of("remove",
                List.of(Map.of("actionClass", MANAGE_WORKSPACE_AGENTS,
                        "resource", grantWorkspaceId.toString()))));
        assertEquals(HttpStatus.OK, revoked.getStatusCode(), String.valueOf(revoked.getBody()));
        assertEquals(true, revoked.getBody().get("changed"));
        assertEquals(0, directRowCount(targetId));
        Map<String, Object> removal = jdbcTemplate.queryForMap(
                "SELECT workspace_id FROM audit_logs WHERE resource_type = 'principal_grant' "
                        + "AND action = 'principal_grant_removed' AND resource_id = ?",
                targetId.toString());
        assertNull(removal.get("workspace_id"));
    }

    @Test
    void unknownBodyFieldsCannotRetargetSubject() {
        fixture();
        UUID otherUserId = UUID.randomUUID();

        // Spring Boot ignores unknown JSON properties by default; the path username stays the only
        // target authority, so an injected identifier has no effect.
        ResponseEntity<Map> response = patch(adminToken, targetUsername,
                Map.of("add", List.of(Map.of("actionClass", CREATE_ACCOUNT)),
                        "userId", otherUserId.toString(),
                        "subjectId", otherUserId.toString()));
        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        assertEquals(targetId.toString(), response.getBody().get("userId"));
        assertEquals(1, directRowCount(targetId));
        assertEquals(0, directRowCount(otherUserId));
        assertEquals(0, auditCount(otherUserId, "principal_grant_added"));
    }

    @Test
    void unrelatedDirectAtomsArePreserved() {
        fixture();
        seedDirectAtoms("read", "write");

        ResponseEntity<Map> granted = patch(adminToken, targetUsername,
                Map.of("add", List.of(Map.of("actionClass", CREATE_ACCOUNT))));
        assertEquals(HttpStatus.OK, granted.getStatusCode(), String.valueOf(granted.getBody()));
        assertEquals(true, granted.getBody().get("changed"));

        String permissions = permissionsJson(targetId);
        assertTrue(permissions.contains("\"actionClass\":\"read\""), permissions);
        assertTrue(permissions.contains("\"actionClass\":\"write\""), permissions);
        assertTrue(permissions.contains("\"actionClass\":\"CREATE_ACCOUNT\""), permissions);

        // The surface's own view stays scoped to the atoms it manages.
        assertEquals(List.of(Map.of("actionClass", CREATE_ACCOUNT, "resource", "*")),
                grantsOf(get(adminToken, targetUsername)));

        // Revoking leaves the unrelated atoms (and the row) in place.
        ResponseEntity<Map> revoked = patch(adminToken, targetUsername,
                Map.of("remove", List.of(Map.of("actionClass", CREATE_ACCOUNT))));
        assertEquals(true, revoked.getBody().get("changed"));
        assertEquals(1, directRowCount(targetId));
        String afterRevoke = permissionsJson(targetId);
        assertFalse(afterRevoke.contains("CREATE_ACCOUNT"), afterRevoke);
        assertTrue(afterRevoke.contains("\"actionClass\":\"read\""), afterRevoke);
    }

    @Test
    void concurrentPatchesSerializeOnTheTargetUser() throws Exception {
        fixture();
        UUID grantWorkspaceId = workspaceRepository.saveAndFlush(
                new Workspace("Grant concurrency workspace", targetId.toString())).getId();
        workspaceId = grantWorkspaceId;

        CountDownLatch start = new CountDownLatch(1);
        Callable<ResponseEntity<Map>> createAccount = () -> {
            start.await();
            return patch(adminToken, targetUsername,
                    Map.of("add", List.of(Map.of("actionClass", CREATE_ACCOUNT))));
        };
        Callable<ResponseEntity<Map>> manageAgents = () -> {
            start.await();
            return patch(adminToken, targetUsername, Map.of("add",
                    List.of(Map.of("actionClass", MANAGE_WORKSPACE_AGENTS,
                            "resource", grantWorkspaceId.toString()))));
        };

        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<ResponseEntity<Map>> first = pool.submit(createAccount);
            Future<ResponseEntity<Map>> second = pool.submit(manageAgents);
            start.countDown();
            for (Future<ResponseEntity<Map>> future : List.of(first, second)) {
                ResponseEntity<Map> response = future.get(60, TimeUnit.SECONDS);
                assertEquals(HttpStatus.OK, response.getStatusCode(),
                        String.valueOf(response.getBody()));
                assertEquals(true, response.getBody().get("changed"),
                        "each writer adds its own atom, so both report a change");
            }
        } finally {
            pool.shutdownNow();
        }

        // Both writes land in the one direct row: the union, never a lost update, one row.
        assertEquals(1, directRowCount(targetId));
        assertEquals(List.of(
                        Map.of("actionClass", CREATE_ACCOUNT, "resource", "*"),
                        Map.of("actionClass", MANAGE_WORKSPACE_AGENTS,
                                "resource", grantWorkspaceId.toString())),
                grantsOf(get(adminToken, targetUsername)));
        assertEquals(1, auditCountForAtom(targetId, CREATE_ACCOUNT + "@*"));
        assertEquals(1, auditCountForAtom(targetId,
                MANAGE_WORKSPACE_AGENTS + "@" + grantWorkspaceId));
    }

    @Test
    void directRowInsertRaceReturnsConflict() throws Exception {
        fixture();

        // Hold an uncommitted direct row on a second connection: the PATCH cannot see it, so its
        // own insert waits on the V65 unique index and fails once the holder commits.
        //
        // Isolation: the connection comes fresh from this test class's own pool (never a shared
        // static connection), the holder transaction is rolled back in the finally block, and the
        // scheduled commit is cancelled there, so no uncommitted state or late commit can leak into
        // the following test in this class.
        try (Connection holder = dataSource.getConnection()) {
            holder.setAutoCommit(false);
            try (PreparedStatement insert = holder.prepareStatement(
                    "INSERT INTO grants (id, subject_type, subject_id, permissions, source, read_state) "
                            + "VALUES (gen_random_uuid(), 'user', ?::uuid, ?::jsonb, 'direct', 'read')")) {
                insert.setString(1, targetId.toString());
                insert.setString(2, "[{\"actionClass\":\"read\"}]");
                insert.executeUpdate();
            }
            ScheduledExecutorService committer = Executors.newSingleThreadScheduledExecutor();
            ScheduledFuture<?> pendingCommit = null;
            try {
                pendingCommit = committer.schedule(() -> {
                    try {
                        holder.commit();
                    } catch (SQLException e) {
                        throw new IllegalStateException("held direct row commit failed", e);
                    }
                }, 600, TimeUnit.MILLISECONDS);
                ResponseEntity<Map> response = patch(adminToken, targetUsername,
                        Map.of("add", List.of(Map.of("actionClass", CREATE_ACCOUNT))));
                assertEquals(HttpStatus.CONFLICT, response.getStatusCode(),
                        String.valueOf(response.getBody()));
                assertEquals("DIRECT_GRANT_CONFLICT", response.getBody().get("code"));
            } finally {
                if (pendingCommit != null) {
                    pendingCommit.cancel(false);
                }
                committer.shutdownNow();
                holder.rollback();
            }
        }

        // The retry recomputes the difference set from the persisted row, so it converges.
        ResponseEntity<Map> retry = patch(adminToken, targetUsername,
                Map.of("add", List.of(Map.of("actionClass", CREATE_ACCOUNT))));
        assertEquals(HttpStatus.OK, retry.getStatusCode(), String.valueOf(retry.getBody()));
        assertEquals(true, retry.getBody().get("changed"));
        assertEquals(1, directRowCount(targetId));
        assertTrue(permissionsJson(targetId).contains("\"actionClass\":\"CREATE_ACCOUNT\""));
    }

    // --- helpers ---------------------------------------------------------------------------

    private void fixture() {
        User admin = new User("pg-admin-" + UUID.randomUUID() + "@test.com", "hash", UserRole.ADMIN,
                "Grant admin", "pgadmin" + shortId());
        admin = userRepository.saveAndFlush(admin);
        adminId = admin.getId();
        adminUsername = admin.getUsername();
        User target = new User("pg-target-" + UUID.randomUUID() + "@test.com", "hash", UserRole.USER,
                "Grant target", "pgtarget" + shortId());
        target = userRepository.saveAndFlush(target);
        targetId = target.getId();
        targetUsername = target.getUsername();
        adminToken = TestDataFactory.createGlobalToken(adminId.toString(), admin.getEmail(), "ADMIN", 0);
        targetToken = TestDataFactory.createGlobalToken(targetId.toString(), target.getEmail(), "USER", 0);
    }

    private static String shortId() {
        return UUID.randomUUID().toString().replace("-", "").substring(0, 8);
    }

    private void seedDirectAtoms(String... actionClasses) {
        StringBuilder atoms = new StringBuilder("[");
        for (int i = 0; i < actionClasses.length; i++) {
            if (i > 0) {
                atoms.append(',');
            }
            atoms.append("{\"actionClass\":\"").append(actionClasses[i]).append("\"}");
        }
        atoms.append(']');
        jdbcTemplate.update(
                "INSERT INTO grants (id, subject_type, subject_id, permissions, source, read_state) "
                        + "VALUES (gen_random_uuid(), 'user', ?::uuid, ?::jsonb, 'direct', 'read')",
                targetId.toString(), atoms.toString());
    }

    private String path(String username) {
        return "/api/v1/principal-grants/" + username;
    }

    private ResponseEntity<Map> get(String token, String username) {
        return patchClient.exchange(url(path(username)), HttpMethod.GET,
                new HttpEntity<>(auth(token)), Map.class);
    }

    private ResponseEntity<Map> patch(String token, String username, Object body) {
        HttpHeaders headers = auth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return patchClient.exchange(url(path(username)), HttpMethod.PATCH,
                new HttpEntity<>(body, headers), Map.class);
    }

    private static HttpHeaders auth(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return headers;
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> grantsOf(ResponseEntity<Map> response) {
        return (List<Map<String, Object>>) response.getBody().get("grants");
    }

    private void assertRejected(ResponseEntity<Map> response, String code) {
        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode(), String.valueOf(response.getBody()));
        assertEquals(code, response.getBody().get("code"), String.valueOf(response.getBody()));
    }

    private int directRowCount(UUID userId) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM grants WHERE subject_type = 'user' AND subject_id = ?::uuid "
                        + "AND source = 'direct'", Integer.class, userId.toString());
    }

    private String permissionsJson(UUID userId) {
        String text = jdbcTemplate.queryForObject(
                "SELECT permissions::text FROM grants WHERE subject_type = 'user' "
                        + "AND subject_id = ?::uuid AND source = 'direct'",
                String.class, userId.toString());
        // jsonb renders "k": v with a space; the assertions look at the canonical atoms only.
        return text == null ? null : text.replace(" ", "");
    }

    private int auditCount(UUID targetUserId, String action) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE resource_type = 'principal_grant' "
                        + "AND action = ? AND resource_id = ?",
                Integer.class, action, targetUserId.toString());
    }

    private int auditCountForAtom(UUID targetUserId, String atom) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE resource_type = 'principal_grant' "
                        + "AND action = 'principal_grant_added' AND resource_id = ? "
                        + "AND details LIKE ?",
                Integer.class, targetUserId.toString(), "%atom=" + atom + "%");
    }
}
