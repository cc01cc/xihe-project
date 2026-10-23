package com.cc01cc.p.xihe.cp.config;

import org.junit.jupiter.api.Test;

import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * PLAN-0547: pins the dev admin password priority contract
 * (OS env > system property > random) for {@link DataSeeder#resolveSeededPassword}.
 * Pure-function tests — no global state mutation.
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
