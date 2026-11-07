package com.cc01cc.p.xihe.cp.plugin.kv;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.TestPropertySource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * PLAN-0691 T1.5: shared base for the plugin KV data-plane tests.
 *
 * <p>Real PostgreSQL (inherited from {@link AbstractIntegrationTest}) plus a real HTTP stack, because
 * the interesting behaviour is spread across three layers that a unit test would each have to fake:
 * the security chain's 401/403 split, the filter that turns a token into claims, and SQL that decides
 * CAS by affected-row count.
 *
 * <p>Seeding is deliberately SQL, not the product's install/bind services: those are lane A's write
 * entry points (task-111) and are not part of this task. The rows inserted here are exactly what
 * those services would leave behind.
 */
@TestPropertySource(properties = {
        "cp.plugin.enabled=true",
        "cp.plugin.advisory-lock=false"
})
public abstract class AbstractPluginKvIntegrationTest extends AbstractIntegrationTest {

    /** Same default the production code falls back to, so the tests mint tokens the app accepts. */
    @Value("${cp.jwt.secret:xihe-cp-jwt-secret-key-change-in-production}")
    protected String jwtSecret;

    @Value("${cp.agent-api-token:dev-token-not-secure}")
    protected String internalServiceToken;

    @Autowired
    protected JdbcTemplate jdbcTemplate;

    @Autowired
    protected ObjectMapper objectMapper;

    protected PluginKvTokenService tokenService;

    @BeforeEach
    void initTokenService() {
        tokenService = new PluginKvTokenService(jwtSecret);
    }

    // ------------------------------------------------------------------ seeding

    /** One workspace + one installed plugin version + one binding, all fresh per call. */
    protected SeededBinding seedBinding(String state) {
        UUID workspaceId = UUID.randomUUID();
        jdbcTemplate.update("INSERT INTO workspaces (id, name) VALUES (?, ?)",
                workspaceId, "kv-ws-" + workspaceId);
        String suffix = UUID.randomUUID().toString().replace("-", "");
        String pluginId = "official.kv-test-" + suffix;
        String digest = "sha256:" + suffix;
        jdbcTemplate.update("INSERT INTO plugins (id, digest, version, state, source, manifest)"
                        + " VALUES (?, ?, '1.0.0', 'enabled', 'builtin', '{}'::jsonb)",
                pluginId, digest);
        UUID bindingId = UUID.randomUUID();
        jdbcTemplate.update("INSERT INTO plugin_bindings (id, plugin_id, digest, version,"
                        + " workspace_id, state) VALUES (?, ?, ?, '1.0.0', ?, ?)",
                bindingId, pluginId, digest, workspaceId, state);
        return new SeededBinding(bindingId, pluginId, digest, workspaceId);
    }

    protected SeededBinding seedEnabledBinding() {
        return seedBinding("enabled");
    }

    /** SEC-1: the ordinary case — a token scoped to exactly this binding. */
    protected String token(SeededBinding binding) {
        return tokenService.issue(binding.bindingId(), binding.pluginId(), binding.digest(), "kv");
    }

    protected String token(SeededBinding binding, String pluginId, String digest) {
        return tokenService.issue(binding.bindingId(), pluginId, digest, "kv");
    }

    protected String expiredToken(SeededBinding binding) {
        return tokenService.issue(binding.bindingId(), binding.pluginId(), binding.digest(), "kv",
                Instant.now().minusSeconds(600));
    }

    // ------------------------------------------------------------------ wire helpers

    protected String kvPath(SeededBinding binding, String tail) {
        return "/internal/v1/plugin-bindings/" + binding.bindingId() + "/kv/" + tail;
    }

    protected ResponseEntity<String> get(String path, String token) {
        return send(HttpMethod.GET, path, token, null, null);
    }

    protected ResponseEntity<String> put(String path, String token, String body) {
        return send(HttpMethod.PUT, path, token, body, null);
    }

    protected ResponseEntity<String> put(String path, String token, String body, String ifMatch) {
        return send(HttpMethod.PUT, path, token, body, ifMatch);
    }

    protected ResponseEntity<String> delete(String path, String token) {
        return send(HttpMethod.DELETE, path, token, null, null);
    }

    protected ResponseEntity<String> delete(String path, String token, String ifMatch) {
        return send(HttpMethod.DELETE, path, token, null, ifMatch);
    }

    protected ResponseEntity<String> send(HttpMethod method, String path, String token, String body,
            String ifMatch) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setAccept(List.of(MediaType.APPLICATION_JSON,
                MediaType.valueOf("application/problem+json")));
        if (token != null) {
            headers.setBearerAuth(token);
        }
        if (ifMatch != null) {
            headers.set("If-Match", ifMatch);
        }
        return restTemplate.exchange(url(path), method, new HttpEntity<>(body, headers), String.class);
    }

    protected JsonNode json(ResponseEntity<String> response) {
        return objectMapper.readTree(response.getBody());
    }

    /** API-11 code of a problem response, e.g. {@code PLUGIN_PRECONDITION_FAILED}. */
    protected String code(ResponseEntity<String> response) {
        JsonNode body = json(response);
        return body.has("code") ? body.get("code").asText() : "<no code>";
    }

    /** A KV JSON body for {@code PUT}, with the boxed fields left out unless asked for. */
    protected String putBody(String rawJsonValue) {
        return "{\"value\":" + rawJsonValue + "}";
    }

    protected String putBody(String rawJsonValue, Long ttlSeconds, Long ifMatch) {
        StringBuilder body = new StringBuilder("{\"value\":").append(rawJsonValue);
        if (ttlSeconds != null) {
            body.append(",\"ttlSeconds\":").append(ttlSeconds);
        }
        if (ifMatch != null) {
            body.append(",\"ifMatch\":").append(ifMatch);
        }
        return body.append('}').toString();
    }

    /** The seeded rows, so a test can address the same binding from both SQL and HTTP. */
    protected record SeededBinding(UUID bindingId, String pluginId, String digest, UUID workspaceId) {
    }
}
