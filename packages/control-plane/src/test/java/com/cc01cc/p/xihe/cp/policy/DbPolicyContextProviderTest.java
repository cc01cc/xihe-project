package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.entity.PolicyRuleEntity;
import com.cc01cc.p.xihe.cp.entity.ToolFaceEntity;
import com.cc01cc.p.xihe.cp.repository.PolicyRuleRepository;
import com.cc01cc.p.xihe.cp.repository.ToolFaceRepository;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** PLAN-0328 M1: persisted layers/faces are loaded per request and fail closed on error. */
class DbPolicyContextProviderTest {

    private static final String USER = "11111111-1111-4111-8111-111111111111";
    private static final String WS = "22222222-2222-4222-8222-222222222222";

    private final PolicyRuleRepository ruleRepository = mock(PolicyRuleRepository.class);
    private final ToolFaceRepository faceRepository = mock(ToolFaceRepository.class);
    private final SessionPolicyState sessionState = new SessionPolicyState();
    private final SessionApprovalMode sessionApprovalMode = mock(SessionApprovalMode.class);
    private final PolicyVersion policyVersion = new PolicyVersion();
    private final ConfigService configService = mock(ConfigService.class);
    private final DbPolicyContextProvider provider =
            new DbPolicyContextProvider(ruleRepository, faceRepository, sessionState, sessionApprovalMode,
                    policyVersion, configService);

    private static PolicyRuleEntity rule(String layer, String owner, String actionClass, String resource,
                                         String effect, boolean locked) {
        return new PolicyRuleEntity(UUID.randomUUID(), layer, owner, actionClass, resource, effect, 0, locked, "tester");
    }

    private static ToolFaceEntity face(String scope, String owner, String tool, String actionClass, String shape) {
        return new ToolFaceEntity(UUID.randomUUID(), scope, owner, tool, actionClass, shape, "tester");
    }

