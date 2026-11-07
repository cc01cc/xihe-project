package com.cc01cc.p.xihe.cp.plugin;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0691 T1.1 L0: the seven catalog/lifecycle routes on H2 with the feature on.
 *
 * <p>Install reads the manifest from the package directory server-side; each fixture below is a
 * real package tree under a temp root, so the source-directory rule is exercised, not stubbed.
 * The advisory lock is property-gated off for H2 (no {@code pg_advisory_xact_lock}); the PG DDL
 * wave is {@code PluginSchemaMigrationTest}.</p>
 */
@TestPropertySource(properties = {
        "cp.plugin.enabled=true",
        "cp.plugin.advisory-lock=false"
})
class PluginManifestControllerTest extends AbstractH2Test {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path PACKAGE_ROOT = preparePackages();

    @Autowired
    private PluginRepository repository;

    @DynamicPropertySource
    static void packageRoot(DynamicPropertyRegistry registry) {
        registry.add("cp.plugin.package-root", () -> PACKAGE_ROOT.toString());
    }

    @Test
    void installListAndGetProjectTheViewWithoutTheManifestNode() {
        String token = token();

        ResponseEntity<Map> installed = install(token, "official/kv-selftest");
        assertEquals(HttpStatus.CREATED, installed.getStatusCode(), String.valueOf(installed.getBody()));
        Map<?, ?> view = installed.getBody();
        assertNotNull(view);
        assertEquals("official.kv-selftest", view.get("pluginId"));
        assertEquals("1.0.0", view.get("version"));
        assertEquals("builtin", view.get("source"));
        assertEquals("disabled", view.get("state"), "install must not auto-enable (T1.1 freeze)");
        assertTrue(String.valueOf(view.get("digest")).startsWith("sha256:"));
        assertEquals(5000, ((Map<?, ?>) view.get("limits")).get("timeoutMs"));
        assertNull(view.get("manifest"), "the jsonb node must not reach the wire");
        assertEquals(1, repository.countVersions("official.kv-selftest"));

        ResponseEntity<Map> list = exchange(token, HttpMethod.GET, "/api/v1/plugins", null);
        assertEquals(HttpStatus.OK, list.getStatusCode());
        List<?> items = (List<?>) list.getBody().get("items");
        // The H2 context is shared by every test in this class, so the catalog may also carry rows
        // installed by a sibling test: assert presence by id instead of a class-wide count.
        assertTrue(items.stream().anyMatch(item -> "official.kv-selftest"
                .equals(((Map<?, ?>) item).get("pluginId"))), String.valueOf(items));

        ResponseEntity<Map> filtered = exchange(token, HttpMethod.GET,
                "/api/v1/plugins?source=third-party", null);
        assertTrue(((List<?>) filtered.getBody().get("items")).stream()
                .noneMatch(item -> String.valueOf(((Map<?, ?>) item).get("pluginId"))
                        .startsWith("official.")),
                "builtin rows must not match source=third-party");

        ResponseEntity<Map> detail = exchange(token, HttpMethod.GET,
                "/api/v1/plugins/official.kv-selftest", null);
        assertEquals(HttpStatus.OK, detail.getStatusCode());
        assertEquals("official.kv-selftest", detail.getBody().get("pluginId"));

        ResponseEntity<Map> missing = exchange(token, HttpMethod.GET,
                "/api/v1/plugins/official.not-installed", null);
        assertEquals(HttpStatus.NOT_FOUND, missing.getStatusCode());
        assertEquals("PLUGIN_NOT_FOUND", missing.getBody().get("code"));
    }

    @Test
    void reinstallOfTheSameDigestIsConflict() {
        String token = token();
        ResponseEntity<Map> first = install(token, "official/conflict");
        assertEquals(HttpStatus.CREATED, first.getStatusCode());

        ResponseEntity<Map> again = install(token, "official/conflict");
        assertEquals(HttpStatus.CONFLICT, again.getStatusCode(), String.valueOf(again.getBody()));
        assertEquals("PLUGIN_DIGEST_EXISTS", again.getBody().get("code"));
    }

    @Test
    void invalidManifestAnswersUnprocessable() {
        String token = token();
        ResponseEntity<Map> response = install(token, "official/broken");
        assertEquals(HttpStatus.UNPROCESSABLE_CONTENT, response.getStatusCode(),
                String.valueOf(response.getBody()));
        assertEquals("PLUGIN_MANIFEST_INVALID", response.getBody().get("code"));
        assertTrue(String.valueOf(response.getBody().get("detail")).contains("unknown field"));
    }

    @Test
    void enableAndDisableFlipTheCurrentRowState() {
        String token = token();
        install(token, "official/lifecycle");

        ResponseEntity<Map> enabled = exchange(token, HttpMethod.POST,
                "/api/v1/plugins/official.lifecycle/enable", null);
        assertEquals(HttpStatus.OK, enabled.getStatusCode());
        assertEquals("enabled", enabled.getBody().get("state"));

        ResponseEntity<Map> disabled = exchange(token, HttpMethod.POST,
                "/api/v1/plugins/official.lifecycle/disable", null);
        assertEquals("disabled", disabled.getBody().get("state"));
    }

