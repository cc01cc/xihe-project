package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.TeamTask;
import com.cc01cc.p.xihe.cp.policy.PolicyContext;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.TeamTaskRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.http.HttpStatus;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * task-188 MVP⑤ S2: TeamTaskService — CAS 身份、行本地授权（owner/creator 链）、ready/warnings
 * 派生、TEAM_TASK_MANAGE 门禁。纯 Mockito：walker 返回手捏的 ChainWalk，仓储按 CAS 形状打桩。
 */
class TeamTaskServiceTest {

    private static final String USER = "user-1";
    private static final String WS = "ws-1";
    private static final UUID ROOT_ID = UUID.fromString("11111111-1111-1111-1111-111111111111");
    private static final UUID CHILD_ID = UUID.fromString("22222222-2222-2222-2222-222222222222");
    private static final UUID FOREIGN_ID = UUID.fromString("33333333-3333-3333-3333-333333333333");
    private static final String ROOT = ROOT_ID.toString();
    private static final String CHILD = CHILD_ID.toString();
    private static final String TOOL = "team_task_create";

    private final TeamTaskRepository teamTasks = Mockito.mock(TeamTaskRepository.class);
    private final SessionRepository sessions = Mockito.mock(SessionRepository.class);
    private final DelegationChainWalker walker = Mockito.mock(DelegationChainWalker.class);
    private final PolicyEngine policy = Mockito.mock(PolicyEngine.class);
    private final AuditLogger audit = Mockito.mock(AuditLogger.class);

    private final TeamTaskService service =
            new TeamTaskService(teamTasks, sessions, walker, policy, audit);

    private Session rootSession;
    private Session childSession;
    private Session foreignSession;

    @BeforeEach
    void setUp() {
        rootSession = session(ROOT_ID, "root", null, "tree root");
        childSession = session(CHILD_ID, Session.KIND_SPAWN, ROOT, "child");
        foreignSession = session(FOREIGN_ID, "root", null, "foreign root");
        lenient().when(sessions.findById(ROOT_ID)).thenReturn(Optional.of(rootSession));
        lenient().when(sessions.findById(CHILD_ID)).thenReturn(Optional.of(childSession));
        lenient().when(sessions.findById(FOREIGN_ID)).thenReturn(Optional.of(foreignSession));
        // Any session walks to its own root by default; tests that need a foreign walk stub walker again.
        lenient().when(walker.walkFromSession(rootSession))
                .thenReturn(walk(ROOT_ID));
        // Hops are nearest-first: the child session starts the walk, the root ends it.
        lenient().when(walker.walkFromSession(childSession))
                .thenReturn(walk(CHILD_ID, ROOT_ID));
        lenient().when(walker.walkFromSession(foreignSession))
                .thenReturn(walk(FOREIGN_ID));
        lenient().when(policy.loadContext(anyString(), anyString(), anyString()))
                .thenReturn(Mockito.mock(PolicyContext.class));
        lenient().when(policy.allowsByGrant(any(), anyString(), isNull(), anyString(), anyString(),
                anyString(), eq(false))).thenReturn(true);
        lenient().when(teamTasks.findByTeamRootSessionIdOrderByTaskNo(ROOT)).thenReturn(List.of());
    }

    private Session session(UUID id, String kind, String spawnedFrom, String title) {
        Session s = Mockito.mock(Session.class);
        when(s.getId()).thenReturn(id);
        when(s.getKind()).thenReturn(kind);
        when(s.getUserId()).thenReturn(USER);
        when(s.getWorkspaceId()).thenReturn(WS);
        when(s.getTitle()).thenReturn(title);
        if (spawnedFrom != null) {
            when(s.getSpawnedFromSessionId()).thenReturn(UUID.fromString(spawnedFrom));
        }
        return s;
    }

    private DelegationChainWalker.ChainWalk walk(UUID... nearestFirstRootIsLast) {
        List<DelegationChainWalker.Hop> hops = new java.util.ArrayList<>();
        String edge = DelegationChainWalker.EDGE_NONE;
        for (UUID id : nearestFirstRootIsLast) {
            hops.add(new DelegationChainWalker.Hop(id, id, edge, "principal-x"));
            edge = DelegationChainWalker.EDGE_SPAWN;
        }
        return new DelegationChainWalker.ChainWalk(List.copyOf(hops), hops.size() - 1,
                java.util.Collections.nCopies(hops.size(), "principal-x"));
    }

