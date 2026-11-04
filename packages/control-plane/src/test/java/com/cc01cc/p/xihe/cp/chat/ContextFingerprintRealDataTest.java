package com.cc01cc.p.xihe.cp.chat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0666 M1a: real-data determinism (verify V1.4, Lead's hard requirement).
 *
 * <p>The fixture is a sanitized copy of a real {@code context_projections.payload} row. PostgreSQL
 * rewrites {@code jsonb} object keys (length-then-byte order), so this input carries key orders that
 * a hand-built fixture would never reproduce. Two <b>independent JVMs</b> must produce byte-identical
 * fingerprints from it — that is the check that catches "canonicalization only works inside one
 * process/JVM version" regressions (design D6 / R2).
 */
class ContextFingerprintRealDataTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Test
    void realProjectionHashesIdenticallyInTwoIndependentJvms() throws Exception {
        Path fixture = fixturePath();
        JsonNode payload = MAPPER.readTree(fixture.toFile());
        String inProcess = inProcessOutput(payload);
        String first = runChildJvm(fixture);
        String second = runChildJvm(fixture);
        assertEquals(first, second, "two independent JVMs must compute the same fingerprint");
        assertEquals(inProcess, first, "child JVM output must agree with the in-process calculation");
    }

    @Test
    void fixtureKeepsRealProjectionShapeAndStaysSanitized() throws Exception {
        JsonNode payload = MAPPER.readTree(fixturePath().toFile());
        assertTrue(payload.path("messages").isArray(), "fixture must keep the real history array");
        assertTrue(payload.path("messages").size() >= 2, "fixture must keep a realistic history");
        assertTrue(payload.has("metadata"), "fixture must keep metadata (context_sources)");
        assertTrue(payload.get("metadata").path("context_sources").isObject(),
                "fixture must keep the real context_sources shape (object with status/source_hash)");
        assertTrue(payload.get("metadata").path("context_sources").has("status"),
                "context_sources must keep its real fields");
        assertFalse(payload.toString().contains("hello"), "fixture content must be sanitized");
    }

    /** Same computation the child JVM runs, so the two processes can be compared line by line. */
    private static String inProcessOutput(JsonNode payload) {
        JsonNode messages = payload.path("messages");
        Map<String, Object> layers = new LinkedHashMap<>();
        layers.put("history", messages);
        if (payload.hasNonNull("metadata")) {
            layers.put("memory", payload.get("metadata"));
        }
        return String.join("\n",
                "history=" + ContextFingerprintCalculator.hash(messages),
                "whole=" + ContextFingerprintCalculator.hash(payload),
                "layers=" + ContextFingerprintCalculator.calculate(layers, payload, 1)
                        .path("layers").path("history").path("hash").asText());
    }

    private static String runChildJvm(Path fixture) throws Exception {
        boolean windows = System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT).contains("win");
        Path java = Path.of(System.getProperty("java.home"), "bin", windows ? "java.exe" : "java");
        String classpath = System.getProperty("surefire.test.class.path",
                System.getProperty("java.class.path"));
        Process process = new ProcessBuilder(
                java.toString(), "-cp", classpath, ContextFingerprintFixtureMain.class.getName(), fixture.toString())
                .redirectErrorStream(true)
                .start();
        String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8)
                .replace("\r\n", "\n")
                .trim();
        boolean finished = process.waitFor(120, TimeUnit.SECONDS);
        if (!finished) {
            process.destroyForcibly();
        }
        assertTrue(finished, "child JVM timed out; classpath=" + classpath);
        assertEquals(0, process.exitValue(), "child JVM failed: " + output);
        // The JVM prints launcher banner lines such as
        //   Picked up JAVA_TOOL_OPTIONS: -Xmx4g
        // on stderr; this harness merges stderr into stdout, so an L2 run that sets
        // JAVA_TOOL_OPTIONS (the standard 4 GiB heap cap) would otherwise look like a
        // fingerprint mismatch. The banner is launcher noise, not calculator output.
        return output.lines()
                .filter(line -> !line.startsWith("Picked up "))
                .reduce((left, right) -> left + "\n" + right)
                .orElse("");
    }

    private static Path fixturePath() throws Exception {
        return Path.of(Objects.requireNonNull(
                ContextFingerprintRealDataTest.class.getResource("/context-fingerprint/real-projection.json"),
                "real-data fixture missing").toURI());
    }
}