    @Test
    void upgradeKeepsOneCurrentVersionThenUninstallRemovesAllVersions() {
        String token = token();
        install(token, "official/rollback");
        assertEquals(1, repository.countVersions("official.rollback"));

        ResponseEntity<Map> upgraded = exchange(token, HttpMethod.POST,
                "/api/v1/plugins/official.rollback/upgrade",
                Map.of("packagePath", "official/rollback-next"));
        assertEquals(HttpStatus.OK, upgraded.getStatusCode(), String.valueOf(upgraded.getBody()));
        assertEquals("1.1.0", upgraded.getBody().get("version"));
        assertEquals("disabled", upgraded.getBody().get("state"),
                "upgrade inherits the previous state");
        assertEquals(2, repository.countVersions("official.rollback"));
        assertEquals("1.1.0", repository.findCurrentById("official.rollback").orElseThrow()
                .getVersion());

        ResponseEntity<Void> deleted = restTemplate.exchange(
                url("/api/v1/plugins/official.rollback"), HttpMethod.DELETE,
                authEntity(token), Void.class);
        assertEquals(HttpStatus.NO_CONTENT, deleted.getStatusCode());
        assertEquals(0, repository.countVersions("official.rollback"));

        ResponseEntity<Map> gone = exchange(token, HttpMethod.GET,
                "/api/v1/plugins/official.rollback", null);
        assertEquals(HttpStatus.NOT_FOUND, gone.getStatusCode());
    }

    @Test
    void thirdPartyPackageInstallsFromLocalDirectory() {
        String token = token();
        ResponseEntity<Map> installed = install(token, "local/com.example.demo");
        assertEquals(HttpStatus.CREATED, installed.getStatusCode(), String.valueOf(installed.getBody()));
        assertEquals("third-party", installed.getBody().get("source"));
    }

    // ------------------------------------------------------------------ helpers

    private String token() {
        String email = "plugin-" + UUID.randomUUID() + "@example.test";
        ResponseEntity<Map> registered = restTemplate.postForEntity(url("/api/v1/auth/register"),
                new HttpEntity<>(Map.of("email", email, "password", "pw-12345678",
                        "name", "Plugin Tester"), jsonHeaders()), Map.class);
        assertEquals(HttpStatus.CREATED, registered.getStatusCode(),
                String.valueOf(registered.getBody()));
        return (String) registered.getBody().get("accessToken");
    }

    private ResponseEntity<Map> install(String token, String packagePath) {
        return exchange(token, HttpMethod.POST, "/api/v1/plugins/install",
                Map.of("packagePath", packagePath));
    }

    private ResponseEntity<Map> exchange(String token, HttpMethod method, String path,
            Object body) {
        HttpHeaders headers = jsonHeaders();
        headers.setBearerAuth(token);
        return restTemplate.exchange(url(path), method, new HttpEntity<>(body, headers),
                Map.class);
    }

    private static HttpEntity<Void> authEntity(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return new HttpEntity<>(headers);
    }

    private static HttpHeaders jsonHeaders() {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        return headers;
    }

    // ------------------------------------------------------------------ fixtures

    private static Path preparePackages() {
        try {
            Path root = Files.createTempDirectory("xihe-plugin-packages-");
            writeManifest(root.resolve("official/kv-selftest"), "official.kv-selftest",
                    "1.0.0", "builtin", "https://plugins.example.test/mcp");
            writeManifest(root.resolve("official/conflict"), "official.conflict", "1.0.0",
                    "builtin", "https://plugins.example.test/mcp");
            writeManifest(root.resolve("official/lifecycle"), "official.lifecycle", "1.0.0",
                    "builtin", "https://plugins.example.test/mcp");
            writeManifest(root.resolve("official/rollback"), "official.rollback", "1.0.0",
                    "builtin", "https://plugins.example.test/mcp");
            writeManifest(root.resolve("official/rollback-next"), "official.rollback", "1.1.0",
                    "builtin", "https://plugins.example.test/mcp");
            writeManifest(root.resolve("local/com.example.demo"), "com.example.demo", "1.0.0",
                    "third-party", "https://plugins.example.test/mcp");

            Path broken = root.resolve("official/broken");
            Files.createDirectories(broken);
            Files.writeString(broken.resolve("manifest.json"),
                    "{\"manifestVersion\":\"1\",\"id\":\"official.broken\",\"unexpected\":true}",
                    StandardCharsets.UTF_8);
            return root;
        } catch (IOException e) {
            throw new IllegalStateException("cannot prepare plugin package fixtures", e);
        }
    }

    private static void writeManifest(Path directory, String id, String version, String source,
            String endpoint) throws IOException {
        Files.createDirectories(directory);
        ObjectNode node = MAPPER.createObjectNode();
        node.put("manifestVersion", "1");
        node.put("id", id);
        node.put("version", version);
        node.put("source", source);
        node.put("title", id);
        node.putObject("runtime").put("kind", "mcp-http").put("endpoint", endpoint);
        node.putArray("actions").addObject().put("name", "demo.echo").put("actionClass",
                "read");
        node.putArray("requestedAtoms").add("plugin:invoke");
        node.putObject("compatibility").put("xhApi", "1.4");
        node.put("digest", PluginManifestValidator.computeDigest(node));
        Files.writeString(directory.resolve("manifest.json"),
                MAPPER.writeValueAsString(node), StandardCharsets.UTF_8);
    }
}

