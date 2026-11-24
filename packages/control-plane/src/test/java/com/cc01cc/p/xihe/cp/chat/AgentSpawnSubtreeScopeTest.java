package com.cc01cc.p.xihe.cp.chat;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator;
import com.cc01cc.p.xihe.cp.policy.GrantAuthorizationService;
import com.cc01cc.p.xihe.cp.policy.PolicyContext;
import com.cc01cc.p.xihe.cp.policy.PolicyContextProvider;
import com.cc01cc.p.xihe.cp.policy.PolicyEffect;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.policy.PolicyLayer;
import com.cc01cc.p.xihe.cp.policy.PolicyRequest;
import com.cc01cc.p.xihe.cp.policy.PolicyVerdict;
import com.cc01cc.p.xihe.cp.policy.RequesterAuthority;
import com.cc01cc.p.xihe.cp.policy.ResourceNamespaces;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.policy.ToolShape;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.OrgUnitMemberRepository;
import com.cc01cc.p.xihe.cp.repository.OrgUnitReadRepository;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

/**
 * task-935 / D-1935: delegation hierarchy is a grant resource, not an {@code if (isDescendant)}.
 *
 * <p>The first half pins the kernel: {@code action:spawn × agent-unit:<subtree>} covers self and
 * descendants, rejects siblings and ancestors, and {@code action:clone} is an ordinary AND-ed atom.
 * The second half pins the gate wiring through the real
 * {@link AgentSpawnAuthorizationService} rather than a hand-built {@code PolicyRequest}: the caller
 * agent's own unit subtree and the {@code action:clone} class are appended on the agent arm only, so
 * removing either append flips the corresponding case red (task-870 / task-966, D-1942).</p>
 */
class AgentSpawnSubtreeScopeTest {

    private static final String WS = "11111111-1111-4111-8111-111111111111";
    private static final String ROOT_TEAM = "root/team";
    private static final String CHILD = "root/team/child";
    private static final String SIBLING = "root/other";
    private static final String PARENT = "root";

    private final GrantIntersectionEvaluator evaluator = new GrantIntersectionEvaluator();

    private PolicyEngine policy;
    private AgentSpawnAuthorizationService service;
    private OrgUnitMemberRepository members;
    private OrgUnitReadRepository units;

    @BeforeEach
    void setUp() {
        policy = mock(PolicyEngine.class);
        members = mock(OrgUnitMemberRepository.class);
        units = mock(OrgUnitReadRepository.class);
        service = new AgentSpawnAuthorizationService(policy, mock(ApprovalService.class),
                mock(SseEmitterManager.class), mock(AuditLogger.class),
                mock(DelegationBudgetService.class),
                new RequesterAuthority(mock(AuthorizationGrantRepository.class),
                        mock(GrantIntersectionEvaluator.class), mock(AuthzContext.class),
                        com.cc01cc.p.xihe.cp.policy.OrgUnitGrantsTestFixture.withoutRows()),
                members, units);
        when(policy.loadContext(any(), any(), any())).thenReturn(PolicyContext.EMPTY);
        when(policy.evaluateVerdict(any(PolicyContext.class), anyString(), anyString(), anyString(),
                any(), anyString(), anyString()))
                .thenReturn(PolicyVerdict.of(PolicyEffect.ALLOW, null, PolicyLayer.BUILTIN,
                        "manual", "allowed"));
        when(policy.faceOf(any(PolicyContext.class), anyString()))
                .thenReturn(new ToolFaceRegistry.Face(ToolFaceRegistry.ACTION_SPAWN_AGENT,
                        ToolShape.STRUCTURED));
    }

    @Test
    void agentUnitTreeCoversSelfAndDescendants() {
        assertTrue(allowsSpawn("agent-unit:" + ROOT_TEAM, "agent-unit:" + ROOT_TEAM),
                "self must be covered by its own subtree");
        assertTrue(allowsSpawn("agent-unit:" + ROOT_TEAM, "agent-unit:" + CHILD),
                "a child unit must be inside the parent subtree");
        assertFalse(allowsSpawn("agent-unit:" + ROOT_TEAM, "agent-unit:" + SIBLING),
                "a sibling unit must not be covered");
        assertFalse(allowsSpawn("agent-unit:" + CHILD, "agent-unit:" + PARENT),
                "an ancestor must not be covered by a descendant grant");
    }

