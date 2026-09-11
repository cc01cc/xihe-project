package com.cc01cc.p.xihe.cp.config;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.*;
import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;

import java.util.Map;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class ConfigControllerTest extends AbstractH2Test {

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    @Test
    void getConfig_returnsMergedConfig() {
        HttpHeaders headers = authHeaders(userToken());

        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/logging"), HttpMethod.GET,
            new HttpEntity<>(headers), Map.class);

        assertEquals(HttpStatus.OK, resp.getStatusCode());
    }

    @Test
    void getConfig_rejectsNoAuth() {
        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/logging"), HttpMethod.GET,
            HttpEntity.EMPTY, Map.class);

        assertEquals(HttpStatus.UNAUTHORIZED, resp.getStatusCode());
    }

    @Test
    void putAdminConfig_rejectsUserRole() {
        HttpHeaders headers = authHeaders(userToken());

        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/admin/logging"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("logLevel", "INFO"), headers), Map.class);

        assertEquals(HttpStatus.FORBIDDEN, resp.getStatusCode());
    }

    @Test
    void putAdminConfig_adminRole_succeeds() {
        HttpHeaders headers = authHeaders(adminToken());

        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/admin/logging"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("logLevel", "WARN"), headers), Map.class);

        assertEquals(HttpStatus.OK, resp.getStatusCode());
    }

    @Test
    void putAdminConfig_validatesSchema() {
        HttpHeaders headers = authHeaders(adminToken());

        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/admin/logging"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("logLevel", "INVALID"), headers), Map.class);

        assertEquals(HttpStatus.BAD_REQUEST, resp.getStatusCode());
    }

    @Test
    void putUserConfig_llmProvider_succeeds() {
        HttpHeaders headers = authHeaders(userToken());

        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/user/llm-provider"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("imageProvider", "deepseek"), headers), Map.class);

        assertEquals(HttpStatus.OK, resp.getStatusCode());
    }

    @Test
    void putUserConfig_llmProviderApiKey_rejectsOwnershipViolation() {
        HttpHeaders headers = authHeaders(userToken());

        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/user/llm-provider"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("openaiApiKey", "sk-user-secret"), headers), Map.class);

        assertEquals(HttpStatus.FORBIDDEN, resp.getStatusCode());
        assertEquals("CONFIG_OWNERSHIP_VIOLATION", resp.getBody().get("code"));
    }

    @Test
    void putUserConfig_embedding_succeeds() {
        HttpHeaders headers = authHeaders(userToken());

        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/user/embedding"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("model", "text-embedding-3-small", "dimensions", "1536"), headers), Map.class);

        assertEquals(HttpStatus.OK, resp.getStatusCode());
    }

    @Test
    void putUserConfig_rag_succeeds() {
        HttpHeaders headers = authHeaders(userToken());

        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/user/rag"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("chunkSize", "512"), headers), Map.class);

        assertEquals(HttpStatus.OK, resp.getStatusCode());
    }

    @Test
    void putUserConfig_logging_succeeds() {
        HttpHeaders headers = authHeaders(userToken());

        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/user/logging"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("logLevel", "DEBUG"), headers), Map.class);

        assertEquals(HttpStatus.OK, resp.getStatusCode());
    }

    @Test
    void putUserConfig_workspaceConfig_succeeds() {
        HttpHeaders headers = authHeaders(userToken());

        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/user/workspace-config"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("profile", "default"), headers), Map.class);

        assertEquals(HttpStatus.OK, resp.getStatusCode());
    }

    @Test
    void putUserConfig_infrastructure_rejected() {
        HttpHeaders headers = authHeaders(userToken());

        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/user/infrastructure"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("dbUrl", "jdbc:h2:mem:test"), headers), Map.class);

        assertEquals(HttpStatus.FORBIDDEN, resp.getStatusCode());
    }

    @Test
    void importConfig_adminOnly_succeeds() {
        HttpHeaders headers = authHeaders(adminToken());
        headers.setContentType(MediaType.APPLICATION_JSON);

        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/import"), HttpMethod.POST,
            new HttpEntity<>("{\"logging\":{\"logLevel\":\"ERROR\"}}", headers), Map.class);

        assertEquals(HttpStatus.OK, resp.getStatusCode());
    }

    @Test
    void importConfig_rejectsUserRole() {
        HttpHeaders headers = authHeaders(userToken());
        headers.setContentType(MediaType.APPLICATION_JSON);

        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/import"), HttpMethod.POST,
            new HttpEntity<>("{\"logging\":{\"logLevel\":\"ERROR\"}}", headers), Map.class);

        assertEquals(HttpStatus.FORBIDDEN, resp.getStatusCode());
    }

    @Test
    void getConfig_masksApiKeysForUser() {
        HttpHeaders adminHeaders = authHeaders(adminToken());
        restTemplate.exchange(url("/api/v1/config/admin/llm-provider"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("openaiApiKey", "sk-abcdefghijklmnopqrst"), adminHeaders), Map.class);

        HttpHeaders userHeaders = authHeaders(userToken());
        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/llm-provider"), HttpMethod.GET,
            new HttpEntity<>(userHeaders), Map.class);

        assertEquals(HttpStatus.OK, resp.getStatusCode());
        Map body = resp.getBody();
        assertNotNull(body);
        String masked = (String) body.get("openaiApiKey");
        assertNotNull(masked);
        assertFalse(masked.contains("abcdefghijklmnopqrst"), "API key should be masked for non-admin");
        assertTrue(masked.contains("****"), "masked value should contain ****");
    }

    @Test
    void getConfig_returnsFullKeysForAdmin() {
        HttpHeaders adminHeaders = authHeaders(adminToken());
        restTemplate.exchange(url("/api/v1/config/admin/llm-provider"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("openaiApiKey", "sk-abcdefghijklmnopqrst"), adminHeaders), Map.class);

        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/llm-provider"), HttpMethod.GET,
            new HttpEntity<>(adminHeaders), Map.class);

        assertEquals(HttpStatus.OK, resp.getStatusCode());
        Map body = resp.getBody();
        assertNotNull(body);
        assertEquals("sk-abcdefghijklmnopqrst", body.get("openaiApiKey"));
    }

    @Test
    void exportConfig_adminOnly_succeeds() {
        HttpHeaders headers = authHeaders(adminToken());

        ResponseEntity<String> resp = restTemplate.exchange(
            url("/api/v1/config/export?layer=admin"), HttpMethod.GET,
            new HttpEntity<>(headers), String.class);

        assertEquals(HttpStatus.OK, resp.getStatusCode());
    }

    @Test
    void internalConfig_withApiToken_succeeds() {
        HttpHeaders headers = internalApiHeaders();

        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/internal/v1/config/system/infrastructure"), HttpMethod.GET,
            new HttpEntity<>(headers), Map.class);

        assertEquals(HttpStatus.OK, resp.getStatusCode());
    }

    @Test
    void internalConfig_wrongToken_rejected() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth("wrong-token");

        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/internal/v1/config/system/infrastructure"), HttpMethod.GET,
            new HttpEntity<>(headers), Map.class);

        assertEquals(HttpStatus.UNAUTHORIZED, resp.getStatusCode());
    }

    @Test
    void internalConfig_noToken_rejected() {
        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/internal/v1/config/system/infrastructure"), HttpMethod.GET,
            HttpEntity.EMPTY, Map.class);

        assertEquals(HttpStatus.UNAUTHORIZED, resp.getStatusCode());
    }

    @Test
    void internalConfig_invalidLayer_returns400() {
        HttpHeaders headers = internalApiHeaders();

        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/internal/v1/config/badlayer/logging"), HttpMethod.GET,
            new HttpEntity<>(headers), Map.class);

        assertEquals(HttpStatus.BAD_REQUEST, resp.getStatusCode());
    }

    @Test
    void mcpConfig_usesObjectEnvelopeForUserAndInternalRuntime() {
        String token = userToken();
        String workspaceId = jwtTokenProvider.getWorkspaceIdFromToken(token);
        Map<String, Object> servers = Map.of(
                "docs", Map.of("command", "npx", "args", List.of("docs-server")));
        HttpHeaders userHeaders = authHeaders(token);
        userHeaders.setContentType(MediaType.APPLICATION_JSON);

        ResponseEntity<Map> put = restTemplate.exchange(
                url("/api/v1/workspaces/" + workspaceId + "/mcp-config"), HttpMethod.PUT,
                new HttpEntity<>(Map.of("mcpServers", servers), userHeaders), Map.class);

        assertEquals(HttpStatus.OK, put.getStatusCode());

        ResponseEntity<Map> userGet = restTemplate.exchange(
                url("/api/v1/workspaces/" + workspaceId + "/mcp-config"), HttpMethod.GET,
                new HttpEntity<>(authHeaders(token)), Map.class);
        assertEquals(HttpStatus.OK, userGet.getStatusCode());
        assertTrue(userGet.getBody().get("mcpServers") instanceof Map);

        ResponseEntity<Map> internalGet = restTemplate.exchange(
                url("/internal/v1/config/workspaces/" + workspaceId + "/mcp-config"), HttpMethod.GET,
                new HttpEntity<>(internalApiHeaders()), Map.class);
        assertEquals(HttpStatus.OK, internalGet.getStatusCode());
        Object internalServers = internalGet.getBody().get("mcpServers");
        assertTrue(internalServers instanceof Map);
        assertEquals("npx", ((Map<?, ?>) ((Map<?, ?>) internalServers).get("docs")).get("command"));
    }

    private HttpHeaders authHeaders(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return headers;
    }

    private HttpHeaders internalApiHeaders() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth("dev-token-not-secure");
        return headers;
    }

    private String userToken() {
        String password = TestDataFactory.PASSWORD;
        ResponseEntity<Map> reg = restTemplate.postForEntity(
            url("/api/v1/auth/register"),
            Map.of("email", "config-user-" + System.nanoTime() + "@test.com",
                "password", password, "name", "TestUser"),
            Map.class);
        assertEquals(HttpStatus.CREATED, reg.getStatusCode());
        String token = (String) reg.getBody().get("accessToken");
        assertNotNull(token);
        return token;
    }

    private String adminToken() {
        String password = DataSeeder.seededAdminPassword();
        ResponseEntity<Map> login = restTemplate.postForEntity(
            url("/api/v1/auth/login"),
            Map.of("email", "admin@xihe.local", "password", password),
            Map.class);
        assertEquals(HttpStatus.OK, login.getStatusCode());
        String token = (String) login.getBody().get("accessToken");
        assertNotNull(token);
        return token;
    }
}
