package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.ToolFaceRepository;
import com.cc01cc.p.xihe.cp.service.SessionApprovalModeStore;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * 审批档位（{@code sessions.permission_tier} 为源、{@code approval_mode} 为派生）与「取严合成」的 CP 侧判据
 * （D-1908 §1 / rev4）。task-122 先固化了 characterization，task-107 起断言的是目标态：测试红即实现回退。
 *
 * <p><b>为什么走真实解析链</b>：这里 mock 的只有 {@link SessionRepository}、{@link ConfigService}、
 * {@link ToolFaceRepository} 与 {@code AuditLogger}，{@link SessionApprovalModeStore}、
 * {@link SessionApprovalMode} 与 {@link DbPolicyContextProvider} 都是真实实现——否则「档位怎么被读出来」
 * 会被 mock 绿掉，测不到 D-1908 关心的取严/派生/回落语义。</p>
 */
class ApprovalTierPolicyTest {

    private static final String USER = "11111111-1111-4111-8111-111111111111";
    private static final String WS = "22222222-2222-4222-8222-222222222222";
    private static final UUID SESSION_ID = UUID.fromString("55555555-5555-4555-8555-555555555555");
    private static final String SESSION = SESSION_ID.toString();
    /** 与 {@code DbPolicyContextProvider.APPROVAL_POLICY_DOMAIN} 同值；配置域是解析链的入参，不是本测试的行为。 */
    private static final String APPROVAL_POLICY = "approval-policy";

    private final ToolFaceRepository faceRepository = mock(ToolFaceRepository.class);
    private final SessionRepository sessionRepository = mock(SessionRepository.class);
    private final ConfigService configService = mock(ConfigService.class);
    private final PolicyVersion policyVersion = new PolicyVersion();
    private final SessionApprovalMode sessionApprovalMode =
            new SessionApprovalMode(new SessionApprovalModeStore(sessionRepository));
    private final DbPolicyContextProvider provider =
            new DbPolicyContextProvider(faceRepository, sessionApprovalMode, policyVersion, configService);
    private final PolicyEngine engine = new PolicyEngine(mock(AuditLogger.class), provider);

    @BeforeEach
    void stubFaces() {
        // workspaceId 非空时两条查询都会走；少 stub 一条就是 NPE -> failedClosed，测出来的东西与档位无关。
        when(faceRepository.findByScopeAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance")).thenReturn(List.of());
        when(faceRepository.findByScopeAndOwnerIdOrderByCreatedAtAscIdAsc("workspace", WS)).thenReturn(List.of());
    }

    private Session storedSession(String approvalMode, String permissionTier) {
        Session session = new Session(WS, USER, "tier");
        session.setId(SESSION_ID);
        session.setApprovalMode(approvalMode);
        session.setPermissionTier(permissionTier);
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(session));
        return session;
    }

    private void storedSessionMode(String mode) {
        storedSession(mode, null);
    }

    private void storedSessionTier(String tier) {
        storedSession(null, tier);
    }

    private void workspaceMode(String source, String mode) {
        when(configService.effective(eq(APPROVAL_POLICY), any(), any()))
                .thenReturn(new ConfigService.EffectiveConfig(APPROVAL_POLICY, "revision-1", source,
                        Map.of("mode", mode)));
    }

    private void emptyWorkspaceConfig() {
        when(configService.effective(eq(APPROVAL_POLICY), any(), any()))
                .thenReturn(new ConfigService.EffectiveConfig(APPROVAL_POLICY, "revision-1", "instance", Map.of()));
    }

    // ---------------------------------------------------------------- ① 取严合成（D-1908 §1）