    private static ConfigService.EffectiveConfig effectiveApprovalMode(String source, String mode) {
        return new ConfigService.EffectiveConfig(
                "approval-policy", "revision-1", source,
                mode == null ? java.util.Map.of() : java.util.Map.of("mode", mode));
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
    void loadFailureFailsClosedToForcedAsk() {
        when(ruleRepository.findByLayerAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance"))
                .thenThrow(new IllegalStateException("db down"));

        PolicyContext context = provider.load("u1", "ws1", "s1");

        assertEquals(1, context.layers().size());
        LayeredPolicyResolver.LayerInput forced = context.layers().get(0);
        assertEquals(PolicyLayer.INSTANCE, forced.layer());
        assertEquals(1, forced.rules().size());
        assertEquals(PolicyEffect.ASK, forced.rules().get(0).effect());
        assertEquals("*", forced.rules().get(0).actionClass());
        assertTrue(context.extraFaces().isEmpty());
    }

    @Test
    void failedClosedContextAsksForNormallyAllowedReadTool() {
        when(ruleRepository.findByLayerAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance"))
                .thenThrow(new IllegalStateException("db down"));
        PolicyEngine engine = new PolicyEngine(mock(AuditLogger.class), provider);

        PolicyVerdict verdict = engine.evaluateVerdict("read_file", "{}", "s1", null, "u1", "ws1");

        assertEquals(PolicyEffect.ASK, verdict.effect());
        assertEquals(PolicyLayer.INSTANCE, verdict.sourceLayer());
    }

    @Test
    void reusesDbSnapshotUntilVersionBumps() {
        provider.load("u1", "ws1", "s1");
        provider.load("u1", "ws1", "s1");

        verify(ruleRepository, times(1)).findByLayerAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance");
        verify(ruleRepository, times(1)).findByLayerAndOwnerIdOrderByCreatedAtAscIdAsc("user", "u1");
        verify(ruleRepository, times(1)).findByLayerAndOwnerIdOrderByCreatedAtAscIdAsc("workspace", "ws1");
        verify(faceRepository, times(1)).findByScopeAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance");

        policyVersion.bump();
        provider.load("u1", "ws1", "s1");

        verify(ruleRepository, times(2)).findByLayerAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance");
        verify(faceRepository, times(2)).findByScopeAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance");
    }

    @Test
    void sessionRulesAreAlwaysReadFreshFromSessionState() {
        PolicyContext first = provider.load("u1", "ws1", "s1");
        sessionState.addRule("s1", PolicyRule.of("exec", "pnpm test *", PolicyEffect.ALLOW));
        PolicyContext second = provider.load("u1", "ws1", "s1");

        assertTrue(first.layers().stream().noneMatch(layer -> layer.layer() == PolicyLayer.SESSION));
        assertEquals(1, second.layers().stream().filter(layer -> layer.layer() == PolicyLayer.SESSION).count());
        verify(ruleRepository, times(1)).findByLayerAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance");
    }

    @Test
    void loadsSessionRulesAndPersistedModeFromOneCoherentView() {
        SessionPolicyState coherentState = mock(SessionPolicyState.class);
        SessionApprovalMode coherentMode = mock(SessionApprovalMode.class);
        PolicyRule sessionRule = PolicyRule.of("exec", "pnpm test *", PolicyEffect.ALLOW);
        SessionPolicyState.Entry entry = new SessionPolicyState.Entry(
                List.of(sessionRule), java.time.Instant.now());
        when(coherentState.snapshot("s1")).thenReturn(java.util.Optional.of(entry));
        when(coherentMode.modeOf("s1")).thenReturn(java.util.Optional.of(LayeredPolicyResolver.MODE_MANUAL));
        DbPolicyContextProvider coherentProvider = new DbPolicyContextProvider(
                ruleRepository, faceRepository, coherentState, coherentMode, policyVersion, configService);

        PolicyContext context = coherentProvider.load("u1", "ws1", "s1");

        assertEquals(LayeredPolicyResolver.MODE_MANUAL, context.mode());
        assertEquals(List.of(sessionRule), context.layers().get(context.layers().size() - 1).rules());
        verify(coherentState).snapshot("s1");
        verify(coherentState, never()).rulesOf("s1");
    }

    @Test
    void workspaceApprovalModeAppliesWhenTheSessionHasNoOverride() {
        when(configService.effective("approval-policy", null, UUID.fromString(WS)))
                .thenReturn(effectiveApprovalMode("workspace", "auto"));

        PolicyContext context = provider.load(null, WS, "s1");

        assertEquals(LayeredPolicyResolver.MODE_AUTO, context.mode());
        assertEquals(PolicyLayer.WORKSPACE, context.modeLayer());
    }

    @Test
    void instanceApprovalModeIsReportedAsInstanceLayer() {
        // PLAN-0364 决策 #9：instance 默认不再被错标为 WORKSPACE。
        when(configService.effective("approval-policy", null, UUID.fromString(WS)))
                .thenReturn(effectiveApprovalMode("instance", "auto"));

        PolicyContext context = provider.load(null, WS, "s1");

        assertEquals(LayeredPolicyResolver.MODE_AUTO, context.mode());
        assertEquals(PolicyLayer.INSTANCE, context.modeLayer());
    }

    @Test
    void envOverriddenApprovalModeIsReportedAsInstanceLayer() {
        // PLAN-0364 决策 #2：env = instance 级部署钉死。
        when(configService.effective("approval-policy", null, UUID.fromString(WS)))
                .thenReturn(effectiveApprovalMode("env", "auto"));

        PolicyContext context = provider.load(null, WS, "s1");

        assertEquals(LayeredPolicyResolver.MODE_AUTO, context.mode());
        assertEquals(PolicyLayer.INSTANCE, context.modeLayer());
    }

    @Test
    void userLayerApprovalModeIsReportedAsUserLayer() {
        // user 层不在 API 可写集（显式例外），但若存在该层行，来源层必须如实标注。
        when(configService.effective("approval-policy", UUID.fromString(USER), UUID.fromString(WS)))
                .thenReturn(effectiveApprovalMode("user", "auto"));

        PolicyContext context = provider.load(USER, WS, "s1");

        assertEquals(LayeredPolicyResolver.MODE_AUTO, context.mode());
        assertEquals(PolicyLayer.USER, context.modeLayer());
    }

    @Test
    void sessionModeOverridesTheConfigMode() {
        when(sessionApprovalMode.modeOf("s1")).thenReturn(java.util.Optional.of(LayeredPolicyResolver.MODE_MANUAL));

        PolicyContext context = provider.load(USER, WS, "s1");

        assertEquals(LayeredPolicyResolver.MODE_MANUAL, context.mode());
        assertEquals(PolicyLayer.SESSION, context.modeLayer());
    }

    @Test
    void unsupportedConfigModeIsIgnoredInsteadOfRelaxing() {
        when(configService.effective("approval-policy", null, UUID.fromString(WS)))
                .thenReturn(effectiveApprovalMode("workspace", "yolo"));

        PolicyContext context = provider.load(null, WS, "s1");

        assertEquals(null, context.mode());
    }

    @Test
    void configModeLookupFailureFallsBackToBuiltinManual() {
        when(configService.effective("approval-policy", null, UUID.fromString(WS)))
                .thenThrow(new IllegalStateException("config db down"));

        PolicyContext context = provider.load(null, WS, "s1");

        assertEquals(null, context.mode());
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
