package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
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
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Test;

/**
 * 审批档位（{@code sessions.approval_mode} 与 {@code approval-policy.mode}）的 CP 侧判据与「取严合成」
 * （D-1908 §1 / rev2）。task-122：把决策固化成可执行断言，改动档位语义必须先改这些测试。
 *
 * <p><b>为什么走真实解析链</b>：这里 mock 的只有 {@link SessionRepository}、{@link ConfigService}、
 * {@link ToolFaceRepository} 与 {@code AuditLogger}，{@link SessionApprovalModeStore}、
 * {@link SessionApprovalMode} 与 {@link DbPolicyContextProvider} 都是真实实现——否则「档位怎么被读出来」
 * 会被 mock 绿掉，测不到 D-1908 关心的合成/回落语义。</p>
 *
 * <p><b>@Disabled 的两条是 characterization（先红后绿）</b>：D-1908 要求「取严合成」与「读失败回落最严」，
 * 当前实现是「session 覆盖 config」和「session 读失败静默继承 workspace」，因此这两条 body 锁的是
 * <b>当前</b>放宽读数。task-107 落地时把断言的放宽值改成严格值并删除 {@code @Disabled}——它们会成为回归门。</p>
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

    private void storedSessionMode(String mode) {
        Session session = new Session(WS, USER, "tier");
        session.setId(SESSION_ID);
        session.setApprovalMode(mode);
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(session));
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

    /**
     * D-1908 §1：workspace=manual + session=auto 必须合成 manual。
     *
     * <p>当前读数（@Disabled 的理由）：session 档位非空就整体覆盖 config 档位，所以这里是 auto——放宽方向。
     * task-107 转绿时把断言值改成 {@code LayeredPolicyResolver.MODE_MANUAL}（层应为 WORKSPACE）并删 {@code @Disabled}。</p>
     */
    @Test
    @Disabled("待 task-107 转绿：D-1908 §1 取严合成；此刻锁的是放宽现状（auto）")
    void synthesis_workspaceManual_mustNotBeRelaxedBySessionAuto() {
        storedSessionMode(LayeredPolicyResolver.MODE_AUTO);
        workspaceMode("workspace", LayeredPolicyResolver.MODE_MANUAL);

        PolicyContext context = provider.load(USER, WS, SESSION);

        assertEquals(LayeredPolicyResolver.MODE_AUTO, context.mode(),
                "当前实现 = session 覆盖式放宽（auto）；D-1908 §1 要求取严 manual");
        assertEquals(PolicyLayer.SESSION, context.modeLayer());
    }

    /** D-1908 §1 的反方向：session=manual + workspace=auto 必须 manual——当前实现已满足，改动合成规则不得破坏它。 */
    @Test
    void synthesis_sessionManual_isNotRelaxedByWorkspaceAuto() {
        storedSessionMode(LayeredPolicyResolver.MODE_MANUAL);
        workspaceMode("workspace", LayeredPolicyResolver.MODE_AUTO);

        PolicyContext context = provider.load(USER, WS, SESSION);

        assertEquals(LayeredPolicyResolver.MODE_MANUAL, context.mode());
        assertEquals(PolicyLayer.SESSION, context.modeLayer());
    }

    /**
     * 取严合成在判定面的后果：manual 的 workspace 下，auto 的 session 不得把写工具自动放行。
     *
     * <p>当前读数（@Disabled 的理由）：{@code approvalVerdict} 在 auto 下用
     * {@code PolicyVerdict.allowedByMode} 把 ASK 改成 ALLOW，{@code allowedBy=auto@SESSION}——写工具被自动放行。
     * task-107 转绿时改为断言 {@code PolicyEffect.ASK} 且 {@code allowedBy} 为 null。</p>
     */
    @Test
    @Disabled("待 task-107 转绿：D-1908 §1；此刻锁的是 auto 会话把写工具自动放行")
    void synthesis_manualWorkspace_mustStillAskForWriteToolUnderAutoSession() {
        storedSessionMode(LayeredPolicyResolver.MODE_AUTO);
        workspaceMode("workspace", LayeredPolicyResolver.MODE_MANUAL);

        PolicyVerdict verdict = engine.evaluateVerdict("write_file", "{}", SESSION, null, USER, WS);

        assertEquals(PolicyEffect.ALLOW, verdict.effect(),
                "当前实现 auto 覆盖 manual：写工具直接放行；D-1908 §1 要求 ASK");
        assertEquals("auto@" + PolicyLayer.SESSION, verdict.allowedBy());
    }

    /** 对照组：没有会话覆盖时，manual 的 workspace 必须让写工具走审批（这条现在就该绿，且转绿后仍必须绿）。 */
    @Test
    void manualWorkspaceWithoutSessionOverrideAsksForWriteTool() {
        workspaceMode("workspace", LayeredPolicyResolver.MODE_MANUAL);

        PolicyVerdict verdict = engine.evaluateVerdict("write_file", "{}", SESSION, null, USER, WS);

        assertEquals(PolicyEffect.ASK, verdict.effect());
        assertEquals(LayeredPolicyResolver.MODE_MANUAL, verdict.mode());
        assertNull(verdict.allowedBy(), "manual 下任何 allow-by-mode 都是放宽泄漏");
    }

    // ---------------------------------------------------------------- ④ 档位白名单（不得回落成放宽值）

    /** 白名单值域就是 manual/auto 两个；新增档位必须同批改这条（否则 UI/契约两侧都不知道新值）。 */
    @Test
    void tierWhitelistIsExactlyManualAndAuto() {
        assertEquals(Set.of(LayeredPolicyResolver.MODE_MANUAL, LayeredPolicyResolver.MODE_AUTO),
                SessionPolicyState.MODES);
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

    /** 写入口同样必须拒绝非法值，且不得落库（否则非法值会被写进列，读侧只能靠过滤兜底）。 */
    @Test
    void setterRejectsUnsupportedTierValuesWithoutWriting() {
        assertThrows(IllegalArgumentException.class, () -> sessionApprovalMode.setMode(SESSION, "yolo"));
        assertThrows(IllegalArgumentException.class, () -> sessionApprovalMode.setMode(SESSION, null));
        verify(sessionRepository, never()).save(any());
    }
}
