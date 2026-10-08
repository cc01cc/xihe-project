package com.cc01cc.p.xihe.cp.api;

import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

class OpenApiYamlContractTest {

    @Test
    void openApiParsesAndContainsFollowUpQueueRoutes() throws Exception {
        Path contract = Path.of("..", "..", "docs", "api", "openapi.yaml");
        try (InputStream input = Files.newInputStream(contract)) {
            Object parsed = new Yaml().load(input);
            assertInstanceOf(Map.class, parsed);
            Map<?, ?> document = (Map<?, ?>) parsed;
            assertInstanceOf(Map.class, document.get("paths"));
            Map<?, ?> paths = (Map<?, ?>) document.get("paths");
            assertTrue(paths.containsKey("/api/v1/sessions/{sessionId}/follow-ups"));
            assertTrue(paths.containsKey("/api/v1/sessions/{sessionId}/follow-ups/{itemId}"));
            assertTrue(paths.containsKey("/api/v1/sessions/{sessionId}/follow-ups/continue"));
        }
    }
}
