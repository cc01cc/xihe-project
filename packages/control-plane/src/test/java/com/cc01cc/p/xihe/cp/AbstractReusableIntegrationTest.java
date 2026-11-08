package com.cc01cc.p.xihe.cp;

import com.cc01cc.p.xihe.cp.integration.TestDatabaseProvider;
import com.cc01cc.p.xihe.cp.service.SessionParticipantService;
import com.cc01cc.p.xihe.cp.support.Jackson2NodeWireInterceptor;
import com.cc01cc.p.xihe.cp.support.ReusableContextSupport;
import com.cc01cc.p.xihe.cp.support.ReusableTestContextConfiguration;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.TestInfo;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;
import org.springframework.web.client.DefaultResponseErrorHandler;
import org.springframework.web.client.RestTemplate;

import java.io.IOException;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * task-251（A 方案试点基类）：**复用** Spring 上下文的集成测试基类。
 *
 * <p>与 {@link AbstractIntegrationTest} 的唯一语义差别：
 * <ul>
 *   <li>**不带** {@code @DirtiesContext(AFTER_CLASS)} ⇒ 同类/邻类的上下文不再重建（这是试点要证的收益）；</li>
 *   <li>库隔离从"每类一个上下文 + DynamicPropertySource"换成"一个上下文 + 路由 DataSource"：</li>
 * </ul>
 * 每个类仍在**自己的、已迁移的克隆库**上跑（{@link ReusableTestContextConfiguration} 按类键懒建 target DS），
 * 因此"空库断言 / 迁移种子"语义逐项不变。
 *
 * <p>**默认关**：本类只被试点类显式继承；既有测试不动。回滚 = 试点类把 {@code extends} 改回
 * {@link AbstractIntegrationTest} 并删除本类（无其它依赖）。
 *
 * <p>边界（试点期）：只适用**同步**测试类（HTTP 请求由 Tomcat 线程处理，路由键来自
 * {@link ReusableContextSupport#activeKey()}）；含 {@code @Async}/SSE/调度/并发的类**不试点**（见设计文档 §4）。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
@Import(ReusableTestContextConfiguration.class)
@TestPropertySource(properties = "XIHE_WORKSPACE_DOCKER_BACKEND=disabled")
public abstract class AbstractReusableIntegrationTest {

    /** 每类只打印一次"类 → 库名"映射（失败后可直接进垃圾桶容器查现场）。 */
    private static final Set<String> LOGGED_CLASSES = ConcurrentHashMap.newKeySet();

    /** 类级池的关闭句柄（{@code @AfterAll} 是静态方法，实例注入后存到静态槽）。 */
    private static volatile com.cc01cc.p.xihe.cp.support.ReusableTestDatabaseRouting reusableRouting;

    @LocalServerPort
    protected int port;

    @Autowired
    protected SessionParticipantService sessionParticipantService;

    protected void bindPrimaryParticipant(String sessionId, String agentPrincipalId) {
        sessionParticipantService.ensurePrimaryParticipant(
                java.util.UUID.fromString(sessionId), agentPrincipalId);
    }

    @Autowired
    void initChatBindingCredentialService(
            com.cc01cc.p.xihe.cp.credentials.CredentialService credentialService) {
        com.cc01cc.p.xihe.cp.chat.ChatBindingTestSupport.setCredentialService(credentialService);
    }

    /**
     * task-255 顺序对照实测的静态钩子修复：{@code RootBranchBinder.rootBranchResolver} 是 JVM
     * 级单槽，任何**新的** Spring 上下文（含 per-class {@code @DirtiesContext} 的异步/SSE 类）
     * 都会把解析器改挂到自己的 {@code BranchPathService}；那个上下文类末关闭后，解析器仍指向
     * 已关闭上下文的 bean，随后复用类写 Session/Message/ChatRun 会
     * {@code CannotGetJdbcConnectionException}。本方法在每个测试实例开始前把解析器重挂回本复用
     * 上下文的 bean——即设计 §4.2 要求的 reset hook（否则复用类只能排在所有 per-class 类之前）。
     */
    @Autowired
    void initReusableRouting(
            com.cc01cc.p.xihe.cp.support.ReusableTestDatabaseRouting routing) {
        reusableRouting = routing;
    }

    @Autowired
    void reRegisterRootBranchBinder(
            com.cc01cc.p.xihe.cp.service.BranchPathService branchPathService) {
        com.cc01cc.p.xihe.cp.entity.RootBranchBinder.register(branchPathService::ensureRootBranchId);
    }

    protected String baseUrl;

    protected RestTemplate restTemplate;

    @BeforeEach
    void bindClassDatabaseAndRestTemplate(TestInfo testInfo) {
        String testClass = testInfo.getTestClass().map(Class::getName).orElse("?");
        ReusableContextSupport.bind(testClass);
        // task-11 R-D：首个类测试开始前取「启动期写入快照」（默认上下文已就绪 ⇒ DataSeeder/
        // ApplicationReady recovery 已跑完）。幂等；快照库是容器内一次性库，随 PG 容器消失。
        if (reusableRouting != null) {
            reusableRouting.prepareSeedSnapshot();
        }
        if (LOGGED_CLASSES.add(testClass)) {
            System.out.println("[test-db] reuse class=" + testClass
                    + " key=" + testClass + " (routing target created lazily)");
            // 触发一次库分配并打印真实库名（诊断用，不参与断言）
            System.out.println("[test-db] reuse database=" + TestDatabaseProvider.lastDatabaseName());
        }
        baseUrl = "http://localhost:" + port;
        restTemplate = new RestTemplate();
        restTemplate.getInterceptors().add(Jackson2NodeWireInterceptor.INSTANCE);
        restTemplate.setErrorHandler(new DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(ClientHttpResponse response) throws IOException {
                HttpStatus status = HttpStatus.resolve(response.getStatusCode().value());
                return status != null && status.is5xxServerError();
            }
        });
    }

    protected String url(String path) {
        return baseUrl + path;
    }

    /**
     * task-11（batch1 实测的连接耗尽修复）：类末关闭本类的 target 池（JUnit 保证测试失败路径
     * 也执行 @AfterAll；这里再 try/finally 保证 unbind 一定发生）。池关闭幂等，重复/落空都安全。
     */
    @AfterAll
    static void releaseReuseKey(TestInfo testInfo) {
        String testClass = testInfo.getTestClass().map(Class::getName).orElse(null);
        try {
            com.cc01cc.p.xihe.cp.support.ReusableTestDatabaseRouting routing = reusableRouting;
            if (routing != null) {
                routing.closeTarget(testClass);
            }
        } finally {
            ReusableContextSupport.unbind();
        }
    }
}
