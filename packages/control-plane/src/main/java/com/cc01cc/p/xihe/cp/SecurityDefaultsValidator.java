package com.cc01cc.p.xihe.cp;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * PLAN-0307 T3.4 (decisions #7/#25/#32): distributed fail-fast for dangerous factory defaults.
 *
 * <p>Runs after the config chain is loaded (CLI/env/files) and validates the effective values.
 * With an explicit {@code XIHE_ENV=prod}, any insecure default refuses startup and lists the
 * offending keys plus the fix; in dev/test (or unset, defaulting to dev) the same findings are
 * only WARNed, and the release gate must force an explicit {@code prod}. No Spring prod profile.
 *
 * <p>The key list mirrors {@code spec/config-env-target.md} §6 and is duplicated per module by
 * design (no shared runtime dependency); keep the three implementations in sync.
 */
public final class SecurityDefaultsValidator {

    private static final Logger logger = LoggerFactory.getLogger(SecurityDefaultsValidator.class);
    private static final String PROD_ENV_NAME = "prod";
    private static final String DEV_TOKEN = "dev-token-not-secure";
    private static final List<String> INSECURE_JWT_SECRETS = List.of(
            "xihe-cp-jwt-secret-key-change-in-production",
            "dev-jwt-secret-key-do-not-use-in-production-please-change");

    private SecurityDefaultsValidator() {}

    /** Validate the effective configuration; throws when prod is explicitly requested. */
    public static void enforce() {
        enforce(SecurityDefaultsValidator::value);
    }

    static void enforce(Function<String, String> envNameLookup) {
        String envName = envNameLookup.apply("XIHE_ENV");
        boolean prod = PROD_ENV_NAME.equals(envName);
        List<String> violations = collectViolations(SecurityDefaultsValidator::value);
        if (violations.isEmpty()) {
            return;
        }
        String body = String.join("\n - ", violations);
        if (prod) {
            logger.error("Refusing to start: insecure default configuration in prod mode:\n - {}\n"
                    + "Fix the keys above (set real secrets / disable dev keys), then restart.", body);
            throw new IllegalStateException("Insecure default configuration rejected in prod mode");
        }
        logger.warn("Insecure default configuration detected ({} mode: WARN only; a prod start "
                + "would refuse):\n - {}\nFix before deploying to prod.", envName == null ? "dev" : envName, body);
    }

    /** Effective value: loaded env-file values land in system properties, so they win over env. */
    static String value(String key) {
        String property = System.getProperty(key);
        return property != null ? property : System.getenv(key);
    }

    static List<String> collectViolations(Function<String, String> lookup) {
        List<String> violations = new ArrayList<>();
        String jwtSecret = lookup.apply("XIHE_CP_JWT_SECRET");
        if (jwtSecret != null && INSECURE_JWT_SECRETS.contains(jwtSecret)) {
            violations.add("XIHE_CP_JWT_SECRET: factory/placeholder secret is in use "
                    + "(generate a random secret, e.g. `openssl rand -base64 48`)");
        }
        if (DEV_TOKEN.equals(lookup.apply("XIHE_CP_API_TOKEN"))) {
            violations.add("XIHE_CP_API_TOKEN: dev token `dev-token-not-secure` is in use "
                    + "(set a strong service token)");
        }
        if (DEV_TOKEN.equals(lookup.apply("XIHE_AGENT_API_TOKEN"))) {
            violations.add("XIHE_AGENT_API_TOKEN: dev token `dev-token-not-secure` is in use "
                    + "(set a strong service token)");
        }
        if ("true".equalsIgnoreCase(lookup.apply("XIHE_CP_OAUTH_ALLOW_DEV_KEY"))) {
            violations.add("XIHE_CP_OAUTH_ALLOW_DEV_KEY: must be `false` in prod "
                    + "(dev fallback encryption key would be accepted)");
        }
        if ("true".equalsIgnoreCase(lookup.apply("XIHE_CP_PROVIDER_CREDENTIALS_ALLOW_DEV_KEY"))) {
            violations.add("XIHE_CP_PROVIDER_CREDENTIALS_ALLOW_DEV_KEY: must be `false` in prod "
                    + "(dev fallback encryption key would be accepted)");
        }
        if (isBlank(lookup.apply("XIHE_CP_OAUTH_ENCRYPTION_KEY"))) {
            violations.add("XIHE_CP_OAUTH_ENCRYPTION_KEY: required in prod (provide a base64 key)");
        }
        if (isBlank(lookup.apply("XIHE_CP_PROVIDER_CREDENTIALS_KEY"))) {
            violations.add("XIHE_CP_PROVIDER_CREDENTIALS_KEY: required in prod (provide a base64 key)");
        }
        return violations;
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }
}
