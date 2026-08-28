package com.cc01cc.p.xihe.cp.crossmodule;

import static com.github.tomakehurst.wiremock.client.WireMock.*;
import static org.junit.jupiter.api.Assertions.*;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.*;
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

        assertEquals(HttpStatus.BAD_GATEWAY, ex.getStatusCode());
    }

    @Test
    void modelListWithoutAuthReturns401() {
        ResponseEntity<String> response = restTemplate.exchange(
                url("/api/v1/models"), HttpMethod.GET, null, String.class);

        assertEquals(HttpStatus.UNAUTHORIZED, response.getStatusCode());
    }
}
