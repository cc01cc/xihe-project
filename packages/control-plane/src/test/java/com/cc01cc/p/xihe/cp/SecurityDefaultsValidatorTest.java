package com.cc01cc.p.xihe.cp;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

class SecurityDefaultsValidatorTest {

    private static final String[] PROPERTY_KEYS = {
        "XIHE_ENV",
        "XIHE_CP_JWT_SECRET",
        "XIHE_CP_API_TOKEN",
        "XIHE_AGENT_API_TOKEN",
        "XIHE_CP_OAUTH_ALLOW_DEV_KEY",
        "XIHE_CP_PROVIDER_CREDENTIALS_ALLOW_DEV_KEY",
        "XIHE_CP_CREDENTIALS_ALLOW_DEV_KEY",
        "XIHE_CP_OAUTH_ENCRYPTION_KEY",
        "XIHE_CP_PROVIDER_CREDENTIALS_KEY",
        "XIHE_CP_CREDENTIALS_KEY",
        "XIHE_CP_CREDENTIALS_KEY_RING",
        "XIHE_CP_CREDENTIALS_FINGERPRINT_KEY",
        "XIHE_CP_DATASOURCE_PASSWORD",
        "XIHE_CP_DATASOURCE_PASSWORD_ALLOW_BLANK"
    };

    @AfterEach
    void clearProperties() {
        for (String key : PROPERTY_KEYS) {
            System.clearProperty(key);
        }
    }

    @Test
    void collectViolationsFlagsAllDangerousDefaults() {
        List<String> violations = SecurityDefaultsValidator.collectViolations(key -> {
            Map<String, String> values = Map.of(
                    "XIHE_CP_JWT_SECRET", "xihe-cp-jwt-secret-key-change-in-production",
                    "XIHE_CP_API_TOKEN", "dev-token-not-secure",
                    "XIHE_AGENT_API_TOKEN", "dev-token-not-secure",
                    "XIHE_CP_OAUTH_ALLOW_DEV_KEY", "true",
                    "XIHE_CP_PROVIDER_CREDENTIALS_ALLOW_DEV_KEY", "true",
                    "XIHE_CP_CREDENTIALS_ALLOW_DEV_KEY", "true");
            return values.get(key);
        });
        // 6 explicit insecure values + 5 empty-required secrets (the last one is the database
        // password, DSD-1491 ② / task-98: optional only in dev, mandatory in prod).
        assertEquals(11, violations.size());
    }

    @Test
    void prodWithInsecureDefaultsRefusesToStart() {
        System.setProperty("XIHE_ENV", "prod");
        System.setProperty("XIHE_CP_JWT_SECRET", "xihe-cp-jwt-secret-key-change-in-production");
        System.setProperty("XIHE_CP_OAUTH_ENCRYPTION_KEY", "secret-key");
        System.setProperty("XIHE_CP_PROVIDER_CREDENTIALS_KEY", "secret-key");
        System.setProperty("XIHE_CP_CREDENTIALS_KEY", "secret-key");
        System.setProperty("XIHE_CP_CREDENTIALS_FINGERPRINT_KEY", "secret-key");

        assertThrows(IllegalStateException.class, SecurityDefaultsValidator::enforce);
    }

    @Test
    void prodWithSecureValuesStarts() {
        System.setProperty("XIHE_ENV", "prod");
        System.setProperty("XIHE_CP_JWT_SECRET", "a-real-random-secret");
        System.setProperty("XIHE_CP_API_TOKEN", "strong-service-token");
        System.setProperty("XIHE_CP_OAUTH_ALLOW_DEV_KEY", "false");
        System.setProperty("XIHE_CP_PROVIDER_CREDENTIALS_ALLOW_DEV_KEY", "false");
        System.setProperty("XIHE_CP_CREDENTIALS_ALLOW_DEV_KEY", "false");
        System.setProperty("XIHE_CP_OAUTH_ENCRYPTION_KEY", "base64-key");
        System.setProperty("XIHE_CP_PROVIDER_CREDENTIALS_KEY", "base64-key");
        System.setProperty("XIHE_CP_CREDENTIALS_KEY", "base64-key");
        System.setProperty("XIHE_CP_CREDENTIALS_FINGERPRINT_KEY", "base64-key");
        System.setProperty("XIHE_CP_DATASOURCE_PASSWORD", "pg-password");

        SecurityDefaultsValidator.enforce();
    }

    @Test
    void unsetEnvWarnsButDoesNotFail() {
        System.clearProperty("XIHE_ENV");
        System.setProperty("XIHE_CP_JWT_SECRET", "xihe-cp-jwt-secret-key-change-in-production");

        SecurityDefaultsValidator.enforce();
    }

    @Test
    void explicitDevWarnsButDoesNotFail() {
        System.setProperty("XIHE_ENV", "dev");
        System.setProperty("XIHE_CP_API_TOKEN", "dev-token-not-secure");
        System.setProperty("XIHE_CP_OAUTH_ENCRYPTION_KEY", "base64-key");
        System.setProperty("XIHE_CP_PROVIDER_CREDENTIALS_KEY", "base64-key");
        System.setProperty("XIHE_CP_CREDENTIALS_KEY", "base64-key");

        SecurityDefaultsValidator.enforce();
    }

    @Test
    void devAlsoAcceptsTemplateJwtPlaceholderAsViolation() {
        Map<String, String> env = new HashMap<>();
        env.put("XIHE_CP_JWT_SECRET", "dev-jwt-secret-key-do-not-use-in-production-please-change");
        assertTrue(SecurityDefaultsValidator.collectViolations(env::get).stream()
                .anyMatch(item -> item.startsWith("XIHE_CP_JWT_SECRET")));
    }

