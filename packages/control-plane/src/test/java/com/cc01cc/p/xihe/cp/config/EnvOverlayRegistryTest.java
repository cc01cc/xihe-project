package com.cc01cc.p.xihe.cp.config;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class EnvOverlayRegistryTest {

    private EnvOverlayRegistry registryWith(Map<String, String> env) {
        return new EnvOverlayRegistry(env::get);
    }

    @Test
    void activeOverrides_mapsEmbeddingModelFromEnv() {
        EnvOverlayRegistry registry =
            registryWith(Map.of("XIHE_EMBEDDING_MODEL", "text-embedding-v3"));

        assertEquals(Map.of("model", "text-embedding-v3"), registry.activeOverrides("embedding"));
        assertTrue(registry.activeOverrides("llm-provider").isEmpty());
    }

    @Test
    void activeOverrides_ignoresBlankValues() {
        EnvOverlayRegistry registry = registryWith(Map.of("XIHE_EMBEDDING_MODEL", "   "));

        assertTrue(registry.activeOverrides("embedding").isEmpty());
    }

    @Test
    void overlayValue_resolvesPerKey() {
        assertTrue(registryWith(Map.<String, String>of()).overlayValue("embedding", "model").isEmpty());

        EnvOverlayRegistry registry = registryWith(Map.of("XIHE_EMBEDDING_MODEL", "m"));
        assertEquals("m", registry.overlayValue("embedding", "model").orElseThrow());
        assertTrue(registry.overlayValue("embedding", "unknown").isEmpty());
    }
}
