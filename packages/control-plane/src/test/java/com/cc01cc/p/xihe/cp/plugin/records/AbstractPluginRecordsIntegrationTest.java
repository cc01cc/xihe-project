package com.cc01cc.p.xihe.cp.plugin.records;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.plugin.kv.PluginKvTokenService;
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

import java.util.List;
import java.util.UUID;

/**
 * PLAN-0691 T2.3: shared base for the records data-plane tests.
 *
 * <p>Real PostgreSQL and a real HTTP stack, because the properties worth proving are spread over the
 * whole path: the security chain's 401/403 split, the filter that turns a token into claims, the query
 * compiler's SQL, and PostgreSQL's own text ordering (which is the <b>definition</b> of range/prefix
 * semantics — a mocked comparison could not prove it).
 *
 * <p>Seeding is SQL, not the product's install/bind services: those are another lane's entry points and
 * not part of this task. The manifest written here is exactly the document shape
 * {@code spec/manifest.schema.json} validates: {@code storage.collections[].fields} is a list of field
 * <b>names</b>, which is why the query whitelist is name-only and range comparisons are textual.
 */
@TestPropertySource(properties = {
        "cp.plugin.enabled=true",
        "cp.plugin.advisory-lock=false"
})
public abstract class AbstractPluginRecordsIntegrationTest extends AbstractIntegrationTest {

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

    /**
     * The manifest every seeded plugin carries: two collections, so a test can prove one collection's
     * rows are untouched by another's writes, plus a unique index declaration for the 409 surface.
     *
     * <p>{@code notes} declares a narrowed {@code docBytesMax} of 4096 bytes; QUOTA-7 allows a manifest
     * to narrow the deployment ceiling but never to widen it.
     */
    protected static final String MANIFEST = """
            {"storage":{"collections":[
              {"name":"notes","docBytesMax":4096,"fields":["status","name","n"],
               "indexes":[{"name":"uniq_status","fields":["status"],"unique":true}]},
              {"name":"tags","fields":["label"]}
            ]}}""";

    @BeforeEach
    void initTokenService() {
        tokenService = new PluginKvTokenService(jwtSecret);
    }

    // ------------------------------------------------------------------ seeding

    /** One workspace + one installed plugin version + one binding, all fresh per call. */
    protected SeededBinding seedBinding(String state) {
        return seedBindingWithManifest(state, MANIFEST);
    }

    protected SeededBinding seedBindingWithManifest(String state, String manifestJson) {
        UUID workspaceId = UUID.randomUUID();
        jdbcTemplate.update("INSERT INTO workspaces (id, name) VALUES (?, ?)",
                workspaceId, "records-ws-" + workspaceId);
        String suffix = UUID.randomUUID().toString().replace("-", "");
        String pluginId = "official.records-test-" + suffix;
        String digest = "sha256:" + suffix;
        jdbcTemplate.update("INSERT INTO plugins (id, digest, version, state, source, manifest)"
                        + " VALUES (?, ?, '1.0.0', 'enabled', 'builtin', ?::jsonb)",
                pluginId, digest, manifestJson);
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
        return tokenService.issue(binding.bindingId(), binding.pluginId(), binding.digest(),
                "records");
    }

    protected String token(SeededBinding binding, String pluginId, String digest) {
        return tokenService.issue(binding.bindingId(), pluginId, digest, "records");
    }

    // ------------------------------------------------------------------ wire helpers

    protected String recordsPath(SeededBinding binding, String tail) {
        return "/internal/v1/plugin-bindings/" + binding.bindingId() + "/records/" + tail;
    }

    protected ResponseEntity<String> get(String path, String token) {
        return send(HttpMethod.GET, path, token, null, null);
    }

    protected ResponseEntity<String> post(String path, String token, String body) {
        return send(HttpMethod.POST, path, token, body, null);
    }

    protected ResponseEntity<String> put(String path, String token, String body) {
        return send(HttpMethod.PUT, path, token, body, null);
    }

    protected ResponseEntity<String> delete(String path, String token) {
        return send(HttpMethod.DELETE, path, token, null, null);
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

    /** API-11 code of a problem response, e.g. {@code INVALID_FILTER}. */
    protected String code(ResponseEntity<String> response) {
        JsonNode body = json(response);
        return body.has("code") ? body.get("code").asText() : "<no code>";
    }

    /** A records body: the document is named, per the controller's wire contract. */
    protected String body(String rawJsonDocument) {
        return "{\"doc\":" + rawJsonDocument + "}";
    }

    /** Direct row count, so a test can prove what the database kept rather than what the API said. */
    protected int storedRows(SeededBinding binding, String collection) {
        Integer rows = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM plugin_records WHERE binding_id = ? AND collection = ?",
                Integer.class, binding.bindingId(), collection);
        return rows == null ? 0 : rows;
    }

    /** The seeded rows, so a test can address the same binding from both SQL and HTTP. */
    protected record SeededBinding(UUID bindingId, String pluginId, String digest, UUID workspaceId) {
    }
}
