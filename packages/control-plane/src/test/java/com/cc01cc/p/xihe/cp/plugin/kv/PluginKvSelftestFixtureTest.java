package com.cc01cc.p.xihe.cp.plugin.kv;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.plugin.PluginManifest;
import com.cc01cc.p.xihe.cp.plugin.PluginManifestValidator;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0691 T1.5 / B-6 ①: the {@code official.kv-selftest} fixture package must be installable, must
 * stay inside the plugin boundary, and must not drift away from its own declared client.
 *
 * <p>Why a test instead of a note in the README: the fixture lives outside the Maven module, so
 * nothing else in the build ever reads it. Without this class a broken digest or a stray database
 * call would be discovered only by whoever next tries to use the fixture — and "the fixture does not
 * install" reads like a CP bug, not a fixture bug, which sends the investigator to the wrong file.</p>
 *
 * <p>Four independent groups:
 * <ol>
 *   <li>{@link #theFixtureManifestIsAnInstallableBuiltinPackage} — real
 *       {@link PluginManifestValidator} run (schema, cross-field semantics, digest recompute);</li>
 *   <li>{@link #aTamperedCopyOfTheFixtureIsRejected} — negative control, so group 1 cannot pass by
 *       the validator being lenient;</li>
 *   <li>{@link #theFixtureNeverReachesTheDatabase} — cross-layer-matrix.md V1, static;</li>
 *   <li>{@link #theDeclarativeClientAndTheServerDescribeTheSameSteps} — the two hand-written
 *       descriptions of the same probe must not drift apart.</li>
 * </ol>
 */
class PluginKvSelftestFixtureTest {

    /** Repo-root-relative location; the test walks up from the module dir to find it. */
    private static final String FIXTURE_DIR = "plugins/official/official.kv-selftest";
    private static final Pattern CLIENT_STEP = Pattern.compile("\"step\"\\s*:\\s*\"([a-z][a-z0-9-]+)\"");
    private static final Pattern SERVER_STEP = Pattern.compile("record\\(\"([a-z][a-z0-9-]+)\"");

    @Test
    void theFixtureManifestIsAnInstallableBuiltinPackage() throws IOException {
        PluginManifest manifest = PluginManifestValidator.validate(
                Files.readAllBytes(fixtureDir().resolve("manifest.json")), "builtin");

        assertEquals("official.kv-selftest", manifest.id());
        assertEquals("builtin", manifest.source());
        assertEquals("1", manifest.manifestVersion());
        assertEquals("mcp-http", manifest.raw().path("runtime").path("kind").asText());
        assertEquals(List.of("plugin:invoke", "plugin:data"), manifest.requestedAtoms());

        assertEquals(1, manifest.actions().size());
        assertEquals("kv_selftest", manifest.actions().getFirst().name());
        // The probe writes and deletes a key, so declaring it `read` (as the spec example happens to)
        // would under-state its authority: every fixture action must carry its real action class.
        assertEquals("write", manifest.actions().getFirst().actionClass());

        // storage.kv is what the CP install path turns into per-binding quota; these are the numbers
        // PluginKvService/PluginKvLimits actually enforce against (spec/data-plane.md §2 caps).
        assertEquals(List.of("selftest"), textList(manifest.raw().path("storage").path("kv")
                .path("namespaces")));
        assertEquals(200, manifest.raw().path("storage").path("kv").path("maxKeys").asInt());
        assertEquals(8192, manifest.raw().path("storage").path("kv").path("maxValueBytes").asInt());
        assertEquals(3600, manifest.raw().path("storage").path("kv").path("ttlSecondsMax").asInt());

        // The digest in the file must be the canonical one. A placeholder copied from
        // spec/examples/valid-01-kv-selftest.json would pass schema validation and fail only at
        // install time, which is exactly the failure mode this assertion exists to prevent.
        assertEquals(PluginManifestValidator.computeDigest(manifest.raw()), manifest.digest(),
                "manifest.json digest is stale: recompute it after any field change");
    }

    @Test
    void aTamperedCopyOfTheFixtureIsRejected() throws IOException {
        String original = Files.readString(fixtureDir().resolve("manifest.json"), StandardCharsets.UTF_8);
        String tampered = original.replace("\"maxKeys\": 200", "\"maxKeys\": 201");
        assertNotEquals(original, tampered, "the fixture no longer declares maxKeys: 200");

        CpApiException rejected = assertThrows(CpApiException.class, () -> PluginManifestValidator
                .validate(tampered.getBytes(StandardCharsets.UTF_8), "builtin"));
        assertEquals(422, rejected.getStatus().value());
        assertEquals(PluginManifestValidator.ERROR_CODE, rejected.getCode());
        assertTrue(rejected.getMessage().contains("digest mismatch"), rejected.getMessage());
    }

    @Test
    void theFixtureNeverReachesTheDatabase() throws IOException {
        // verify.md V1 / cross-layer-matrix.md: plugins talk to CP over /internal/v1 and never open a
        // database session. A single line of SQL in the fixture would silently invalidate V1 for the
        // whole chain while every HTTP assertion stayed green.
        String server = Files.readString(fixtureDir().resolve("server.py"), StandardCharsets.UTF_8)
                .toLowerCase(Locale.ROOT);
        List<String> forbidden = List.of("psycopg", "pg8000", "sqlalchemy", "jdbc", "create table",
                "create schema", "insert into", "sqlite3", "flyway");
        List<String> found = forbidden.stream().filter(server::contains).toList();
        assertTrue(found.isEmpty(), "a plugin must not touch the database; server.py contains " + found);
        assertTrue(server.contains("/internal/v1/plugin-bindings/"),
                "the fixture's only store must be CP's plugin KV data plane");
        assertFalse(server.contains("curl "), "no shelling out to curl: keep the probe in-process");
    }

    @Test
    void theDeclarativeClientAndTheServerDescribeTheSameSteps() throws IOException {
        List<String> declared = AllowedSteps.of(CLIENT_STEP, Files.readString(
                fixtureDir().resolve("client.json"), StandardCharsets.UTF_8));
        List<String> recorded = AllowedSteps.of(SERVER_STEP, Files.readString(
                fixtureDir().resolve("server.py"), StandardCharsets.UTF_8));

        assertFalse(declared.isEmpty(), "client.json declares no steps");
        assertEquals(declared.size(), new LinkedHashSet<>(declared).size(),
                "client.json step names must be unique: " + declared);
        assertEquals(declared, recorded,
                "client.json and server.py disagree about the probe; keep them in the same order");
    }

    private static List<String> textList(com.fasterxml.jackson.databind.JsonNode node) {
        List<String> values = new ArrayList<>();
        node.forEach(element -> values.add(element.asText()));
        return values;
    }

    private static Path fixtureDir() throws IOException {
        Path current = Paths.get("").toAbsolutePath();
        for (Path candidate = current; candidate != null; candidate = candidate.getParent()) {
            Path manifest = candidate.resolve(FIXTURE_DIR).resolve("manifest.json");
            if (Files.isRegularFile(manifest)) {
                return manifest.getParent();
            }
        }
        throw new IOException("cannot locate " + FIXTURE_DIR
                + " by walking up from " + current + "; the fixture is part of this task's deliverable");
    }

    /** Ordered capture of one regex group across a file, used to compare the two step lists. */
    private static final class AllowedSteps {
        private AllowedSteps() {
        }

        static List<String> of(Pattern pattern, String text) {
            List<String> steps = new ArrayList<>();
            Matcher matcher = pattern.matcher(text);
            while (matcher.find()) {
                steps.add(matcher.group(1));
            }
            return steps;
        }
    }
}