    /** D-1908 §1：workspace=manual + session=full(=auto) 必须合成 manual，且来源层是 workspace。 */
    @Test
    void synthesis_workspaceManual_mustNotBeRelaxedBySessionAuto() {
        storedSessionTier(SessionPermissionTier.FULL);
        workspaceMode("workspace", LayeredPolicyResolver.MODE_MANUAL);

        PolicyContext context = provider.load(USER, WS, SESSION);

        assertEquals(LayeredPolicyResolver.MODE_MANUAL, context.mode(),
                "session 档位只能收紧：auto 会话不得放宽 manual 的 workspace");
        assertEquals(PolicyLayer.WORKSPACE, context.modeLayer());
        assertEquals(SessionPermissionTier.WORKSPACE, context.tier());
        assertEquals(PolicyLayer.WORKSPACE, context.tierSourceLayer());
    }

    /** D-1908 §1 的反方向：session=manual + workspace=auto 必须 manual，来源层是 session。 */
    @Test
    void synthesis_sessionManual_isNotRelaxedByWorkspaceAuto() {
        storedSessionTier(SessionPermissionTier.WORKSPACE);
        workspaceMode("workspace", LayeredPolicyResolver.MODE_AUTO);

        PolicyContext context = provider.load(USER, WS, SESSION);

        assertEquals(LayeredPolicyResolver.MODE_MANUAL, context.mode());
        assertEquals(PolicyLayer.SESSION, context.modeLayer());
        assertEquals(SessionPermissionTier.WORKSPACE, context.tier());
    }

    /** 取严合成在判定面的后果：manual 的 workspace 下，auto 会话不得把写工具自动放行。 */
    @Test
    void synthesis_manualWorkspace_mustStillAskForWriteToolUnderAutoSession() {
        storedSessionTier(SessionPermissionTier.FULL);
        workspaceMode("workspace", LayeredPolicyResolver.MODE_MANUAL);

        PolicyVerdict verdict = engine.evaluateVerdict("write_file", "{}", SESSION, null, USER, WS);

        assertEquals(PolicyEffect.ASK, verdict.effect());
        assertNull(verdict.allowedBy(), "取严之后没有任何 allow-by-mode 的放行依据");
    }

    /** 对照组：没有会话覆盖时，manual 的 workspace 必须让写工具走审批。 */
    @Test
    void manualWorkspaceWithoutSessionOverrideAsksForWriteTool() {
        workspaceMode("workspace", LayeredPolicyResolver.MODE_MANUAL);

        PolicyVerdict verdict = engine.evaluateVerdict("write_file", "{}", SESSION, null, USER, WS);

        assertEquals(PolicyEffect.ASK, verdict.effect());
        assertEquals(LayeredPolicyResolver.MODE_MANUAL, verdict.mode());
        assertNull(verdict.allowedBy(), "manual 下任何 allow-by-mode 都是放宽泄漏");
    }

    /** 没有任何 workspace 配置时会话档位仍然生效（不会因为没有下层就退成内置 manual 而丢档位）。 */
    @Test
    void sessionTierAppliesWithoutAnyWorkspacePolicy() {
        storedSessionTier(SessionPermissionTier.VIEW);
        emptyWorkspaceConfig();

        PolicyContext context = provider.load(USER, WS, SESSION);

        assertEquals(LayeredPolicyResolver.MODE_MANUAL, context.mode());
        assertEquals(SessionPermissionTier.VIEW, context.tier());
        assertEquals(PolicyLayer.SESSION, context.tierSourceLayer());
        assertNull(context.tierFallback());
    }

    // ---------------------------------------------------------------- ② 派生（tier -> mode，单向）

    /** D-1908 rev4：派生是单向的——view/workspace ⇒ manual，full ⇒ auto。 */
    @Test
    void permissionTierDerivesApprovalMode() {
        assertEquals(LayeredPolicyResolver.MODE_MANUAL, SessionPermissionTier.modeForTier(SessionPermissionTier.VIEW));
        assertEquals(LayeredPolicyResolver.MODE_MANUAL,
                SessionPermissionTier.modeForTier(SessionPermissionTier.WORKSPACE));
        assertEquals(LayeredPolicyResolver.MODE_AUTO, SessionPermissionTier.modeForTier(SessionPermissionTier.FULL));
    }