    @Test
    void agentSpawnRequiresCloneThroughTheRealGate() {
        // task-966: this used to build a PolicyRequest by hand, which proved the kernel could
        // handle `clone` but not that the spawn path ever asked for it. The gate is now the
        // subject: the agent arm must append `clone`, the human delegation arm must not.
        agentGate();
        ArgumentCaptor<List<String>> actions = ArgumentCaptor.forClass(List.class);
        verify(policy).allowsByGrant(any(PolicyContext.class),
                eq(ChatSubmissionService.SPAWN_TOOL_NAME), anyString(), anyString(),
                anyString(), anyString(), eq(false), any(), actions.capture());
        assertEquals(List.of(ToolFaceRegistry.ACTION_CLONE), actions.getValue(),
                "the self-spawn arm must AND action:clone onto the spawn face");
    }

    @Test
    void humanDelegationDoesNotRequireClone() {
        ChatSubmissionService.SpawnInvocation invocation = invocation("88888888-8888-4888-8888-888888888888");
        when(policy.allowsByGrant(any(PolicyContext.class), anyString(), anyString(), anyString(),
                anyString(), anyString(), eq(true), any(), any())).thenReturn(true);
        service.authorizeUserSpawn(invocation, null);
        ArgumentCaptor<List<String>> actions = ArgumentCaptor.forClass(List.class);
        verify(policy).allowsByGrant(any(PolicyContext.class),
                eq(ChatSubmissionService.SPAWN_TOOL_NAME), anyString(), anyString(),
                anyString(), anyString(), eq(true), any(), actions.capture());
        assertTrue(actions.getValue().isEmpty(),
                "human presets never carry clone; requiring it here would deny every delegation");
    }

    @Test
    void gateAppendsTheCallerAgentsOwnSubtreeResource() {
        ChatSubmissionService.SpawnInvocation invocation = agentGate();

        ArgumentCaptor<List<String>> resources = ArgumentCaptor.forClass(List.class);
        verify(policy).allowsByGrant(any(PolicyContext.class),
                eq(ChatSubmissionService.SPAWN_TOOL_NAME), eq(invocation.authorizationBody()),
                eq(invocation.parentSessionId()), eq(invocation.userId()),
                eq(invocation.workspaceId()), eq(false), resources.capture(), any());
        assertEquals(List.of("agent-unit:root/team"), resources.getValue(),
                "the ltree path must be projected onto the TREE matcher with `/` separators");
    }

    @Test
    void removingTheHierarchyResourceFlipsTheCounterexampleRed() {
        // Counter-evidence in the kernel's own terms: without the agent-unit pair, a grant that
        // covers the caller's sibling still adds nothing to the request and the pair is missing.
        PolicyRequest request = new PolicyRequest(ChatSubmissionService.SPAWN_TOOL_NAME,
                List.of(ToolFaceRegistry.ACTION_SPAWN_AGENT), List.of("agent-unit:" + ROOT_TEAM),
                ToolShape.STRUCTURED, "agent-1", WS, "session");
        assertFalse(evaluator.allows(request, List.of(Set.of(
                atom(ToolFaceRegistry.ACTION_SPAWN_AGENT, "agent-unit:" + SIBLING)))),
                "a sibling-scoped grant cannot satisfy the caller's own subtree resource");
    }

    @Test
    void spawnAndCloneAreTwoAndedAtoms() {
        // Kernel half of the counter-evidence: once the gate asks for both classes, a grant set
        // holding only `spawn` (i.e. the agent preset with `action:clone` removed) is denied.
        PolicyRequest request = new PolicyRequest(ChatSubmissionService.SPAWN_TOOL_NAME,
                List.of(ToolFaceRegistry.ACTION_SPAWN_AGENT, ToolFaceRegistry.ACTION_CLONE),
                List.of("agent-unit:" + ROOT_TEAM), ToolShape.STRUCTURED, "agent-1", WS, "session");
        assertTrue(evaluator.allows(request, List.of(Set.of(
                atom(ToolFaceRegistry.ACTION_SPAWN_AGENT, "agent-unit:" + ROOT_TEAM),
                atom(ToolFaceRegistry.ACTION_CLONE, "agent-unit:" + ROOT_TEAM)))));
        assertFalse(evaluator.allows(request, List.of(Set.of(
                atom(ToolFaceRegistry.ACTION_SPAWN_AGENT, "agent-unit:" + ROOT_TEAM)))),
                "spawn alone (no clone) must be denied");
        assertFalse(evaluator.allows(request, List.of(Set.of(
                atom(ToolFaceRegistry.ACTION_CLONE, "agent-unit:" + ROOT_TEAM)))),
                "clone alone (no spawn) must be denied");
    }

