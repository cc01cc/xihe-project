package com.cc01cc.p.xihe.cp.oauth;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.Map;

import org.junit.jupiter.api.Test;

class EnvelopeEncryptionServiceTest {

    private static final byte[] KEY = "01234567890123456789012345678901".getBytes(StandardCharsets.US_ASCII);

    @Test
    void roundTripUsesVersionedEnvelopeAndRandomNonce() {
        var service = new EnvelopeEncryptionService(KEY);
        String first = service.encrypt("refresh-secret", "u1:w1:m1");
        String second = service.encrypt("refresh-secret", "u1:w1:m1");

        assertEquals("refresh-secret", service.decrypt(first, "u1:w1:m1"));
        assertNotEquals(first, second);
    }

    @Test
    void aadMismatchAndTamperingFailClosed() {
        var service = new EnvelopeEncryptionService(KEY);
        String envelope = service.encrypt("refresh-secret", "u1:w1:m1");

        assertThrows(IllegalArgumentException.class, () -> service.decrypt(envelope, "u2:w1:m1"));
        assertThrows(IllegalArgumentException.class, () -> service.decrypt(envelope + "x", "u1:w1:m1"));
    }

    @Test
    void masterKeyMustBeAes256() {
        assertThrows(IllegalArgumentException.class, () -> new EnvelopeEncryptionService(new byte[16]));
    }

    @Test
    void keyRingDecryptsOldVersionAndEncryptsWithCurrentVersion() {
        byte[] oldKey = "01234567890123456789012345678901".getBytes(StandardCharsets.US_ASCII);
        byte[] newKey = "12345678901234567890123456789012".getBytes(StandardCharsets.US_ASCII);
        var oldService = new EnvelopeEncryptionService(oldKey);
        String oldEnvelope = oldService.encrypt("refresh-secret", "binding");
        var rotated = new EnvelopeEncryptionService(Map.of("v1", oldKey, "v2", newKey), "v2");
        assertEquals("refresh-secret", rotated.decrypt(oldEnvelope, "binding"));
        String newEnvelope = rotated.encrypt("refresh-secret", "binding");
        assertTrue(newEnvelope.startsWith("v2:"));
        assertEquals("refresh-secret", rotated.decrypt(newEnvelope, "binding"));
    }
}