    /** 档位是源：列上 tier=full 时，遗留 approval_mode 列里的 manual 不得把它拉回 manual。 */
    @Test
    void storedTierWinsOverTheLegacyApprovalModeColumn() {
        storedSession(LayeredPolicyResolver.MODE_MANUAL, SessionPermissionTier.FULL);

        assertEquals(Optional.of(LayeredPolicyResolver.MODE_AUTO), sessionApprovalMode.modeOf(SESSION));
        assertEquals(Optional.of(SessionPermissionTier.FULL), sessionApprovalMode.tierOf(SESSION));
    }

    /** V176 之前的行只有 approval_mode：仍必须读出档位与 mode（否则升级即把所有会话打回继承）。 */
    @Test
    void legacyApprovalModeRowStillResolvesTierAndMode() {
        storedSessionMode(LayeredPolicyResolver.MODE_AUTO);

        assertTrue(sessionApprovalMode.tierOf(SESSION).isEmpty(),
                "tierOf 只报「存了档位」，遗留列不是档位；派生发生在 provider 里");
        PolicyContext context = provider.load(USER, WS, SESSION);
        assertEquals(LayeredPolicyResolver.MODE_AUTO, context.mode());
        assertEquals(SessionPermissionTier.FULL, context.tier());
        assertEquals(PolicyLayer.SESSION, context.tierSourceLayer());
    }

    // ---------------------------------------------------------------- ③ 值域白名单（不得回落成放宽值）

    /** 派生 mode 的取值域仍是 manual/auto 两个；新增档位必须同批改这条。 */
    @Test
    void tierWhitelistIsExactlyManualAndAuto() {
        assertEquals(Set.of(LayeredPolicyResolver.MODE_MANUAL, LayeredPolicyResolver.MODE_AUTO),
                SessionPolicyState.MODES);
    }

    /** 档位取值域是 view/workspace/full（D-1908 rev4）；卡面旧写法 workspace-write 不在其中。 */
    @Test
    void permissionTierWhitelistIsExactlyViewWorkspaceFull() {
        assertEquals(Set.of("view", "workspace", "full"), SessionPermissionTier.TIERS);
        assertTrue(SessionPermissionTier.normalize("workspace-write").isEmpty());
    }

    /** 合法值的归一化：大小写与空白必须被吸收，不能因格式差异退回继承（继承可能更宽）。 */
    @Test
    void storedTierValueIsTrimmedAndLowercased() {
        storedSessionMode("  AUTO  ");

        assertEquals(Optional.of(LayeredPolicyResolver.MODE_AUTO), sessionApprovalMode.modeOf(SESSION));
    }

    /** 非法列值必须被拒并退回下一层，绝不能当成 auto：这一列是宽松方向，读错就是静默放行。 */
    @Test
    void unsupportedStoredTierValueFallsBackToTheNextLayerNotToAuto() {
        storedSessionMode("yolo");
        workspaceMode("workspace", LayeredPolicyResolver.MODE_MANUAL);

        assertTrue(sessionApprovalMode.modeOf(SESSION).isEmpty(), "非法值在读到列时即被丢弃");
        PolicyContext context = provider.load(USER, WS, SESSION);

        assertEquals(LayeredPolicyResolver.MODE_MANUAL, context.mode());
        assertEquals(PolicyLayer.WORKSPACE, context.modeLayer());
    }

    /** 非法 permission_tier 同样不得被猜成 full：丢到下一层，由下一层（或内置 manual）决定。 */
    @Test
    void unsupportedStoredPermissionTierFallsBackToTheNextLayer() {
        storedSessionTier("god-mode");
        workspaceMode("workspace", LayeredPolicyResolver.MODE_MANUAL);

        assertTrue(sessionApprovalMode.tierOf(SESSION).isEmpty());
        PolicyContext context = provider.load(USER, WS, SESSION);
        assertEquals(LayeredPolicyResolver.MODE_MANUAL, context.mode());
        assertEquals(SessionPermissionTier.WORKSPACE, context.tier());
        assertEquals(PolicyLayer.WORKSPACE, context.tierSourceLayer());
    }

