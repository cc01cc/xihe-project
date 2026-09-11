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
    void getConfig_unknownDomain_returns400() {
        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/nonexistent"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(userToken())), Map.class);

        assertEquals(HttpStatus.BAD_REQUEST, resp.getStatusCode());
        assertEquals("INVALID_DOMAIN", resp.getBody().get("code"));
    }

    @Test
    void putInstanceConfig_rejectsUserRole() {
        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/instance/logging"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("logLevel", "INFO"), authHeaders(userToken())), Map.class);

        assertEquals(HttpStatus.FORBIDDEN, resp.getStatusCode());
    }

    @Test
    void putInstanceConfig_adminRole_succeeds() {
        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/instance/logging"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("logLevel", "WARN"), authHeaders(adminToken())), Map.class);

        assertEquals(HttpStatus.OK, resp.getStatusCode());
    }

    @Test
    void putInstanceConfig_validatesSchema() {
        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/instance/logging"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("logLevel", "INVALID"), authHeaders(adminToken())), Map.class);

        assertEquals(HttpStatus.BAD_REQUEST, resp.getStatusCode());
    }

    @Test
    void putUserConfig_llmProvider_succeeds() {
        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/user/llm-provider"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("defaultModel", "user-model"), authHeaders(userToken())), Map.class);

        assertEquals(HttpStatus.OK, resp.getStatusCode());
    }

    @Test
    void putUserConfig_providerSecret_rejected() {
        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/user/llm-provider"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("openaiApiKey", "sk-user-secret"), authHeaders(userToken())), Map.class);

        assertEquals(HttpStatus.FORBIDDEN, resp.getStatusCode());
        assertEquals("CONFIG_OWNERSHIP_VIOLATION", resp.getBody().get("code"));
    }

    @Test
    void putUserConfig_loggingDomain_rejected() {
        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/user/logging"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("logLevel", "DEBUG"), authHeaders(userToken())), Map.class);

        assertEquals(HttpStatus.FORBIDDEN, resp.getStatusCode());
    }

    @Test
    void agentRuntime_isMaskedForNonAdmin() {
        HttpHeaders adminHeaders = authHeaders(adminToken());
        ResponseEntity<Map> put = restTemplate.exchange(
            url("/api/v1/config/instance/agent-runtime"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("instructions", "baseline prompt"), adminHeaders), Map.class);
        assertEquals(HttpStatus.OK, put.getStatusCode());

        ResponseEntity<Map> userRead = restTemplate.exchange(
            url("/api/v1/config/agent-runtime"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(userToken())), Map.class);
        assertEquals(HttpStatus.OK, userRead.getStatusCode());
        assertEquals("****", userRead.getBody().get("instructions"));

        ResponseEntity<Map> adminRead = restTemplate.exchange(
            url("/api/v1/config/agent-runtime"), HttpMethod.GET,
            new HttpEntity<>(adminHeaders), Map.class);
        assertEquals(HttpStatus.OK, adminRead.getStatusCode());
        assertEquals("baseline prompt", adminRead.getBody().get("instructions"));
    }

    @Test
    void workspaceLayer_resolvesOverUserAndInstance() {
        String token = userToken();
        String workspaceId = jwtTokenProvider.getWorkspaceIdFromToken(token);
        assertNotNull(workspaceId);

        HttpHeaders headers = authHeaders(token);
        headers.set("X-Workspace-Id", workspaceId);
        ResponseEntity<Map> putInstance = restTemplate.exchange(
            url("/api/v1/config/instance/llm-provider"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("defaultModel", "instance-model"), authHeaders(adminToken())), Map.class);
        assertEquals(HttpStatus.OK, putInstance.getStatusCode());

        ResponseEntity<Map> putWorkspace = restTemplate.exchange(
            url("/api/v1/config/workspace/llm-provider"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("defaultModel", "workspace-model"), headers), Map.class);
        assertEquals(HttpStatus.OK, putWorkspace.getStatusCode());

        ResponseEntity<Map> resolved = restTemplate.exchange(
            url("/api/v1/config/llm-provider?workspaceId=" + workspaceId), HttpMethod.GET,
            new HttpEntity<>(authHeaders(token)), Map.class);
        assertEquals(HttpStatus.OK, resolved.getStatusCode());
        assertEquals("workspace-model", resolved.getBody().get("defaultModel"));

        ResponseEntity<Map> layerView = restTemplate.exchange(
            url("/api/v1/config/llm-provider?layer=workspace&workspaceId=" + workspaceId), HttpMethod.GET,
            new HttpEntity<>(authHeaders(token)), Map.class);
        assertEquals(HttpStatus.OK, layerView.getStatusCode());
        assertEquals("workspace-model", layerView.getBody().get("defaultModel"));

        ResponseEntity<Map> instanceView = restTemplate.exchange(
            url("/api/v1/config/llm-provider?layer=instance"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(token)), Map.class);
        assertEquals(HttpStatus.OK, instanceView.getStatusCode());
        assertEquals("instance-model", instanceView.getBody().get("defaultModel"));
    }

    @Test
    void internalEffective_returnsMergedEntries() {
        restTemplate.exchange(
            url("/api/v1/config/instance/logging"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("logLevel", "ERROR"), authHeaders(adminToken())), Map.class);

        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/internal/v1/config/effective/logging"), HttpMethod.GET,
            new HttpEntity<>(internalApiHeaders()), Map.class);

        assertEquals(HttpStatus.OK, resp.getStatusCode());
        assertEquals("logging", resp.getBody().get("domain"));
        assertNotNull(resp.getBody().get("revision"));
        assertNotNull(resp.getBody().get("source"));
        assertTrue(resp.getBody().get("entries") instanceof Map);
    }

    @Test
    void internalEffective_invalidDomain_returns400() {
        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/internal/v1/config/effective/not-a-domain"), HttpMethod.GET,
            new HttpEntity<>(internalApiHeaders()), Map.class);

        assertEquals(HttpStatus.BAD_REQUEST, resp.getStatusCode());
        assertEquals("INVALID_DOMAIN", resp.getBody().get("code"));
    }

    @Test
    void internalEffective_rejectsWrongToken() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth("wrong-token");

        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/internal/v1/config/effective/logging"), HttpMethod.GET,
            new HttpEntity<>(headers), Map.class);

        assertEquals(HttpStatus.UNAUTHORIZED, resp.getStatusCode());
    }

    @Test
    void deprecatedInternalLayerEndpoint_isGone() {
        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/internal/v1/config/system/infrastructure"), HttpMethod.GET,
            new HttpEntity<>(internalApiHeaders()), Map.class);

        assertEquals(HttpStatus.NOT_FOUND, resp.getStatusCode());
    }

    @Test
    void importConfig_instanceOnly() {
        HttpHeaders adminHeaders = authHeaders(adminToken());
        adminHeaders.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<Map> ok = restTemplate.exchange(
            url("/api/v1/config/import?layer=instance"), HttpMethod.POST,
            new HttpEntity<>("{\"logging\":{\"logLevel\":\"ERROR\"}}", adminHeaders), Map.class);
        assertEquals(HttpStatus.OK, ok.getStatusCode());
        assertEquals("ok", ok.getBody().get("status"));
        assertNotNull(ok.getBody().get("warnings"));

        HttpHeaders userHeaders = authHeaders(userToken());
        userHeaders.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<Map> forbidden = restTemplate.exchange(
            url("/api/v1/config/import?layer=instance"), HttpMethod.POST,
            new HttpEntity<>("{\"logging\":{\"logLevel\":\"ERROR\"}}", userHeaders), Map.class);
        assertEquals(HttpStatus.FORBIDDEN, forbidden.getStatusCode());
    }

    @Test
    void exportConfig_adminOnly() {
        ResponseEntity<String> ok = restTemplate.exchange(
            url("/api/v1/config/export?layer=instance"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(adminToken())), String.class);
        assertEquals(HttpStatus.OK, ok.getStatusCode());

        ResponseEntity<Map> forbidden = restTemplate.exchange(
            url("/api/v1/config/export?layer=instance"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(userToken())), Map.class);
        assertEquals(HttpStatus.FORBIDDEN, forbidden.getStatusCode());
    }

    @Test
    void exportConfig_includeSecretsBoundaryAndNoStoreHeader() {
        // PLAN-0307 T2.25: the boundary is explicit and the response must not
        // be cached; ciphertext/key columns are never part of the export.
        ResponseEntity<String> resp = restTemplate.exchange(
            url("/api/v1/config/export?layer=instance&includeSecrets=false"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(adminToken())), String.class);

        assertEquals(HttpStatus.OK, resp.getStatusCode());
        assertEquals("no-store", resp.getHeaders().getCacheControl());
        assertFalse(resp.getBody().contains("credential_ciphertext"));
        assertFalse(resp.getBody().contains("apiKey"));
    }

    @Test
    void getConfig_includeMetaExposesEnvLockMetadata() {
        // PLAN-0307 T2.14: the UI lock contract rides on the resolved endpoint;
        // no env overlay is active in tests, so the map is present but empty.
        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/llm-provider?includeMeta=true"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(adminToken())), Map.class);

        assertEquals(HttpStatus.OK, resp.getStatusCode());
        assertEquals("llm-provider", resp.getBody().get("domain"));
        assertNotNull(resp.getBody().get("entries"));
        assertTrue(((Map<?, ?>) resp.getBody().get("envOverridden")).isEmpty());
    }

    @Test
    void getConfig_layerViewIncludeMetaReportsEnvLockShape() {
        // PLAN-0307 T2.17: the env layer is global, so layer tabs get the same
        // lock metadata surface as the resolved view.
        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/llm-provider?layer=instance&includeMeta=true"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(adminToken())), Map.class);

        assertEquals(HttpStatus.OK, resp.getStatusCode());
        assertEquals("llm-provider", resp.getBody().get("domain"));
        assertNotNull(resp.getBody().get("entries"));
        assertTrue(((Map<?, ?>) resp.getBody().get("envOverridden")).isEmpty());
    }

    @Test
    void stdioServers_putGetAndGenerationConflict() {
        String token = userToken();
        String workspaceId = jwtTokenProvider.getWorkspaceIdFromToken(token);
        HttpHeaders headers = authHeaders(token);
        headers.setContentType(MediaType.APPLICATION_JSON);

        ResponseEntity<Map> initial = restTemplate.exchange(
            url("/api/v1/workspaces/" + workspaceId + "/stdio-servers"), HttpMethod.GET,
            new HttpEntity<>(headers), Map.class);
        assertEquals(HttpStatus.OK, initial.getStatusCode());
        assertEquals(((Number) initial.getBody().get("generation")).longValue(), 0L);
        assertNotNull(initial.getBody().get("hash"));

        Map<String, Object> putBody = Map.of(
            "generation", 0,
            "servers", Map.of("docs", Map.of("command", "npx", "args", List.of("docs-server"))));
        ResponseEntity<Map> put = restTemplate.exchange(
            url("/api/v1/workspaces/" + workspaceId + "/stdio-servers"), HttpMethod.PUT,
            new HttpEntity<>(putBody, headers), Map.class);
        assertEquals(HttpStatus.OK, put.getStatusCode());
        assertTrue(((Number) put.getBody().get("generation")).longValue() > 0L);

        ResponseEntity<Map> after = restTemplate.exchange(
            url("/api/v1/workspaces/" + workspaceId + "/stdio-servers"), HttpMethod.GET,
            new HttpEntity<>(headers), Map.class);
        Map<?, ?> servers = (Map<?, ?>) after.getBody().get("servers");
        assertEquals("npx", ((Map<?, ?>) servers.get("docs")).get("command"));

        ResponseEntity<Map> conflict = restTemplate.exchange(
            url("/api/v1/workspaces/" + workspaceId + "/stdio-servers"), HttpMethod.PUT,
            new HttpEntity<>(putBody, headers), Map.class);
        assertEquals(HttpStatus.CONFLICT, conflict.getStatusCode());
        assertEquals("GENERATION_CONFLICT", conflict.getBody().get("code"));
    }

    @Test
    void stdioServers_internalEndpointReturnsArray() {
        String token = userToken();
        String workspaceId = jwtTokenProvider.getWorkspaceIdFromToken(token);
        HttpHeaders headers = authHeaders(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        Map<String, Object> putBody = Map.of(
            "generation", 0,
            "servers", Map.of("docs", Map.of("command", "npx", "args", List.of("docs-server"))));
        restTemplate.exchange(
            url("/api/v1/workspaces/" + workspaceId + "/stdio-servers"), HttpMethod.PUT,
            new HttpEntity<>(putBody, headers), Map.class);

        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/internal/v1/workspaces/" + workspaceId + "/stdio-servers"), HttpMethod.GET,
            new HttpEntity<>(internalApiHeaders()), Map.class);

        assertEquals(HttpStatus.OK, resp.getStatusCode());
        List<?> servers = (List<?>) resp.getBody().get("servers");
        assertEquals(1, servers.size());
        Map<?, ?> first = (Map<?, ?>) servers.get(0);
        assertEquals("docs", first.get("name"));
        assertEquals("npx", ((Map<?, ?>) first.get("config")).get("command"));
        assertNotNull(resp.getBody().get("hash"));
    }

    @Test
    void mcpConfig_splitsAndMergesStdioAndRemote() {
        String token = userToken();
        String workspaceId = jwtTokenProvider.getWorkspaceIdFromToken(token);
        HttpHeaders headers = authHeaders(token);
        headers.setContentType(MediaType.APPLICATION_JSON);

        Map<String, Object> putBody = Map.of("mcpServers", Map.of(
            "docs", Map.of("command", "npx", "args", List.of("docs-server")),
            "remote1", Map.of("url", "https://example.com/mcp")));
        ResponseEntity<Map> put = restTemplate.exchange(
            url("/api/v1/workspaces/" + workspaceId + "/mcp-config"), HttpMethod.PUT,
            new HttpEntity<>(putBody, headers), Map.class);
        assertEquals(HttpStatus.OK, put.getStatusCode());

        ResponseEntity<Map> get = restTemplate.exchange(
            url("/api/v1/workspaces/" + workspaceId + "/mcp-config"), HttpMethod.GET,
            new HttpEntity<>(headers), Map.class);
        assertEquals(HttpStatus.OK, get.getStatusCode());
        Map<?, ?> servers = (Map<?, ?>) get.getBody().get("mcpServers");
        assertEquals("npx", ((Map<?, ?>) servers.get("docs")).get("command"));
        assertEquals("https://example.com/mcp", ((Map<?, ?>) servers.get("remote1")).get("url"));
    }

    @Test
    void mcpConfig_ambiguousEntry_returns400() {
        String token = userToken();
        String workspaceId = jwtTokenProvider.getWorkspaceIdFromToken(token);
        HttpHeaders headers = authHeaders(token);
        headers.setContentType(MediaType.APPLICATION_JSON);

        Map<String, Object> putBody = Map.of("mcpServers", Map.of(
            "broken", Map.of("command", "npx", "url", "https://example.com/mcp")));
        ResponseEntity<Map> put = restTemplate.exchange(
            url("/api/v1/workspaces/" + workspaceId + "/mcp-config"), HttpMethod.PUT,
            new HttpEntity<>(putBody, headers), Map.class);
        assertEquals(HttpStatus.BAD_REQUEST, put.getStatusCode());
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