    @Test
    void notificationFacesNeverUseTheSpawnAtom() {
        assertNotEquals(ToolFaceRegistry.ACTION_SPAWN_AGENT,
                new ToolFaceRegistry().faceOf("team_task_create").actionClass(),
                "team_task_* is board work, not delegation");
        assertEquals(ToolFaceRegistry.ACTION_SPAWN_AGENT,
                new ToolFaceRegistry().faceOf(ChatSubmissionService.SPAWN_TOOL_NAME).actionClass());
        assertTrue(ResourceNamespaces.find(ResourceNamespaces.AGENT_UNIT).isPresent(),
                "agent-unit is the registered TREE namespace task-935 adds");
        assertEquals(ResourceNamespaces.Matcher.TREE,
                ResourceNamespaces.find(ResourceNamespaces.AGENT_UNIT).orElseThrow().matcher());
    }

    @Test
    void theEngineAppendsCloneWithoutDroppingTheSpawnFace() {
        // task-966: proves the 9-argument overload merges `clone` into the face's own classes
        // instead of substituting them, by capturing the PolicyRequest the engine actually hands
        // to grant evaluation. Without the merge, `spawn_agent`'s class disappears and a caller
        // holding only clone would silently pass.
        GrantAuthorizationService grants = mock(GrantAuthorizationService.class);
        when(grants.allows(any())).thenReturn(true);
        PolicyEngine engine = new PolicyEngine(mock(AuditLogger.class),
                mock(PolicyContextProvider.class), grants);

        engine.allowsByGrant(PolicyContext.EMPTY, ChatSubmissionService.SPAWN_TOOL_NAME, "{}",
                "session", "user-1", WS, false, List.of("agent-unit:" + ROOT_TEAM),
                List.of(ToolFaceRegistry.ACTION_CLONE));

        ArgumentCaptor<PolicyRequest> request = ArgumentCaptor.forClass(PolicyRequest.class);
        verify(grants).allows(request.capture());
        assertTrue(request.getValue().actionClasses().containsAll(
                List.of(ToolFaceRegistry.ACTION_SPAWN_AGENT, ToolFaceRegistry.ACTION_CLONE)),
                "clone must be appended to, not substituted for, the spawn face's own class");
        assertTrue(request.getValue().resources().contains("agent-unit:" + ROOT_TEAM),
                "the hierarchy resource must still ride the same request");
    }

    private boolean allowsSpawn(String grantResource, String requestResource) {
        PolicyRequest request = new PolicyRequest(ChatSubmissionService.SPAWN_TOOL_NAME,
                List.of(ToolFaceRegistry.ACTION_SPAWN_AGENT), List.of(requestResource),
                ToolShape.STRUCTURED, "agent-1", WS, "session");
        return evaluator.allows(request, List.of(Set.of(
                atom(ToolFaceRegistry.ACTION_SPAWN_AGENT, grantResource))));
    }

    private static GrantIntersectionEvaluator.PermissionAtom atom(String action, String resource) {
        return new GrantIntersectionEvaluator.PermissionAtom(action, resource);
    }

    private static ChatSubmissionService.SpawnInvocation invocation(String principalId) {
        return new ChatSubmissionService.SpawnInvocation(
                "11111111-1111-4111-8111-111111111111",
                "33333333-3333-4333-8333-333333333333",
                "55555555-5555-4555-8555-555555555555",
                UUID.randomUUID(), "user-1", WS, principalId, "canonical-body");
    }

    /**
     * Drive the agent (self-spawn) arm of the real gate for an agent that sits in {@code root.team},
     * and return the invocation so callers can assert on what the gate actually passed to the policy.
     */
    private ChatSubmissionService.SpawnInvocation agentGate() {
        ChatSubmissionService.SpawnInvocation invocation =
                invocation("88888888-8888-4888-8888-888888888888");
        UUID unit = UUID.randomUUID();
        when(members.findUnitOf("agent_principal", UUID.fromString(invocation.principalId())))
                .thenReturn(Optional.of(unit));
        when(units.findUnit(unit)).thenReturn(Optional.of(
                new OrgUnitReadRepository.UnitRow(unit, null, "team", null, "root.team", 1)));
        when(policy.allowsByGrant(any(PolicyContext.class), anyString(), anyString(), anyString(),
                anyString(), anyString(), eq(false), any(), any())).thenReturn(true);
        service.authorize(invocation, null);
        return invocation;
    }
}
