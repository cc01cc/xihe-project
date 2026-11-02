package com.cc01cc.p.xihe.cp;

import com.cc01cc.p.xihe.cp.integration.TestDatabaseProvider;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.TestInfo;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpStatus;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.client.DefaultResponseErrorHandler;
import org.springframework.web.client.RestTemplate;

import java.io.IOException;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * PostgreSQL 集成测试基类。
 *
 * <p>PLAN-eff / task-13 M1（A1 路线）：数据源不再是"每类一个容器"，而是
 * {@link TestDatabaseProvider} 的 <b>JVM 级单例容器 + 每类克隆已迁移模板库</b>。
 * 每个类仍然拿到<b>一个全新的、已迁移的、带迁移种子的独立数据库</b>，因此
 * "空数据断言"与"迁移种子依赖"两类隔离假设**逐项不变**；容器启停与 Flyway 全量迁移
 * 从"每类一次"降到"每 JVM 一次"（M0 实测每类省 ≈3.4 s）。
 *
 * <p>{@code @DirtiesContext(AFTER_CLASS)} 在 M1 **刻意保留**：context 复用属于 M2
 * （会引入 Hikari 指向重建库、{@code @Scheduled} 跨类运行、13 个自声明 dirties 类等语义变化）。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
// PLAN-0612 M4: the PG integration lane exercises the docker workspace backend (jobs/materialize/
// imports). `.env.dev` carries the production default (disabled) and the dotenv loader writes it as
// a system property, which outranks application-test.properties; an inlined test property outranks
// both. The frozen-by-default contract itself is asserted by WorkspaceBackendPolicyTest.
@org.springframework.test.context.TestPropertySource(
        properties = "XIHE_WORKSPACE_DOCKER_BACKEND=disabled")
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
public abstract class AbstractIntegrationTest {

    /**
     * 每类一个克隆库：{@code CREATE DATABASE xihe_t_it_NNN TEMPLATE xihe_cp_tpl}。
     * 上下文创建时调用一次（{@code @DirtiesContext(AFTER_CLASS)} ⇒ 每类恰好一次）。
     */
    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        TestDatabaseProvider.DatabaseRef database = TestDatabaseProvider.migratedDatabase("it");
        registry.add("spring.datasource.url", database::jdbcUrl);
        registry.add("spring.datasource.username", database::username);
        registry.add("spring.datasource.password", database::password);
        registry.add("spring.datasource.driver-class-name", TestDatabaseProvider::driverClassName);
    }

    /** 每个类只打印一次"类 → 库名"映射：失败后可直接进垃圾桶容器查该类的现场。 */
    private static final Set<String> LOGGED_CLASSES = ConcurrentHashMap.newKeySet();

    @LocalServerPort
    protected int port;

    @org.springframework.beans.factory.annotation.Autowired
    void initChatBindingCredentialService(
            com.cc01cc.p.xihe.cp.credentials.CredentialService credentialService) {
        com.cc01cc.p.xihe.cp.chat.ChatBindingTestSupport.setCredentialService(credentialService);
    }

    protected String baseUrl;

    protected RestTemplate restTemplate;

    @BeforeEach
    void initRestTemplate(TestInfo testInfo) {
        String testClass = testInfo.getTestClass().map(Class::getName).orElse("?");
        if (LOGGED_CLASSES.add(testClass)) {
            System.out.println("[test-db] class=" + testClass
                    + " database=" + TestDatabaseProvider.lastDatabaseName());
        }
        baseUrl = "http://localhost:" + port;
        restTemplate = new RestTemplate();
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
}
