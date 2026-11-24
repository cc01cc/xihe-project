package com.cc01cc.p.xihe.cp.chat;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.policy.GrantAuthorizationService;
import com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator;
import com.cc01cc.p.xihe.cp.policy.PolicyContext;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.policy.PolicyLayer;
import com.cc01cc.p.xihe.cp.policy.PolicyContextProvider;
import com.cc01cc.p.xihe.cp.policy.PolicyRequest;
import com.cc01cc.p.xihe.cp.policy.RequesterAuthority;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.repository.OrgUnitMemberRepository;
import com.cc01cc.p.xihe.cp.repository.OrgUnitReadRepository;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

/**
 * task-961: explicit spawn target selection. The gate must ask the policy for
 * {@code spawn_agent × agent-unit:<target subtree>}; only the self-spawn shape (no target) adds
 * {@code action:clone}. Sibling and ancestor targets must be refused by the normal TREE matcher,
 * never by an {@code isDescendant} branch in the service.
 */
class AgentSpawnTargetSelectionTest {

    private static final String WS = "11111111-1111-4111-8111-111111111111";
    private static final UUID CALLER = UUID.fromString("22222222-2222-4222-8222-222222222222");
    private static final UUID CHILD_TARGET = UUID.fromString("33333333-3333-4333-8333-333333333333");
    private static final UUID SIBLING_TARGET = UUID.fromString("44444444-4444-4444-8444-444444444444");
    private static final UUID PARENT_TARGET = UUID.fromString("55555555-5555-4555-8555-555555555555");
    private static final String TEAM = "root/team";
    private static final String CHILD = "root/team/child";
    private static final String SIBLING = "root/other";
    private static final String PARENT = "root";

    private final GrantIntersectionEvaluator evaluator = new GrantIntersectionEvaluator();
    private final Map<UUID, UUID> unitOfPrincipal = new HashMap<>();
    private final Map<UUID, OrgUnitReadRepository.UnitRow> unitsById = new HashMap<>();
    private Set<GrantIntersectionEvaluator.PermissionAtom> grantSet;

    private GrantAuthorizationService grants;
    private AgentSpawnAuthorizationService service;

    @BeforeEach
    void setUp() {
        unitOfPrincipal.clear();
        unitsById.clear();
        unit(CALLER, TEAM);
        unit(CHILD_TARGET, CHILD);
        unit(SIBLING_TARGET, SIBLING);
        unit(PARENT_TARGET, PARENT);

        OrgUnitMemberRepository members = mock(OrgUnitMemberRepository.class);
        OrgUnitReadRepository units = mock(OrgUnitReadRepository.class);
        when(members.findUnitOf(eq("agent_principal"), any(UUID.class)))
                .thenAnswer(call -> Optional.ofNullable(unitOfPrincipal.get(call.getArgument(1))));
        when(units.findUnit(any(UUID.class)))
                .thenAnswer(call -> Optional.ofNullable(unitsById.get(call.getArgument(0))));

        PolicyContextProvider contextProvider = mock(PolicyContextProvider.class);
        PolicyContext allowContext = new PolicyContext(Map.of(), null, null, null, List.of(),
                PolicyLayer.BUILTIN);
        when(contextProvider.load(any(), any(), any())).thenReturn(allowContext);
        grants = mock(GrantAuthorizationService.class);
        when(grants.allows(any())).thenAnswer(call ->
                evaluator.allows(call.getArgument(0), List.of(grantSet)));
        when(grants.allowsUserOnly(any())).thenAnswer(call ->
                evaluator.allows(call.getArgument(0), List.of(grantSet)));
        PolicyEngine policy = new PolicyEngine(mock(AuditLogger.class), contextProvider, grants);

        service = new AgentSpawnAuthorizationService(policy, mock(ApprovalService.class),
                mock(SseEmitterManager.class), mock(AuditLogger.class),
                mock(DelegationBudgetService.class), mock(RequesterAuthority.class), members, units);
    }

    @Test
    void selfSpawnRequiresClone() {
        grantSet = atoms(atom(ToolFaceRegistry.ACTION_SPAWN_AGENT, "*"));
        assertDenied(agentInvocation(null), "no target means 分身, which must AND action:clone");
    }

    @Test
    void selfSpawnWithCloneIsAllowed() {
        grantSet = atoms(
                atom(ToolFaceRegistry.ACTION_SPAWN_AGENT, "*"),
                atom(ToolFaceRegistry.ACTION_CLONE, "*"));
        assertAgentAllowed(agentInvocation(null));
    }

    @Test
    void explicitTargetDelegatesWithoutClone() {
        // Counter-evidence: a caller that holds only spawn_agent (no clone) may still delegate
        // to a principal inside its own subtree. This is delegation, not 分身.
        grantSet = atoms(atom(ToolFaceRegistry.ACTION_SPAWN_AGENT, "agent-unit:" + TEAM));
        assertAgentAllowed(agentInvocation(CHILD_TARGET.toString()));
        PolicyRequest request = lastAgentRequest();
        assertEquals(List.of(ToolFaceRegistry.ACTION_SPAWN_AGENT), request.actionClasses(),
                "an explicit target must not ask the policy for action:clone");
        assertTrue(request.resources().contains("agent-unit:" + CHILD),
                "the target subtree must ride the evaluation request");
        assertEquals(1, request.resources().size(),
                "the target resource must replace the extractor's `*` fallback");
    }

