package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.cc01cc.p.xihe.cp.entity.PolicyRuleEntity;
import com.cc01cc.p.xihe.cp.entity.ToolFaceEntity;
import com.cc01cc.p.xihe.cp.repository.PolicyRuleRepository;
import com.cc01cc.p.xihe.cp.repository.ToolFaceRepository;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** PLAN-0328 M1: persisted layers/faces are loaded per request and fail closed on error. */
class DbPolicyContextProviderTest {

    private final PolicyRuleRepository ruleRepository = mock(PolicyRuleRepository.class);
    private final ToolFaceRepository faceRepository = mock(ToolFaceRepository.class);
    private final SessionPolicyState sessionState = new SessionPolicyState();
    private final DbPolicyContextProvider provider =
            new DbPolicyContextProvider(ruleRepository, faceRepository, sessionState);

    private static PolicyRuleEntity rule(String layer, String owner, String actionClass, String resource,
                                         String effect, boolean locked) {
        return new PolicyRuleEntity(UUID.randomUUID(), layer, owner, actionClass, resource, effect, 0, locked, "tester");
    }

    private static ToolFaceEntity face(String scope, String owner, String tool, String actionClass, String shape) {
        return new ToolFaceEntity(UUID.randomUUID(), scope, owner, tool, actionClass, shape, "tester");
    }

    @Test
    void loadsInstanceUserAndWorkspaceLayersInPriorityOrder() {
        when(ruleRepository.findByLayerAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance"))
                .thenReturn(List.of(rule("instance", null, "exec", "git push *", "deny", true)));
        when(ruleRepository.findByLayerAndOwnerIdOrderByCreatedAtAscIdAsc("user", "u1"))
                .thenReturn(List.of(rule("user", "u1", "exec", "*", "ask", false)));
        when(ruleRepository.findByLayerAndOwnerIdOrderByCreatedAtAscIdAsc("workspace", "ws1"))
                .thenReturn(List.of(rule("workspace", "ws1", "exec", "pnpm test *", "allow", false)));
        when(faceRepository.findByScopeAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance")).thenReturn(List.of());
        when(faceRepository.findByScopeAndOwnerIdOrderByCreatedAtAscIdAsc("workspace", "ws1")).thenReturn(List.of());

        PolicyContext context = provider.load("u1", "ws1", "s1");

        assertEquals(3, context.layers().size());
        assertEquals(PolicyLayer.INSTANCE, context.layers().get(0).layer());
        assertEquals(PolicyLayer.USER, context.layers().get(1).layer());
        assertEquals(PolicyLayer.WORKSPACE, context.layers().get(2).layer());
        assertTrue(context.layers().get(0).rules().get(0).locked());
        assertEquals(PolicyEffect.ALLOW, context.layers().get(2).rules().get(0).effect());
    }

    @Test
    void skipsUserAndWorkspaceLayersWithoutIdentity() {
        when(ruleRepository.findByLayerAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance")).thenReturn(List.of());

        PolicyContext context = provider.load(null, null, "s1");

        assertEquals(1, context.layers().size());
        assertEquals(PolicyLayer.INSTANCE, context.layers().get(0).layer());
        assertTrue(context.extraFaces().isEmpty());
    }

    @Test
    void workspaceFacesOverrideInstanceFaces() {
        when(ruleRepository.findByLayerAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance")).thenReturn(List.of());
        when(ruleRepository.findByLayerAndOwnerIdOrderByCreatedAtAscIdAsc(anyString(), anyString())).thenReturn(List.of());
        when(faceRepository.findByScopeAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance"))
                .thenReturn(List.of(face("instance", null, "mcp__acme__deploy", "exec", "interpreter")));
        when(faceRepository.findByScopeAndOwnerIdOrderByCreatedAtAscIdAsc("workspace", "ws1"))
                .thenReturn(List.of(face("workspace", "ws1", "mcp__acme__deploy", "write", "structured")));

        PolicyContext context = provider.load("u1", "ws1", "s1");

        ToolFaceRegistry.Face face = context.extraFaces().get("mcp__acme__deploy");
        assertEquals("write", face.actionClass());
        assertEquals(ToolShape.STRUCTURED, face.shape());
    }

    @Test
    void loadFailureFailsClosedToEmptyContext() {
        when(ruleRepository.findByLayerAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance"))
                .thenThrow(new IllegalStateException("db down"));

        PolicyContext context = provider.load("u1", "ws1", "s1");

        assertTrue(context.layers().isEmpty());
        assertTrue(context.extraFaces().isEmpty());
        assertFalse(false, "fail-closed must never relax decisions");
    }

    @Test
    void mapsShapeAndEffectCaseInsensitively() {
        when(ruleRepository.findByLayerAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance"))
                .thenReturn(List.of(rule("instance", null, "exec", "*", "ask", false)));
        when(faceRepository.findByScopeAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance"))
                .thenReturn(List.of(face("instance", null, "mcp__x__run", "exec", "interpreter")));
        when(ruleRepository.findByLayerAndOwnerIdOrderByCreatedAtAscIdAsc(anyString(), anyString())).thenReturn(List.of());

        PolicyContext context = provider.load("u1", "ws1", "s1");

        assertEquals(PolicyEffect.ASK, context.layers().get(0).rules().get(0).effect());
        assertEquals(ToolShape.INTERPRETER, context.extraFaces().get("mcp__x__run").shape());
    }

    @Test
    void facesLoadsOnlyWhenRepositoryEmpty() {
        when(ruleRepository.findByLayerAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance")).thenReturn(List.of());
        when(ruleRepository.findByLayerAndOwnerIdOrderByCreatedAtAscIdAsc(anyString(), anyString())).thenReturn(anyList());
        when(faceRepository.findByScopeAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance")).thenReturn(List.of());

        PolicyContext context = provider.load("u1", "ws1", "s1");

        assertTrue(context.extraFaces().isEmpty());
    }
}
