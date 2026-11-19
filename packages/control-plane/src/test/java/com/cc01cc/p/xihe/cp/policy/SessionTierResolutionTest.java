package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.ToolFaceRepository;
import com.cc01cc.p.xihe.cp.service.SessionApprovalModeStore;
import java.lang.reflect.Method;
import java.lang.reflect.RecordComponent;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import java.util.stream.Stream;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Test;

/**
 * 档位继承链与回落语义（D-1908 二节）：session → workspace → workspace-default → instance → 内置 manual，
 * 以及两条「不许静默放宽」的设计闸门（rev2 第 2/3 条）。
 *
 * <p>解析链是真实实现（只 mock {@link SessionRepository}/{@link ConfigService}/{@link ToolFaceRepository}），
 * 这样断言的是「CP 实际怎么算」，不是「测试怎么拼」。</p>
 */
class SessionTierResolutionTest {

    private static final String USER = "11111111-1111-4111-8111-111111111111";
    private static final String WS = "22222222-2222-4222-8222-222222222222";
    private static final UUID SESSION_ID = UUID.fromString("55555555-5555-4555-8555-555555555555");
    private static final String SESSION = SESSION_ID.toString();
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
        when(faceRepository.findByScopeAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance")).thenReturn(List.of());
        when(faceRepository.findByScopeAndOwnerIdOrderByCreatedAtAscIdAsc("workspace", WS)).thenReturn(List.of());
    }