    @Test
    void siblingTargetIsDenied() {
        grantSet = atoms(atom(ToolFaceRegistry.ACTION_SPAWN_AGENT, "agent-unit:" + TEAM));
        assertDenied(agentInvocation(SIBLING_TARGET.toString()),
                "a sibling unit is outside the caller's agent-unit subtree");
    }

    @Test
    void ancestorTargetIsDenied() {
        grantSet = atoms(atom(ToolFaceRegistry.ACTION_SPAWN_AGENT, "agent-unit:" + TEAM));
        assertDenied(agentInvocation(PARENT_TARGET.toString()),
                "the TREE matcher never covers an ancestor");
    }

    @Test
    void humanDelegationUsesTheSameTargetMatrix() {
        grantSet = atoms(atom(ToolFaceRegistry.ACTION_SPAWN_AGENT, "agent-unit:" + TEAM));
        assertHumanAllowed(userInvocation(CHILD_TARGET.toString()));
        assertThrows(CpApiException.class,
                () -> service.authorizeUserSpawn(userInvocation(SIBLING_TARGET.toString()), null));
        assertThrows(CpApiException.class,
                () -> service.authorizeUserSpawn(userInvocation(PARENT_TARGET.toString()), null));
    }

    @Test
    void notificationsNeverEnterTheSpawnFace() {
        ToolFaceRegistry registry = new ToolFaceRegistry();
        for (String tool : List.of("team_task_create", "team_task_list", "team_task_get",
                "team_task_update", "send_message", "to", "cc")) {
            assertNotEquals(ToolFaceRegistry.ACTION_SPAWN_AGENT,
                    registry.faceOf(tool).actionClass(), tool + " is notification, not delegation");
        }
        assertEquals(ToolFaceRegistry.ACTION_SPAWN_AGENT,
                registry.faceOf(ChatSubmissionService.SPAWN_TOOL_NAME).actionClass());
    }

    private void assertAgentAllowed(ChatSubmissionService.SpawnInvocation invocation) {
        assertTrue(service.authorize(invocation, null).allowed());
    }

    private void assertHumanAllowed(ChatSubmissionService.SpawnInvocation invocation) {
        assertTrue(service.authorizeUserSpawn(invocation, null).allowed());
    }

    private void assertDenied(ChatSubmissionService.SpawnInvocation invocation, String message) {
        CpApiException thrown = assertThrows(CpApiException.class,
                () -> service.authorize(invocation, null));
        assertEquals("FORBIDDEN", thrown.getCode(), message);
    }

    private PolicyRequest lastAgentRequest() {
        ArgumentCaptor<PolicyRequest> request = ArgumentCaptor.forClass(PolicyRequest.class);
        org.mockito.Mockito.verify(grants, org.mockito.Mockito.atLeastOnce()).allows(request.capture());
        return request.getAllValues().get(request.getAllValues().size() - 1);
    }

    private void unit(UUID principal, String path) {
        UUID unitId = UUID.nameUUIDFromBytes(path.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        unitOfPrincipal.put(principal, unitId);
        int depth = path.split("/").length;
        unitsById.put(unitId, new OrgUnitReadRepository.UnitRow(
                unitId, null, path.substring(path.lastIndexOf('/') + 1), null,
                path.replace('/', '.'), depth));
    }

    private static Set<GrantIntersectionEvaluator.PermissionAtom> atoms(
            GrantIntersectionEvaluator.PermissionAtom... atoms) {
        return new LinkedHashSet<>(List.of(atoms));
    }

    private static GrantIntersectionEvaluator.PermissionAtom atom(String action, String resource) {
        return new GrantIntersectionEvaluator.PermissionAtom(action, resource);
    }

    private static ChatSubmissionService.SpawnInvocation agentInvocation(String target) {
        return new ChatSubmissionService.SpawnInvocation(
                "11111111-1111-4111-8111-111111111111",
                "33333333-3333-4333-8333-333333333333",
                "55555555-5555-4555-8555-555555555555",
                UUID.randomUUID(), "user-1", WS, CALLER.toString(), body(target), target);
    }

    private static ChatSubmissionService.SpawnInvocation userInvocation(String target) {
        return new ChatSubmissionService.SpawnInvocation(
                "11111111-1111-4111-8111-111111111111",
                "33333333-3333-4333-8333-333333333333",
                "55555555-5555-4555-8555-555555555555", null,
                "user-1", WS, target, body(target), target);
    }

    private static String body(String target) {
        return target == null
                ? "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{\"name\":\"spawn_agent\",\"arguments\":{\"prompt\":\"work\"}}}"
                : "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{\"name\":\"spawn_agent\",\"arguments\":{\"prompt\":\"work\",\"agentPrincipalId\":\""
                        + target + "\"}}}";
    }
}
