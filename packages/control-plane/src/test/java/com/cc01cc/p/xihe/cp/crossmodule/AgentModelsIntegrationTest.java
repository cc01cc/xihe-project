package com.cc01cc.p.xihe.cp.crossmodule;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.containing;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.getRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.client.HttpServerErrorException;

import java.util.Map;

class AgentModelsIntegrationTest extends AbstractWireMockTest {

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        registry.add("cp.agent-base-url", () -> "http://localhost:" + wireMock.port());
    }

    private String token;

    @BeforeEach
    void setUp() {
        super.setUp();
        token = registerAndLogin();
    }

    @Test
    void modelListForwardsToAgentAndReturnsModels() {
        wireMock.stubFor(get(urlEqualTo("/internal/v1/agent/models"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("""
                                {"data":[{"id":"deepseek-chat","object":"model"}]}
                                """)));

        ResponseEntity<Map> response = restTemplate.exchange(
                url("/api/v1/models"),
                HttpMethod.GET,
                entityWithAuth(null, token),
                Map.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertNotNull(response.getBody());

        wireMock.verify(getRequestedFor(urlEqualTo("/internal/v1/agent/models"))
                .withHeader("Authorization", containing("Bearer dev-token-not-secure")));
    }

    @Test
    void modelListHandlesAgentError() {
        wireMock.stubFor(get(urlEqualTo("/internal/v1/agent/models"))
                .willReturn(aResponse().withStatus(500)));

        HttpServerErrorException ex = assertThrows(HttpServerErrorException.class, () ->
                restTemplate.exchange(url("/api/v1/models"), HttpMethod.GET,
                        entityWithAuth(null, token), String.class));

        // PLAN-0557/BL-109: dependency failures are 503 with a stable code and diagnostics.
        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, ex.getStatusCode());
        assertTrue(ex.getResponseBodyAsString().contains("\"code\":\"AGENT_UNAVAILABLE\""));
        assertTrue(ex.getResponseBodyAsString().contains("\"dependency\":\"agent\""));
        assertTrue(ex.getResponseBodyAsString().contains("\"reason\":\"upstream_error\""));
        assertTrue(ex.getResponseBodyAsString().contains("\"retryable\":true"));
    }

    @Test
    void modelListAgentAuthFailureIsNotRetryable() {
        wireMock.stubFor(get(urlEqualTo("/internal/v1/agent/models"))
                .willReturn(aResponse().withStatus(401)));

        HttpServerErrorException ex = assertThrows(HttpServerErrorException.class, () ->
                restTemplate.exchange(url("/api/v1/models"), HttpMethod.GET,
                        entityWithAuth(null, token), String.class));

        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, ex.getStatusCode());
        assertTrue(ex.getResponseBodyAsString().contains("\"reason\":\"auth_failed\""));
        assertTrue(ex.getResponseBodyAsString().contains("\"retryable\":false"));
    }

    @Test
    void modelListWithoutAuthReturns401() {
        ResponseEntity<String> response = restTemplate.exchange(
                url("/api/v1/models"), HttpMethod.GET, null, String.class);

        assertEquals(HttpStatus.UNAUTHORIZED, response.getStatusCode());
    }
}
