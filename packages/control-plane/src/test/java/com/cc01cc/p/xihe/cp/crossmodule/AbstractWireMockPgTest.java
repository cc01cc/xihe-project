package com.cc01cc.p.xihe.cp.crossmodule;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.github.tomakehurst.wiremock.WireMockServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.client.DefaultResponseErrorHandler;
import org.springframework.web.client.RestTemplate;

import java.util.Map;

import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.wireMockConfig;

/**
 * task-202: the PostgreSQL-lane twin of {@link AbstractWireMockTest} — same WireMock server and HTTP
 * helpers, but running against {@link AbstractIntegrationTest}'s migrated PostgreSQL clone instead of
 * the H2 create-drop lane.
 *
 * <p>The split exists because of a measured H2 failure, not taste. {@code org_units} (V163) and
 * {@code org_unit_members} (V164) have no JPA entity, so the H2 lane's {@code ddl-auto=create-drop}
 * cannot build them. The org-unit grant source (PLAN-0773) therefore throws
 * {@code BadSqlGrammarException: Table "org_unit_members" not found} on H2, and
 * {@code RequesterAuthority.actionPermissions} turns that into an empty atom set — so every
 * instance-scope grant gate answers "the caller holds nothing": creating an agent principal fails
 * with {@code Cannot grant atoms the caller does not hold: ...}. {@link AbstractH2Test} already
 * documents the same mechanism for the eight classes task-118/DSD-1502 moved; this base is the
 * WireMock-flavoured lane the crossmodule classes need, since they drive the CP over HTTP with
 * provider stubs.
 *
 * <p>Keep the H2 base for classes whose fixtures live entirely inside JPA tables; a class that
 * creates principals, binds instance/workspace roles or reads org units belongs here.
 */
public abstract class AbstractWireMockPgTest extends AbstractIntegrationTest {

    protected static final WireMockServer wireMock = new WireMockServer(wireMockConfig().dynamicPort());

    static {
        wireMock.start();
    }

    @Autowired
    protected ObjectMapper objectMapper;

    @AfterAll
    static void cleanupWireMock() {
        wireMock.resetAll();
    }

    /**
     * Rebuilds the HTTP client on top of the inherited {@code port}/{@code baseUrl}; subclasses call
     * this from their own {@code @BeforeEach} (the H2 base had the same contract, so tests did not
     * have to change).
     */
    @BeforeEach
    void setUp() {
        baseUrl = "http://localhost:" + port;
        restTemplate = new RestTemplate();
        restTemplate.getInterceptors().add(com.cc01cc.p.xihe.cp.support.Jackson2NodeWireInterceptor.INSTANCE);
        restTemplate.setErrorHandler(new DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(HttpStatusCode statusCode) {
                return statusCode.is5xxServerError();
            }
        });
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
