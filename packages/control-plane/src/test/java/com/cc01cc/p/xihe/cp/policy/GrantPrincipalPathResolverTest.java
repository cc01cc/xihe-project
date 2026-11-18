package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.chat.ChatRunStatusReadService;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.mcp.McpInvocationService;
import com.cc01cc.p.xihe.cp.service.SessionReadService;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class GrantPrincipalPathResolverTest {

    /**
     * PLAN-0464 T2.2: with no invocation row the verdict is {@link Optional#empty()}
     * and the caller ({@code GrantAuthorizationService}) fails closed - there is no
     * legacy operation/item path left to fall back to.
     */
    @Test
    void missingInvocationYieldsEmptyVerdictWithoutTouchingLegacyLedger() {
        UUID userId = UUID.randomUUID();
        UUID workspaceId = UUID.randomUUID();
        UUID sessionId = UUID.randomUUID();
        UUID runId = UUID.randomUUID();
        UUID toolCallId = UUID.randomUUID();

        SessionReadService sessionReadService = mock(SessionReadService.class);
        ChatRunStatusReadService chatRunStatusReadService = mock(ChatRunStatusReadService.class);
        McpInvocationService mcpInvocationService = mock(McpInvocationService.class);
        when(mcpInvocationService.findAgentInvocationContext(runId.toString(), toolCallId.toString()))
                .thenReturn(Optional.empty());

        GrantPrincipalPathResolver resolver = new GrantPrincipalPathResolver(
                sessionReadService, chatRunStatusReadService, mcpInvocationService);

        assertEquals(Optional.empty(), resolver.validateAgentInvocationContext(
                userId.toString(), workspaceId.toString(), sessionId.toString(), runId.toString(),
                toolCallId.toString(), "read_file"));
    }

    /**
     * PLAN-0463 T1.3 → PLAN-0464 T2.2 (verify V1/V4): an active in-scope
     * invocation authorizes with no operation/item row at all, and a cross-user
     * invocation fails closed.
     */
    @Test
    void activeInScopeInvocationPassesAndCrossUserFailsClosed() {
        UUID userId = UUID.randomUUID();
        UUID otherUserId = UUID.randomUUID();
        UUID workspaceId = UUID.randomUUID();
        UUID sessionId = UUID.randomUUID();
        UUID runId = UUID.randomUUID();
        UUID toolCallId = UUID.randomUUID();
        UUID principalId = UUID.randomUUID();

        SessionReadService sessionReadService = mock(SessionReadService.class);
        ChatRunStatusReadService chatRunStatusReadService = mock(ChatRunStatusReadService.class);
        McpInvocationService mcpInvocationService = mock(McpInvocationService.class);

        Session session = new Session(workspaceId.toString(), userId.toString(), "test");
        session.setId(sessionId);
        SessionReadService.SessionPathView sessionView = new SessionReadService.SessionPathView(
                session.getId(), session.getUserId(), session.getWorkspaceId(),
                principalId.toString(), session.getSpawnedFromSessionId(),
                session.getSpawnedFromRunId(), session.getSpawnedAt(), session.getKind(),
                session.getAgentPermissionsSnapshot());
        when(sessionReadService.findById(sessionId)).thenReturn(Optional.of(sessionView));

        ChatRun run = new ChatRun(runId.toString(), sessionId.toString(), userId.toString(),
                workspaceId.toString(), "request", "hash", "provider", "model", "workspace", "running");
        ChatRunStatusReadService.ChatRunStatusView runView = new ChatRunStatusReadService.ChatRunStatusView(
                run.getId(), run.getStatus(), run.getSessionId(), run.getUserId(),
                run.getWorkspaceId(), run.getCreatedAt(), run.getUpdatedAt());
        when(chatRunStatusReadService.findById(runId)).thenReturn(Optional.of(runView));

        com.cc01cc.p.xihe.cp.entity.McpInvocation invocation =
                new com.cc01cc.p.xihe.cp.entity.McpInvocation();
        invocation.setId(UUID.randomUUID());
        invocation.setRunId(runId.toString());
        invocation.setSessionId(sessionId.toString());
        invocation.setWorkspaceId(workspaceId.toString());
        invocation.setUserId(userId.toString());
        invocation.setToolCallId(toolCallId.toString());
        invocation.setToolName("read_file");
        invocation.setSource("agent");
        invocation.setStatus("active");
        when(mcpInvocationService.findAgentInvocationContext(runId.toString(), toolCallId.toString()))
                .thenReturn(Optional.of(new McpInvocationService.InvocationContextView(
                        invocation.getStatus(), invocation.getSessionId(), invocation.getUserId(),
                        invocation.getWorkspaceId(), invocation.getRunId(), invocation.getToolName())));

        GrantPrincipalPathResolver resolver = new GrantPrincipalPathResolver(
                sessionReadService, chatRunStatusReadService, mcpInvocationService);

        assertEquals(Optional.of(Boolean.TRUE), resolver.validateAgentInvocationContext(
                userId.toString(), workspaceId.toString(), sessionId.toString(), runId.toString(),
                toolCallId.toString(), "read_file"));

        assertThrows(IllegalArgumentException.class, () -> resolver.validateAgentInvocationContext(
                otherUserId.toString(), workspaceId.toString(), sessionId.toString(), runId.toString(),
                toolCallId.toString(), "read_file"));
    }

    // ── D-1865 / task-23: the chain is a scope + lineage check, not an identity check ──
    //
    // Before the fix every cross-principal case below threw IllegalArgumentException, which
    // ChatSubmissionService.bindOrValidateAgentSession masks as 403 AGENT_PRINCIPAL_MISSING and
    // GrantAuthorizationService.hasCurrentAgentToolCall turns into a tool deny. The cases split in
    // two groups on purpose: what the fix must now accept, and what must keep failing closed.

    private static final UUID OWNER = UUID.fromString("11111111-1111-4111-8111-111111111111");
    private static final UUID OTHER_USER = UUID.fromString("22222222-2222-4222-8222-222222222222");
    private static final UUID WS = UUID.fromString("33333333-3333-4333-8333-333333333333");
    private static final UUID OTHER_WS = UUID.fromString("44444444-4444-4444-8444-444444444444");
    private static final Instant SPAWNED_AT = Instant.parse("2026-11-18T00:00:00Z");

    /** One chain node. A null {@code kind} is a root; a null principal is a roster without PRIMARY. */
    private static SessionReadService.SessionPathView node(UUID id, UUID userId, UUID workspaceId,
                                                           UUID principalId, UUID parentSessionId,
                                                           UUID parentRunId, String kind) {
        return new SessionReadService.SessionPathView(id, userId.toString(), workspaceId.toString(),
                principalId == null ? null : principalId.toString(), parentSessionId, parentRunId,
                kind == null ? null : SPAWNED_AT, kind, null);
    }

    /** A ChatRun view owned by the fixture user/Workspace, so only the Session link varies. */
    private static ChatRunStatusReadService.ChatRunStatusView run(UUID runId, UUID sessionId) {
        return new ChatRunStatusReadService.ChatRunStatusView(runId, "running", sessionId.toString(),
                OWNER.toString(), WS.toString(), SPAWNED_AT, SPAWNED_AT);
    }

    private static GrantPrincipalPathResolver resolverOf(
            Map<UUID, SessionReadService.SessionPathView> sessions,
            Map<UUID, ChatRunStatusReadService.ChatRunStatusView> runs) {
        SessionReadService sessionReadService = mock(SessionReadService.class);
        ChatRunStatusReadService chatRunStatusReadService = mock(ChatRunStatusReadService.class);
        when(sessionReadService.findById(any()))
                .thenAnswer(call -> Optional.ofNullable(sessions.get(call.<UUID>getArgument(0))));
        when(chatRunStatusReadService.findById(any()))
                .thenAnswer(call -> Optional.ofNullable(runs.get(call.<UUID>getArgument(0))));
        return new GrantPrincipalPathResolver(sessionReadService, chatRunStatusReadService,
                mock(McpInvocationService.class));
    }

    private static List<UUID> pathIds(GrantPrincipalPathResolver.AgentPath path) {
        return path.sessionPath().stream().map(SessionReadService.SessionPathView::id).toList();
    }

    /** The human-delegation shape: root carried by P1, child by P2, grandchild by P3. */
    @Test
    void crossPrincipalSpawnChainResolvesToTheLeafPrincipalAndKeepsEveryAncestor() {
        UUID rootId = UUID.randomUUID();
        UUID childId = UUID.randomUUID();
        UUID grandId = UUID.randomUUID();
        UUID p1 = UUID.randomUUID();
        UUID p2 = UUID.randomUUID();
        UUID p3 = UUID.randomUUID();
        UUID runA = UUID.randomUUID();
        UUID runB = UUID.randomUUID();

        Map<UUID, SessionReadService.SessionPathView> sessions = Map.of(
                rootId, node(rootId, OWNER, WS, p1, null, null, null),
                childId, node(childId, OWNER, WS, p2, rootId, runA, Session.KIND_SPAWN),
                grandId, node(grandId, OWNER, WS, p3, childId, runB, Session.KIND_SPAWN));
        Map<UUID, ChatRunStatusReadService.ChatRunStatusView> runs = Map.of(
                runA, run(runA, rootId),
                runB, run(runB, childId));

        GrantPrincipalPathResolver.AgentPath path = resolverOf(sessions, runs)
                .resolveAgent(OWNER.toString(), WS.toString(), grandId.toString());

        assertEquals(p3, path.principalId(),
                "D-1865: the identity stays the leaf's own PRIMARY, never an ancestor's");
        assertEquals(List.of(rootId, childId, grandId), pathIds(path),
                "every ancestor Session still joins the path, because each frozen cap narrows the leaf");
    }

    /** Production's exact shape: a same-principal prefix with one hop that changes subject. */
    @Test
    void crossPrincipalChildOfASinglePrincipalChainResolves() {
        UUID rootId = UUID.randomUUID();
        UUID childId = UUID.randomUUID();
        UUID grandId = UUID.randomUUID();
        UUID p1 = UUID.randomUUID();
        UUID p2 = UUID.randomUUID();
        UUID runA = UUID.randomUUID();
        UUID runB = UUID.randomUUID();

        Map<UUID, SessionReadService.SessionPathView> sessions = Map.of(
                rootId, node(rootId, OWNER, WS, p1, null, null, null),
                childId, node(childId, OWNER, WS, p1, rootId, runA, Session.KIND_SPAWN),
                grandId, node(grandId, OWNER, WS, p2, childId, runB, Session.KIND_SPAWN));
        Map<UUID, ChatRunStatusReadService.ChatRunStatusView> runs = Map.of(
                runA, run(runA, rootId),
                runB, run(runB, childId));

        GrantPrincipalPathResolver.AgentPath path = resolverOf(sessions, runs)
                .resolveAgent(OWNER.toString(), WS.toString(), grandId.toString());
        assertEquals(p2, path.principalId());
        assertEquals(3, path.sessionPath().size());
    }

    /**
     * Zero-behaviour-change pin for the existing producers (spawn copies the parent Run principal,
     * fork copies the source PRIMARY, create is a root): on a single-principal chain "equals the
     * leaf" and "is present" are the same predicate, so the accepted set is bit-for-bit unchanged.
     */
    @Test
    void singlePrincipalChainResolvesExactlyAsBeforeTheFix() {
        UUID rootId = UUID.randomUUID();
        UUID childId = UUID.randomUUID();
        UUID grandId = UUID.randomUUID();
        UUID only = UUID.randomUUID();
        UUID runA = UUID.randomUUID();
        UUID runB = UUID.randomUUID();

        Map<UUID, SessionReadService.SessionPathView> sessions = Map.of(
                rootId, node(rootId, OWNER, WS, only, null, null, null),
                childId, node(childId, OWNER, WS, only, rootId, runA, Session.KIND_SPAWN),
                grandId, node(grandId, OWNER, WS, only, childId, runB, Session.KIND_SPAWN));
        Map<UUID, ChatRunStatusReadService.ChatRunStatusView> runs = Map.of(
                runA, run(runA, rootId),
                runB, run(runB, childId));

        GrantPrincipalPathResolver resolver = resolverOf(sessions, runs);
        assertEquals(List.of(rootId), pathIds(
                resolver.resolveAgent(OWNER.toString(), WS.toString(), rootId.toString())));
        assertEquals(List.of(rootId, childId), pathIds(
                resolver.resolveAgent(OWNER.toString(), WS.toString(), childId.toString())));
        GrantPrincipalPathResolver.AgentPath deep =
                resolver.resolveAgent(OWNER.toString(), WS.toString(), grandId.toString());
        assertEquals(only, deep.principalId());
        assertEquals(List.of(rootId, childId, grandId), pathIds(deep));
    }

    /** A fork is still a new permission root, whatever principal its source carries. */
    @Test
    void crossPrincipalForkStillStopsAtItsOwnPermissionRoot() {
        UUID sourceId = UUID.randomUUID();
        UUID forkId = UUID.randomUUID();
        UUID p1 = UUID.randomUUID();
        UUID p2 = UUID.randomUUID();
        UUID sourceRun = UUID.randomUUID();

        Map<UUID, SessionReadService.SessionPathView> sessions = Map.of(
                sourceId, node(sourceId, OWNER, WS, p1, null, null, null),
                forkId, node(forkId, OWNER, WS, p2, sourceId, sourceRun, Session.KIND_FORK));
        Map<UUID, ChatRunStatusReadService.ChatRunStatusView> runs = Map.of(
                sourceRun, run(sourceRun, sourceId));

        GrantPrincipalPathResolver.AgentPath path = resolverOf(sessions, runs)
                .resolveAgent(OWNER.toString(), WS.toString(), forkId.toString());
        assertEquals(p2, path.principalId());
        assertEquals(List.of(forkId), pathIds(path),
                "spec §3.2: a fork does not inherit the source's permission path");
    }

    // ── what must KEEP failing closed after the relaxation ──

    @Test
    void crossPrincipalChainStillFailsClosedOnForeignUserOrWorkspace() {
        UUID rootId = UUID.randomUUID();
        UUID childId = UUID.randomUUID();
        UUID p1 = UUID.randomUUID();
        UUID p2 = UUID.randomUUID();
        UUID runA = UUID.randomUUID();
        Map<UUID, ChatRunStatusReadService.ChatRunStatusView> runs = Map.of(runA, run(runA, rootId));

        Map<UUID, SessionReadService.SessionPathView> foreignUser = Map.of(
                rootId, node(rootId, OTHER_USER, WS, p1, null, null, null),
                childId, node(childId, OWNER, WS, p2, rootId, runA, Session.KIND_SPAWN));
        GrantPrincipalPathResolver userResolver = resolverOf(foreignUser, runs);
        assertThrows(IllegalArgumentException.class, () -> userResolver
                .resolveAgent(OWNER.toString(), WS.toString(), childId.toString()),
                "the tenant relaxation must not reach across users");

        Map<UUID, SessionReadService.SessionPathView> foreignWorkspace = Map.of(
                rootId, node(rootId, OWNER, OTHER_WS, p1, null, null, null),
                childId, node(childId, OWNER, WS, p2, rootId, runA, Session.KIND_SPAWN));
        GrantPrincipalPathResolver workspaceResolver = resolverOf(foreignWorkspace, runs);
        assertThrows(IllegalArgumentException.class, () -> workspaceResolver
                .resolveAgent(OWNER.toString(), WS.toString(), childId.toString()),
                "the tenant relaxation must not reach across Workspaces");
    }

    @Test
    void crossPrincipalChainStillFailsClosedOnIncompleteLineage() {
        UUID rootId = UUID.randomUUID();
        UUID childId = UUID.randomUUID();
        UUID p1 = UUID.randomUUID();
        UUID p2 = UUID.randomUUID();
        UUID runA = UUID.randomUUID();
        SessionReadService.SessionPathView child =
                node(childId, OWNER, WS, p2, rootId, runA, Session.KIND_SPAWN);

        // The parent Run row the child names does not exist.
        GrantPrincipalPathResolver missingRun = resolverOf(Map.of(childId, child), Map.of());
        assertThrows(IllegalArgumentException.class,
                () -> missingRun.resolveAgent(OWNER.toString(), WS.toString(), childId.toString()));

        // The parent Session row does not exist although the parent Run does.
        Map<UUID, ChatRunStatusReadService.ChatRunStatusView> runs = new HashMap<>();
        runs.put(runA, run(runA, rootId));
        GrantPrincipalPathResolver missingSession = resolverOf(Map.of(childId, child), runs);
        assertThrows(IllegalArgumentException.class,
                () -> missingSession.resolveAgent(OWNER.toString(), WS.toString(), childId.toString()));

        // Both rows exist, but the named Run belongs to a different Session (forged provenance).
        UUID unrelatedRun = UUID.randomUUID();
        UUID forgedParent = UUID.randomUUID();
        Map<UUID, SessionReadService.SessionPathView> forged = Map.of(
                rootId, node(rootId, OWNER, WS, p1, null, null, null),
                childId, node(childId, OWNER, WS, p2, rootId, unrelatedRun, Session.KIND_SPAWN));
        Map<UUID, ChatRunStatusReadService.ChatRunStatusView> forgedRuns = Map.of(
                unrelatedRun, run(unrelatedRun, forgedParent));
        GrantPrincipalPathResolver forgedResolver = resolverOf(forged, forgedRuns);
        assertThrows(IllegalArgumentException.class,
                () -> forgedResolver.resolveAgent(OWNER.toString(), WS.toString(), childId.toString()),
                "dropping principal equality must not drop the provenance cross-check");

        // A fork whose source rows are half present stays malformed.
        UUID forkId = UUID.randomUUID();
        Map<UUID, SessionReadService.SessionPathView> forkSessions = Map.of(
                rootId, node(rootId, OWNER, WS, p1, null, null, null),
                forkId, node(forkId, OWNER, WS, p2, rootId, runA, Session.KIND_FORK));
        GrantPrincipalPathResolver halfSource = resolverOf(forkSessions, Map.of());
        assertThrows(IllegalArgumentException.class,
                () -> halfSource.resolveAgent(OWNER.toString(), WS.toString(), forkId.toString()));
    }

    @Test
    void crossPrincipalChainStillFailsClosedOnCyclesAndMissingIdentities() {
        UUID a = UUID.randomUUID();
        UUID b = UUID.randomUUID();
        UUID p1 = UUID.randomUUID();
        UUID p2 = UUID.randomUUID();
        UUID runA = UUID.randomUUID();
        UUID runB = UUID.randomUUID();
        Map<UUID, SessionReadService.SessionPathView> cycle = Map.of(
                a, node(a, OWNER, WS, p1, b, runB, Session.KIND_SPAWN),
                b, node(b, OWNER, WS, p2, a, runA, Session.KIND_SPAWN));
        Map<UUID, ChatRunStatusReadService.ChatRunStatusView> cycleRuns = Map.of(
                runA, run(runA, b),
                runB, run(runB, a));
        GrantPrincipalPathResolver cycleResolver = resolverOf(cycle, cycleRuns);
        assertThrows(IllegalArgumentException.class,
                () -> cycleResolver.resolveAgent(OWNER.toString(), WS.toString(), a.toString()),
                "the cycle guard must not be relaxed together with principal equality");

        // A leaf whose roster has no PRIMARY participant is the genuine AGENT_PRINCIPAL_MISSING case.
        UUID orphanId = UUID.randomUUID();
        GrantPrincipalPathResolver noLeaf = resolverOf(Map.of(
                orphanId, node(orphanId, OWNER, WS, null, null, null, null)), Map.of());
        assertThrows(IllegalArgumentException.class,
                () -> noLeaf.resolveAgent(OWNER.toString(), WS.toString(), orphanId.toString()));

        // An ancestor without an identity stays malformed too: presence is still required.
        UUID rootId = UUID.randomUUID();
        UUID childId = UUID.randomUUID();
        Map<UUID, SessionReadService.SessionPathView> ancestorless = Map.of(
                rootId, node(rootId, OWNER, WS, null, null, null, null),
                childId, node(childId, OWNER, WS, p2, rootId, runA, Session.KIND_SPAWN));
        Map<UUID, ChatRunStatusReadService.ChatRunStatusView> runs = Map.of(runA, run(runA, rootId));
        GrantPrincipalPathResolver noAncestor = resolverOf(ancestorless, runs);
        assertThrows(IllegalArgumentException.class,
                () -> noAncestor.resolveAgent(OWNER.toString(), WS.toString(), childId.toString()));
    }

    /**
     * Hard requirement 1: the tool boundary shares {@code resolveAgent} with the submission gate, so
     * a tool call inside a cross-principal delegated child must be admitted. Fixing only the
     * creation side would leave every tool call in such a Session denied here.
     */
    @Test
    void toolBoundaryAdmitsToolCallsOfACrossPrincipalChildSession() {
        UUID rootId = UUID.randomUUID();
        UUID childId = UUID.randomUUID();
        UUID p1 = UUID.randomUUID();
        UUID p2 = UUID.randomUUID();
        UUID parentRun = UUID.randomUUID();
        UUID childRun = UUID.randomUUID();
        UUID toolCall = UUID.randomUUID();

        Map<UUID, SessionReadService.SessionPathView> sessions = Map.of(
                rootId, node(rootId, OWNER, WS, p1, null, null, null),
                childId, node(childId, OWNER, WS, p2, rootId, parentRun, Session.KIND_SPAWN));
        Map<UUID, ChatRunStatusReadService.ChatRunStatusView> runs = Map.of(
                parentRun, run(parentRun, rootId),
                childRun, run(childRun, childId));

        McpInvocationService mcpInvocationService = mock(McpInvocationService.class);
        when(mcpInvocationService.findAgentInvocationContext(childRun.toString(), toolCall.toString()))
                .thenReturn(Optional.of(new McpInvocationService.InvocationContextView("active",
                        childId.toString(), OWNER.toString(), WS.toString(), childRun.toString(),
                        "read_file")));
        SessionReadService sessionReadService = mock(SessionReadService.class);
        ChatRunStatusReadService chatRunStatusReadService = mock(ChatRunStatusReadService.class);
        when(sessionReadService.findById(any()))
                .thenAnswer(call -> Optional.ofNullable(sessions.get(call.<UUID>getArgument(0))));
        when(chatRunStatusReadService.findById(any()))
                .thenAnswer(call -> Optional.ofNullable(runs.get(call.<UUID>getArgument(0))));
        GrantPrincipalPathResolver resolver = new GrantPrincipalPathResolver(
                sessionReadService, chatRunStatusReadService, mcpInvocationService);

        assertEquals(Optional.of(Boolean.TRUE), resolver.validateAgentInvocationContext(
                OWNER.toString(), WS.toString(), childId.toString(), childRun.toString(),
                toolCall.toString(), "read_file"));

        // An out-of-vocabulary tool name still fails the invocation scope clause, chain or not.
        assertThrows(IllegalArgumentException.class, () -> resolver.validateAgentInvocationContext(
                OWNER.toString(), WS.toString(), childId.toString(), childRun.toString(),
                toolCall.toString(), "delete_file"));
    }

    /** The tool boundary keeps failing closed when the cross-principal chain itself is broken. */
    @Test
    void toolBoundaryStillFailsClosedWhenTheCrossPrincipalChainIsBroken() {
        UUID ghostRoot = UUID.randomUUID();
        UUID childId = UUID.randomUUID();
        UUID p2 = UUID.randomUUID();
        UUID parentRun = UUID.randomUUID();
        UUID childRun = UUID.randomUUID();
        UUID toolCall = UUID.randomUUID();

        Map<UUID, SessionReadService.SessionPathView> sessions = Map.of(
                childId, node(childId, OWNER, WS, p2, ghostRoot, parentRun, Session.KIND_SPAWN));
        Map<UUID, ChatRunStatusReadService.ChatRunStatusView> runs = Map.of(
                childRun, run(childRun, childId));
        McpInvocationService mcpInvocationService = mock(McpInvocationService.class);
        when(mcpInvocationService.findAgentInvocationContext(childRun.toString(), toolCall.toString()))
                .thenReturn(Optional.of(new McpInvocationService.InvocationContextView("active",
                        childId.toString(), OWNER.toString(), WS.toString(), childRun.toString(),
                        "read_file")));
        GrantPrincipalPathResolver resolver = new GrantPrincipalPathResolver(
                mockSessionReadService(sessions), mockChatRunReadService(runs), mcpInvocationService);

        assertThrows(IllegalArgumentException.class, () -> resolver.validateAgentInvocationContext(
                OWNER.toString(), WS.toString(), childId.toString(), childRun.toString(),
                toolCall.toString(), "read_file"));
    }

    private static SessionReadService mockSessionReadService(
            Map<UUID, SessionReadService.SessionPathView> sessions) {
        SessionReadService service = mock(SessionReadService.class);
        when(service.findById(any()))
                .thenAnswer(call -> Optional.ofNullable(sessions.get(call.<UUID>getArgument(0))));
        return service;
    }

    private static ChatRunStatusReadService mockChatRunReadService(
            Map<UUID, ChatRunStatusReadService.ChatRunStatusView> runs) {
        ChatRunStatusReadService service = mock(ChatRunStatusReadService.class);
        when(service.findById(any()))
                .thenAnswer(call -> Optional.ofNullable(runs.get(call.<UUID>getArgument(0))));
        return service;
    }
}