    private TeamTask row(long taskNo, String status, String owner, List<String> blockedBy,
                         List<String> writeScopes, UUID createdBy) {
        TeamTask t = TeamTask.create();
        t.setTaskNo(taskNo);
        t.setSubject("task " + taskNo);
        t.setStatus(status);
        t.setOwnerSessionId(owner);
        t.setBlockedBy(json(blockedBy));
        t.setWriteScopes(json(writeScopes));
        t.setCreatedBySessionId(createdBy.toString());
        t.setTeamRootSessionId(ROOT);
        t.setWorkspaceId(WS);
        return t;
    }

    private com.fasterxml.jackson.databind.JsonNode json(List<String> values) {
        return com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.arrayNode()
                .addAll(values.stream()
                        .map(com.fasterxml.jackson.databind.node.JsonNodeFactory.instance::textNode)
                        .toList());
    }

    private CpApiException assertProblem(HttpStatus status, String code, Runnable call) {
        CpApiException thrown = assertThrows(CpApiException.class, call::run);
        assertEquals(status, thrown.getStatus());
        assertEquals(code, thrown.getCode());
        return thrown;
    }

    // ---------------------------------------------------------------------------------------------
    // create
    // ---------------------------------------------------------------------------------------------

    @Test
    void createAssignsBoardScopedTaskNumberAndAudits() {
        when(teamTasks.countByTeamRootSessionId(ROOT)).thenReturn(2L);

        TeamTaskService.TeamTaskView view = service.create(TOOL, USER, WS, CHILD,
                "wire the board", "details", List.of(), List.of("packages/control-plane"));

        assertEquals(3, view.taskNo());
        assertEquals(ROOT, view.teamRootSessionId());
        assertEquals(TeamTask.STATUS_PENDING, view.status());
        assertTrue(view.ready(), "no dependencies ⇒ ready");
        assertNotNull(view.taskId());
        verify(teamTasks).save(any(TeamTask.class));
        verify(audit).recordDurableChange(eq(USER), eq(WS), eq("team_task_create"),
                eq("team_task"), anyString(), anyString());
    }

    @Test
    void createWithoutTheAtomIsDeniedAndAudited() {
        when(policy.allowsByGrant(any(), anyString(), isNull(), anyString(), anyString(),
                anyString(), eq(false))).thenReturn(false);

        assertProblem(HttpStatus.FORBIDDEN, "TEAM_TASK_FORBIDDEN",
                () -> service.create(TOOL, USER, WS, CHILD, "x", null, null, null));
        verify(audit).record(eq(CHILD), anyString(), eq("authorization_denied"),
                eq("actionClass=TEAM_TASK_MANAGE"));
        verify(teamTasks, never()).save(any());
    }

    @Test
    void createRejectsBlankOrOversizedSubject() {
        assertProblem(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                () -> service.create(TOOL, USER, WS, CHILD, "  ", null, null, null));
        assertProblem(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                () -> service.create(TOOL, USER, WS, CHILD, "x".repeat(201), null, null, null));
        verify(teamTasks, never()).save(any());
    }

    // ---------------------------------------------------------------------------------------------
    // read gate + projection derivation
    // ---------------------------------------------------------------------------------------------

