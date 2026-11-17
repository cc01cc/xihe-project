package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.support.TestAgentPrincipals;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-134 (D-1785): the workspace-level delegated-child read face
 * {@code GET /api/v1/workspaces/{ws}/agents/{pid}/spawn-sessions}.
 *
 * <p>Assembly-level on purpose (the checklist's minimum for a new route): real interceptor + real
 * controller + real service + real database. The route's two decisions are made in different layers
 * — the roster gate in {@code WorkspaceMemberService}, the count in
 * {@code AgentSpawnSessionReadService} — so unit tests of either would stay green while the seam is
 * wrong.</p>
 *
 * <p>What this pins (each assertion names the rule it protects):</p>
 * <ol>
 *   <li><b>honest count</b> — an OWNER sees a colleague's delegated child that their own
 *       {@code GET /api/v1/sessions} does NOT contain (the silent under-count this face exists to
 *       kill);</li>
 *   <li><b>count and content are independent</b> — that same row is counted, but
 *       {@code readable:false, title:null} (PLAN-0668 D1b);</li>
 *   <li><b>VIEWER ⇒ 403</b> (the roster gate) while EDITOR/OWNER are 200;</li>
 *   <li><b>depth cohorts</b> — {@code counts.all} vs {@code counts.direct} in one response;</li>
 *   <li><b>archived opt-in</b> — excluded by default, counted and flagged when asked;</li>
 *   <li><b>limit never truncates the count</b>;</li>
 *   <li><b>no existence oracle</b> — an unknown principal answers an empty 200, not 404.</li>
 * </ol>
 */
class DelegateSpawnSessionReadTest extends AbstractReusableIntegrationTest {

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private AgentPrincipalRepository principalRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private SessionRepository sessionRepository;
    @Autowired private ChatRunRepository chatRunRepository;
    @Autowired private ObjectMapper objectMapper;
    @Autowired private JdbcTemplate jdbcTemplate;

    private UUID ownerId;
    private UUID editorId;
    private UUID viewerId;
    private UUID colleagueId;
    private UUID outsiderId;
    private UUID workspaceId;
    private UUID principalId;
    private String ownerToken;
    private String editorToken;
    private String viewerToken;
    private String outsiderToken;
    private final List<UUID> users = new ArrayList<>();

    @BeforeEach
    void fixture() throws Exception {
        User owner = userRepository.saveAndFlush(new User("spawn-read-owner-" + UUID.randomUUID() + "@test.com",
                "hash", "Owner"));
        ownerId = owner.getId();
        users.add(ownerId);
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Spawn read test", ownerId.toString());
        workspaceId = workspace.getId();
        User editor = userRepository.saveAndFlush(new User("spawn-read-editor-" + UUID.randomUUID() + "@test.com",
                "hash", "Editor"));
        editorId = editor.getId();
        users.add(editorId);
        workspaceFixture.bindWorkspaceRole(workspaceId.toString(), editorId.toString(), WorkspaceRole.EDITOR);
        User viewer = userRepository.saveAndFlush(new User("spawn-read-viewer-" + UUID.randomUUID() + "@test.com",
                "hash", "Viewer"));
        viewerId = viewer.getId();
        users.add(viewerId);
        workspaceFixture.bindWorkspaceRole(workspaceId.toString(), viewerId.toString(), WorkspaceRole.VIEWER);
        User colleague = userRepository.saveAndFlush(new User(
                "spawn-read-colleague-" + UUID.randomUUID() + "@test.com", "hash", "Colleague"));
        colleagueId = colleague.getId();
        users.add(colleagueId);
        workspaceFixture.bindWorkspaceRole(workspaceId.toString(), colleagueId.toString(), WorkspaceRole.EDITOR);
        User outsider = userRepository.saveAndFlush(new User(
                "spawn-read-outsider-" + UUID.randomUUID() + "@test.com", "hash", "Outsider"));
        outsiderId = outsider.getId();
        users.add(outsiderId);

        AgentPrincipal principal = TestAgentPrincipals.newUserAgentPrincipal();
        principal.setName("DelegateAgent");
        principal.setCreatedByUserId(ownerId.toString());
        principal.setTemplateId("template-1");
        principal.setTemplateSnapshot(objectMapper.readTree(
                "{\"templateId\":\"template-1\",\"templateName\":\"Delegate\"}"));
        principal = principalRepository.saveAndFlush(principal);
        principalId = principal.getId();

        ownerToken = token(owner, ownerId);
        editorToken = token(editor, editorId);
        viewerToken = token(viewer, viewerId);
        outsiderToken = token(outsider, outsiderId);
    }

    @AfterEach
    void cleanFixtures() {
        if (workspaceId != null) {
            jdbcTemplate.update("DELETE FROM chat_runs WHERE workspace_id = ?", workspaceId);
            jdbcTemplate.update("DELETE FROM sessions WHERE workspace_id = ?", workspaceId);
            jdbcTemplate.update("DELETE FROM audit_logs WHERE CAST(workspace_id AS VARCHAR) = ?",
                    workspaceId.toString());
            workspaceRepository.deleteById(workspaceId);
        }
        if (principalId != null) {
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                    "agent_principal", principalId));
        }
        for (UUID user : users) {
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("user", user));
        }
        if (principalId != null) {
            principalRepository.deleteById(principalId);
        }
        for (UUID user : users) {
            userRepository.deleteById(user);
        }
        users.clear();
    }

    // ---------------------------------------------------------------- tests

    @Test
    void honestCount_countsColleagueChildThatTheCallerCannotList_butRedactsItsTitle() throws Exception {
        // The colleague chatted; the Agent delegated a child inside that conversation.
        Session colleagueRoot = rootSession(colleagueId, "同事的会话");
        Session colleagueChild = spawnChild(colleagueRoot.getId(), colleagueId, "同事的委派", false);

        // Control: the owner's own session list is the CALLER's visible set and cannot see it.
        JsonNode listed = ownerSessions();
        assertFalse(containsSession(listed, colleagueChild.getId()),
                "control: GET /api/v1/sessions must not contain the colleague's session — "
                        + "that absence IS the silent under-count the new face replaces");

        JsonNode body = get(ownerToken, "");
        assertEquals(1, body.path("counts").path("all").asInt(),
                "the count must come from the workspace, not from the caller's visible set");
        assertEquals(1, body.path("counts").path("direct").asInt());
        JsonNode row = body.path("sessions").get(0);
        assertEquals(colleagueChild.getId().toString(), row.path("id").asText());
        assertEquals(1, row.path("depth").asInt());
        assertTrue(row.path("direct").asBoolean());
        assertFalse(row.path("readable").asBoolean(),
                "count and content are independent invariants: counted, not readable");
        assertTrue(row.path("title").isNull(), "an unreadable row must never carry a title");
        assertEquals(colleagueRoot.getId().toString(), row.path("parentSessionId").asText());
    }

    @Test
    void viewerAnswers403_editorAndOwnerAnswer200_outsiderAnswers403() {
        ResponseEntity<Map> viewer = rawGet(viewerToken, "");
        assertEquals(HttpStatus.FORBIDDEN, viewer.getStatusCode(),
                "the roster gate excludes VIEWER; this read face must not be looser than the roster");
        assertEquals(HttpStatus.OK, rawGet(editorToken, "").getStatusCode());
        assertEquals(HttpStatus.OK, rawGet(ownerToken, "").getStatusCode());
        assertEquals(HttpStatus.FORBIDDEN, rawGet(outsiderToken, "").getStatusCode());
    }

    @Test
    void depthCohorts_allIsTheWholeCone_directIsTheFirstLevel() throws Exception {
        Session root = rootSession(ownerId, "我的会话");
        Session first = spawnChild(root.getId(), ownerId, "直接委派", false);
        Session second = spawnChild(first.getId(), ownerId, "孙辈委派", false);

        JsonNode all = get(ownerToken, "");
        assertEquals(2, all.path("counts").path("all").asInt());
        assertEquals(1, all.path("counts").path("direct").asInt(),
                "counts carry BOTH cohorts so the UI never needs a second request");
        assertEquals(2, all.path("sessions").size());
        JsonNode grandChild = rowFor(all, second.getId());
        assertEquals(2, grandChild.path("depth").asInt());
        assertFalse(grandChild.path("direct").asBoolean());

        JsonNode direct = get(ownerToken, "?depth=direct");
        assertEquals(1, direct.path("sessions").size());
        assertEquals(first.getId().toString(), direct.path("sessions").get(0).path("id").asText());
        assertEquals(2, direct.path("counts").path("all").asInt(),
                "the filter narrows rows, never the honest counts");

        assertEquals(HttpStatus.BAD_REQUEST, rawGet(ownerToken, "?depth=deep").getStatusCode());
    }

    @Test
    void archivedChild_isExcludedByDefault_andCountedWhenOptedIn() throws Exception {
        Session root = rootSession(ownerId, "我的会话");
        spawnChild(root.getId(), ownerId, "在跑的委派", false);
        Session archived = spawnChild(root.getId(), ownerId, "已归档的委派", true);

        JsonNode defaults = get(ownerToken, "");
        assertEquals(1, defaults.path("counts").path("all").asInt(),
                "archived children are not part of 'what is running now'");
        assertEquals(1, defaults.path("sessions").size());

        JsonNode withArchived = get(ownerToken, "?includeArchived=true");
        assertEquals(2, withArchived.path("counts").path("all").asInt());
        assertTrue(withArchived.path("includeArchived").asBoolean());
        assertTrue(rowFor(withArchived, archived.getId()).path("archived").asBoolean());
    }

    @Test
    void limitTruncatesRowsButNeverTheCounts() throws Exception {
        Session root = rootSession(ownerId, "我的会话");
        spawnChild(root.getId(), ownerId, "一", false);
        spawnChild(root.getId(), ownerId, "二", false);

        JsonNode body = get(ownerToken, "?limit=1");
        assertEquals(1, body.path("sessions").size());
        assertTrue(body.path("truncated").asBoolean());
        assertEquals(2, body.path("counts").path("all").asInt(), "the count is honest even when rows are capped");
        assertEquals(1, body.path("limit").asInt());

        assertEquals(HttpStatus.BAD_REQUEST, rawGet(ownerToken, "?limit=0").getStatusCode());
        assertEquals(HttpStatus.BAD_REQUEST, rawGet(ownerToken, "?limit=501").getStatusCode());
    }

    @Test
    void unknownPrincipal_answersEmpty200_notAnExistenceOracle() throws Exception {
        UUID stranger = UUID.randomUUID();
        JsonNode body = json(rawGet(ownerToken, "", stranger));
        assertEquals(0, body.path("counts").path("all").asInt());
        assertEquals(0, body.path("sessions").size(),
                "an unknown principal answers the same as one with no delegations (no 404 oracle)");
    }

    @Test
    void malformedPrincipalUuid_answers400() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(ownerToken);
        ResponseEntity<Map> response = restTemplate.exchange(
                url("/api/v1/workspaces/" + workspaceId + "/agents/not-a-uuid/spawn-sessions"),
                HttpMethod.GET, new HttpEntity<>(null, headers), Map.class);

        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode(),
                "a malformed path uuid is client input, not a 500");
    }

    @Test
    void activeRunStatus_isReportedEvenForAnUnreadableRow() throws Exception {
        Session colleagueRoot = rootSession(colleagueId, "同事的会话");
        Session child = spawnChild(colleagueRoot.getId(), colleagueId, "同事的委派", false);
        runningRun(child, colleagueId);

        JsonNode body = get(ownerToken, "");
        JsonNode row = rowFor(body, child.getId());
        assertEquals("running", row.path("runStatus").asText());
        assertTrue(row.path("active").asBoolean());
        assertFalse(row.path("readable").asBoolean(), "status is a count-face fact, not content");
    }

    @Test
    void readableRow_carriesItsTitle() throws Exception {
        Session root = rootSession(ownerId, "我的会话");
        Session child = spawnChild(root.getId(), ownerId, "我能读的委派", false);

        JsonNode row = rowFor(get(ownerToken, ""), child.getId());
        assertTrue(row.path("readable").asBoolean());
        assertEquals("我能读的委派", row.path("title").asText());

        // The same session read through the roster (editor is a member but not a participant) stays
        // counted while its title is redacted — the two invariants again, from the other direction.
        JsonNode asEditor = rowFor(get(editorToken, ""), child.getId());
        assertFalse(asEditor.path("readable").asBoolean());
        assertTrue(asEditor.path("title").isNull());
        assertNotNull(asEditor.path("id").asText());
    }

    // ---------------------------------------------------------------- helpers

    private String token(User user, UUID userId) {
        return TestDataFactory.createWorkspaceToken(userId.toString(), user.getEmail(), "USER",
                workspaceId.toString(), 0);
    }

    private Session rootSession(UUID ownerUserId, String title) {
        Session root = new Session(workspaceId.toString(), ownerUserId.toString(), title);
        // Session has an assigned @Id (no generator): a fixture that forgets it fails at persist.
        root.setId(UUID.randomUUID());
        return sessionRepository.saveAndFlush(root);
    }

    private Session spawnChild(UUID parentId, UUID ownerUserId, String title, boolean archived) {
        Session child = new Session(workspaceId.toString(), ownerUserId.toString(), title);
        child.setId(UUID.randomUUID());
        child.setKind(Session.KIND_SPAWN);
        child.setSpawnedFromSessionId(parentId);
        // ck_sessions_provenance_shape: a spawn row must carry all three provenance columns, so the
        // fixture writes the triggering run of the PARENT session exactly like production does.
        child.setSpawnedFromRunId(triggeringRun(parentId, ownerUserId));
        child.setSpawnedAt(Instant.now());
        child.setArchived(archived);
        Session saved = sessionRepository.saveAndFlush(child);
        bindPrimaryParticipant(saved.getId().toString(), principalId.toString());
        return saved;
    }

    /** The parent run that triggered the spawn (terminal: it already finished when we read). */
    private UUID triggeringRun(UUID parentSessionId, UUID userId) {
        return saveRun(parentSessionId, userId, "succeeded", false).getId();
    }

    private void runningRun(Session session, UUID userId) {
        saveRun(session.getId(), userId, "running", true);
    }

    private ChatRun saveRun(UUID sessionId, UUID userId, String status, boolean withPrincipal) {
        ChatRun run = new ChatRun(UUID.randomUUID().toString(), sessionId.toString(), userId.toString(),
                workspaceId.toString(), "idem-" + UUID.randomUUID(), "hash-" + UUID.randomUUID(),
                "provider", "model", "none", status);
        if (withPrincipal) {
            run.setAgentPrincipalId(principalId);
        }
        return chatRunRepository.saveAndFlush(run);
    }

    private JsonNode get(String token, String query) {
        return json(rawGet(token, query));
    }

    private JsonNode get(String token, String query, UUID principalOverride) {
        return json(rawGet(token, query, principalOverride));
    }

    private ResponseEntity<Map> rawGet(String token, String query) {
        return rawGet(token, query, null);
    }

    private ResponseEntity<Map> rawGet(String token, String query, UUID principalOverride) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        String principal = (principalOverride == null ? principalId : principalOverride).toString();
        return restTemplate.exchange(url(spawnPath(principal) + query), HttpMethod.GET,
                new HttpEntity<>(null, headers), Map.class);
    }

    private JsonNode ownerSessions() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(ownerToken);
        headers.set("X-Workspace-Id", workspaceId.toString());
        headers.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<Map> response = restTemplate.exchange(url("/api/v1/sessions"), HttpMethod.GET,
                new HttpEntity<>(null, headers), Map.class);
        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        return json(response);
    }

    private String spawnPath(String principal) {
        return "/api/v1/workspaces/" + workspaceId + "/agents/" + principal + "/spawn-sessions";
    }

    private JsonNode json(ResponseEntity<Map> response) {
        return objectMapper.valueToTree(response.getBody());
    }

    private static boolean containsSession(JsonNode listed, UUID sessionId) {
        for (JsonNode item : listed.path("sessions")) {
            if (sessionId.toString().equals(item.path("id").asText())) {
                return true;
            }
        }
        return false;
    }

    private static JsonNode rowFor(JsonNode body, UUID sessionId) {
        for (JsonNode row : body.path("sessions")) {
            if (sessionId.toString().equals(row.path("id").asText())) {
                return row;
            }
        }
        throw new AssertionError("row " + sessionId + " missing from " + body);
    }
}
