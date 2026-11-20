package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthService;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.entity.TeamTask;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService;
import com.cc01cc.p.xihe.cp.support.TestAgentPrincipals;
import com.cc01cc.p.xihe.cp.support.TestWorkspaceCleanup;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-188 J3: the create projection's timestamps are the ones PostgreSQL actually stored.
 *
 * <p>Real PostgreSQL lane, real {@link TeamTaskService}, real row: the defect this class guards
 * against was a null {@code createdAt} on the in-memory row the service projects — invisible to a
 * mock repository (no {@code @PrePersist} runs there) and invisible to a flush-first assertion.
 * Here the returned instant is compared with {@code team_tasks.created_at} read back over JDBC,
 * within a one-second tolerance (the JVM and the database clock are two sources).</p>
 *
 * <p>The fixture has to be the <b>agent door</b>, not the user door: {@code TeamTaskService.create}
 * authorises with {@code userPrincipalOnly = false}, so {@code GrantAuthorizationService.allows}
 * resolves an agent-principal path ({@code GrantPrincipalPathResolver.resolveAgent}) and every level
 * of that path — principal grants, the workspace-agent binding snapshot, each session's snapshot —
 * must hold {@code TEAM_TASK_MANAGE}. A hand-saved user with a workspace role therefore gets
 * "an explicit TEAM_TASK_MANAGE grant is required"; the shape below is what the product's own spawn
 * path writes (see {@code chat/AgentSpawnPrincipalContractTest.java:943-972}).</p>
 */
class TeamTaskCreatePersistenceTest extends AbstractReusableIntegrationTest {

    private static final long TOLERANCE_MILLIS = 1000L;
    private static final String ATOM = "TEAM_TASK_MANAGE";

    @Autowired
    private TeamTaskService teamTaskService;

    @Autowired
    private AuthService authService;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private SessionParticipantRepository participantRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private WorkspaceAgentRepository workspaceAgentRepository;

    @Autowired
    private AgentPrincipalRepository agentPrincipalRepository;

    @Autowired
    private AuthorizationGrantRepository grantRepository;

    @Autowired
    private ChatRunRepository chatRunRepository;

    @Autowired
    private ProviderConnectionRepository providerConnectionRepository;

    @Autowired
    private ApiRequestTemplateService apiRequestTemplates;

    @Autowired
    private WorkspaceFixture workspaceFixture;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    private String userId;
    private String workspaceId;
    private UUID principalId;

    @AfterEach
    void cleanFixtures() {
        if (workspaceId != null) {
            // team_tasks / context_events carry plain FKs to sessions (no cascade): clear first.
            jdbcTemplate.update("DELETE FROM team_tasks WHERE CAST(workspace_id AS VARCHAR) = ?", workspaceId);
            jdbcTemplate.update("DELETE FROM context_events WHERE session_id IN "
                    + "(SELECT id FROM sessions WHERE CAST(workspace_id AS VARCHAR) = ?)", workspaceId);
            // The agent door left rows with plain FKs to the workspace/principal: clear them first.
            jdbcTemplate.update("DELETE FROM workspace_agents WHERE CAST(workspace_id AS VARCHAR) = ?", workspaceId);
            jdbcTemplate.update("DELETE FROM grants WHERE CAST(subject_id AS VARCHAR) = ?",
                    principalId == null ? "" : principalId.toString());
            TestWorkspaceCleanup.deleteWorkspaceData(jdbcTemplate, workspaceId);
            workspaceRepository.deleteById(UUID.fromString(workspaceId));
        }
        // The registered account and its instance bindings are left in place: the reusable lane gives
        // this class its own target database and drops it at class end, so nothing escapes.
        userId = null;
        workspaceId = null;
        principalId = null;
    }

