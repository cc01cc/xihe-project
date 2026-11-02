package com.cc01cc.p.xihe.cp.crossmodule;

import com.cc01cc.p.xihe.cp.support.Jackson2NodeWireInterceptor;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.github.tomakehurst.wiremock.WireMockServer;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.web.client.DefaultResponseErrorHandler;
import org.springframework.web.client.RestTemplate;

import java.util.Map;

import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.wireMockConfig;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("h2")
// PLAN-0612 M4: `.env.dev` carries XIHE_WORKSPACE_DOCKER_BACKEND=disabled and the dotenv loader
// exports it as a system property; the H2 lane still needs docker-backed workspaces to exercise
// materialize/import/jobs, so an inlined test property overrides it (the frozen-by-default contract
// is asserted by WorkspaceBackendPolicyTest).
@org.springframework.test.context.TestPropertySource(
        properties = "XIHE_WORKSPACE_DOCKER_BACKEND=disabled")
// L2 Phase 3 (2026-11-03): the AFTER_CLASS @DirtiesContext that used to sit here is gone.
// It never isolated the database - it only threw away the Spring beans, while the schema, the
// Flyway template DB and every row stayed shared. What actually isolates these classes is per-class
// fixture setup with random ids plus the @AfterEach teardown; the WireMock stubs are reset per class
// by each subclass's @BeforeEach. Keeping it cost one full context startup (~1.5 s) per class for
// every subclass. If a subclass turns out to need a fresh context, add the annotation back ON THAT
// CLASS with a written reason - not on the base.
public abstract class AbstractWireMockTest {

    protected static final WireMockServer wireMock = new WireMockServer(wireMockConfig().dynamicPort());

    static {
        wireMock.start();
    }

    @LocalServerPort
    private int cpPort;

    @Autowired
    void initChatBindingCredentialService(
            com.cc01cc.p.xihe.cp.credentials.CredentialService credentialService) {
        com.cc01cc.p.xihe.cp.chat.ChatBindingTestSupport.setCredentialService(credentialService);
    }

    @Autowired
    protected ObjectMapper objectMapper;

    protected RestTemplate restTemplate;
    protected String baseUrl;

    @AfterAll
    static void cleanupWireMock() {
        wireMock.resetAll();
    }

    @BeforeEach
    void setUp() {
        baseUrl = "http://localhost:" + cpPort;
        restTemplate = new RestTemplate();
        restTemplate.getInterceptors().add(Jackson2NodeWireInterceptor.INSTANCE);
        restTemplate.setErrorHandler(new DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(HttpStatusCode statusCode) {
                return statusCode.is5xxServerError();
            }
        });
    }

    protected String url(String path) {
        return baseUrl + path;
    }

    protected HttpEntity<?> entityWithAuth(Object body, String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(token);
        return new HttpEntity<>(body, headers);
    }

    protected String registerAndLogin() {
        String email = "test-" + System.currentTimeMillis() + "@test.com";
        String password = TestDataFactory.PASSWORD;
        ResponseEntity<Map> reg = restTemplate.postForEntity(
                url("/api/v1/auth/register"),
                Map.of("email", email, "password", password, "name", "Test"),
                Map.class);
        Map regBody = reg.getBody();
        if (regBody != null && regBody.containsKey("accessToken")) {
            return (String) regBody.get("accessToken");
        }
        ResponseEntity<Map> login = restTemplate.postForEntity(
                url("/api/v1/auth/login"),
                Map.of("identifier", email, "password", password),
                Map.class);
        Map loginBody = login.getBody();
        return loginBody != null ? (String) loginBody.get("accessToken") : null;
    }
}
