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

    protected String baseUrl;

    protected RestTemplate restTemplate;

    @BeforeEach
    void bindClassDatabaseAndRestTemplate(TestInfo testInfo) {
        String testClass = testInfo.getTestClass().map(Class::getName).orElse("?");
        ReusableContextSupport.bind(testClass);
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

    @AfterAll
    static void releaseReuseKey() {
        ReusableContextSupport.unbind();
    }
}
