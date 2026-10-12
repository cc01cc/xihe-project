package com.cc01cc.p.xihe.cp.crossmodule;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.containing;
import static com.github.tomakehurst.wiremock.client.WireMock.equalTo;
import static com.github.tomakehurst.wiremock.client.WireMock.matchingJsonPath;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
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
        // RagProxyController hops to the Agent through cp.agent-base-url; without
        // it the proxy would call the default localhost:12632 and 502.
        registry.add("cp.agent-base-url", () -> "http://localhost:" + wireMock.port());
    }

    private String token;

    @BeforeEach
    void setUp() {
        super.setUp();
        token = registerAndLogin();
        seedEmbeddingProfile();
    }

    /**
     * PLAN-0485: the public RAG routes resolve the caller's embedding profile
     * server-side and forward a one-use credential lease, so the forwarding
     * tests need a READY embedding connection plus a user-scope profile.
     */
    private void seedEmbeddingProfile() {
        String fixedModel = "tongyi-embedding-vision-flash-2026-03-06";
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(token);
        Map<String, Object> connection = new java.util.LinkedHashMap<>();
        connection.put("providerId", "dashscope-qwen");
        connection.put("label", "RAG forwarding fixture");
        connection.put("scope", "USER");
        connection.put("apiKey", "isolated-test-only");
        connection.put("modelDiscovery", "manual");
        connection.put("manualModels", java.util.List.of(fixedModel));
        connection.put("apiTypeId", "dashscope-multimodal-embedding");
        connection.put("apiTypeVersion", 1);
        connection.put("connectionKey", "rag-emb");
        ResponseEntity<Map> created = restTemplate.exchange(url("/api/v1/provider-connections"),
                HttpMethod.POST, new HttpEntity<>(connection, headers), Map.class);
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), String.valueOf(created.getBody()));
        ResponseEntity<Map> verified = restTemplate.exchange(
                url("/api/v1/provider-connections/" + created.getBody().get("id") + "/verify"),
                HttpMethod.POST, new HttpEntity<>(null, headers), Map.class);
        assertEquals(HttpStatus.OK, verified.getStatusCode(), String.valueOf(verified.getBody()));
        assertEquals("READY", ((Map<?, ?>) verified.getBody().get("connection")).get("status"),
                String.valueOf(verified.getBody()));
        Map<String, Object> profile = Map.of("profile",
                "{\"providerId\":\"dashscope-qwen\",\"connectionKey\":\"rag-emb\",\"model\":\"" + fixedModel + "\"}");
        ResponseEntity<String> written = restTemplate.exchange(url("/api/v1/config/user/embedding"),
                HttpMethod.PUT, new HttpEntity<>(profile, headers), String.class);
        assertEquals(HttpStatus.OK, written.getStatusCode(), written.getBody());
    }

    @Test
    void ragStatsForwardsToAgent() throws Exception {
        wireMock.stubFor(post(urlEqualTo("/internal/v1/agent/rag/stats"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"totalDocuments\":5,\"documents\":[]}")));

        ResponseEntity<String> response = restTemplate.exchange(
                url("/api/v1/rag/stats"),
                HttpMethod.GET,
                entityWithAuth(null, token),
                String.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        Map<?, ?> body = objectMapper.readValue(response.getBody(), Map.class);
        assertEquals(5, ((Number) body.get("totalDocuments")).intValue());

        wireMock.verify(postRequestedFor(urlEqualTo("/internal/v1/agent/rag/stats"))
                .withHeader("Authorization", containing("Bearer dev-token-not-secure"))
                .withRequestBody(containing("embeddingProfile")));
    }

    @Test
    void ragStatsHandlesAgentError() {
        wireMock.stubFor(post(urlEqualTo("/internal/v1/agent/rag/stats"))
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
                .withHeader("Authorization", containing("Bearer dev-token-not-secure"))
                .withRequestBody(containing("embeddingProfile"))
                .withRequestBody(containing("embeddingCredentialLease")));
    }

    @Test
    void ragSearchForwardsJsonBody() {
        wireMock.stubFor(post(urlEqualTo("/internal/v1/agent/rag/search"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"results\":[]}")));

        ResponseEntity<String> response = restTemplate.exchange(
                url("/api/v1/rag/search"),
                HttpMethod.POST,
                entityWithAuth(Map.of("query", "hello", "topK", 3, "minScore", 0.5), token),
                String.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("{\"results\":[]}", response.getBody());

        wireMock.verify(postRequestedFor(urlEqualTo("/internal/v1/agent/rag/search"))
                .withHeader("Authorization", containing("Bearer dev-token-not-secure"))
                .withRequestBody(matchingJsonPath("$.query", equalTo("hello")))
                .withRequestBody(matchingJsonPath("$.topK", equalTo("3")))
                .withRequestBody(matchingJsonPath("$.minScore", equalTo("0.5")))
                .withRequestBody(matchingJsonPath("$.embeddingProfile.providerId", equalTo("dashscope-qwen")))
                .withRequestBody(matchingJsonPath("$.embeddingCredentialLease")));
    }

    @Test
    void ragDeleteForwardsDocIdToPartitionScopedRoute() {
        String docId = "doc-" + UUID.randomUUID().toString().substring(0, 8);

        wireMock.stubFor(post(urlEqualTo("/internal/v1/agent/rag/documents/" + docId + "/delete"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"deleted\":true}")));

        ResponseEntity<String> response = restTemplate.exchange(
                url("/api/v1/rag/documents/" + docId),
                HttpMethod.DELETE,
                entityWithAuth(null, token),
                String.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("{\"deleted\":true}", response.getBody());

        wireMock.verify(postRequestedFor(urlEqualTo("/internal/v1/agent/rag/documents/" + docId + "/delete"))
                .withHeader("Authorization", containing("Bearer dev-token-not-secure"))
                .withRequestBody(containing("embeddingProfile")));

        // Unknown docId is a partition-scoped 404 by design (spec §RAG Route):
        // the Agent answers 404 and CP maps the stable problem code through.
        String unknownId = "doc-unknown-" + UUID.randomUUID().toString().substring(0, 8);
        wireMock.stubFor(post(urlEqualTo("/internal/v1/agent/rag/documents/" + unknownId + "/delete"))
                .willReturn(aResponse()
                        .withStatus(404)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"code\":\"RAG_DOCUMENT_NOT_FOUND\"}")));
        ResponseEntity<String> missing = restTemplate.exchange(
                url("/api/v1/rag/documents/" + unknownId),
                HttpMethod.DELETE,
                entityWithAuth(null, token),
                String.class);
        assertEquals(HttpStatus.NOT_FOUND, missing.getStatusCode());
        assertTrue(missing.getBody().contains("RAG_DOCUMENT_NOT_FOUND"), missing.getBody());
        wireMock.verify(postRequestedFor(
                urlEqualTo("/internal/v1/agent/rag/documents/" + unknownId + "/delete")));
    }

    @Test
    void ragHandlesAuthRequired() {
        ResponseEntity<String> response = restTemplate.postForEntity(
                url("/api/v1/rag/search?query=test"), null, String.class);

        assertEquals(HttpStatus.UNAUTHORIZED, response.getStatusCode());
    }
}
