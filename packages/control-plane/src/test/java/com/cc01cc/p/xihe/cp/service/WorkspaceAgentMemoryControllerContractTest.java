package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.policy.GrantSources;
import com.cc01cc.p.xihe.cp.repository.AgentMemoryRepository;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.client.DefaultResponseErrorHandler;
import org.springframework.web.client.RestTemplate;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * PLAN-0629 M1-5: the memory write API on a real PostgreSQL.
 *
 * <p>What is asserted here is the part a service test cannot see: the {@code MEMORY_WRITE} <b>action
 * atom</b> gate on the wire (403 before any existence lookup), the 404 for a principal the caller
 * cannot see, the body contract ({@code additionalProperties:false}, so an unknown key is a 400), the
 * dedupe/dedupe-conflict 201/409 pair, and the archive ruling of 2026-11-03 expressed as
 * {@code DELETE → status=retired|all}.</p>
 */
class WorkspaceAgentMemoryControllerContractTest extends AbstractIntegrationTest {

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private com.cc01cc.p.xihe.cp.integration.WorkspaceFixture workspaceFixture;
    @Autowired private AgentPrincipalRepository principalRepository;
    @Autowired private WorkspaceAgentRepository bindingRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private AgentMemoryRepository memories;
    @Autowired private ObjectMapper objectMapper;
    @Autowired private JdbcTemplate jdbcTemplate;

    private UUID userId;
    private UUID otherUserId;
    private UUID workspaceId;
    private UUID otherWorkspaceId;
    private UUID otherPrincipalId;
    private UUID principalId;
    private UUID adminTargetPrincipalId;
    private String token;
    private RestTemplate patchClient;