    @Test
    void boardReadIsRootOwnerOnlyAndIncludesDeletedRows() {
        TeamTask done = row(1, TeamTask.STATUS_COMPLETED, CHILD, List.of(), List.of(), CHILD_ID);
        TeamTask live = row(2, TeamTask.STATUS_PENDING, null,
                List.of(done.getId().toString()), List.of(), CHILD_ID);
        TeamTask tomb = row(3, TeamTask.STATUS_DELETED, null, List.of(), List.of(), CHILD_ID);
        when(teamTasks.findByTeamRootSessionIdOrderByTaskNo(ROOT)).thenReturn(List.of(done, live, tomb));

        TeamTaskService.BoardView board = service.boardView(CHILD, USER);
        assertEquals(ROOT, board.teamRootSessionId());
        assertEquals(3, board.tasks().size(), "tombstones ride along; the UI filters one layer up");
        TeamTaskService.TeamTaskView liveView = board.tasks().get(1);
        assertTrue(liveView.ready(), "its only dependency is completed ⇒ ready");
        TeamTaskService.TeamTaskView doneView = board.tasks().get(0);
        assertFalse(doneView.ready(), "terminal rows are never ready");
        assertEquals(TeamTask.STATUS_DELETED, board.tasks().get(2).status());

        // Switch the blocker to pending: unfinished dependency ⇒ not ready.
        TeamTask blocker = row(4, TeamTask.STATUS_PENDING, CHILD, List.of(), List.of(), CHILD_ID);
        TeamTask blocked = TeamTask.create();
        blocked.setTaskNo(5);
        blocked.setSubject("blocked");
        blocked.setStatus(TeamTask.STATUS_PENDING);
        blocked.setBlockedBy(json(List.of(blocker.getId().toString())));
        blocked.setCreatedBySessionId(CHILD);
        blocked.setTeamRootSessionId(ROOT);
        blocked.setWorkspaceId(WS);
        when(teamTasks.findByTeamRootSessionIdOrderByTaskNo(ROOT))
                .thenReturn(List.of(done, live, tomb, blocker, blocked));
        TeamTaskService.BoardView board2 = service.boardView(CHILD, USER);
        assertFalse(board2.tasks().get(4).ready(), "unfinished blocker ⇒ not ready");
        TeamTask blockerDone = row(4, TeamTask.STATUS_COMPLETED, CHILD, List.of(), List.of(), CHILD_ID);
        when(teamTasks.findByTeamRootSessionIdOrderByTaskNo(ROOT))
                .thenReturn(List.of(blockerDone, blocked));
        assertTrue(service.boardView(CHILD, USER).tasks().get(1).ready(),
                "completed blocker ⇒ ready");
    }

    @Test
    void boardReadByANonOwnerHumanIsForbidden() {
        assertProblem(HttpStatus.FORBIDDEN, "TEAM_TASK_FORBIDDEN",
                () -> service.boardView(CHILD, "someone-else"));
    }

    @Test
    void writeScopeWarningsDeriveFromAdvisoryOverlap() {
        TeamTask a = row(1, TeamTask.STATUS_IN_PROGRESS, CHILD,
                List.of(), List.of("packages/control-plane/src"), CHILD_ID);
        TeamTask b = row(2, TeamTask.STATUS_PENDING, null,
                List.of(), List.of("packages/control-plane/src/chat"), CHILD_ID);
        TeamTask c = row(3, TeamTask.STATUS_PENDING, null,
                List.of(), List.of("packages/agent"), CHILD_ID);
        when(teamTasks.findByTeamRootSessionIdOrderByTaskNo(ROOT))
                .thenReturn(List.of(a, b, c));

        TeamTaskService.BoardView board = service.boardView(CHILD, USER);
        assertEquals(1, board.tasks().get(0).writeScopeWarnings().size(),
                "b's nested scope overlaps a's");
        assertTrue(board.tasks().get(0).writeScopeWarnings().get(0).contains("task-2"));
        assertTrue(board.tasks().get(2).writeScopeWarnings().isEmpty(),
                "disjoint scope ⇒ no warning");
    }

    // ---------------------------------------------------------------------------------------------
    // update: claim / complete / move / reopen / reassign / update_details
    // ---------------------------------------------------------------------------------------------

    @Test
    void claimAssignsTheCallerAndBumpsRevisionThroughTheCas() {
        TeamTask unclaimed = row(1, TeamTask.STATUS_PENDING, null, List.of(), List.of(), CHILD_ID);
        when(teamTasks.findByTeamRootSessionIdOrderByTaskNo(ROOT)).thenReturn(List.of(unclaimed));
        when(teamTasks.casClaim(eq(unclaimed.getId()), eq(0L), eq(CHILD), any(), any()))
                .thenReturn(1);

        service.update("team_task_update", USER, WS, CHILD,
                unclaimed.getId().toString(), "claim", 0L, null, null, null, null, null, null);

        // The assertion lands on the CAS call, not the returned view: the mocked repository does
        // not reflect the UPDATE back into the stale in-memory row (in production the
        // clearAutomatically fresh SELECT does).
        verify(teamTasks).casClaim(eq(unclaimed.getId()), eq(0L), eq(CHILD), eq("child"), any());
    }

