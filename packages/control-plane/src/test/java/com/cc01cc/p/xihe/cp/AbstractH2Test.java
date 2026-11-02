package com.cc01cc.p.xihe.cp;

import com.cc01cc.p.xihe.cp.support.Jackson2NodeWireInterceptor;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpStatus;
import org.springframework.http.client.ClientHttpResponse;
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
// L2 Phase 3 (2026-11-03): the AFTER_CLASS @DirtiesContext that used to sit here is gone.
// It never isolated anything the H2 lane relies on — the H2 database is created and dropped with the
// Spring context, and every fixture in these classes uses fresh random ids plus @AfterEach cleanup, so
// the only thing the annotation bought was one full context startup per class (24 classes).
// Level-2 A/B proof: single JVM, the same 24 classes, `DefaultContextCache missCount` 24 -> 1 with an
// unchanged failure set. If a subclass turns out to need a fresh context, add the annotation to THAT
// CLASS with a written reason — never back on the base.
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
