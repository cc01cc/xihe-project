package com.cc01cc.p.xihe.cp.crossmodule;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.github.tomakehurst.wiremock.WireMockServer;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.*;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.web.client.DefaultResponseErrorHandler;
import org.springframework.web.client.RestTemplate;

import java.util.Map;

import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.wireMockConfig;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("h2")
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
public abstract class AbstractWireMockTest {

    protected static final WireMockServer wireMock = new WireMockServer(wireMockConfig().dynamicPort());

    static {
        wireMock.start();
    }

    @LocalServerPort
    private int cpPort;

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
                Map.of("email", email, "password", password),
                Map.class);
        Map loginBody = login.getBody();
        return loginBody != null ? (String) loginBody.get("accessToken") : null;
    }
}
