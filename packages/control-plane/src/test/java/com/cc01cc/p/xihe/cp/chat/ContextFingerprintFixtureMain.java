package com.cc01cc.p.xihe.cp.chat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.JsonNode;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Prints the real-data fingerprint of a projection payload, so the determinism test can run it in a
 * <b>separate JVM</b> (design D6 / verify V1.4: two independent processes must agree). Deliberately
 * a plain {@code main} with no Spring context: the point is to prove the same file bytes produce the
 * same hash in a fresh process, not to test the dispatch wiring (that is M1b).
 */
public final class ContextFingerprintFixtureMain {

    private ContextFingerprintFixtureMain() {}

    public static void main(String[] args) throws IOException {
        if (args.length != 1) {
            System.err.println("usage: ContextFingerprintFixtureMain <projection.json>");
            System.exit(2);
        }
        JsonNode payload = new ObjectMapper().readTree(Files.readString(Path.of(args[0])));
        JsonNode messages = payload.path("messages");
        Map<String, Object> layers = new LinkedHashMap<>();
        layers.put("history", messages);
        if (payload.hasNonNull("metadata")) {
            layers.put("memory", payload.get("metadata"));
        }
        System.out.println("history=" + ContextFingerprintCalculator.hash(messages));
        System.out.println("whole=" + ContextFingerprintCalculator.hash(payload));
        System.out.println("layers=" + ContextFingerprintCalculator.calculate(layers, payload, 1)
                .path("layers").path("history").path("hash").asText());
    }
}