    /** 非法列值 + 下一层也没有配置 ⇒ 内置 manual（不是 auto，也不是「继承到某个未知层」）。 */
    @Test
    void unsupportedStoredTierValueWithoutAnyLowerTierStaysManual() {
        storedSessionMode("YOLO");
        emptyWorkspaceConfig();

        PolicyContext context = provider.load(USER, WS, SESSION);

        assertNull(context.mode(), "null mode 在 PolicyEngine 里解析为 manual");
        assertNull(context.modeLayer());
        assertEquals(PolicyEffect.ASK,
                engine.evaluateVerdict("write_file", "{}", SESSION, null, USER, WS).effect());
    }

    // ---------------------------------------------------------------- ④ 写侧（tier 与派生 mode 同一次落库）

    /** 写入口同样必须拒绝非法值，且不得落库（否则非法值会被写进列，读侧只能靠过滤兜底）。 */
    @Test
    void setterRejectsUnsupportedTierValuesWithoutWriting() {
        assertThrows(IllegalArgumentException.class, () -> sessionApprovalMode.setMode(SESSION, "yolo"));
        assertThrows(IllegalArgumentException.class, () -> sessionApprovalMode.setMode(SESSION, null));
        assertThrows(IllegalArgumentException.class,
                () -> sessionApprovalMode.setTier(SESSION, "workspace-write"));
        verify(sessionRepository, never()).save(any());
    }

    /** setMode(auto) 必须写 tier=full 与 mode=auto（派生值不能只写一半）。 */
    @Test
    void setModeWritesTheDerivedTierInTheSameSave() {
        Session session = storedSession(null, null);

        sessionApprovalMode.setMode(SESSION, LayeredPolicyResolver.MODE_AUTO);

        assertEquals(SessionPermissionTier.FULL, session.getPermissionTier());
        assertEquals(LayeredPolicyResolver.MODE_AUTO, session.getApprovalMode());
        verify(sessionRepository).save(session);
    }

    /** setTier(view) 必须写 mode=manual（派生方向恒为 tier -> mode）。 */
    @Test
    void setTierWritesTheDerivedModeInTheSameSave() {
        Session session = storedSession(null, null);

        sessionApprovalMode.setTier(SESSION, SessionPermissionTier.VIEW);

        assertEquals(SessionPermissionTier.VIEW, session.getPermissionTier());
        assertEquals(LayeredPolicyResolver.MODE_MANUAL, session.getApprovalMode());
        verify(sessionRepository).save(session);
    }

    /** 旧的 mode 开关不得把更细的 view 抬成 workspace：派生 mode 未变时保留原档位。 */
    @Test
    void setModeKeepsTheFinerTierWhenTheDerivedModeDoesNotChange() {
        Session session = storedSession(LayeredPolicyResolver.MODE_MANUAL, SessionPermissionTier.VIEW);

        sessionApprovalMode.setMode(SESSION, LayeredPolicyResolver.MODE_MANUAL);

        assertEquals(SessionPermissionTier.VIEW, session.getPermissionTier());
    }

    // ---------------------------------------------------------------- ⑤ 主体维度（设计闸门，D-1908 rev2 ③）

    /**
     * 设计闸门：principal 只能通过四参重载进入，且当前实现不因主主体改变档位；一旦把主体做成
     * 第二维度（权限矩阵），这条测试必须同批改写——它不是「什么都不测」的占位。
     */
    @Test
    void principalOverloadDelegatesWithoutChangingTheTier() {
        storedSessionTier(SessionPermissionTier.WORKSPACE);
        emptyWorkspaceConfig();

        PolicyContext withPrincipal = provider.load(USER, WS, SESSION, "agent-principal-1");
        PolicyContext withoutPrincipal = provider.load(USER, WS, SESSION);

        assertEquals(withoutPrincipal.mode(), withPrincipal.mode());
        assertEquals(withoutPrincipal.tier(), withPrincipal.tier());
        assertFalse(withPrincipal.tierSourceLayer() == null);
    }
}