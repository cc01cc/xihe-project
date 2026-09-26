package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.entity.ToolFaceEntity;
import com.cc01cc.p.xihe.cp.repository.ToolFaceRepository;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * PLAN-0328 M1 + PLAN-0407 T2.8: persisted faces load per request, the approval mode and ask
 * list read fresh from {@code approval-policy}, and the provider fails closed on error.
 * Rule-layer loading retired with the adjudication engine (design #18/#21).
 */
class DbPolicyContextProviderTest {

    private static final String USER = "11111111-1111-4111-8111-111111111111";
    private static final String WS = "22222222-2222-4222-8222-222222222222";

    private final ToolFaceRepository faceRepository = mock(ToolFaceRepository.class);
    private final SessionApprovalMode sessionApprovalMode = mock(SessionApprovalMode.class);
    private final PolicyVersion policyVersion = new PolicyVersion();
    private final ConfigService configService = mock(ConfigService.class);
    private final DbPolicyContextProvider provider =
            new DbPolicyContextProvider(faceRepository, sessionApprovalMode, policyVersion, configService);

    private static ToolFaceEntity face(String scope, String owner, String tool, String actionClass, String shape) {
        return new ToolFaceEntity(UUID.randomUUID(), scope, owner, tool, actionClass, shape, "tester");
    }

    private static ConfigService.EffectiveConfig effectiveApproval(String source, Map<String, String> entries) {
        return new ConfigService.EffectiveConfig("approval-policy", "revision-1", source, entries);
    }

    private static ConfigService.EffectiveConfig effectiveApprovalMode(String source, String mode) {
        return effectiveApproval(source,
                mode == null ? Map.of() : Map.of("mode", mode));
    }

    @Test
    void workspaceFacesOverrideInstanceFaces() {
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
        when(faceRepository.findByScopeAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance"))
                .thenThrow(new IllegalStateException("db down"));

        PolicyContext context = provider.load("u1", "ws1", "s1");

        assertTrue(context.extraFaces().isEmpty());
        assertEquals(PolicyLayer.INSTANCE, context.askLayer());
        assertTrue(context.askActionClasses().containsAll(ToolFaceRegistry.builtinActionClasses()),
                "fail-closed puts every builtin action class on the ask list");
    }

    @Test
    void failedClosedContextAsksForNormallyAllowedReadTool() {
        when(faceRepository.findByScopeAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance"))
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

        verify(faceRepository, times(1)).findByScopeAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance");

        policyVersion.bump();
        provider.load("u1", "ws1", "s1");

        verify(faceRepository, times(2)).findByScopeAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance");
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
        when(sessionApprovalMode.modeOf("s1"))
                .thenReturn(java.util.Optional.of(LayeredPolicyResolver.MODE_MANUAL));

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
    void configLookupFailureFallsBackToBuiltinManualAndDefaultAskList() {
        when(configService.effective("approval-policy", null, UUID.fromString(WS)))
                .thenThrow(new IllegalStateException("config db down"));

        PolicyContext context = provider.load(null, WS, "s1");

        assertEquals(null, context.mode());
        assertEquals(PolicyContext.DEFAULT_ASK_ACTION_CLASSES, context.askActionClasses());
        assertEquals(PolicyLayer.BUILTIN, context.askLayer());
    }

    @Test
    void configuredAskActionClassesReplaceTheDefaultList() {
        when(configService.effective("approval-policy", null, UUID.fromString(WS)))
                .thenReturn(effectiveApproval("workspace",
                        Map.of("mode", "manual", "askActionClasses", "[\"write\",\"delete\"]")));

        PolicyContext context = provider.load(null, WS, "s1");

        assertEquals(List.of("write", "delete"), context.askActionClasses());
        assertEquals(PolicyLayer.WORKSPACE, context.askLayer());
        assertEquals(LayeredPolicyResolver.MODE_MANUAL, context.mode());
    }

    @Test
    void anExplicitlyEmptyAskListIsPreservedNotReplacedByTheDefault() {
        when(configService.effective("approval-policy", null, UUID.fromString(WS)))
                .thenReturn(effectiveApproval("workspace", Map.of("askActionClasses", "[]")));

        PolicyContext context = provider.load(null, WS, "s1");

        assertTrue(context.askActionClasses().isEmpty(),
                "an explicit empty list means nothing asks and must not fall back to the default");
        assertEquals(PolicyLayer.WORKSPACE, context.askLayer());
    }

    @Test
    void malformedAskActionClassesFallsBackToTheCodeDefault() {
        when(configService.effective("approval-policy", null, UUID.fromString(WS)))
                .thenReturn(effectiveApproval("workspace", Map.of("askActionClasses", "not-an-array")));

        PolicyContext context = provider.load(null, WS, "s1");

        assertEquals(PolicyContext.DEFAULT_ASK_ACTION_CLASSES, context.askActionClasses(),
                "a malformed value never relaxes to an empty ask list");
        assertEquals(PolicyLayer.BUILTIN, context.askLayer());
    }

    @Test
    void mapsShapeCaseInsensitively() {
        when(faceRepository.findByScopeAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance"))
                .thenReturn(List.of(face("instance", null, "mcp__x__run", "exec", "interpreter")));

        PolicyContext context = provider.load("u1", "ws1", "s1");

        assertEquals(ToolShape.INTERPRETER, context.extraFaces().get("mcp__x__run").shape());
    }

    @Test
    void facesLoadsOnlyWhenRepositoryEmpty() {
        when(faceRepository.findByScopeAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance"))
                .thenReturn(List.of());

        PolicyContext context = provider.load("u1", "ws1", "s1");

        assertTrue(context.extraFaces().isEmpty());
    }
}
