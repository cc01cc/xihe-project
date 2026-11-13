package com.cc01cc.p.xihe.cp.config;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ConfigControllerTest extends AbstractH2Test {

    @org.springframework.beans.factory.annotation.Autowired
    private com.cc01cc.p.xihe.cp.integration.WorkspaceFixture workspaceFixture;

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    @Autowired
    private ConfigService configService;

    @Autowired
    private WorkspaceService workspaceService;

    private String workspaceIdFor(String token) {
        String userId = jwtTokenProvider.getUserIdFromToken(token);
        // PLAN-0614: register no longer creates a workspace; the fixture creates the caller's own.
        return workspaceFixture.createOwnedWorkspace("Config fixture workspace", userId).getId().toString();
    }

    @Test
    void getConfig_returnsMergedConfig() {
        HttpHeaders headers = authHeaders(userToken());

        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/rag"), HttpMethod.GET,
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
            new HttpEntity<>(Map.of("imageProvider", "deepseek"), authHeaders(userToken())), Map.class);

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

        // MEASURED (task-229): this expectation said 403 since 2026-09-11; the D-928 guard
        // (`b2c568b79`, 2026-11-11, task-196: "gate non-writable domains BEFORE the template
        // dispatch") made a non-writable domain answer 400 DOMAIN_NOT_WORKSPACE_WRITABLE at every
        // layer. That commit did not touch this test, so the 403 was a pre-existing red unrelated
        // to this card. The assertion now also pins WHICH answer it is: a status-only check would
        // let a future guard silently change the verdict while staying "green".
        assertEquals(HttpStatus.BAD_REQUEST, resp.getStatusCode(), String.valueOf(resp.getBody()));
        assertEquals("DOMAIN_NOT_WORKSPACE_WRITABLE", resp.getBody().get("code"));
    }

    @Test
    void agentRuntime_isMaskedForNonAdmin() {
        HttpHeaders adminHeaders = authHeaders(adminToken());
        ResponseEntity<Map> put = restTemplate.exchange(
            url("/api/v1/config/instance/agent-runtime"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("runMaxTurns", "25", "instructions", "baseline prompt"), adminHeaders), Map.class);
        assertEquals(HttpStatus.OK, put.getStatusCode());

        ResponseEntity<Map> userRead = restTemplate.exchange(
            url("/api/v1/config/agent-runtime"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(userToken())), Map.class);
        assertEquals(HttpStatus.OK, userRead.getStatusCode());
        assertEquals("****", userRead.getBody().get("runMaxTurns"));
        assertFalse(userRead.getBody().containsKey("instructions"));

        ResponseEntity<Map> adminRead = restTemplate.exchange(
            url("/api/v1/config/agent-runtime"), HttpMethod.GET,
            new HttpEntity<>(adminHeaders), Map.class);
        assertEquals(HttpStatus.OK, adminRead.getStatusCode());
        assertEquals("baseline prompt", adminRead.getBody().get("instructions"));
    }

    @Test
    void workspaceLayer_resolvesOverUserAndInstance() {
        // T2.4: llm-provider left the workspace layer with the model 4 domains; the
        // resolution chain now runs on a behavior domain (job-policy).
        String token = userToken();
        String workspaceId = workspaceIdFor(token);
        assertNotNull(workspaceId);

        HttpHeaders headers = authHeaders(token);
        headers.set("X-Workspace-Id", workspaceId);
        ResponseEntity<Map> putInstance = restTemplate.exchange(
            url("/api/v1/config/instance/job-policy"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("defaultTimeoutSecs", "40"), authHeaders(adminToken())), Map.class);
        assertEquals(HttpStatus.OK, putInstance.getStatusCode());

        ResponseEntity<Map> putWorkspace = restTemplate.exchange(
            url("/api/v1/config/workspace/job-policy"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("defaultTimeoutSecs", "90"), headers), Map.class);
        assertEquals(HttpStatus.OK, putWorkspace.getStatusCode());

        ResponseEntity<Map> resolved = restTemplate.exchange(
            url("/api/v1/config/job-policy?workspaceId=" + workspaceId), HttpMethod.GET,
            new HttpEntity<>(authHeaders(token)), Map.class);
        assertEquals(HttpStatus.OK, resolved.getStatusCode());
        assertEquals("90", resolved.getBody().get("defaultTimeoutSecs"));

        ResponseEntity<Map> layerView = restTemplate.exchange(
            url("/api/v1/config/job-policy?layer=workspace&workspaceId=" + workspaceId), HttpMethod.GET,
            new HttpEntity<>(authHeaders(token)), Map.class);
        assertEquals(HttpStatus.OK, layerView.getStatusCode());
        assertEquals("90", layerView.getBody().get("defaultTimeoutSecs"));

        ResponseEntity<Map> instanceView = restTemplate.exchange(
            url("/api/v1/config/job-policy?layer=instance"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(token)), Map.class);
        assertEquals(HttpStatus.FORBIDDEN, instanceView.getStatusCode());

        ResponseEntity<Map> adminInstanceView = restTemplate.exchange(
            url("/api/v1/config/job-policy?layer=instance"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(adminToken())), Map.class);
        assertEquals(HttpStatus.OK, adminInstanceView.getStatusCode());
        assertEquals("40", adminInstanceView.getBody().get("defaultTimeoutSecs"));
    }

    @Test
    void put_modelDomainsAnswer400DomainNotWorkspaceWritable_onWorkspaceLayer() {
        // T2.4 refusal pin (workspace-layer half of 4-domains × 2-layers; the
        // workspace-default half lives in ConfigWorkspaceDefaultLayerTest). The caller
        // reaches the layer gate (member with the H1 atom), and the layer verdict —
        // 400 DOMAIN_NOT_WORKSPACE_WRITABLE — must precede any body validation.
        String token = userToken();
        String workspaceId = workspaceIdFor(token);
        HttpHeaders headers = authHeaders(token);
        headers.set("X-Workspace-Id", workspaceId);
        for (String domain : java.util.List.of("llm-provider", "context-policy", "embedding", "rag")) {
            ResponseEntity<Map> resp = restTemplate.exchange(
                url("/api/v1/config/workspace/" + domain + "?workspaceId=" + workspaceId),
                HttpMethod.PUT, new HttpEntity<>(Map.of("anything", "x"), headers), Map.class);
            assertEquals(HttpStatus.BAD_REQUEST, resp.getStatusCode(), domain);
            assertEquals("DOMAIN_NOT_WORKSPACE_WRITABLE", resp.getBody().get("code"), domain);
        }
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
        String workspaceId = workspaceIdFor(token);
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
        String workspaceId = workspaceIdFor(token);
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
        String workspaceId = workspaceIdFor(token);
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
    void mcpConfig_roundTripsRemoteOauthBlock() {
        String token = userToken();
        String workspaceId = workspaceIdFor(token);
        HttpHeaders headers = authHeaders(token);
        headers.setContentType(MediaType.APPLICATION_JSON);

        // PLAN-0759 / BL-548: the OAuth client block must survive the PUT->GET
        // round-trip; before the fix PUT dropped it and GET rebuilt {url,type} only,
        // so the UI's authorize entry was unreachable.
        Map<String, Object> oauth = new LinkedHashMap<>();
        oauth.put("clientId", "client-123");
        oauth.put("authorizationEndpoint", "https://auth.example.com/authorize");
        oauth.put("tokenEndpoint", "https://auth.example.com/token");
        oauth.put("redirectUri", "http://localhost:5173/oauth/callback");
        oauth.put("scope", "mcp:read mcp:write");
        Map<String, Object> putBody = Map.of("mcpServers", Map.of(
            "remote-oauth", Map.of(
                "url", "https://example.com/mcp",
                "type", "http",
                "oauth", oauth)));
        ResponseEntity<Map> put = restTemplate.exchange(
            url("/api/v1/workspaces/" + workspaceId + "/mcp-config"), HttpMethod.PUT,
            new HttpEntity<>(putBody, headers), Map.class);
        assertEquals(HttpStatus.OK, put.getStatusCode());

        ResponseEntity<Map> get = restTemplate.exchange(
            url("/api/v1/workspaces/" + workspaceId + "/mcp-config"), HttpMethod.GET,
            new HttpEntity<>(headers), Map.class);
        assertEquals(HttpStatus.OK, get.getStatusCode());
        Map<?, ?> servers = (Map<?, ?>) get.getBody().get("mcpServers");
        Map<?, ?> remote = (Map<?, ?>) servers.get("remote-oauth");
        assertEquals("https://example.com/mcp", remote.get("url"));
        assertEquals("http", remote.get("type"));
        Map<?, ?> stored = (Map<?, ?>) remote.get("oauth");
        assertNotNull(stored, "oauth block must be rebuilt on GET");
        assertEquals("client-123", stored.get("clientId"));
        assertEquals("https://auth.example.com/authorize", stored.get("authorizationEndpoint"));
        assertEquals("https://auth.example.com/token", stored.get("tokenEndpoint"));
        assertEquals("http://localhost:5173/oauth/callback", stored.get("redirectUri"));
        assertEquals("mcp:read mcp:write", stored.get("scope"));
    }

    @Test
    void mcpConfig_remoteWithoutOauth_hasNoOauthKey() {
        String token = userToken();
        String workspaceId = workspaceIdFor(token);
        HttpHeaders headers = authHeaders(token);
        headers.setContentType(MediaType.APPLICATION_JSON);

        Map<String, Object> putBody = Map.of("mcpServers", Map.of(
            "plain", Map.of("url", "https://example.com/plain")));
        ResponseEntity<Map> put = restTemplate.exchange(
            url("/api/v1/workspaces/" + workspaceId + "/mcp-config"), HttpMethod.PUT,
            new HttpEntity<>(putBody, headers), Map.class);
        assertEquals(HttpStatus.OK, put.getStatusCode());

        ResponseEntity<Map> get = restTemplate.exchange(
            url("/api/v1/workspaces/" + workspaceId + "/mcp-config"), HttpMethod.GET,
            new HttpEntity<>(headers), Map.class);
        Map<?, ?> servers = (Map<?, ?>) get.getBody().get("mcpServers");
        Map<?, ?> plain = (Map<?, ?>) servers.get("plain");
        assertEquals("https://example.com/plain", plain.get("url"));
        assertFalse(plain.containsKey("oauth"), "no oauth key when none was supplied");
    }

    @Test
    void mcpConfig_ambiguousEntry_returns400() {
        String token = userToken();
        String workspaceId = workspaceIdFor(token);
        HttpHeaders headers = authHeaders(token);
        headers.setContentType(MediaType.APPLICATION_JSON);

        Map<String, Object> putBody = Map.of("mcpServers", Map.of(
            "broken", Map.of("command", "npx", "url", "https://example.com/mcp")));
        ResponseEntity<Map> put = restTemplate.exchange(
            url("/api/v1/workspaces/" + workspaceId + "/mcp-config"), HttpMethod.PUT,
            new HttpEntity<>(putBody, headers), Map.class);
        assertEquals(HttpStatus.BAD_REQUEST, put.getStatusCode());
    }

    @Test
    void getConfig_nonAdminHidesInstanceOnlyAgentRuntimeKeys() {
        restTemplate.exchange(
            url("/api/v1/config/instance/agent-runtime"), HttpMethod.PUT,
            new HttpEntity<>(Map.of(
                "runMaxTurns", "25",
                "runMaxTurnsCeiling", "100",
                "instructions", "instance-only instructions"), authHeaders(adminToken())), Map.class);

        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/agent-runtime"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(userToken())), Map.class);

        assertEquals(HttpStatus.OK, resp.getStatusCode());
        assertTrue(resp.getBody().containsKey("runMaxTurns"));
        assertFalse(resp.getBody().containsKey("runMaxTurnsCeiling"));
        assertFalse(resp.getBody().containsKey("instructions"));
        assertEquals("****", resp.getBody().get("runMaxTurns"));
    }

    @Test
    void getConfig_nonAdminCannotReadInstanceOnlyDomains() {
        String token = userToken();
        for (String domain : List.of("pricing", "logging")) {
            ResponseEntity<Map> resp = restTemplate.exchange(
                url("/api/v1/config/" + domain), HttpMethod.GET,
                new HttpEntity<>(authHeaders(token)), Map.class);
            assertEquals(HttpStatus.FORBIDDEN, resp.getStatusCode(), domain);
        }
    }

    @Test
    void getConfigMeta_instanceRequiresAdmin() {
        String token = userToken();
        ResponseEntity<Map> userResp = restTemplate.exchange(
            url("/api/v1/config/logging/meta?layer=instance"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(token)), Map.class);
        assertEquals(HttpStatus.FORBIDDEN, userResp.getStatusCode());

        ResponseEntity<Map> adminResp = restTemplate.exchange(
            url("/api/v1/config/logging/meta?layer=instance"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(adminToken())), Map.class);
        assertEquals(HttpStatus.OK, adminResp.getStatusCode());
        List<Map<String, Object>> keys = (List<Map<String, Object>>) adminResp.getBody().get("keys");
        Map<String, Object> levelCp = keys.stream()
            .filter(item -> "levelCp".equals(item.get("key"))).findFirst().orElseThrow();
        assertEquals("code", levelCp.get("source"));
        assertEquals(true, levelCp.get("instanceEligible"));
        assertEquals(false, levelCp.get("overridable"));
    }

    @Test
    void getConfigMeta_userFiltersInstanceOnlyKeys() {
        restTemplate.exchange(
            url("/api/v1/config/instance/agent-runtime"), HttpMethod.PUT,
            new HttpEntity<>(Map.of(
                "runMaxTurns", "25",
                "runMaxTurnsCeiling", "100",
                "instructions", "instance-only instructions"), authHeaders(adminToken())), Map.class);

        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/agent-runtime/meta?layer=user"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(userToken())), Map.class);

        assertEquals(HttpStatus.OK, resp.getStatusCode());
        List<Map<String, Object>> keys = (List<Map<String, Object>>) resp.getBody().get("keys");
        assertTrue(keys.stream().noneMatch(item -> "instructions".equals(item.get("key"))));
        assertTrue(keys.stream().noneMatch(item -> "runMaxTurnsCeiling".equals(item.get("key"))));
        Map<String, Object> runMaxTurns = keys.stream()
            .filter(item -> "runMaxTurns".equals(item.get("key"))).findFirst().orElseThrow();
        assertEquals("instance", runMaxTurns.get("source"));
        assertEquals(true, runMaxTurns.get("writable"));
        assertEquals(false, runMaxTurns.get("instanceEligible"));
    }

    @Test
    void getConfigMeta_rejectsServiceOnlyAndNonWritableDomains() {
        ResponseEntity<Map> pricing = restTemplate.exchange(
            url("/api/v1/config/pricing/meta?layer=instance"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(adminToken())), Map.class);
        assertEquals(HttpStatus.BAD_REQUEST, pricing.getStatusCode());
        assertEquals("INVALID_DOMAIN", pricing.getBody().get("code"));

        ResponseEntity<Map> logging = restTemplate.exchange(
            url("/api/v1/config/logging/meta?layer=user"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(userToken())), Map.class);
        assertEquals(HttpStatus.FORBIDDEN, logging.getStatusCode());
    }

    @Test
    void deleteInstanceConfig_removesRow() {
        restTemplate.exchange(
            url("/api/v1/config/instance/logging"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("logLevel", "WARN"), authHeaders(adminToken())), Map.class);

        ResponseEntity<Map> deleted = restTemplate.exchange(
            url("/api/v1/config/instance/logging/logLevel"), HttpMethod.DELETE,
            new HttpEntity<>(authHeaders(adminToken())), Map.class);
        assertEquals(HttpStatus.OK, deleted.getStatusCode());

        ResponseEntity<Map> layer = restTemplate.exchange(
            url("/api/v1/config/logging?layer=instance"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(adminToken())), Map.class);
        assertEquals(HttpStatus.OK, layer.getStatusCode());
        assertFalse(layer.getBody().containsKey("logLevel"));

        ResponseEntity<Map> deletedAgain = restTemplate.exchange(
            url("/api/v1/config/instance/logging/logLevel"), HttpMethod.DELETE,
            new HttpEntity<>(authHeaders(adminToken())), Map.class);
        assertEquals(HttpStatus.OK, deletedAgain.getStatusCode());
    }

    @Test
    void envLockedKey_rejectsPutAndDelete() throws Exception {
        EnvOverlayRegistry original = swapEnvOverlay(
            new EnvOverlayRegistry(key -> "XIHE_JOB_TIMEOUT_DEFAULT_SECS".equals(key) ? "7200" : null));
        try {
            ResponseEntity<Map> put = restTemplate.exchange(
                url("/api/v1/config/instance/job-policy"), HttpMethod.PUT,
                new HttpEntity<>(Map.of("defaultTimeoutSecs", "3600"), authHeaders(adminToken())), Map.class);
            assertEquals(HttpStatus.CONFLICT, put.getStatusCode());
            assertEquals("CONFIG_ENV_LOCKED", put.getBody().get("code"));

            ResponseEntity<Map> delete = restTemplate.exchange(
                url("/api/v1/config/instance/job-policy/defaultTimeoutSecs"), HttpMethod.DELETE,
                new HttpEntity<>(authHeaders(adminToken())), Map.class);
            assertEquals(HttpStatus.CONFLICT, delete.getStatusCode());
            assertEquals("CONFIG_ENV_LOCKED", delete.getBody().get("code"));
        } finally {
            swapEnvOverlay(original);
        }
    }

    // ------------------------------------------------------------------
    // PLAN-0773 / task-229: the three workspace write faces (H1/H2/H3)
    // ------------------------------------------------------------------

    /**
     * The hole this card closes, in the shape that was actually reachable at HEAD {@code 8d725dadd}:
     * a caller who is a <b>VIEWER of the target workspace</b> but whose resolved context workspace
     * is one they may write (they own it). Two facts made the write go through before the atom gate:
     * {@code WorkspaceWriteGuard} grades the <b>context</b> role (PLAN-0559), and the controllers
     * only asked "is the caller a member of the target". The gate below is keyed on the
     * <b>target</b> workspace, so it answers 403 FORBIDDEN where the coarse guard cannot.
     */
    @Test
    void aViewerOfTheTargetCannotWriteItsMcpFaces() {
        String ownerToken = userToken();
        String targetWorkspaceId = workspaceIdFor(ownerToken);

        String viewerToken = userToken();
        String viewerId = jwtTokenProvider.getUserIdFromToken(viewerToken);
        // The viewer owns a workspace of their own: that is the write-capable CONTEXT, and it is
        // what makes the coarse guard pass without opening the target.
        String contextWorkspaceId = workspaceIdFor(viewerToken);
        workspaceFixture.bindWorkspaceRole(UUID.fromString(targetWorkspaceId),
                UUID.fromString(viewerId), WorkspaceRole.VIEWER);

        HttpHeaders headers = authHeaders(viewerToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("X-Workspace-Id", contextWorkspaceId);

        ResponseEntity<Map> stdio = restTemplate.exchange(
                url("/api/v1/workspaces/" + targetWorkspaceId + "/stdio-servers"), HttpMethod.PUT,
                new HttpEntity<>(stdioBody(), headers), Map.class);
        evidence("viewer/stdio-servers", stdio);
        assertEquals(HttpStatus.FORBIDDEN, stdio.getStatusCode(), String.valueOf(stdio.getBody()));
        assertEquals("FORBIDDEN", stdio.getBody().get("code"),
                "the refusal must come from the atom gate, not from the context-role guard: "
                        + stdio.getBody());

        ResponseEntity<Map> mcp = restTemplate.exchange(
                url("/api/v1/workspaces/" + targetWorkspaceId + "/mcp-config"), HttpMethod.PUT,
                new HttpEntity<>(mcpBody(), headers), Map.class);
        evidence("viewer/mcp-config", mcp);
        assertEquals(HttpStatus.FORBIDDEN, mcp.getStatusCode(), String.valueOf(mcp.getBody()));
        assertEquals("FORBIDDEN", mcp.getBody().get("code"),
                "the legacy door answers with the same code as the new one: " + mcp.getBody());
    }

    /** 404 first: a non-member must not learn whether the workspace exists (ordering red line). */
    @Test
    void aNonMemberKeepsTheNotFoundAnswerOnTheMcpFaces() {
        String ownerToken = userToken();
        String targetWorkspaceId = workspaceIdFor(ownerToken);
        // Registration creates no workspace (PLAN-0614), so this account has no workspace context
        // at all and the request reaches the controller's membership check.
        String strangerToken = userToken();
        HttpHeaders headers = authHeaders(strangerToken);
        headers.setContentType(MediaType.APPLICATION_JSON);

        ResponseEntity<Map> stdio = restTemplate.exchange(
                url("/api/v1/workspaces/" + targetWorkspaceId + "/stdio-servers"), HttpMethod.PUT,
                new HttpEntity<>(stdioBody(), headers), Map.class);
        evidence("non-member/stdio-servers", stdio);
        assertEquals(HttpStatus.NOT_FOUND, stdio.getStatusCode(), String.valueOf(stdio.getBody()));
        assertEquals("WORKSPACE_NOT_FOUND", stdio.getBody().get("code"));

        ResponseEntity<Map> mcp = restTemplate.exchange(
                url("/api/v1/workspaces/" + targetWorkspaceId + "/mcp-config"), HttpMethod.PUT,
                new HttpEntity<>(mcpBody(), headers), Map.class);
        evidence("non-member/mcp-config", mcp);
        assertEquals(HttpStatus.NOT_FOUND, mcp.getStatusCode(), String.valueOf(mcp.getBody()));
        assertEquals("WORKSPACE_NOT_FOUND", mcp.getBody().get("code"));
    }

    /** The positive control for all THREE faces: WS_EDITOR carries the atoms, so writes stay 200. */
    @Test
    void aWorkspaceEditorWritesAllThreeFaces() {
        String ownerToken = userToken();
        String targetWorkspaceId = workspaceIdFor(ownerToken);
        String editorToken = userToken();
        String editorId = jwtTokenProvider.getUserIdFromToken(editorToken);
        workspaceFixture.bindWorkspaceRole(UUID.fromString(targetWorkspaceId),
                UUID.fromString(editorId), WorkspaceRole.EDITOR);

        HttpHeaders headers = authHeaders(editorToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        // No X-Workspace-Id: the fallback resolves the editor's own membership, which IS the target
        // workspace, so the coarse guard and the atom gate both see the same role.
        ResponseEntity<Map> stdio = restTemplate.exchange(
                url("/api/v1/workspaces/" + targetWorkspaceId + "/stdio-servers"), HttpMethod.PUT,
                new HttpEntity<>(stdioBody(), headers), Map.class);
        evidence("editor/stdio-servers", stdio);
        assertEquals(HttpStatus.OK, stdio.getStatusCode(), String.valueOf(stdio.getBody()));

        ResponseEntity<Map> mcp = restTemplate.exchange(
                url("/api/v1/workspaces/" + targetWorkspaceId + "/mcp-config"), HttpMethod.PUT,
                new HttpEntity<>(mcpBody(), headers), Map.class);
        evidence("editor/mcp-config", mcp);
        assertEquals(HttpStatus.OK, mcp.getStatusCode(), String.valueOf(mcp.getBody()));

        // T2.4: llm-provider left the workspace layer; the editor write runs on job-policy.
        ResponseEntity<Map> config = restTemplate.exchange(
                url("/api/v1/config/workspace/job-policy?workspaceId=" + targetWorkspaceId),
                HttpMethod.PUT, new HttpEntity<>(Map.of("defaultTimeoutSecs", "60"), headers),
                Map.class);
        evidence("editor/config-workspace", config);
        assertEquals(HttpStatus.OK, config.getStatusCode(), String.valueOf(config.getBody()));
    }

    /**
     * H1's denial for a viewer is answered by the <b>coarse</b> guard before the atom gate can run:
     * with {@code X-Workspace-Id} the context workspace IS the target, so {@code PLAN-0559}'s
     * {@code WorkspaceWriteGuard} rejects the WRITE with WORKSPACE_READ_ONLY. Pinned here so the
     * layering stays visible — the atom is defence in depth on this face, not the answering layer.
     */
    @Test
    void theConfigWriteFaceKeepsTheCoarseReadOnlyDenialForAViewer() {
        String ownerToken = userToken();
        String targetWorkspaceId = workspaceIdFor(ownerToken);
        String viewerToken = userToken();
        String viewerId = jwtTokenProvider.getUserIdFromToken(viewerToken);
        workspaceFixture.bindWorkspaceRole(UUID.fromString(targetWorkspaceId),
                UUID.fromString(viewerId), WorkspaceRole.VIEWER);

        HttpHeaders headers = authHeaders(viewerToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("X-Workspace-Id", targetWorkspaceId);

        // T2.4: job-policy keeps this test measuring the coarse guard, not the domain gate
        // (llm-provider would be refused by the domain gate too, muddying the measured layer).
        ResponseEntity<Map> put = restTemplate.exchange(
                url("/api/v1/config/workspace/job-policy"), HttpMethod.PUT,
                new HttpEntity<>(Map.of("defaultTimeoutSecs", "10"), headers), Map.class);
        evidence("viewer/config-workspace(coarse-guard)", put);
        assertEquals(HttpStatus.FORBIDDEN, put.getStatusCode(), String.valueOf(put.getBody()));
        assertEquals("WORKSPACE_READ_ONLY", put.getBody().get("code"),
                "measured layer: the coarse guard answers first on this face: " + put.getBody());
    }

    /** Writes the measured status/code of one face to the test log (evidence without by-hand reruns). */
    private static void evidence(String face, ResponseEntity<Map> response) {
        org.slf4j.LoggerFactory.getLogger(ConfigControllerTest.class)
                .info("[EVIDENCE] task229 face={} status={} code={}", face,
                        response.getStatusCode().value(),
                        response.getBody() == null ? null : response.getBody().get("code"));
    }

    private Map<String, Object> stdioBody() {
        return Map.of("generation", 0,
                "servers", Map.of("docs", Map.of("command", "npx", "args", List.of("docs-server"))));
    }

    private Map<String, Object> mcpBody() {
        return Map.of("mcpServers",
                Map.of("docs", Map.of("command", "npx", "args", List.of("docs-server"))));
    }

    private EnvOverlayRegistry swapEnvOverlay(EnvOverlayRegistry overlay) throws Exception {
        ConfigService target = org.springframework.test.util.AopTestUtils.getTargetObject(configService);
        java.lang.reflect.Field field = ConfigService.class.getDeclaredField("envOverlay");
        field.setAccessible(true);
        EnvOverlayRegistry old = (EnvOverlayRegistry) field.get(target);
        field.set(target, overlay);
        return old;
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
            Map.of("identifier", "admin@xihe.local", "password", password),
            Map.class);
        assertEquals(HttpStatus.OK, login.getStatusCode());
        String token = (String) login.getBody().get("accessToken");
        assertNotNull(token);
        return token;
    }
}
