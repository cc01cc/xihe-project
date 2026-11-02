package com.cc01cc.p.xihe.cp;

import com.cc01cc.p.xihe.cp.support.Jackson2NodeWireInterceptor;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpStatus;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.web.client.DefaultResponseErrorHandler;
import org.springframework.web.client.RestTemplate;

import java.io.IOException;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("h2")
// PLAN-0612 M4: see AbstractWireMockTest — `.env.dev` sets the frozen default as a system property,
// while the H2 lane needs the docker workspace backend available for its workspace fixtures.
@org.springframework.test.context.TestPropertySource(
        properties = "XIHE_WORKSPACE_DOCKER_BACKEND=disabled")
// L2 Phase 3 (2026-11-03): the AFTER_CLASS @DirtiesContext STAYS HERE — this line was temporarily
// removed, measured, and deliberately put back. Do not remove it again without reading
// `.local/xh-d28/l2-phase3-report.md` §10 first. Short version, measured on the full lane:
//   * removing it made the 24-class H2 batch look great (creations 24 -> 10, -18 s) — and that batch
//     PASSED because the classes that still close their own context happened to run last;
//   * on the full shard (233 suites) it produced 50 errors (`Table "users" not found (this database is
//     empty)`) because `application-h2.properties` uses a FIXED in-memory database name: any class that
//     closes the shared context runs `ddl-auto=create-drop` and drops the tables for everyone else;
//   * giving each context its own database (`mem:testdb-${random.uuid}`) did fix that (0 "database
//     empty", URL per context) but exposed the next layer: classes whose @BeforeEach inserts FIXED ids
//     now collide on unique constraints in the shared schema (9 errors in 2 classes, and the "next one"
//     is not predictable).
// ⇒ prerequisites before anyone tries again: (1) audit the WHOLE lane for fixed-id fixtures and make
// them random; (2) make the H2 database name per-context; (3) only then drop this annotation. Payoff is
// ~18 s; that trade was judged not worth it in PLAN L2 Phase 3.
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
public abstract class AbstractH2Test {

    @LocalServerPort
    protected int port;

    @org.springframework.beans.factory.annotation.Autowired
    void initChatBindingCredentialService(
            com.cc01cc.p.xihe.cp.credentials.CredentialService credentialService) {
        com.cc01cc.p.xihe.cp.chat.ChatBindingTestSupport.setCredentialService(credentialService);
    }

    protected RestTemplate restTemplate;
    public String baseUrl;

    @BeforeEach
    void setUp() {
        this.baseUrl = "http://localhost:" + port;
        this.restTemplate = new RestTemplate();
        restTemplate.getInterceptors().add(Jackson2NodeWireInterceptor.INSTANCE);
        // 不抛出 4xx 错误，让测试断言自行处理
        this.restTemplate.setErrorHandler(new DefaultResponseErrorHandler() {
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