    @Test
    void claimOnAnOwnedTaskConflictsBeforeTheCas() {
        TeamTask owned = row(1, TeamTask.STATUS_IN_PROGRESS, CHILD, List.of(), List.of(), CHILD_ID);
        when(teamTasks.findByTeamRootSessionIdOrderByTaskNo(ROOT)).thenReturn(List.of(owned));

        assertProblem(HttpStatus.CONFLICT, "TEAM_TASK_CONFLICT",
                () -> service.update("team_task_update", USER, WS, CHILD,
                        owned.getId().toString(), "claim", 0L, null, null, null, null, null, null));
        verify(teamTasks, never()).casClaim(any(), anyLong(), anyString(), any(), any());
    }

    @Test
    void completeRequiresOwnerAndInProgress() {
        TeamTask owned = row(1, TeamTask.STATUS_IN_PROGRESS, CHILD, List.of(), List.of(), CHILD_ID);
        when(teamTasks.findByTeamRootSessionIdOrderByTaskNo(ROOT)).thenReturn(List.of(owned));
        when(teamTasks.casUpdateStatus(eq(owned.getId()), eq(0L), eq(TeamTask.STATUS_COMPLETED), any()))
                .thenReturn(1);

        // Non-owner cannot complete.
        assertProblem(HttpStatus.CONFLICT, "TEAM_TASK_CONFLICT",
                () -> service.update("team_task_update", USER, WS, ROOT,
                        owned.getId().toString(), "complete", 0L, null, null, null, null, null, null));
        verify(teamTasks, never()).casUpdateStatus(any(), anyLong(), eq(TeamTask.STATUS_COMPLETED), any());

        // Owner completes.
        TeamTaskService.TeamTaskView view = service.update("team_task_update", USER, WS, CHILD,
                owned.getId().toString(), "complete", 0L, null, null, null, null, null, null);
        verify(teamTasks).casUpdateStatus(eq(owned.getId()), eq(0L), eq(TeamTask.STATUS_COMPLETED), any());
        assertNotNull(view);
    }

    @Test
    void completeOnAPendingTaskConflictsOnStatusShape() {
        TeamTask pending = row(1, TeamTask.STATUS_PENDING, CHILD, List.of(), List.of(), CHILD_ID);
        when(teamTasks.findByTeamRootSessionIdOrderByTaskNo(ROOT)).thenReturn(List.of(pending));
        assertProblem(HttpStatus.CONFLICT, "TEAM_TASK_CONFLICT",
                () -> service.update("team_task_update", USER, WS, CHILD,
                        pending.getId().toString(), "complete", 0L, null, null, null, null, null, null));
        verify(teamTasks, never()).casUpdateStatus(any(), anyLong(), anyString(), any());
    }

    @Test
    void staleExpectedRevisionConflictsWithoutTouchingTheRow() {
        TeamTask row = row(1, TeamTask.STATUS_PENDING, null, List.of(), List.of(), CHILD_ID);
        when(teamTasks.findByTeamRootSessionIdOrderByTaskNo(ROOT)).thenReturn(List.of(row));

        assertProblem(HttpStatus.CONFLICT, "TEAM_TASK_CONFLICT",
                () -> service.update("team_task_update", USER, WS, CHILD,
                        row.getId().toString(), "claim", 7L, null, null, null, null, null, null));
        assertProblem(HttpStatus.CONFLICT, "TEAM_TASK_CONFLICT",
                () -> service.update("team_task_update", USER, WS, CHILD,
                        row.getId().toString(), "claim", null, null, null, null, null, null, null));
        verify(teamTasks, never()).casClaim(any(), anyLong(), anyString(), any(), any());
    }

