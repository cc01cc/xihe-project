package com.cc01cc.p.xihe.cp;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
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
        "XIHE_CP_OAUTH_ENCRYPTION_KEY",
        "XIHE_CP_PROVIDER_CREDENTIALS_KEY"
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
                    "XIHE_CP_PROVIDER_CREDENTIALS_ALLOW_DEV_KEY", "true");
            return values.get(key);
        });
        // 5 explicit insecure values + 2 empty-required encryption keys.
        assertEquals(7, violations.size());
    }

    @Test
    void prodWithInsecureDefaultsRefusesToStart() {
        System.setProperty("XIHE_ENV", "prod");
        System.setProperty("XIHE_CP_JWT_SECRET", "xihe-cp-jwt-secret-key-change-in-production");
        System.setProperty("XIHE_CP_OAUTH_ENCRYPTION_KEY", "secret-key");
        System.setProperty("XIHE_CP_PROVIDER_CREDENTIALS_KEY", "secret-key");

        assertThrows(IllegalStateException.class, SecurityDefaultsValidator::enforce);
    }

    @Test
    void prodWithSecureValuesStarts() {
        System.setProperty("XIHE_ENV", "prod");
        System.setProperty("XIHE_CP_JWT_SECRET", "a-real-random-secret");
        System.setProperty("XIHE_CP_API_TOKEN", "strong-service-token");
        System.setProperty("XIHE_CP_OAUTH_ALLOW_DEV_KEY", "false");
        System.setProperty("XIHE_CP_PROVIDER_CREDENTIALS_ALLOW_DEV_KEY", "false");
        System.setProperty("XIHE_CP_OAUTH_ENCRYPTION_KEY", "base64-key");
        System.setProperty("XIHE_CP_PROVIDER_CREDENTIALS_KEY", "base64-key");

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

        SecurityDefaultsValidator.enforce();
    }

    @Test
    void devAlsoAcceptsTemplateJwtPlaceholderAsViolation() {
        Map<String, String> env = new HashMap<>();
        env.put("XIHE_CP_JWT_SECRET", "dev-jwt-secret-key-do-not-use-in-production-please-change");
        assertTrue(SecurityDefaultsValidator.collectViolations(env::get).stream()
                .anyMatch(item -> item.startsWith("XIHE_CP_JWT_SECRET")));
    }
}