    private void storedSessionMode(String mode) {
        Session session = new Session(WS, USER, "tier");
        session.setId(SESSION_ID);
        session.setApprovalMode(mode);
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(session));
    }

    private void configTier(String source, String mode) {
        when(configService.effective(eq(APPROVAL_POLICY), any(), any()))
                .thenReturn(new ConfigService.EffectiveConfig(APPROVAL_POLICY, "revision-1", source,
                        mode == null ? Map.of() : Map.of("mode", mode)));
    }

    // ---------------------------------------------------------------- 二节①：链的每一级

    /** 第一级：会话列有值就用它，并如实标注 SESSION。 */
    @Test
    void sessionTierBeatsEveryLowerTier() {
        storedSessionMode(LayeredPolicyResolver.MODE_AUTO);
        configTier("workspace", LayeredPolicyResolver.MODE_MANUAL);

        PolicyContext context = provider.load(USER, WS, SESSION);

        assertEquals(LayeredPolicyResolver.MODE_AUTO, context.mode());
        assertEquals(PolicyLayer.SESSION, context.modeLayer());
    }

    /** 第二级：会话列空 ⇒ 用 workspace 档位（不是「没配 ⇒ manual」）。 */
    @Test
    void emptySessionTierInheritsTheWorkspaceTier() {
        configTier("workspace", LayeredPolicyResolver.MODE_AUTO);

        PolicyContext context = provider.load(USER, WS, SESSION);

        assertEquals(LayeredPolicyResolver.MODE_AUTO, context.mode());
        assertEquals(PolicyLayer.WORKSPACE, context.modeLayer());
    }

    /** 第三级：共享层 workspace-default 必须报自己的层，不能被错标成 WORKSPACE（审计口径）。 */
    @Test
    void sharedWorkspaceDefaultTierIsReportedAsItsOwnLayer() {
        configTier("workspace-default", LayeredPolicyResolver.MODE_AUTO);

        PolicyContext context = provider.load(USER, WS, SESSION);

        assertEquals(LayeredPolicyResolver.MODE_AUTO, context.mode());
        assertEquals(PolicyLayer.WORKSPACE_DEFAULT, context.modeLayer());
    }

    /** 第四级：instance 档位（含 env 钉死）同样如实标注 INSTANCE。 */
    @Test
    void instanceTierIsReportedAsInstanceLayer() {
        configTier("instance", LayeredPolicyResolver.MODE_AUTO);

        assertEquals(PolicyLayer.INSTANCE, provider.load(USER, WS, SESSION).modeLayer());
    }

    /** 第五级：三层都没配 ⇒ mode 为 null，由 PolicyEngine 解析成 manual，asks 走代码默认表。 */
    @Test
    void noTierAnywhereFallsBackToBuiltinManual() {
        configTier("instance", null);

        PolicyContext context = provider.load(USER, WS, SESSION);

        assertNull(context.mode());
        assertNull(context.modeLayer());
        assertEquals(PolicyLayer.BUILTIN, context.askLayer());
        assertEquals(PolicyEffect.ASK,
                engine.evaluateVerdict("write_file", "{}", SESSION, null, USER, WS).effect());
    }

    // ---------------------------------------------------------------- 二节②：读失败必须回落最严 + 有信号

    /** 对照组：读类工具在正常配置下直接放行——用来证明「读失败」那条断言测的是信号而不是常量。 */
    @Test
    void readToolIsAllowedWhenTheContextLoadsNormally() {
        configTier("instance", null);

        assertEquals(PolicyEffect.ALLOW,
                engine.evaluateVerdict("read_file", "{}", SESSION, null, USER, WS).effect());
    }

    /**
     * 配置读失败 ⇒ 档位回落 manual（mode=null）+ ask 表回落代码默认表、来源层如实标 BUILTIN。
     *
     * <p><b>诚实边界（实测，别把这条读大）</b>：配置面的读失败走的是 {@code approvalConfig} 内部 catch，
     * 回落结果是「内置默认 ask 表」，<b>不是</b> {@link PolicyContext#failedClosed()} 的全量 action class 表——
     * 那张全量表只在 face 快照/版本读取失败时出现。所以 fail-closed 在这里的形态是：
     * ①档位不会被沿用（读不到即 manual）；②ask 表只会变得更宽（默认表 ⊇ 任何合法窄表，含显式空表），
     * 不会漏拦；③审计面能用 {@code sourceLayer=BUILTIN} 看出「这次判定用的是内置表，不是配置」。</p>
     */
    @Test
    void unreadableConfigTierFallsBackToManualAndTheBuiltinAskList() {
        when(configService.effective(eq(APPROVAL_POLICY), any(), any()))
                .thenThrow(new IllegalStateException("config db down"));

        PolicyContext context = provider.load(USER, WS, SESSION);

        assertNull(context.mode(), "读不到档位就是 manual，不是沿用某个更宽的档");
        assertNull(context.modeLayer());
        assertEquals(PolicyLayer.BUILTIN, context.askLayer(), "来源层回落 = 可审计的失败信号");
        assertEquals(PolicyContext.DEFAULT_ASK_ACTION_CLASSES, context.askActionClasses(),
                "回落表必须是内置默认表（比任何合法窄表都宽）");

        PolicyVerdict write = engine.evaluateVerdict("write_file", "{}", SESSION, null, USER, WS);
        assertEquals(PolicyEffect.ASK, write.effect(), "写工具仍然被拦");
        assertEquals(PolicyLayer.BUILTIN, write.sourceLayer(), "verdict 里能看见 ask 表来源已回落到内置");
        assertNull(write.allowedBy());
    }

    /**
     * D-1908 二节②：任意层读失败必须回落最严 + 明确信号，不能静默继承。
     *
     * <p>当前读数（@Disabled 的理由）：{@link SessionApprovalMode#modeOf} 吞掉 {@code RuntimeException} 返回
     * empty，于是会话层读失败表现成「会话没配」⇒ 静默继承 workspace 的 auto（放宽方向）。
     * task-107 转绿时改为断言 manual（以及一条可观测的回落信号），并删 {@code @Disabled}。</p>
     */
    @Test
    @Disabled("待 task-107 转绿：D-1908 二节②；此刻锁的是会话层读失败静默继承 auto")
    void unreadableSessionTierMustFailClosedToStrictestNotToWorkspaceAuto() {
        when(sessionRepository.findById(SESSION_ID)).thenThrow(new IllegalStateException("session db down"));
        configTier("workspace", LayeredPolicyResolver.MODE_AUTO);

        PolicyContext context = provider.load(USER, WS, SESSION);

        assertEquals(LayeredPolicyResolver.MODE_AUTO, context.mode(),
                "当前实现静默继承 workspace=auto；D-1908 要求回落最严（manual）+ 明确信号");
        assertEquals(PolicyLayer.WORKSPACE, context.modeLayer());
    }

    // ---------------------------------------------------------------- rev2 第 3 条：策略面没有主体维度

    /**
     * 设计闸门（D-1908 rev2 第 3 条）：CP 的策略判定只有 userId/workspaceId/sessionId 三个身份维度，
     * 没有 principalId。加主体维度是设计变更——必须同批改这条测试并在 decision 里记录理由，
     * 不允许「顺手加个重载」把主体面混进策略面。
     */
    @Test
    void policy_has_noPrincipalDimension_byDesign() {
        Method[] declared = PolicyContextProvider.class.getDeclaredMethods();
        assertEquals(1, declared.length,
                "PolicyContextProvider 是单方法接口；加主体维度必然在这里多出一个方法");
        assertEquals("load", declared[0].getName());
        assertEquals(List.of(String.class, String.class, String.class),
                List.of(declared[0].getParameterTypes()),
                "策略上下文只按 userId/workspaceId/sessionId 求值");

        for (String forbidden : List.of("principalId", "principalKind", "agentPrincipalId")) {
            assertFalse(hasComponent(PolicyRequest.class, forbidden), "PolicyRequest 不得携带 " + forbidden);
            assertFalse(hasComponent(PolicyContext.class, forbidden), "PolicyContext 不得携带 " + forbidden);
        }
        assertTrue(Arrays.stream(PolicyEngine.class.getDeclaredMethods())
                        .noneMatch(method -> method.getName().toLowerCase(Locale.ROOT).contains("principal")),
                "PolicyEngine 不得接受主体参数：主体面归 grant 层（GrantPrincipalPathResolver）");
    }

    private static boolean hasComponent(Class<?> recordType, String name) {
        return Arrays.stream(recordType.getRecordComponents())
                .map(RecordComponent::getName)
                .anyMatch(name::equals);
    }

    // ---------------------------------------------------------------- rev2 第 2 条：CP 不按档位选后端

    /**
     * 设计闸门（D-1908 rev2 第 2 条）：后端由 Runtime 决定，CP 只持久化/下发 {@code workspaces.execution_mode}。
     * 因此「档位名称」与「后端名称」在 CP 里必须互不可见：一旦某个文件同时出现两者，就是「按档位选后端」的分支开始长出来。
     *
     * <p>为什么不用 grep 判据：测试要跟着源码走，不看同目录是否恰好有别的构建产物；先扫整棵
     * {@code src/main/java}，再用「后端名字面量只允许出现在三个工作区环境面文件里」把范围钉死，
     * 顺带防住本测试在空树上假绿。</p>
     */
    @Test
    void controlPlaneNeverSelectsABackendFromTheApprovalTier() throws Exception {
        Path sourceRoot = mainSourceRoot();
        List<Path> sources;
        try (Stream<Path> walk = Files.walk(sourceRoot)) {
            sources = walk.filter(Files::isRegularFile)
                    .filter(path -> path.toString().endsWith(".java"))
                    .toList();
        }
        assertTrue(sources.size() > 200, "源扫描必须有内容可扫，否则本测试是假绿：" + sourceRoot);

        List<String> backendLiterals = List.of("windows-host", "windows-mxc");
        List<String> tierLiterals = List.of("approvalMode", "MODE_AUTO", "MODE_MANUAL",
                "approval-policy", "SessionApprovalMode");
        Set<String> backendSurface = new TreeSet<>();

        for (Path source : sources) {
            String relative = sourceRoot.relativize(source).toString().replace('\\', '/');
            String text = Files.readString(source);
            boolean policyOrChat = relative.startsWith("com/cc01cc/p/xihe/cp/policy/")
                    || relative.startsWith("com/cc01cc/p/xihe/cp/chat/");
            if (policyOrChat) {
                for (String literal : List.of("windows-host", "windows-mxc", "executionMode", "backendKind")) {
                    assertFalse(text.contains(literal),
                            relative + " 不得知道后端选择（出现 " + literal + "）：D-1908 rev2 第 2 条把后端决定权留在 Runtime");
                }
            }
            if (backendLiterals.stream().anyMatch(text::contains)) {
                backendSurface.add(relative);
            }
        }

        // 后端名字面量只允许出现在工作区环境面（校验/映射/文案）；新增文件必须显式改这张白名单。
        Set<String> allowed = Set.of(
                "com/cc01cc/p/xihe/cp/service/WorkspaceService.java",
                "com/cc01cc/p/xihe/cp/controller/WorkspaceController.java",
                "com/cc01cc/p/xihe/cp/service/WorkspaceBackendPolicy.java");
        assertEquals(allowed, backendSurface,
                "后端名字面量只允许出现在工作区环境面；新增出现点 = 重新设计，不是顺手加");

        for (String file : backendSurface) {
            String text = Files.readString(sourceRoot.resolve(file));
            for (String tier : tierLiterals) {
                assertFalse(text.contains(tier),
                        file + " 同时出现后端与档位（" + tier + "）：这就是「按档位选后端」的耦合，D-1908 rev2 第 2 条禁止");
            }
        }
    }

    /** 主源码根：测试类 code source 是 {@code <module>/target/test-classes} ⇒ 上两级是模块根。 */
    private static Path mainSourceRoot() {
        try {
            Path moduleRoot = Path.of(Objects.requireNonNull(
                            SessionTierResolutionTest.class.getProtectionDomain().getCodeSource().getLocation().toURI()))
                    .getParent()
                    .getParent();
            Path sourceRoot = moduleRoot.resolve("src").resolve("main").resolve("java");
            assertTrue(Files.isDirectory(sourceRoot), "主源码根不存在：" + sourceRoot);
            return sourceRoot;
        } catch (java.net.URISyntaxException e) {
            throw new IllegalStateException("cannot resolve test code source location", e);
        }
    }
}