    @Test
    void reassignIsCreatorLineageOnlyAndTargetMustShareTheTree() {
        TeamTask createdByRoot = row(1, TeamTask.STATUS_PENDING, CHILD, List.of(), List.of(), ROOT_ID);
        when(teamTasks.findByTeamRootSessionIdOrderByTaskNo(ROOT)).thenReturn(List.of(createdByRoot));
        when(teamTasks.casReassign(eq(createdByRoot.getId()), eq(0L), eq(CHILD), eq("child"), any()))
                .thenReturn(1);

        // A child-session caller is not the creator.
        assertProblem(HttpStatus.CONFLICT, "TEAM_TASK_CONFLICT",
                () -> service.update("team_task_update", USER, WS, CHILD,
                        createdByRoot.getId().toString(), "reassign", 0L, CHILD, null, null, null, null, null));

        // The creator (root caller) reassigns to a tree member.
        TeamTaskService.TeamTaskView view = service.update("team_task_update", USER, WS, ROOT,
                createdByRoot.getId().toString(), "reassign", 0L, CHILD, null, null, null, null, null);
        verify(teamTasks).casReassign(eq(createdByRoot.getId()), eq(0L), eq(CHILD), eq("child"), any());
        assertEquals(CHILD, view.ownerSessionId());

        // A foreign session (its own root) is not a tree member.
        assertProblem(HttpStatus.CONFLICT, "TEAM_TASK_INVALID_TARGET",
                () -> service.update("team_task_update", USER, WS, ROOT,
                        createdByRoot.getId().toString(), "reassign", 0L, FOREIGN_ID.toString(),
                        null, null, null, null, null));
    }

    @Test
    void updateDetailsValidatesDependencyClosure() {
        TeamTask first = row(1, TeamTask.STATUS_PENDING, CHILD, List.of(), List.of(), CHILD_ID);
        TeamTask second = row(2, TeamTask.STATUS_PENDING, CHILD,
                List.of(first.getId().toString()), List.of(), CHILD_ID);
        when(teamTasks.findByTeamRootSessionIdOrderByTaskNo(ROOT))
                .thenReturn(List.of(first, second));
        when(teamTasks.casUpdateDetails(eq(first.getId()), eq(0L), any(), isNull(),
                any(), isNull(), any())).thenReturn(1);

        // Unknown dependency id.
        assertProblem(HttpStatus.NOT_FOUND, "TEAM_TASK_NOT_FOUND",
                () -> service.update("team_task_update", USER, WS, CHILD,
                        first.getId().toString(), "update_details", 0L, null, "new subject", null,
                        null, List.of(UUID.randomUUID().toString()), null));

        // Closed cycle: second already blocks closingCycle, so closingCycle blocking second
        // would close the loop. closingCycle is owned by the caller so requireOwner passes and
        // the DFS in validateDependencyClosure is what fires.
        TeamTask closingCycle = TeamTask.create();
        closingCycle.setTaskNo(1);
        closingCycle.setSubject("first");
        closingCycle.setStatus(TeamTask.STATUS_PENDING);
        closingCycle.setOwnerSessionId(CHILD);
        closingCycle.setCreatedBySessionId(CHILD);
        closingCycle.setTeamRootSessionId(ROOT);
        closingCycle.setWorkspaceId(WS);
        TeamTask secondBlocked = TeamTask.create();
        secondBlocked.setTaskNo(2);
        secondBlocked.setSubject("second");
        secondBlocked.setStatus(TeamTask.STATUS_PENDING);
        secondBlocked.setOwnerSessionId(CHILD);
        secondBlocked.setBlockedBy(json(List.of(closingCycle.getId().toString())));
        secondBlocked.setCreatedBySessionId(CHILD);
        secondBlocked.setTeamRootSessionId(ROOT);
        secondBlocked.setWorkspaceId(WS);
        when(teamTasks.findByTeamRootSessionIdOrderByTaskNo(ROOT))
                .thenReturn(List.of(closingCycle, secondBlocked));
        assertProblem(HttpStatus.CONFLICT, "TEAM_TASK_CYCLE",
                () -> service.update("team_task_update", USER, WS, CHILD,
                        closingCycle.getId().toString(), "update_details", 0L, null, null, null,
                        null, List.of(secondBlocked.getId().toString()), null));

        // Happy path renames — the CAS call carries the new values (the mocked repo does not
        // reflect them back into the stale row, so the assertion lands on the verify, not the view).
        when(teamTasks.casUpdateDetails(eq(closingCycle.getId()), eq(0L), eq("renamed"),
                isNull(), any(), any(), any())).thenReturn(1);
        service.update("team_task_update", USER, WS, CHILD,
                closingCycle.getId().toString(), "update_details", 0L, null, "renamed", null,
                null, List.of(), List.of("packages/control-plane"));
        verify(teamTasks).casUpdateDetails(eq(closingCycle.getId()), eq(0L), eq("renamed"),
                isNull(), any(), any(), any());
    }

