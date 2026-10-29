package com.cc01cc.p.xihe.cp.credentials;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0495 T1.2/T1.3（契约: PLAN-0494 #8 决策基线 + PLAN-0495 V1/V5/V7）：
 * credential 加密域配置——单 key 与 key ring 两形态、缺 current 启动失败、
 * dev fallback 门、AAD 绑定（跨凭据/跨 owner 拼接解密失败）。
 */
class CredentialCryptoConfigTest {

    private static final byte[] KEY_V1 =
            "01234567890123456789012345678901".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] KEY_V2 =
            "12345678901234567890123456789012".getBytes(StandardCharsets.US_ASCII);

    private final CredentialCryptoConfig config = new CredentialCryptoConfig();

    private static String base64(byte[] key) {
        return Base64.getEncoder().encodeToString(key);
    }

    @Test
    void singleKeyRoundTripsAndUsesCurrentVersion() {
        var service = config.credentialEncryption(base64(KEY_V1), "", "v1", true);
        String aad = CredentialAad.formatV1("c-1", "USER", "u-1");
        String envelope = service.encrypt("{\"token\":\"secret\"}", aad);

        assertTrue(envelope.startsWith("v1:"));
        assertEquals("{\"token\":\"secret\"}", service.decrypt(envelope, aad));
    }

    @Test
    void ciphertextBoundToCredentialAndOwnerFailsWhenReused() {
        var service = config.credentialEncryption(base64(KEY_V1), "", "v1", true);
        String envelope = service.encrypt("payload", CredentialAad.formatV1("c-1", "USER", "u-1"));

        assertNotEquals(
                CredentialAad.formatV1("c-1", "USER", "u-1"),
                CredentialAad.formatV1("c-2", "USER", "u-1"));
        assertThrows(IllegalArgumentException.class,
                () -> service.decrypt(envelope, CredentialAad.formatV1("c-2", "USER", "u-1")));
        assertThrows(IllegalArgumentException.class,
                () -> service.decrypt(envelope, CredentialAad.formatV1("c-1", "WORKSPACE", "u-1")));
    }

    @Test
    void keyRingDecryptsOldVersionAndEncryptsWithCurrent() {
        String ring = "{\"v1\":\"" + base64(KEY_V1) + "\",\"v2\":\"" + base64(KEY_V2) + "\"}";
        var legacy = config.credentialEncryption(base64(KEY_V1), "", "v1", true);
        String oldEnvelope = legacy.encrypt("payload", "aad");

        var rotated = config.credentialEncryption("", ring, "v2", true);
        assertEquals("payload", rotated.decrypt(oldEnvelope, "aad"));
        assertTrue(rotated.encrypt("payload", "aad").startsWith("v2:"));
    }

    @Test
    void ringMissingCurrentVersionRefusesStartup() {
        String ring = "{\"v1\":\"" + base64(KEY_V1) + "\"}";
        var error = assertThrows(IllegalStateException.class,
                () -> config.credentialEncryption("", ring, "v2", true));
        assertTrue(error.getMessage().contains("missing the current version"));
    }

    @Test
    void singleKeyAndRingAreMutuallyExclusive() {
        String ring = "{\"v1\":\"" + base64(KEY_V1) + "\"}";
        assertThrows(IllegalStateException.class,
                () -> config.credentialEncryption(base64(KEY_V1), ring, "v1", true));
    }

    @Test
    void blankKeyWithoutDevFallbackRefusesStartup() {
        assertThrows(IllegalStateException.class,
                () -> config.credentialEncryption("", "", "v1", false));
    }

    @Test
    void devFallbackDerivesStableKeyAndRoundTrips() {
        var dev = config.credentialEncryption("", "", "v1", true);
        var devAgain = config.credentialEncryption("", "", "v1", true);
        String envelope = dev.encrypt("payload", "aad");

        assertEquals("payload", devAgain.decrypt(envelope, "aad"));
    }

    @Test
    void devFallbackHonorsConfiguredCurrentVersion() {
        var dev = config.credentialEncryption("", "", "v2", true);
        String envelope = dev.encrypt("payload", "aad");

        assertEquals("v2", dev.currentVersion());
        assertTrue(envelope.startsWith("v2:"));
        assertEquals("payload", dev.decrypt(envelope, "aad"));
    }

    @Test
    void devFallbackWarnsAboutThePublicDevelopmentKey() {
        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender =
                new ch.qos.logback.core.read.ListAppender<>();
        appender.start();
        ch.qos.logback.classic.Logger logger = (ch.qos.logback.classic.Logger)
                org.slf4j.LoggerFactory.getLogger(CredentialCryptoConfig.class);
        logger.addAppender(appender);
        try {
            config.credentialEncryption("", "", "v1", true);
            assertTrue(appender.list.stream()
                            .map(event -> event.getFormattedMessage())
                            .anyMatch(message -> message.contains("credential dev key active")),
                    "the dev fallback must WARN about the public derived key (V5)");
        } finally {
            logger.detachAppender(appender);
            appender.stop();
        }
    }

    @Test
    void nonCanonicalVersionsAreRejectedOnBothConfigurationPaths() {
        assertThrows(IllegalStateException.class,
                () -> config.credentialEncryption(base64(KEY_V1), "", "v1:bad", true),
                "the colon would corrupt the envelope format");
        assertThrows(IllegalStateException.class,
                () -> config.credentialEncryption(base64(KEY_V1), "", "x".repeat(17), true),
                "versions longer than the key_version column must fail at startup");
    }

    @Test
    void invalidBase64KeyRejected() {
        assertThrows(IllegalStateException.class,
                () -> config.credentialEncryption("not-base64!", "", "v1", true));
    }

    @Test
    void wrongLengthKeyRejected() {
        assertThrows(IllegalStateException.class,
                () -> config.credentialEncryption(base64(new byte[16]), "", "v1", true));
    }

    @Test
    void invalidRingJsonRejected() {
        assertThrows(IllegalStateException.class,
                () -> config.credentialEncryption("", "not-json", "v1", true));
    }

    @Test
    void emptyRingObjectRejected() {
        assertThrows(IllegalStateException.class,
                () -> config.credentialEncryption("", "{}", "v1", true));
    }

    @Test
    void ringVersionWithColonRejected() {
        String ring = "{\"v1:x\":\"" + base64(KEY_V1) + "\"}";
        assertThrows(IllegalStateException.class,
                () -> config.credentialEncryption("", ring, "v1:x", true));
    }

    @Test
    void fingerprintKeyIsStableAcrossInstances() {
        CredentialFingerprint first = config.credentialFingerprint(base64(KEY_V1), true);
        CredentialFingerprint second = config.credentialFingerprint(base64(KEY_V1), true);

        String one = first.fingerprint("token-value");
        assertEquals(one, second.fingerprint("token-value"));
        assertEquals(64, one.length());
    }

    @Test
    void fingerprintKeyMissingWithoutDevFallbackRefusesStartup() {
        assertThrows(IllegalStateException.class,
                () -> config.credentialFingerprint("", false));
    }

    @Test
    void fingerprintKeyMustBe32Bytes() {
        assertThrows(IllegalStateException.class,
                () -> config.credentialFingerprint(base64(new byte[16]), true));
    }

    @Test
    void fingerprintDevFallbackWarnsAndIsStable() {
        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender =
                new ch.qos.logback.core.read.ListAppender<>();
        appender.start();
        ch.qos.logback.classic.Logger logger = (ch.qos.logback.classic.Logger)
                org.slf4j.LoggerFactory.getLogger(CredentialCryptoConfig.class);
        logger.addAppender(appender);
        try {
            CredentialFingerprint dev = config.credentialFingerprint("", true);
            CredentialFingerprint devAgain = config.credentialFingerprint("", true);
            assertEquals(dev.fingerprint("token-value"), devAgain.fingerprint("token-value"));
            assertTrue(appender.list.stream()
                            .map(event -> event.getFormattedMessage())
                            .anyMatch(message -> message.contains("credential fingerprint dev key active")),
                    "the fingerprint dev fallback must WARN (V5)");
        } finally {
            logger.detachAppender(appender);
            appender.stop();
        }
    }
}