    @Test
    void createReturnsTheInstantPostgresActuallyStored() {
        User user = authService.registerUser(new RegisterRequest(
                "team-task-persist-" + UUID.randomUUID() + "@test.com", "team-task-persist-password",
                "Team task persist test"));
        userId = user.getId().toString();
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Team task persist test", userId);
        workspaceId = workspace.getId().toString();
        workspaceFixture.bindWorkspaceRole(workspaceId, userId, WorkspaceRole.OWNER);
        bindAgentDoor();

        Session root = saveSession(null, null, "board root");
        // V40's ck_sessions_provenance_shape wants all three provenance fields plus the kind:
        // a spawn session needs a real parent run row, exactly like the product's spawn path.
        String parentRunId = saveRun(root);
        Session child = saveSession(root.getId(), parentRunId, "board child");

        TeamTaskService.TeamTaskView view = teamTaskService.create("team_task_create", userId, workspaceId,
                child.getId().toString(), "persist the create", "details", List.of(), List.of("src/x"));

        assertNotNull(view.createdAt(), "the create projection carries the stamp the row was written with");
        assertNotNull(view.updatedAt(), "a fresh row's updated_at is the same write");

        Map<String, Object> stored = jdbcTemplate.queryForMap(
                "SELECT created_at, updated_at, task_no, status FROM team_tasks WHERE id = CAST(? AS UUID)",
                view.taskId());
        Instant storedCreated = ((java.sql.Timestamp) stored.get("created_at")).toInstant();
        Instant storedUpdated = ((java.sql.Timestamp) stored.get("updated_at")).toInstant();

        assertTrue(Math.abs(storedCreated.toEpochMilli() - view.createdAt().toEpochMilli()) <= TOLERANCE_MILLIS,
                "returned createdAt " + view.createdAt() + " vs stored " + storedCreated + " (tolerance 1s)");
        assertTrue(Math.abs(storedUpdated.toEpochMilli() - view.updatedAt().toEpochMilli()) <= TOLERANCE_MILLIS,
                "returned updatedAt " + view.updatedAt() + " vs stored " + storedUpdated + " (tolerance 1s)");
        assertTrue(Math.abs(storedUpdated.toEpochMilli() - storedCreated.toEpochMilli()) <= TOLERANCE_MILLIS,
                "created_at and updated_at are the same write: " + storedCreated + " vs " + storedUpdated
                        + " (onCreate refreshes updated_at, so they differ by microseconds, not by a flush)");

        // The fix must not move anything else: the allocation and lifecycle the row was written with.
        assertEquals(view.taskNo(), ((Number) stored.get("task_no")).longValue(),
                "the number the projection shows is the number on the row");
        assertEquals(TeamTask.STATUS_PENDING, stored.get("status"),
                "a create still lands as pending");
    }

    /**
     * The three levels {@code GrantAuthorizationService.allows} reads for an agent-door request:
     * the principal's own grant, the workspace-agent binding snapshot, and (per session) the session
     * capability snapshot. All three must carry {@link #ATOM}.
     */
    private void bindAgentDoor() {
        AgentPrincipal principal = TestAgentPrincipals.newUserAgentPrincipal();
        principal.setName("Team task persist principal");
        principal.setCreatedByUserId(userId);
        ObjectNode template = objectMapper.createObjectNode();
        template.set("permissions", atomSnapshot());
        principal.setTemplateSnapshot(template);
        principalId = agentPrincipalRepository.saveAndFlush(principal).getId();

        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setId(UUID.randomUUID());
        grant.setSubjectType("agent_principal");
        grant.setSubjectId(principalId);
        grant.setGranterType("user");
        grant.setGranterId(UUID.fromString(userId));
        grant.setSource("template");
        grant.setPermissions(atomSnapshot());
        grantRepository.saveAndFlush(grant);

        workspaceAgentRepository.saveAndFlush(
                new WorkspaceAgent(principalId.toString(), workspaceId, atomSnapshot()));
    }

    private ArrayNode atomSnapshot() {
        ArrayNode snapshot = objectMapper.createArrayNode();
        ObjectNode atom = objectMapper.createObjectNode();
        atom.put("actionClass", ATOM);
        snapshot.add(atom);
        return snapshot;
    }

    private Session saveSession(UUID spawnedFrom, String spawnedFromRunId, String title) {
        Session session = new Session(workspaceId, userId, title + " " + UUID.randomUUID());
        session.setId(UUID.randomUUID());
        session.setAgentPermissionsSnapshot(atomSnapshot());
        if (spawnedFrom != null) {
            session.setKind(Session.KIND_SPAWN);
            session.setSpawnedFromSessionId(spawnedFrom);
            session.setSpawnedFromRunId(UUID.fromString(spawnedFromRunId));
            session.setSpawnedAt(Instant.now());
        }
        ChatBindingTestSupport.bindNewChatConnection(session, providerConnectionRepository,
                apiRequestTemplates, userId);
        Session saved = sessionRepository.saveAndFlush(session);
        participantRepository.saveAndFlush(new SessionParticipant(saved.getId(),
                SessionParticipant.KIND_AGENT, principalId, SessionParticipant.ROLE_PRIMARY, 10,
                SessionParticipant.WAKE_ALL_MESSAGES, SessionParticipant.RESPOND_ALWAYS));
        return saved;
    }

    private String saveRun(Session session) {
        String runId = UUID.randomUUID().toString();
        chatRunRepository.saveAndFlush(new ChatRun(runId, session.getId().toString(), userId, workspaceId,
                "team-task-run-" + runId, "team-task-hash-" + runId, "provider", "model",
                "workspace", "succeeded"));
        return runId;
    }
}