    @Test
    void credentialKeyRingSatisfiesProdRequirement() {
        Map<String, String> env = new HashMap<>();
        env.put("XIHE_CP_CREDENTIALS_KEY_RING", "{\"v1\":\"base64-key\"}");
        env.put("XIHE_CP_CREDENTIALS_FINGERPRINT_KEY", "base64-key");
        assertFalse(SecurityDefaultsValidator.collectViolations(env::get).stream()
                .anyMatch(item -> item.startsWith("XIHE_CP_CREDENTIALS_KEY")));
    }

    @Test
    void missingFingerprintKeyIsAProdViolation() {
        Map<String, String> env = new HashMap<>();
        env.put("XIHE_CP_JWT_SECRET", "a-real-random-secret");
        env.put("XIHE_CP_API_TOKEN", "strong-service-token");
        env.put("XIHE_CP_AGENT_API_TOKEN", "strong-service-token");
        env.put("XIHE_CP_OAUTH_ALLOW_DEV_KEY", "false");
        env.put("XIHE_CP_PROVIDER_CREDENTIALS_ALLOW_DEV_KEY", "false");
        env.put("XIHE_CP_CREDENTIALS_ALLOW_DEV_KEY", "false");
        env.put("XIHE_CP_OAUTH_ENCRYPTION_KEY", "base64-key");
        env.put("XIHE_CP_PROVIDER_CREDENTIALS_KEY", "base64-key");
        env.put("XIHE_CP_CREDENTIALS_KEY", "base64-key");
        env.put("XIHE_CP_DATASOURCE_PASSWORD", "pg-password");

        List<String> violations = SecurityDefaultsValidator.collectViolations(env::get);
        assertEquals(1, violations.size(), "only the fingerprint key is missing");
        assertTrue(violations.get(0).startsWith("XIHE_CP_CREDENTIALS_FINGERPRINT_KEY"));
    }

    /** DSD-1491 ② (task-98 正1): a prod start without the database password is refused. */
    @Test
    void prodWithBlankDatasourcePasswordRefusesToStart() {
        System.setProperty("XIHE_ENV", "prod");
        System.setProperty("XIHE_CP_JWT_SECRET", "a-real-random-secret");
        System.setProperty("XIHE_CP_API_TOKEN", "strong-service-token");
        System.setProperty("XIHE_AGENT_API_TOKEN", "strong-service-token");
        System.setProperty("XIHE_CP_OAUTH_ALLOW_DEV_KEY", "false");
        System.setProperty("XIHE_CP_PROVIDER_CREDENTIALS_ALLOW_DEV_KEY", "false");
        System.setProperty("XIHE_CP_CREDENTIALS_ALLOW_DEV_KEY", "false");
        System.setProperty("XIHE_CP_OAUTH_ENCRYPTION_KEY", "base64-key");
        System.setProperty("XIHE_CP_PROVIDER_CREDENTIALS_KEY", "base64-key");
        System.setProperty("XIHE_CP_CREDENTIALS_KEY", "base64-key");
        System.setProperty("XIHE_CP_CREDENTIALS_FINGERPRINT_KEY", "base64-key");

        List<String> violations = SecurityDefaultsValidator.collectViolations(SecurityDefaultsValidator::value);
        assertEquals(1, violations.size(), "only the database password is missing");
        assertTrue(violations.get(0).startsWith("XIHE_CP_DATASOURCE_PASSWORD"));
        assertThrows(IllegalStateException.class, SecurityDefaultsValidator::enforce);
    }

    /**
     * DSD-1491 ② (task-98 反1): the dev stack runs PostgreSQL passwordless and opts out with an
     * explicit switch; the very same switch must not silence the prod gate (正2: a real password
     * needs no switch at all).
     */
    @Test
    void datasourcePasswordOptOutIsHonoredOnlyOutsideProd() {
        Map<String, String> dev = new HashMap<>();
        dev.put("XIHE_ENV", "dev");
        dev.put("XIHE_CP_DATASOURCE_PASSWORD_ALLOW_BLANK", "true");
        assertFalse(datasourcePasswordViolation(dev).isPresent(), "the dev stack must be able to opt out");

        Map<String, String> prodWithSwitch = new HashMap<>();
        prodWithSwitch.put("XIHE_ENV", "prod");
        prodWithSwitch.put("XIHE_CP_DATASOURCE_PASSWORD_ALLOW_BLANK", "true");
        assertTrue(datasourcePasswordViolation(prodWithSwitch).isPresent(),
                "the opt-out must never apply in prod");

        Map<String, String> prodWithPassword = new HashMap<>();
        prodWithPassword.put("XIHE_ENV", "prod");
        prodWithPassword.put("XIHE_CP_DATASOURCE_PASSWORD", "pg-password");
        assertFalse(datasourcePasswordViolation(prodWithPassword).isPresent(),
                "a configured database password satisfies the prod gate");
    }

    private static Optional<String> datasourcePasswordViolation(Map<String, String> env) {
        return SecurityDefaultsValidator.collectViolations(env::get).stream()
                .filter(item -> item.startsWith("XIHE_CP_DATASOURCE_PASSWORD"))
                .findFirst();
    }

    @Test
    void credentialDevKeyFlagIsFlagged() {
        Map<String, String> env = new HashMap<>();
        env.put("XIHE_CP_CREDENTIALS_ALLOW_DEV_KEY", "true");
        env.put("XIHE_CP_CREDENTIALS_KEY", "base64-key");
        assertTrue(SecurityDefaultsValidator.collectViolations(env::get).stream()
                .anyMatch(item -> item.startsWith("XIHE_CP_CREDENTIALS_ALLOW_DEV_KEY")));
    }
}
