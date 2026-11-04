package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.policy.DelegationPolicyValidator.DelegationLimits;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * PLAN-0630 M1: the delegation budget gate's decision table.
 *
 * <p>These cases are the ones a later "optimisation" is most likely to break, so each one names the
 * invariant it protects: the fork edge must not be walked through (§0.3-2), {@code >=} rather than
 * {@code >} on the count, only non-terminal runs occupying a slot, per-root (not per-workspace)
 * accounting, and fail-closed on a broken tree or an unreadable stored policy.</p>
 */
class DelegationBudgetServiceTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String ROOT_PRINCIPAL = UUID.randomUUID().toString();
    private static final String OTHER_PRINCIPAL = UUID.randomUUID().toString();

    private SessionRepository sessions;
    private ChatRunRepository runs;
    private AgentPrincipalService principals;
    private ConfigService config;
    private DelegationBudgetService budget;

    /** session id → session; spawn children are registered in {@link #childrenOf}. */
    private final Map<UUID, Session> byId = new HashMap<>();
    private final Map<UUID, List<Session>> childrenOf = new HashMap<>();
    /** session id → has a non-terminal run. */
    private final Map<UUID, Boolean> inFlight = new HashMap<>();

    private JsonNode policy;

    @BeforeEach
    void setUp() {
        sessions = mock(SessionRepository.class);
        runs = mock(ChatRunRepository.class);
        principals = mock(AgentPrincipalService.class);
        config = mock(ConfigService.class);
        budget = new DelegationBudgetService(sessions, runs, principals, config);

        when(sessions.findById(any())).thenAnswer(invocation ->
                Optional.ofNullable(byId.get(invocation.getArgument(0))));
        when(sessions.findBySpawnedFromSessionIdAndKind(any(), eq(Session.KIND_SPAWN)))
                .thenAnswer(invocation -> childrenOf.getOrDefault(invocation.getArgument(0), List.of()));
        when(runs.existsBySessionIdAndStatusIn(anyString(), any()))
                .thenAnswer(invocation -> inFlight.getOrDefault(
                        UUID.fromString(invocation.getArgument(0)), false));
        when(config.resolve(eq("agent-runtime"), anyString(), any(), any())).thenReturn(null);
        when(principals.readDelegationPolicy(anyString())).thenAnswer(invocation -> policy);
    }

    private Session session(UUID id, String kind, UUID spawnedFrom, String principalId) {
        Session session = new Session("ws-1", "user-1", "t-" + id.toString().substring(0, 6));
        session.setId(id);
        session.setKind(kind);
        session.setSpawnedFromSessionId(spawnedFrom);
        session.setAgentPrincipalId(principalId);
        byId.put(id, session);
        return session;
    }

    private Session childOf(Session parent) {
        Session child = session(UUID.randomUUID(), Session.KIND_SPAWN, parent.getId(),
                parent.getAgentPrincipalId());
        childrenOf.computeIfAbsent(parent.getId(), key -> new java.util.ArrayList<>()).add(child);
        return child;
    }

    /** A parent run stub: only {@code getId} is used, by the audit detail. */
    private static ChatRun run() {
        ChatRun run = mock(ChatRun.class);
        when(run.getId()).thenReturn(UUID.randomUUID());
        return run;
    }

    private void policy(String json) throws Exception {
        policy = json == null ? null : MAPPER.readTree(json);
    }

    // ------------------------------------------------------------------ depth

    @Test
    void allowsUpToMaxDepthAndRefusesOneDeeper() throws Exception {
        policy("{\"maxDepth\":3}");
        Session root = session(UUID.randomUUID(), null, null, ROOT_PRINCIPAL);
        Session d1 = childOf(root);
        Session d2 = childOf(d1);
        Session d3 = childOf(d2);

        // The limit applies to the depth the NEW child would have: a parent at depth 2 may spawn once
        // more (child depth 3 = the last legal hop), a parent already at depth 3 may not.
        assertEquals(new DelegationLimits(8, 3), budget.requireWithinBudget(d2, run(), "tc"),
                "a child of depth 3 is the last legal hop");

        DelegationRefusedException refused = assertThrows(DelegationRefusedException.class,
                () -> budget.requireWithinBudget(d3, run(), "tc"));
        assertEquals("DELEGATION_LIMIT_EXCEEDED", refused.getCode());
        assertTrue(refused.auditDetail().contains("\"reason\":\"depth_exceeded\""), refused.auditDetail());
        assertTrue(refused.auditDetail().contains("\"depth\":4"), refused.auditDetail());
        assertTrue(refused.auditDetail().contains("\"maxDepth\":3"), refused.auditDetail());
    }

    @Test
    void forkEdgeIsNotWalkedThrough() throws Exception {
        // A five-deep spawn chain BELOW a fork: the fork child is a new authority root, so its subtree
        // starts again at depth 0. Walking to `kind IS NULL` would charge these hops to the forked-from
        // tree and refuse the spawn.
        policy("{\"maxDepth\":3}");
        Session ordinary = session(UUID.randomUUID(), null, null, OTHER_PRINCIPAL);
        Session s1 = childOf(ordinary);
        Session s2 = childOf(s1);
        Session s3 = childOf(s2);
        Session forked = session(UUID.randomUUID(), Session.KIND_FORK, s3.getId(), ROOT_PRINCIPAL);
        Session forkChild = childOf(forked);

        assertEquals(new DelegationLimits(8, 3), budget.requireWithinBudget(forkChild, run(), "tc"),
                "the fork child is depth 1 of its own tree, not depth 6 of the forked-from tree");
    }

    @Test
    void brokenTreeFailsClosed() throws Exception {
        policy("{\"maxDepth\":3}");
        Session orphan = session(UUID.randomUUID(), Session.KIND_SPAWN, null, ROOT_PRINCIPAL);

        DelegationRefusedException refused = assertThrows(DelegationRefusedException.class,
                () -> budget.requireWithinBudget(orphan, run(), "tc"));
        assertEquals("DELEGATION_POLICY_INVALID", refused.getCode(),
                "a spawn session without a parent is a broken tree, never 'root'");
        assertTrue(refused.auditDetail().contains("\"reason\":\"tree_broken\""), refused.auditDetail());
    }

    @Test
    void missingAncestorRowFailsClosed() throws Exception {
        policy("{\"maxDepth\":3}");
        Session orphan = session(UUID.randomUUID(), Session.KIND_SPAWN, UUID.randomUUID(), ROOT_PRINCIPAL);

        DelegationRefusedException refused = assertThrows(DelegationRefusedException.class,
                () -> budget.requireWithinBudget(orphan, run(), "tc"));
        assertEquals("DELEGATION_POLICY_INVALID", refused.getCode(),
                "a hard-deleted ancestor (V37 has no FK) must not be treated as a root");
    }

    // ------------------------------------------------------------------ count

    @Test
    void countsOnlySpawnSessionsWithANonTerminalRun() throws Exception {
        policy("{\"maxCount\":2}");
        Session root = session(UUID.randomUUID(), null, null, ROOT_PRINCIPAL);
        Session first = childOf(root);
        Session second = childOf(root);
        inFlight.put(first.getId(), true);

        assertEquals(2, budget.requireWithinBudget(root, run(), "tc").maxCount(),
                "one in-flight child is below maxCount=2");

        inFlight.put(second.getId(), true);
        DelegationRefusedException refused = assertThrows(DelegationRefusedException.class,
                () -> budget.requireWithinBudget(root, run(), "tc"));
        assertTrue(refused.auditDetail().contains("\"reason\":\"count_exceeded\""), refused.auditDetail());
        assertTrue(refused.auditDetail().contains("\"current\":2"), refused.auditDetail());
    }

    @Test
    void aTerminalChildReleasesItsSlot() throws Exception {
        policy("{\"maxCount\":1}");
        Session root = session(UUID.randomUUID(), null, null, ROOT_PRINCIPAL);
        Session child = childOf(root);

        inFlight.put(child.getId(), true);
        assertThrows(DelegationRefusedException.class,
                () -> budget.requireWithinBudget(root, run(), "tc"));

        inFlight.put(child.getId(), false);
        assertEquals(1, budget.requireWithinBudget(root, run(), "tc").maxCount(),
                "the concurrent reading: a finished child frees the slot again");
    }

    @Test
    void budgetIsPerRootTreeNotPerWorkspace() throws Exception {
        policy("{\"maxCount\":1}");
        Session firstRoot = session(UUID.randomUUID(), null, null, ROOT_PRINCIPAL);
        Session secondRoot = session(UUID.randomUUID(), null, null, OTHER_PRINCIPAL);
        inFlight.put(childOf(firstRoot).getId(), true);

        assertThrows(DelegationRefusedException.class,
                () -> budget.requireWithinBudget(firstRoot, run(), "tc"));
        assertEquals(1, budget.requireWithinBudget(secondRoot, run(), "tc").maxCount(),
                "a second root in the same workspace has its own budget");
    }

    @Test
    void onlyTheRootSubjectsPolicyIsRead() throws Exception {
        // The parent is a spawn child whose own principal carries a *different* (tiny) policy; the gate
        // must read the ROOT subject's document, so the parent's limits stay inert as a subagent.
        policy("{\"maxCount\":8,\"maxDepth\":3}");
        Session root = session(UUID.randomUUID(), null, null, ROOT_PRINCIPAL);
        Session parent = childOf(root);
        parent.setAgentPrincipalId(OTHER_PRINCIPAL);

        assertEquals(new DelegationLimits(8, 3), budget.requireWithinBudget(parent, run(), "tc"));
    }

    // ------------------------------------------------------------- robustness

    @Test
    void missingRootPrincipalRowDegradesToTheCodeDefaults() {
        // Regression pin for the SpawnLifecycleTest finding: a session whose principal row is gone (only
        // reachable through a hard delete or a hand-built fixture) must NOT become a new hard failure.
        when(principals.readDelegationPolicy(anyString())).thenThrow(new com.cc01cc.p.xihe.cp.config
                .CpApiException(org.springframework.http.HttpStatus.NOT_FOUND,
                "AGENT_PRINCIPAL_NOT_FOUND", "Agent principal not found"));
        Session root = session(UUID.randomUUID(), null, null, ROOT_PRINCIPAL);

        assertEquals(new DelegationLimits(DelegationBudgetService.DEFAULT_MAX_COUNT,
                        DelegationBudgetService.DEFAULT_MAX_DEPTH),
                budget.requireWithinBudget(root, run(), "tc"),
                "missing principal row -> code defaults, not a refusal");
    }

    @Test
    void unreadableStoredPolicyFailsClosed() throws Exception {
        policy("{\"maxCount\":\"x\"}");
        Session root = session(UUID.randomUUID(), null, null, ROOT_PRINCIPAL);

        DelegationRefusedException refused = assertThrows(DelegationRefusedException.class,
                () -> budget.requireWithinBudget(root, run(), "tc"));
        assertEquals("DELEGATION_POLICY_INVALID", refused.getCode());
    }

    @Test
    void instanceCeilingClampsTheEffectiveLimits() throws Exception {
        policy("{\"maxCount\":8,\"maxDepth\":5}");
        when(config.resolve(eq("agent-runtime"), eq("delegationMaxCountCeiling"), any(), any())).thenReturn("2");
        when(config.resolve(eq("agent-runtime"), eq("delegationMaxDepthCeiling"), any(), any())).thenReturn("1");
        Session root = session(UUID.randomUUID(), null, null, ROOT_PRINCIPAL);

        assertEquals(new DelegationLimits(2, 1), budget.requireWithinBudget(root, run(), "tc"),
                "the instance ceiling wins over a more generous subject policy");
    }

    @Test
    void zeroCeilingMeansNoClamp() throws Exception {
        policy("{\"maxCount\":8,\"maxDepth\":5}");
        when(config.resolve(eq("agent-runtime"), eq("delegationMaxCountCeiling"), any(), any())).thenReturn("0");
        when(config.resolve(eq("agent-runtime"), eq("delegationMaxDepthCeiling"), any(), any())).thenReturn("0");
        Session root = session(UUID.randomUUID(), null, null, ROOT_PRINCIPAL);

        assertEquals(new DelegationLimits(8, 5), budget.requireWithinBudget(root, run(), "tc"));
    }
    @Test
    void maxCountZeroDisablesDelegationWithTheDedicatedReason() throws Exception {
        policy("{\"maxCount\":0}");
        Session root = session(UUID.randomUUID(), null, null, ROOT_PRINCIPAL);

        DelegationRefusedException refused = assertThrows(DelegationRefusedException.class,
                () -> budget.requireWithinBudget(root, run(), "tc"));
        assertEquals("DELEGATION_LIMIT_EXCEEDED", refused.getCode());
        assertTrue(refused.getMessage().contains("delegationPolicy"),
                "the refusal names the policy knob: " + refused.getMessage());
        assertTrue(refused.auditDetail().contains("delegation_disabled"),
                "the audit detail carries the dedicated reason: " + refused.auditDetail());
    }

    @Test
    void maxCountOneStillAllowsTheFirstChild() throws Exception {
        policy("{\"maxCount\":1}");
        Session root = session(UUID.randomUUID(), null, null, ROOT_PRINCIPAL);

        DelegationLimits limits = budget.requireWithinBudget(root, run(), "tc");
        assertEquals(1, limits.maxCount(), "a single-child policy is unchanged");
    }
}
