package com.cc01cc.p.xihe.cp.config;

import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-167 (DSD-1519 R1): the merged read face answers the documented code defaults, and does so
 * without touching the execution face. The merge itself is pure, so this class needs no context;
 * {@link ConfigServiceTest} carries the one assertion that the execution resolver stays empty.
 */
class ConfigReadFaceDefaultsTest {

    private static final String CONTEXT_POLICY_DEFAULTS =
        "{\"fingerprintEnabled\":true,\"maxInputTokens\":128000,\"pruneWindowChars\":80000,"
            + "\"recoveryBand\":0.8,\"summaryProvider\":\"rule\",\"summaryTimeoutMs\":15000}";

    @Test
    void anUnsetDomainAnswersTheDocumentedCodeDefaults() {
        assertEquals(Map.of("mode", "manual"),
            ConfigService.mergeReadFaceDefaults("approval-policy", Map.of()));
        assertEquals(Map.of("defaults", CONTEXT_POLICY_DEFAULTS),
            ConfigService.mergeReadFaceDefaults("context-policy", Map.of()));
        assertEquals(Map.of("theme", "system", "language", "zh-CN"),
            ConfigService.mergeReadFaceDefaults("user-preference", Map.of()));
    }

    @Test
    void anExplicitRowWinsOverTheCodeDefault() {
        Map<String, String> merged = ConfigService.mergeReadFaceDefaults(
            "user-preference", Map.of("theme", "dark"));

        assertEquals("dark", merged.get("theme"));
        assertEquals("zh-CN", merged.get("language"), "the untouched key still falls back");
    }

    @Test
    void aBlankRowCountsAsAbsentSoClearingFallsBackToTheCodeDefault() {
        // Only the instance layer can delete a row: the user and workspace layers clear by writing
        // "", so a blank value must not pin the key to empty.
        Map<String, String> merged = ConfigService.mergeReadFaceDefaults(
            "approval-policy", Map.of("mode", "  "));

        assertEquals("manual", merged.get("mode"));
    }

    @Test
    void domainsWithoutCodeDefaultsAreReturnedUnchanged() {
        Map<String, String> stored = new LinkedHashMap<>();
        stored.put("chunkSize", "1500");

        assertSame(stored, ConfigService.mergeReadFaceDefaults("rag", stored),
            "no read-face defaults means no copy, so callers keep the resolver result");
        assertTrue(ConfigService.mergeReadFaceDefaults("job-policy", Map.of()).isEmpty());
        assertNull(ConfigService.mergeReadFaceDefaults("approval-policy", null));
    }

    @Test
    void nothingIsInventedForKeysWithoutARuntimeFallback() {
        assertEquals(Map.of("mode", "manual"),
            ConfigService.mergeReadFaceDefaults("approval-policy", Map.of()),
            "askActionClasses has no code default: the read face must not invent one");
    }
}