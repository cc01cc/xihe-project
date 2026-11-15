package com.cc01cc.p.xihe.cp.config;

import org.junit.jupiter.api.Test;

import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * PLAN-0547: pins the dev admin password priority contract
 * (OS env > system property > random) for {@link DataSeeder#resolveSeededPassword}.
 * Pure-function tests — no global state mutation.
 *
 * <p>task-172 follow-up (Lead ruling 2026-11-15) adds the sibling question the disclosure log
 * depends on: {@link DataSeeder#isPasswordConfigured} must answer "configured?" with exactly the
 * same priority (env, then property, blank counts as absent). If the two drift, the boot either
 * prints an operator's secret or stays silent about a generated one — both are the failure this
 * pair exists to prevent.
 */
class DataSeederPasswordResolutionTest {

    private static Supplier<String> fixed(String value) {
        return () -> value;
    }

    @Test
    void osEnvWinsOverPropertyAndRandom() {
        String result = DataSeeder.resolveSeededPassword(
                fixed("from-env"), fixed("from-property"), fixed("from-random"));
        assertThat(result).isEqualTo("from-env");
    }

    @Test
    void propertyUsedWhenEnvAbsent() {
        String result = DataSeeder.resolveSeededPassword(
                fixed(null), fixed("from-property"), fixed("from-random"));
        assertThat(result).isEqualTo("from-property");
    }

    @Test
    void propertyUsedWhenEnvBlank() {
        String result = DataSeeder.resolveSeededPassword(
                fixed("  "), fixed("from-property"), fixed("from-random"));
        assertThat(result).isEqualTo("from-property");
    }

    @Test
    void randomFallbackWhenBothAbsent() {
        String result = DataSeeder.resolveSeededPassword(
                fixed(null), fixed(null), fixed("from-random"));
        assertThat(result).isEqualTo("from-random");
    }

    @Test
    void randomFallbackWhenBothBlank() {
        String result = DataSeeder.resolveSeededPassword(
                fixed(""), fixed("   "), fixed("from-random"));
        assertThat(result).isEqualTo("from-random");
    }

    @Test
    void configuredWhenEnvSet() {
        assertThat(DataSeeder.isPasswordConfigured(fixed("from-env"), fixed(null))).isTrue();
    }

    @Test
    void configuredWhenOnlyPropertySet() {
        assertThat(DataSeeder.isPasswordConfigured(fixed(null), fixed("from-property"))).isTrue();
    }

    @Test
    void configuredWhenEnvBlankButPropertySet() {
        assertThat(DataSeeder.isPasswordConfigured(fixed("   "), fixed("from-property"))).isTrue();
    }

    @Test
    void notConfiguredWhenBothAbsent() {
        // == the generated branch: this is the only case where the seeded password may be logged.
        assertThat(DataSeeder.isPasswordConfigured(fixed(null), fixed(null))).isFalse();
    }

    @Test
    void notConfiguredWhenBothBlank() {
        assertThat(DataSeeder.isPasswordConfigured(fixed(""), fixed("  "))).isFalse();
    }

    @Test
    void randomPathProduces32CharBase64url() {
        // Mirrors DataSeeder.generatePassword (private): 24 random bytes -> base64url.
        Supplier<String> random24 = () -> {
            byte[] bytes = new byte[24];
            new java.security.SecureRandom().nextBytes(bytes);
            return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        };
        String result = DataSeeder.resolveSeededPassword(() -> null, () -> null, random24);
        // 24 bytes -> 32 chars base64url without padding
        assertThat(result).hasSize(32).doesNotContain("=").matches("[A-Za-z0-9_-]{32}");
    }
}
