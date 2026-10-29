package com.cc01cc.p.xihe.cp.credentials;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * PLAN-0576 T2.4: keyed fingerprint stability/domain separation and the single
 * canonical implementation shared by create/replace and rotation.
 */
class CredentialFingerprintTest {

    private static final byte[] KEY =
            "0123456789abcdef0123456789abcdef".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] OTHER_KEY =
            "fedcba9876543210fedcba9876543210".getBytes(StandardCharsets.US_ASCII);

    private final CredentialFingerprint fingerprint = new CredentialFingerprint(KEY);

    @Test
    void hmacIsStableAndSixtyFourHexChars() {
        String first = fingerprint.fingerprint("token-value");
        String second = fingerprint.fingerprint("token-value");

        assertEquals(first, second);
        assertEquals(64, first.length());
        assertEquals(first, first.toLowerCase());
    }

    @Test
    void hmacDiffersFromLegacySha256() {
        assertNotEquals(CredentialFingerprint.legacySha256("token-value"),
                fingerprint.fingerprint("token-value"));
    }

    @Test
    void differentKeysProduceDifferentFingerprints() {
        assertNotEquals(fingerprint.fingerprint("token-value"),
                new CredentialFingerprint(OTHER_KEY).fingerprint("token-value"));
    }

    @Test
    void keyMustBeExactly32Bytes() {
        assertThrows(IllegalArgumentException.class, () -> new CredentialFingerprint(new byte[16]));
        assertThrows(IllegalArgumentException.class, () -> new CredentialFingerprint(null));
    }

    @Test
    void payloadAndJsonEntryPointsShareTheCanonicalForm() {
        String tokenFromPayload = CredentialSecretCodec.canonical("token",
                CredentialService.SecretPayload.ofToken("sk-value"));
        String tokenFromJson = CredentialSecretCodec.canonical("token", "{\"token\":\"sk-value\"}");
        assertEquals(tokenFromPayload, tokenFromJson);
        assertEquals(fingerprint.fingerprint(tokenFromPayload), fingerprint.fingerprint(tokenFromJson));

        String pairFromPayload = CredentialSecretCodec.canonical("key_pair",
                CredentialService.SecretPayload.ofKeyPair("AKIA", "secret"));
        String pairFromJson = CredentialSecretCodec.canonical("key_pair",
                "{\"accessKey\":\"AKIA\",\"secretKey\":\"secret\"}");
        assertEquals("AKIA\nsecret", pairFromPayload);
        assertEquals(pairFromPayload, pairFromJson);
        assertEquals(fingerprint.fingerprint(pairFromPayload), fingerprint.fingerprint(pairFromJson));
    }

    @Test
    void codecRejectsInvalidOrIncompletePayloads() {
        assertThrows(IllegalArgumentException.class,
                () -> CredentialSecretCodec.canonical("token", "not-json"));
        assertThrows(IllegalArgumentException.class,
                () -> CredentialSecretCodec.canonical("token", "{\"accessKey\":\"a\"}"));
        assertThrows(IllegalArgumentException.class,
                () -> CredentialSecretCodec.canonical("key_pair", "{\"accessKey\":\"a\"}"));
    }
}
