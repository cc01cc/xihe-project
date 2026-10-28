package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.client.RestTemplate;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0565 T1.5: the spec §3 permission matrix over real HTTP + PostgreSQL,
 * plus last-owner protection and the concurrent-add serialization (spec §4/§8).
 */
class WorkspaceMemberControllerContractTest extends AbstractIntegrationTest {

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceUserRepository workspaceUserRepository;
    @Autowired private JdbcTemplate jdbcTemplate;

    private UUID ownerId;
    private UUID workspaceId;
    private String ownerToken;
    private String ownerUsername;
    private RestTemplate client;
    private final List<UUID> extraUsers = new java.util.ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        if (workspaceId != null) {
            jdbcTemplate.update("DELETE FROM workspace_users WHERE workspace_id = ?::uuid",
                    workspaceId.toString());
            jdbcTemplate.update("DELETE FROM audit_logs WHERE CAST(workspace_id AS VARCHAR) = ?",
                    workspaceId.toString());
            workspaceRepository.deleteById(workspaceId);
        }
        for (UUID id : extraUsers) {
            jdbcTemplate.update("DELETE FROM users WHERE id = ?::uuid", id.toString());
        }
        if (ownerId != null) {
            jdbcTemplate.update("DELETE FROM users WHERE id = ?::uuid", ownerId.toString());
        }
        extraUsers.clear();
        ownerId = null;
        workspaceId = null;
    }

    @Test
    void ownerManagesMembersAndEditorIsReadOnly() {
        fixture();

        User target = newUser("editor-target");
        String targetUsername = target.getUsername();
        String path = path();

        // OWNER sees the list containing himself.
        ResponseEntity<List> list = request(HttpMethod.GET, path, null, ownerToken, true, List.class);
        assertEquals(HttpStatusCode.valueOf(200), list.getStatusCode(),
                String.valueOf(list.getBody()));
        assertTrue(list.getBody().stream().anyMatch(row -> ownerId.toString()
                .equals(String.valueOf(((Map<?, ?>) row).get("userId")))));

        // Add an existing account by username (ruling #7).
        ResponseEntity<Map> added = request(HttpMethod.POST, path,
                Map.of("username", targetUsername, "role", "EDITOR"), ownerToken, true, Map.class);
        assertEquals(HttpStatusCode.valueOf(201), added.getStatusCode(),
                String.valueOf(added.getBody()));
        assertEquals(targetUsername, added.getBody().get("username"));
        assertEquals("EDITOR", added.getBody().get("role"));
        UUID targetId = UUID.fromString(String.valueOf(added.getBody().get("userId")));

        // Insert-only: the same username again is a conflict, not an upsert.
        ResponseEntity<Map> duplicate = request(HttpMethod.POST, path,
                Map.of("username", targetUsername, "role", "VIEWER"), ownerToken, true, Map.class);
        assertEquals(HttpStatusCode.valueOf(409), duplicate.getStatusCode());
        assertEquals("MEMBER_ALREADY_EXISTS", code(duplicate));

        // Unknown username → 404 USER_NOT_FOUND (ruling #6 copy is a UI mapping).
        ResponseEntity<Map> unknown = request(HttpMethod.POST, path,
                Map.of("username", "no-such-user", "role", "VIEWER"), ownerToken, true, Map.class);
        assertEquals(HttpStatusCode.valueOf(404), unknown.getStatusCode());
        assertEquals("USER_NOT_FOUND", code(unknown));

        // Role input is limited to EDITOR|VIEWER (OWNER/legacy values are 400).
        assertEquals(HttpStatusCode.valueOf(400),
                request(HttpMethod.POST, path,
                        Map.of("username", targetUsername, "role", "OWNER"), ownerToken, true,
                        Map.class).getStatusCode());
        assertEquals(HttpStatusCode.valueOf(400),
                request(HttpMethod.POST, path,
                        Map.of("username", targetUsername, "role", "MEMBER"), ownerToken, true,
                        Map.class).getStatusCode());

        // Role change and removal round-trip with durable audit rows.
        ResponseEntity<Map> patched = request(HttpMethod.PATCH, path + "/" + targetId,
                Map.of("role", "VIEWER"), ownerToken, true, Map.class);
        assertEquals(HttpStatusCode.valueOf(200), patched.getStatusCode(),
                String.valueOf(patched.getBody()));
        assertEquals("VIEWER", patched.getBody().get("role"));
        ResponseEntity<Void> removed = request(HttpMethod.DELETE, path + "/" + targetId,
                null, ownerToken, true, Void.class);
        assertEquals(HttpStatusCode.valueOf(204), removed.getStatusCode());

        Integer auditRows = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE CAST(workspace_id AS VARCHAR) = ? "
                        + "AND action IN ('workspace_member_added','workspace_member_role_changed',"
                        + "'workspace_member_removed')",
                Integer.class, workspaceId.toString());
        assertEquals(3, auditRows);
    }

    @Test
    void editorCanReadButWritesAreForbidden() {
        fixture();
        String editorToken = tokenFor(newUser("editor-member"), "EDITOR");

        assertEquals(HttpStatusCode.valueOf(200),
                request(HttpMethod.GET, path(), null, editorToken, true, List.class)
                        .getStatusCode(), "EDITOR list is read-only visible (ruling #2)");

        ResponseEntity<Map> deniedAdd = request(HttpMethod.POST, path(),
                Map.of("username", ownerUsername, "role", "VIEWER"), editorToken, true, Map.class);
        assertEquals(HttpStatusCode.valueOf(403), deniedAdd.getStatusCode());
        assertEquals("WORKSPACE_FORBIDDEN", code(deniedAdd));

        ResponseEntity<Map> deniedPatch = request(HttpMethod.PATCH, path() + "/" + ownerId,
                Map.of("role", "VIEWER"), editorToken, true, Map.class);
        assertEquals(HttpStatusCode.valueOf(403), deniedPatch.getStatusCode());

        ResponseEntity<Void> deniedDelete = request(HttpMethod.DELETE, path() + "/" + ownerId,
                null, editorToken, true, Void.class);
        assertEquals(HttpStatusCode.valueOf(403), deniedDelete.getStatusCode());
    }

    @Test
    void viewerCannotSeeTheListAndWritesStayReadOnly() {
        fixture();
        String viewerToken = tokenFor(newUser("viewer-member"), "VIEWER");

        ResponseEntity<Map> deniedList = request(HttpMethod.GET, path(), null, viewerToken,
                true, Map.class);
        assertEquals(HttpStatusCode.valueOf(403), deniedList.getStatusCode(),
                "VIEWER list is hidden (ruling #2)");
        assertEquals("WORKSPACE_FORBIDDEN", code(deniedList));

        // With the workspace header the 0559 guard pre-empts VIEWER writes.
        ResponseEntity<Map> deniedWrite = request(HttpMethod.POST, path(),
                Map.of("username", ownerUsername, "role", "VIEWER"), viewerToken, true, Map.class);
        assertEquals(HttpStatusCode.valueOf(403), deniedWrite.getStatusCode());
        assertEquals("WORKSPACE_READ_ONLY", code(deniedWrite));
    }

    @Test
    void nonMembersAreRejectedOnBothHeaderAndHeaderlessPaths() {
        fixture();
        String outsiderToken = tokenFor(newUser("outsider"), null);

        // Header path: the tenant gate rejects before the member service.
        ResponseEntity<Map> viaHeader = request(HttpMethod.GET, path(), null, outsiderToken,
                true, Map.class);
        assertEquals(HttpStatusCode.valueOf(403), viaHeader.getStatusCode());
        assertEquals("WORKSPACE_FORBIDDEN", code(viaHeader));

        // Headerless path: the member service self-held matrix rejects.
        ResponseEntity<Map> headerless = request(HttpMethod.GET, path(), null, outsiderToken,
                false, Map.class);
        assertEquals(HttpStatusCode.valueOf(403), headerless.getStatusCode());
        assertEquals("WORKSPACE_FORBIDDEN", code(headerless));
    }

    @Test
    void instanceAdminCanReadAndEmergencyRemoveButNotChangeRoles() {
        fixture();
        User target = newUser("admin-target");
        User admin = adminUser();
        String adminToken = TestDataFactory.createGlobalToken(admin.getId().toString(),
                admin.getEmail(), "ADMIN");

        // Read without any workspace header (spec §7 API-only fallback path).
        assertEquals(HttpStatusCode.valueOf(200),
                request(HttpMethod.GET, path(), null, adminToken, false, List.class)
                        .getStatusCode(), "instance ADMIN reads the list (ruling #3)");

        // Unknown workspace for an authorized caller stays 404.
        ResponseEntity<Map> missing = request(HttpMethod.GET,
                "/api/v1/workspaces/" + UUID.randomUUID() + "/members", null, adminToken,
                false, Map.class);
        assertEquals(HttpStatusCode.valueOf(404), missing.getStatusCode());
        assertEquals("WORKSPACE_NOT_FOUND", code(missing));

        // Role changes stay OWNER-only, even for instance ADMIN.
        ResponseEntity<Map> deniedPatch = request(HttpMethod.PATCH, path() + "/" + target.getId(),
                Map.of("role", "EDITOR"), adminToken, false, Map.class);
        assertEquals(HttpStatusCode.valueOf(403), deniedPatch.getStatusCode());
        ResponseEntity<Map> deniedAdd = request(HttpMethod.POST, path(),
                Map.of("username", target.getUsername(), "role", "VIEWER"), adminToken,
                false, Map.class);
        assertEquals(HttpStatusCode.valueOf(403), deniedAdd.getStatusCode());

        // Emergency removal works without membership.
        workspaceUserRepository.saveAndFlush(new WorkspaceUser(workspaceId.toString(),
                target.getId().toString(), WorkspaceRole.EDITOR));
        ResponseEntity<Void> removed = request(HttpMethod.DELETE, path() + "/" + target.getId(),
                null, adminToken, false, Void.class);
        assertEquals(HttpStatusCode.valueOf(204), removed.getStatusCode());
        assertTrue(workspaceUserRepository.findByIdWorkspaceIdAndIdUserId(
                workspaceId, target.getId()).isEmpty());

        // Removing the unique OWNER is refused even for instance ADMIN.
        ResponseEntity<Map> lastOwner = request(HttpMethod.DELETE, path() + "/" + ownerId,
                null, adminToken, false, Map.class);
        assertEquals(HttpStatusCode.valueOf(409), lastOwner.getStatusCode());
        assertEquals("LAST_OWNER", code(lastOwner));
    }

    @Test
    void lastOwnerIsProtectedAndDualOwnersCanSplit() {
        fixture();

        // Self-demotion and self-removal of the unique owner are both 409.
        ResponseEntity<Map> demote = request(HttpMethod.PATCH, path() + "/" + ownerId,
                Map.of("role", "VIEWER"), ownerToken, true, Map.class);
        assertEquals(HttpStatusCode.valueOf(409), demote.getStatusCode());
        assertEquals("LAST_OWNER", code(demote));
        ResponseEntity<Map> remove = request(HttpMethod.DELETE, path() + "/" + ownerId,
                null, ownerToken, true, Map.class);
        assertEquals(HttpStatusCode.valueOf(409), remove.getStatusCode());
        assertEquals("LAST_OWNER", code(remove));

        // Fixture-seeded dual owners (API cannot grant OWNER; spec §2): one removal succeeds.
        User second = newUser("second-owner");
        workspaceUserRepository.saveAndFlush(new WorkspaceUser(workspaceId.toString(),
                second.getId().toString(), WorkspaceRole.OWNER));
        ResponseEntity<Void> split = request(HttpMethod.DELETE, path() + "/" + second.getId(),
                null, ownerToken, true, Void.class);
        assertEquals(HttpStatusCode.valueOf(204), split.getStatusCode());
    }

    @Test
    void concurrentAddOfTheSameUsernameSerializesWithoutDoubleInsert() throws Exception {
        fixture();
        User target = newUser("racing-target");
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Callable<ResponseEntity<Map>> add = () -> request(HttpMethod.POST, path(),
                    Map.of("username", target.getUsername(), "role", "VIEWER"), ownerToken,
                    true, Map.class);
            Future<ResponseEntity<Map>> first = pool.submit(add);
            Future<ResponseEntity<Map>> second = pool.submit(add);
            HttpStatusCode firstStatus = first.get(30, TimeUnit.SECONDS).getStatusCode();
            HttpStatusCode secondStatus = second.get(30, TimeUnit.SECONDS).getStatusCode();
            assertTrue(HttpStatusCode.valueOf(201).equals(firstStatus)
                    || HttpStatusCode.valueOf(201).equals(secondStatus),
                    "one add must succeed");
            assertTrue(HttpStatusCode.valueOf(409).equals(firstStatus)
                    || HttpStatusCode.valueOf(409).equals(secondStatus),
                    "the duplicate must be a 409 MEMBER_ALREADY_EXISTS");
            assertNotEquals(firstStatus, secondStatus);
        } finally {
            pool.shutdownNow();
        }
        assertEquals(1, workspaceUserRepository.findByIdUserId(target.getId()).size());
    }

    private User adminUser;

    private User adminUser() {
        if (adminUser == null) {
            adminUser = newUser("instance-admin-holder");
        }
        return adminUser;
    }

    private void fixture() {
        User owner = userRepository.saveAndFlush(new User(
                "member-owner-" + UUID.randomUUID() + "@test.com", "hash", UserRole.USER, "Owner"));
        ownerId = owner.getId();
        ownerUsername = owner.getUsername();
        Workspace workspace = workspaceRepository.saveAndFlush(
                new Workspace("Member matrix test", ownerId.toString()));
        workspaceId = workspace.getId();
        workspaceUserRepository.saveAndFlush(new WorkspaceUser(workspaceId.toString(),
                ownerId.toString(), WorkspaceRole.OWNER));
        ownerToken = TestDataFactory.createGlobalToken(ownerId.toString(), owner.getEmail(), "USER");
        // JDK HttpClient factory supports PATCH (the shared RestTemplate cannot).
        client = new RestTemplate(new JdkClientHttpRequestFactory());
        client.setErrorHandler(new org.springframework.web.client.DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(org.springframework.http.client.ClientHttpResponse response)
                    throws java.io.IOException {
                return response.getStatusCode().is5xxServerError();
            }
        });
    }

    private User newUser(String label) {
        User user = userRepository.saveAndFlush(new User(
                label + "-" + UUID.randomUUID() + "@test.com", "hash", UserRole.USER, label));
        extraUsers.add(user.getId());
        return user;
    }

    /** Token for a user; a non-null workspaceRole seeds a membership row (header path). */
    private String tokenFor(User user, String workspaceRole) {
        if (workspaceRole != null) {
            workspaceUserRepository.saveAndFlush(new WorkspaceUser(workspaceId.toString(),
                    user.getId().toString(), WorkspaceRole.valueOf(workspaceRole)));
        }
        return TestDataFactory.createGlobalToken(user.getId().toString(), user.getEmail(), "USER");
    }

    private String path() {
        return "/api/v1/workspaces/" + workspaceId + "/members";
    }

    private <T> ResponseEntity<T> request(HttpMethod method, String path, Object body,
            String token, boolean withWorkspaceHeader, Class<T> responseType) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        if (withWorkspaceHeader) {
            headers.set("X-Workspace-Id", workspaceId.toString());
        }
        return client.exchange(url(path), method, new HttpEntity<>(body, headers), responseType);
    }

    private String code(ResponseEntity<?> response) {
        Object body = response.getBody();
        return body == null ? null : String.valueOf(((Map<?, ?>) body).get("code"));
    }
}
