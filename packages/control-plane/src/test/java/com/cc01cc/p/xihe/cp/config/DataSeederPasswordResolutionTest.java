package com.cc01cc.p.xihe.cp.config;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

import java.nio.file.Files;
import java.nio.file.Path;
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
        // == the generated branch. Since D-1753 ② (task-62) even this case must NOT log the value:
        // cp.out.log is a permanent-retention surface, so "printed exactly once" was still a leak.
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

    /* ---------------- D-1753 ② (task-62): the disclosure log must never carry the value -------- */

    /**
     * The disclosure method only reads static fields and the logger, so a bare instance is enough —
     * no Spring context, no database, no global state mutation (the appender is detached again).
     */
    private static DataSeeder bareSeeder() {
        return new DataSeeder(null, null, null, null, null, null, null, "", false);
    }
    private static void assertNoValueLogged(boolean created) {
        Logger logger = (Logger) LoggerFactory.getLogger(DataSeeder.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        try {
            bareSeeder().logSeededPasswordDisclosure(created);
            // Not empty: a silent method would pass a "does not contain" assertion vacuously.
            assertThat(appender.list).isNotEmpty();
            assertThat(appender.list).allSatisfy(event ->
                    assertThat(event.getFormattedMessage()).doesNotContain(DataSeeder.seededAdminPassword()));
        } finally {
            logger.detachAppender(appender);
            appender.stop();
        }
    }

    @Test
    void disclosureOnFreshRowNeverLogsThePasswordValue() {
        assertNoValueLogged(true);
    }

    @Test
    void disclosureOnReusedRowNeverLogsThePasswordValue() {
        assertNoValueLogged(false);
    }

    /**
     * Source-level companion to the two behavioural tests above: they only see the branch this
     * JVM's env selects, so a value re-added to the <em>other</em> branch would slip through them.
     * This scans the whole method body instead: the password constant may not appear in it at all
     * ({@code ADMIN_PASSWORD_GENERATED} is a different identifier and stays allowed), and the
     * recovery command must be named — removing the disclosure without naming a way back in would
     * trade a leak for a lockout.
     */
    @Test
    void disclosureMethodBodyNeverReferencesThePasswordConstant() throws Exception {
        Path source = Path.of("src/main/java/com/cc01cc/p/xihe/cp/config/DataSeeder.java");
        String text = Files.readString(source);
        int start = text.indexOf("void logSeededPasswordDisclosure");
        assertThat(start).as("disclosure method must exist").isGreaterThanOrEqualTo(0);
        int end = text.indexOf("\n    }", start);
        assertThat(end).isGreaterThan(start);
        String body = text.substring(start, end);
        assertThat(body).doesNotContainPattern("(?<![_A-Za-z])ADMIN_PASSWORD(?![_A-Za-z])");
        assertThat(body).contains("mise run reset-admin");
    }
}