    @Test
    void moveValidatesTheTargetStatusName() {
        TeamTask row = row(1, TeamTask.STATUS_PENDING, CHILD, List.of(), List.of(), CHILD_ID);
        when(teamTasks.findByTeamRootSessionIdOrderByTaskNo(ROOT)).thenReturn(List.of(row));
        assertProblem(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                () -> service.update("team_task_update", USER, WS, CHILD,
                        row.getId().toString(), "move", 0L, null, null, null, "sideways",
                        null, null));
        verify(teamTasks, never()).casUpdateStatus(any(), anyLong(), anyString(), any());
    }

    @Test
    void deletedTasksAreImmutableExceptReopen() {
        TeamTask tomb = row(1, TeamTask.STATUS_DELETED, CHILD, List.of(), List.of(), CHILD_ID);
        when(teamTasks.findByTeamRootSessionIdOrderByTaskNo(ROOT)).thenReturn(List.of(tomb));
        assertProblem(HttpStatus.CONFLICT, "TEAM_TASK_CONFLICT",
                () -> service.update("team_task_update", USER, WS, CHILD,
                        tomb.getId().toString(), "update_details", 0L, null, "x", null, null, null, null));
        assertProblem(HttpStatus.CONFLICT, "TEAM_TASK_CONFLICT",
                () -> service.update("team_task_update", USER, WS, CHILD,
                        tomb.getId().toString(), "claim", 0L, null, null, null, null, null, null));
        verify(teamTasks, never()).casUpdateDetails(any(), anyLong(), any(), any(), any(), any(), any());
    }

    @Test
    void unknownActionIsAValidationError() {
        TeamTask row = row(1, TeamTask.STATUS_PENDING, CHILD, List.of(), List.of(), CHILD_ID);
        when(teamTasks.findByTeamRootSessionIdOrderByTaskNo(ROOT)).thenReturn(List.of(row));
        assertProblem(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                () -> service.update("team_task_update", USER, WS, CHILD,
                        row.getId().toString(), "nuke", 0L, null, null, null, null, null, null));
    }

    @Test
    void taskFromAnotherBoardIsNotFoundHere() {
        TeamTask foreign = row(9, TeamTask.STATUS_PENDING, null, List.of(), List.of(), CHILD_ID);
        foreign.setTeamRootSessionId(FOREIGN_ID.toString());
        when(teamTasks.findByTeamRootSessionIdOrderByTaskNo(ROOT)).thenReturn(List.of());
        assertProblem(HttpStatus.NOT_FOUND, "TEAM_TASK_NOT_FOUND",
                () -> service.update("team_task_update", USER, WS, CHILD,
                        foreign.getId().toString(), "claim", 0L, null, null, null, null, null, null));
    }

    @Test
    void unclaimedOwnerFieldsAreNullOnTheWire() {
        TeamTask unclaimed = row(1, TeamTask.STATUS_PENDING, null, List.of(), List.of(), CHILD_ID);
        when(teamTasks.findByTeamRootSessionIdOrderByTaskNo(ROOT)).thenReturn(List.of(unclaimed));
        TeamTaskService.TeamTaskView view = service.getForRead(CHILD, USER,
                unclaimed.getId().toString());
        assertNull(view.ownerSessionId());
        assertNull(view.ownerName());
    }
}