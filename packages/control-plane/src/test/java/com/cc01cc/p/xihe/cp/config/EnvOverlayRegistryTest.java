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

    @Test
    void activeOverrides_mapsJobTimeoutKeysFromEnv() {
        // PLAN-0373 decision #7：job-policy 两键为注册表第二组成 overlap（装机注入类）。
        EnvOverlayRegistry registry = registryWith(Map.of(
            "XIHE_JOB_TIMEOUT_DEFAULT_SECS", "7200",
            "XIHE_JOB_TIMEOUT_MAX_SECS", "3600"));

        assertEquals(
            Map.of("defaultTimeoutSecs", "7200", "maxTimeoutSecs", "3600"),
            registry.activeOverrides("job-policy"));
        assertEquals("7200",
            registry.overlayValue("job-policy", "defaultTimeoutSecs").orElseThrow());
        assertTrue(registry.activeOverrides("approval-policy").isEmpty());
    }

    @Test
    void activeOverrides_jobTimeoutPartialEnvOnlyLocksPresentKey() {
        EnvOverlayRegistry registry =
            registryWith(Map.of("XIHE_JOB_TIMEOUT_MAX_SECS", "1800"));

        assertEquals(Map.of("maxTimeoutSecs", "1800"),
            registry.activeOverrides("job-policy"));
    }
}