    @BeforeEach
    void initPatchClient() {
        // PATCH is not supported by HttpURLConnection (the shared RestTemplate's default factory).
        patchClient = new RestTemplate(new JdkClientHttpRequestFactory());
        patchClient.setErrorHandler(new DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(org.springframework.http.client.ClientHttpResponse response) {
                return false;
            }
        });
    }

    @AfterEach
    void cleanFixtures() {
        if (principalId != null || otherPrincipalId != null) {
            jdbcTemplate.update("DELETE FROM agent_memories WHERE principal_id IN (CAST(? AS UUID), CAST(? AS UUID))",
                    String.valueOf(principalId), String.valueOf(otherPrincipalId));
        }
        if (principalId != null && workspaceId != null) {
            bindingRepository.deleteById(new WorkspaceAgentId(principalId, workspaceId));
        }
        if (otherPrincipalId != null && otherWorkspaceId != null) {
            bindingRepository.deleteById(new WorkspaceAgentId(otherPrincipalId, otherWorkspaceId));
        }
        if (adminTargetPrincipalId != null && workspaceId != null) {
            bindingRepository.deleteById(new WorkspaceAgentId(adminTargetPrincipalId, workspaceId));
            principalRepository.deleteById(adminTargetPrincipalId);
        }
        if (workspaceId != null) {
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("user", userId));
            jdbcTemplate.update("DELETE FROM audit_logs WHERE CAST(workspace_id AS VARCHAR) = ?",
                    workspaceId.toString());
            workspaceRepository.deleteById(workspaceId);
        }
        if (otherWorkspaceId != null) {
            workspaceRepository.deleteById(otherWorkspaceId);
        }
        if (principalId != null) {
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("agent_principal", principalId));
            principalRepository.deleteById(principalId);
        }
        if (otherPrincipalId != null) {
            principalRepository.deleteById(otherPrincipalId);
        }
        if (userId != null) {
            jdbcTemplate.update("DELETE FROM audit_logs WHERE user_id = CAST(? AS UUID)", userId.toString());
            userRepository.deleteById(userId);
        }
        if (otherUserId != null) {
            userRepository.deleteById(otherUserId);
        }
    }

    @Test
    void writeNeedsTheMemoryAtomAndOnlyThenFindsThePrincipal() throws Exception {
        fixture();

        // 1) No atom: 403, and the check happens before the visibility lookup (no existence oracle).
        ResponseEntity<Map> denied = createMemory(randomUuid().toString(), Map.of("content", "x"));
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatusCode(), String.valueOf(denied.getBody()));
        assertEquals("FORBIDDEN", denied.getBody().get("code"));

        addGrant("MEMORY_WRITE", workspaceId.toString());

        // 2) Atom held, principal not visible in this workspace: the read face's 404.
        ResponseEntity<Map> invisible = createMemory(otherPrincipalId.toString(), Map.of("content", "x"));
        assertEquals(HttpStatus.NOT_FOUND, invisible.getStatusCode(), String.valueOf(invisible.getBody()));
        assertEquals("AGENT_PRINCIPAL_NOT_FOUND", invisible.getBody().get("code"));

        // 3) Atom held + visible principal: created with the injected provenance.
        ResponseEntity<Map> created = createMemory(principalId.toString(), Map.of("content", "Deploys on Fridays"));
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), String.valueOf(created.getBody()));
        Map<?, ?> view = (Map<?, ?>) created.getBody().get("memory");
        assertNotNull(view, "the create response is {memory:{…}}: " + created.getBody());
        assertEquals("Deploys on Fridays", view.get("content"));
        assertEquals(Boolean.FALSE, view.get("pinned"));
        assertEquals("manual", view.get("origin"), "origin=ui maps to the UI bucket `manual`");
        assertEquals(Boolean.FALSE, view.get("archived"));
        assertNull(view.get("deletedAt"));
        assertNotNull(view.get("createdAt"));
        assertFalse(view.containsKey("type"), "V106 removed the profile/fact classification");
    }

    @Test
    void createDedupesAndRejectsBadBodies() throws Exception {
        fixture();
        addGrant("MEMORY_WRITE", workspaceId.toString());

        ResponseEntity<Map> first = createMemory(principalId.toString(), Map.of("content", "  Likes   concise answers "));
        assertEquals(HttpStatus.CREATED, first.getStatusCode(), String.valueOf(first.getBody()));
        ResponseEntity<Map> second = createMemory(principalId.toString(), Map.of("content", "Likes concise answers"));
        assertEquals(HttpStatus.CREATED, second.getStatusCode(), String.valueOf(second.getBody()));
        assertEquals(
                ((Map<?, ?>) first.getBody().get("memory")).get("id"),
                ((Map<?, ?>) second.getBody().get("memory")).get("id"),
                "the same normalized assertion is one row, whatever the whitespace");
        assertEquals(1, memories.count());

        assertInvalid(principalId.toString(), Map.of("content", "x", "type", "fact"),
                "additionalProperties:false: `type` is gone (V106)");
        assertInvalid(principalId.toString(), Map.of("content", "x", "extra", 1), "unknown key");
        assertInvalid(principalId.toString(), Map.of(), "content is required");
        assertInvalid(principalId.toString(), Map.of("content", 42), "content must be a string");
        assertInvalid(principalId.toString(), Map.of("content", "x", "pinned", "yes"), "pinned must be a boolean");
        assertInvalid(principalId.toString(), Map.of("content", "   \u200B  "), "blank content");

        ResponseEntity<Map> tooLong = createMemory(principalId.toString(),
                Map.of("content", "x".repeat(8001)));
        assertEquals(HttpStatus.BAD_REQUEST, tooLong.getStatusCode());
        assertEquals("MEMORY_CONTENT_TOO_LONG", tooLong.getBody().get("code"));
        assertEquals(1, memories.count(), "no rejected write may reach the table");
    }

    @Test
    void patchEditsContentAndPinAndRefusesADedupeCollision() throws Exception {
        fixture();
        addGrant("MEMORY_WRITE", workspaceId.toString());
        String idA = createdId(createMemory(principalId.toString(), Map.of("content", "first assertion")));
        String idB = createdId(createMemory(principalId.toString(), Map.of("content", "second assertion")));

        ResponseEntity<Map> pinned = patchMemory(principalId.toString(), idB, Map.of("pinned", true));
        assertEquals(HttpStatus.OK, pinned.getStatusCode(), String.valueOf(pinned.getBody()));
        Map<?, ?> pinnedView = (Map<?, ?>) pinned.getBody().get("memory");
        assertEquals(Boolean.TRUE, pinnedView.get("pinned"));
        assertEquals("second assertion", pinnedView.get("content"), "an omitted field is left alone");

        ResponseEntity<Map> collision = patchMemory(principalId.toString(), idB, Map.of("content", "first assertion"));
        assertEquals(HttpStatus.CONFLICT, collision.getStatusCode(), String.valueOf(collision.getBody()));
        assertEquals("MEMORY_DUPLICATE", collision.getBody().get("code"));

        ResponseEntity<Map> edited = patchMemory(principalId.toString(), idB, Map.of("content", "second, edited"));
        assertEquals(HttpStatus.OK, edited.getStatusCode(), String.valueOf(edited.getBody()));
        assertEquals("second, edited", ((Map<?, ?>) edited.getBody().get("memory")).get("content"));
        assertNotEquals(idA, idB, "two distinct assertions are two rows");
        assertInvalidPatch(principalId.toString(), idB, Map.of(), "an empty PATCH names no change");
        assertInvalidPatch(principalId.toString(), idB, Map.of("type", "fact"), "`type` is gone");
        assertInvalidPatch(principalId.toString(), idB, Map.of("content", 7), "content must be a string");

        ResponseEntity<Map> foreign = patchMemory(principalId.toString(), randomUuid().toString(),
                Map.of("pinned", false));
        assertEquals(HttpStatus.NOT_FOUND, foreign.getStatusCode(), String.valueOf(foreign.getBody()));
        assertEquals("MEMORY_NOT_FOUND", foreign.getBody().get("code"));
    }

    @Test
    void deleteArchivesAndTheStatusQueryReadsItBack() throws Exception {
        fixture();
        addGrant("MEMORY_WRITE", workspaceId.toString());
        String id = createdId(createMemory(principalId.toString(), Map.of("content", "Archived by ruling")));

        List<Map<String, Object>> active = listMemories("active");
        assertEquals(1, active.size());
        assertEquals(Boolean.FALSE, active.getFirst().get("archived"));

        ResponseEntity<Void> archived = deleteMemory(principalId.toString(), id);
        assertEquals(HttpStatus.NO_CONTENT, archived.getStatusCode());

        assertEquals(0, listMemories("active").size(), "an archived row leaves the default read face");
        List<Map<String, Object>> retired = listMemories("retired");
        assertEquals(1, retired.size(), "the archive view must be readable, or it looks like data loss");
        assertEquals(Boolean.TRUE, retired.getFirst().get("archived"));
        assertNotNull(retired.getFirst().get("deletedAt"));
        assertEquals(1, listMemories("all").size());
        assertEquals(1, countAudit("memory_deleted"));

        ResponseEntity<Map> badStatus = listMemoriesResponse("nonsense");
        assertEquals(HttpStatus.BAD_REQUEST, badStatus.getStatusCode(), String.valueOf(badStatus.getBody()));
        assertEquals("INVALID_REQUEST", badStatus.getBody().get("code"),
                "an unknown status is a 400, never a silent fallback");

        assertEquals(HttpStatus.NOT_FOUND, deleteMemory(principalId.toString(), id).getStatusCode(),
                "archiving twice is a 404, not a second audit row");

        ResponseEntity<Map> rewritten = createMemory(principalId.toString(), Map.of("content", "Archived by ruling"));
        assertEquals(HttpStatus.CREATED, rewritten.getStatusCode());
        String rewrittenId = createdId(rewritten);
        assertFalse(rewrittenId.equals(id), "the archive freed the dedupe key");
    }

    @Test
    void selfAtomWritesOwnPrincipalWithoutAnyMemoryWriteGrant() throws Exception {
        fixture();
        // EDITOR carries MEMORY_WRITE_SELF by default (BL-345); no MEMORY_WRITE grant is added.
        ResponseEntity<Map> own = createMemory(principalId.toString(),
                Map.of("content", "Own principal memory"));
        assertEquals(HttpStatus.CREATED, own.getStatusCode(), String.valueOf(own.getBody()));

        // A principal created by another user is not "mine": 403 even though SELF is held.
        ResponseEntity<Map> foreign = createMemory(otherPrincipalId.toString(),
                Map.of("content", "Foreign memory"));
        assertEquals(HttpStatus.FORBIDDEN, foreign.getStatusCode(), String.valueOf(foreign.getBody()));
        assertEquals("FORBIDDEN", foreign.getBody().get("code"));

        // The audit trail names the atom and its grant provenance (role → MEMORY_WRITE_SELF).
        Integer hits = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE action = 'authorization_atom_hit'"
                        + " AND CAST(workspace_id AS VARCHAR) = ? AND details LIKE '%MEMORY_WRITE_SELF%'",
                Integer.class, workspaceId.toString());
        assertNotNull(hits);
        assertEquals(1, hits.intValue(), "the self write must record atom → grant source");
    }

    @Test
    void workspaceAdminWritesAnySubjectInTheWorkspace() throws Exception {
        fixture();
        // WS_OWNER carries MEMORY_WRITE (ruling B), so any visible subject is writable.
        workspaceFixture.bindWorkspaceRole(workspaceId.toString(), userId.toString(), WorkspaceRole.OWNER);
        adminTargetPrincipalId = newPrincipal("Admin target", otherUserId);
        bindingRepository.saveAndFlush(new WorkspaceAgent(adminTargetPrincipalId.toString(),
                workspaceId.toString(), objectMapper.readTree("[{\"actionClass\":\"read\"}]")));

        ResponseEntity<Map> created = createMemory(adminTargetPrincipalId.toString(),
                Map.of("content", "Admin writes another owner's subject"));
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), String.valueOf(created.getBody()));
    }

    // ── fixtures / helpers ────────────────────────────────────────────────────────────────

    private void fixture() throws Exception {
        User user = userRepository.saveAndFlush(new User("memory-write-" + UUID.randomUUID() + "@test.com",
                "hash", "Memory Write Test"));
        userId = user.getId();
        workspaceId = workspaceFixture.createOwnedWorkspace("Memory write ws", userId.toString()).getId();
        otherWorkspaceId = workspaceFixture.createOwnedWorkspace("Memory other ws", userId.toString()).getId();
        // EDITOR is the ordinary operator: WS_OWNER materializes atoms by design and would bypass the gate.
        workspaceFixture.bindWorkspaceRole(workspaceId.toString(), userId.toString(), WorkspaceRole.EDITOR);
        workspaceFixture.bindWorkspaceRole(otherWorkspaceId.toString(), userId.toString(), WorkspaceRole.EDITOR);

        otherUserId = userRepository.saveAndFlush(new User(
                "memory-other-" + UUID.randomUUID() + "@test.com", "hash", "Other User")).getId();
        principalId = newPrincipal("MemoryAgent", userId);
        bindingRepository.saveAndFlush(new WorkspaceAgent(principalId.toString(), workspaceId.toString(),
                objectMapper.readTree("[{\"actionClass\":\"read\"}]")));
        otherPrincipalId = newPrincipal("OtherWorkspaceAgent", otherUserId);
        bindingRepository.saveAndFlush(new WorkspaceAgent(otherPrincipalId.toString(), otherWorkspaceId.toString(),
                objectMapper.readTree("[{\"actionClass\":\"read\"}]")));
        addGrant("read", "*");
        token = TestDataFactory.createWorkspaceToken(userId.toString(), user.getEmail(), "USER",
                workspaceId.toString(), 0);
    }

    private UUID newPrincipal(String name, UUID creatorId) throws Exception {
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName(name);
        principal.setCreatedByUserId(creatorId.toString());
        principal.setTemplateId("template-1");
        principal.setTemplateSnapshot(objectMapper.createObjectNode());
        return principalRepository.saveAndFlush(principal).getId();
    }

    private void addGrant(String actionClass, String resource) throws Exception {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setGranterType("user");
        grant.setGranterId(userId);
        grant.setSubjectType("user");
        grant.setSubjectId(userId);
        grant.setSource(GrantSources.ROLE);
        grant.setReadState("read");
        grant.setPermissions(objectMapper.readTree("[{\"actionClass\":\"" + actionClass
                + "\",\"resource\":\"" + resource + "\"}]"));
        grantRepository.saveAndFlush(grant);
    }

    private static UUID randomUuid() {
        return UUID.randomUUID();
    }

    private String createdId(ResponseEntity<Map> response) {
        assertEquals(HttpStatus.CREATED, response.getStatusCode(), String.valueOf(response.getBody()));
        return String.valueOf(((Map<?, ?>) response.getBody().get("memory")).get("id"));
    }

    private void assertInvalid(String principalId, Map<String, Object> body, String why) {
        ResponseEntity<Map> response = createMemory(principalId, body);
        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode(), why + " — " + response.getBody());
        assertEquals("INVALID_REQUEST", response.getBody().get("code"), why);
    }

    private void assertInvalidPatch(String principalId, String memoryId, Map<String, Object> body, String why) {
        ResponseEntity<Map> response = patchMemory(principalId, memoryId, body);
        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode(), why + " — " + response.getBody());
        assertEquals("INVALID_REQUEST", response.getBody().get("code"), why);
    }

    private String basePath(String principalId) {
        return "/api/v1/workspaces/" + workspaceId + "/agents/" + principalId + "/memories";
    }

    private ResponseEntity<Map> createMemory(String principalId, Map<String, Object> body) {
        return exchange(HttpMethod.POST, basePath(principalId), body);
    }

    private ResponseEntity<Map> patchMemory(String principalId, String memoryId, Map<String, Object> body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return patchClient.exchange(url(basePath(principalId) + "/" + memoryId), HttpMethod.PATCH,
                new HttpEntity<>(body, headers), Map.class);
    }

    private ResponseEntity<Void> deleteMemory(String principalId, String memoryId) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return restTemplate.exchange(url(basePath(principalId) + "/" + memoryId), HttpMethod.DELETE,
                new HttpEntity<>(headers), Void.class);
    }

    private List<Map<String, Object>> listMemories(String status) {
        ResponseEntity<Map> response = listMemoriesResponse(status);
        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> rows = (List<Map<String, Object>>) response.getBody().get("memories");
        assertNotNull(rows, "the frozen {memories:[…]} envelope: " + response.getBody());
        return rows;
    }

    private ResponseEntity<Map> listMemoriesResponse(String status) {
        return exchange(HttpMethod.GET, basePath(principalId.toString()) + "?status=" + status, null);
    }

    private int countAudit(String action) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE action = ? AND resource_type = 'agent_memory' "
                        + "AND CAST(workspace_id AS VARCHAR) = ?",
                Integer.class, action, workspaceId.toString());
    }

    // ── V107: the subject-level route ────────────────────────────────────────────────────

    private String subjectBasePath() {
        return "/api/v1/agent-principals/" + principalId + "/memories";
    }

    @Test
    void subjectLevelRouteReadsTheSameRowsAndCarriesNoWorkspaceField() throws Exception {
        fixture();
        addGrant("MEMORY_WRITE", "*");
        String id = createdId(createMemory(principalId.toString(), Map.of("content", "Shared across workspaces")));

        ResponseEntity<Map> oldPath = exchange(HttpMethod.GET, basePath(principalId.toString()) + "?status=active", null);
        assertEquals(HttpStatus.OK, oldPath.getStatusCode(), String.valueOf(oldPath.getBody()));
        ResponseEntity<Map> newPath = exchange(HttpMethod.GET,
                subjectBasePath() + "?workspaceId=" + workspaceId + "&status=active", null);
        assertEquals(HttpStatus.OK, newPath.getStatusCode(), String.valueOf(newPath.getBody()));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> rows = (List<Map<String, Object>>) newPath.getBody().get("memories");
        assertEquals(1, rows.size(), String.valueOf(newPath.getBody()));
        assertEquals(id, rows.get(0).get("id"), "the subject route returns the same row as the alias");
        assertFalse(rows.get(0).containsKey("workspaceId"),
                "V107: a memory row is not owned by a workspace, so the view must not carry one");
    }

    @Test
    void subjectLevelRouteRejectsAMissingAuthorizationWorkspace() throws Exception {
        fixture();
        addGrant("MEMORY_WRITE", "*");

        // The workspace is the authorization context, so omitting it is a malformed request, not an
        // implicit "no workspace needed" read: Spring rejects the required query parameter with the
        // project's standard 400 envelope before any lookup happens.
        ResponseEntity<Map> missing = exchange(HttpMethod.GET, subjectBasePath(), null);
        assertEquals(HttpStatus.BAD_REQUEST, missing.getStatusCode(), String.valueOf(missing.getBody()));
        assertEquals("INVALID_REQUEST", missing.getBody().get("code"));

        // With a workspace present the read face uses the visibility gate (the same one the nested
        // alias used), not MEMORY_WRITE: an empty set is the answer, not a 403.
        ResponseEntity<Map> listed = exchange(HttpMethod.GET, subjectBasePath() + "?workspaceId=" + workspaceId, null);
        assertEquals(HttpStatus.OK, listed.getStatusCode(), String.valueOf(listed.getBody()));
        assertEquals(List.of(), listed.getBody().get("memories"));
    }

    @Test
    void subjectLevelWriteKeepsTheAtomGateBeforeExistence() throws Exception {
        fixture();

        // No atom yet: 403 even for a principal that is not mine (no existence oracle). The own
        // principal would be allowed by MEMORY_WRITE_SELF since BL-345, so this uses another user's
        // principal to keep proving the "any subject" gate.
        ResponseEntity<Map> denied = exchange(HttpMethod.POST,
                "/api/v1/agent-principals/" + otherPrincipalId + "/memories?workspaceId=" + workspaceId,
                Map.of("content", "x"));
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatusCode(), String.valueOf(denied.getBody()));

        addGrant("MEMORY_WRITE", "*");
        ResponseEntity<Map> created = exchange(HttpMethod.POST,
                subjectBasePath() + "?workspaceId=" + workspaceId, Map.of("content", "Written subject-level"));
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), String.valueOf(created.getBody()));
        Map<?, ?> view = (Map<?, ?>) created.getBody().get("memory");
        assertEquals("Written subject-level", view.get("content"));
        assertEquals("manual", view.get("origin"));
        assertFalse(view.containsKey("workspaceId"), "no workspace semantics on the wire (V107)");
    }
    @SuppressWarnings("unchecked")
    private <T> ResponseEntity<T> exchange(HttpMethod method, String path, Object body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return restTemplate.exchange(url(path), method, new HttpEntity<>(body, headers), (Class<T>) Map.class);
    }
}
