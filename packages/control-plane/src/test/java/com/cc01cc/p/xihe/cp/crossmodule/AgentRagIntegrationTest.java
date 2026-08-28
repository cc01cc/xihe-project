package com.cc01cc.p.xihe.cp.crossmodule;

import static com.github.tomakehurst.wiremock.client.WireMock.*;
import static org.junit.jupiter.api.Assertions.*;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.*;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.web.client.HttpServerErrorException;

import java.util.Map;
import java.util.UUID;

class AgentRagIntegrationTest extends AbstractWireMockTest {

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        registry.add("cp.agent-url", () -> "http://localhost:" + wireMock.port());
    }

    private String token;

    @BeforeEach
    void setUp() {
        super.setUp();
        token = registerAndLogin();
    }

    @Test
    void ragStatsForwardsToAgent() {
        wireMock.stubFor(get(urlEqualTo("/internal/v1/agent/rag/stats"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"documents\":5}")));

        ResponseEntity<String> response = restTemplate.exchange(
                url("/api/v1/rag/stats"),
                HttpMethod.GET,
                entityWithAuth(null, token),
                String.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("{\"documents\":5}", response.getBody());

        wireMock.verify(getRequestedFor(urlEqualTo("/internal/v1/agent/rag/stats"))
                .withHeader("Authorization", containing("Bearer dev-token-not-secure")));
    }

    @Test
    void ragStatsHandlesAgentError() {
        wireMock.stubFor(get(urlEqualTo("/internal/v1/agent/rag/stats"))
                .willReturn(aResponse().withStatus(500)));

        HttpServerErrorException ex = assertThrows(HttpServerErrorException.class, () ->
                restTemplate.exchange(url("/api/v1/rag/stats"), HttpMethod.GET,
                        entityWithAuth(null, token), String.class));

        assertEquals(HttpStatus.BAD_GATEWAY, ex.getStatusCode());
    }

    @Test
    void ragIngestForwardsToAgent() {
        wireMock.stubFor(post(urlEqualTo("/internal/v1/agent/rag/ingest"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"chunks\":[\"chunk1\"]}")));

        LinkedMultiValueMap<String, Object> parts = new LinkedMultiValueMap<>();
        parts.add("file", new ByteArrayResource("test content".getBytes()) {
            @Override
            public String getFilename() {
                return "test.txt";
            }
        });
        parts.add("chunkSize", "1000");
        parts.add("chunkOverlap", "200");

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.MULTIPART_FORM_DATA);
        headers.setBearerAuth(token);

        HttpEntity<LinkedMultiValueMap<String, Object>> entity = new HttpEntity<>(parts, headers);

        ResponseEntity<String> response = restTemplate.exchange(
                url("/api/v1/rag/ingest"), HttpMethod.POST, entity, String.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("{\"chunks\":[\"chunk1\"]}", response.getBody());

        wireMock.verify(postRequestedFor(urlEqualTo("/internal/v1/agent/rag/ingest"))
                .withHeader("Authorization", containing("Bearer dev-token-not-secure")));
    }

    @Test
    void ragSearchForwardsQueryParams() {
        wireMock.stubFor(post(urlEqualTo("/internal/v1/agent/rag/search"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"results\":[]}")));

        ResponseEntity<String> response = restTemplate.exchange(
                url("/api/v1/rag/search?query=hello&topK=3&minScore=0.5"),
                HttpMethod.POST,
                entityWithAuth(null, token),
                String.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());

        wireMock.verify(postRequestedFor(urlEqualTo("/internal/v1/agent/rag/search"))
                .withHeader("Authorization", containing("Bearer dev-token-not-secure")));
    }

    @Test
    void ragDeleteForwardsDocId() {
        String docId = "doc-" + UUID.randomUUID().toString().substring(0, 8);

        wireMock.stubFor(delete(urlPathMatching("/internal/v1/agent/rag/documents/.*"))
                .willReturn(aResponse().withStatus(200)));

        ResponseEntity<String> response = restTemplate.exchange(
                url("/api/v1/rag/documents/" + docId),
                HttpMethod.DELETE,
                entityWithAuth(null, token),
                String.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());

        wireMock.verify(deleteRequestedFor(urlEqualTo("/internal/v1/agent/rag/documents/" + docId))
                .withHeader("Authorization", containing("Bearer dev-token-not-secure")));
    }

    @Test
    void ragHandlesAuthRequired() {
        ResponseEntity<String> response = restTemplate.postForEntity(
                url("/api/v1/rag/search?query=test"), null, String.class);

        assertEquals(HttpStatus.UNAUTHORIZED, response.getStatusCode());
    }
}
