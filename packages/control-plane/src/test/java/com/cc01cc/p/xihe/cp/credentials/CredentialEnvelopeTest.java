package com.cc01cc.p.xihe.cp.credentials;

import com.cc01cc.p.xihe.cp.crypto.EnvelopeEncryptionService;
import com.cc01cc.p.xihe.cp.entity.Credential;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0576 T1.4/T1.7: the unified envelope entry point — v1 compatibility,
 * v2 round-trip, explicit unknown-version failure and the "only the ciphertext
 * column was swapped" negatives (old revision / other kind / other key version
 * / other owner).
 */
class CredentialEnvelopeTest {

    private static final byte[] KEY_V1 =
            "0123456789abcdef0123456789abcdef".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] KEY_V2 =
            "fedcba9876543210fedcba9876543210".getBytes(StandardCharsets.US_ASCII);

    private final EnvelopeEncryptionService encryption = new EnvelopeEncryptionService(
            Map.of("v1", KEY_V1, "v2", KEY_V2), "v2");
    private final CredentialEnvelope envelope = new CredentialEnvelope(encryption);

    @Test
    void v1RowStillDecryptsWithTheLegacyAad() {
        Credential row = row(Credential.AAD_VERSION_LEGACY, 1, "v1");
        row.setSecretCiphertext(encryption.encrypt("{\"token\":\"legacy\"}",
                CredentialAad.formatV1(row.getId().toString(), row.getOwnerType(), row.getOwnerId())));

        assertEquals("{\"token\":\"legacy\"}", envelope.decrypt(row));
    }

    @Test
    void encryptV2StampsTheVersionAndRoundTrips() {
        Credential row = row(Credential.AAD_VERSION_LEGACY, 1, "v2");
        String ciphertext = envelope.encryptV2(row, "{\"token\":\"fresh\"}");
        row.setSecretCiphertext(ciphertext);

        assertEquals(Credential.AAD_VERSION_V2, row.getAadVersion(),
                "new writes must not rely on the V84 column default");
        assertTrue(ciphertext.startsWith("v2:"));
        assertEquals("{\"token\":\"fresh\"}", envelope.decrypt(row));
    }

    @Test
    void unknownAadVersionFailsExplicitly() {
        Credential row = row((short) 3, 1, "v2");
        row.setSecretCiphertext("v2:nonce:cipher");

        IllegalArgumentException error = assertThrows(IllegalArgumentException.class,
                () -> envelope.decrypt(row));
        assertTrue(error.getMessage().contains("Unsupported credential AAD version: 3"));
        assertThrows(IllegalArgumentException.class,
                () -> envelope.encrypt(row, "payload"));
    }

    @Test
    void v2MissingContextFieldFailsInsteadOfGuessing() {
        Credential row = row(Credential.AAD_VERSION_V2, 1, "v2");
        row.setKind(null);
        row.setSecretCiphertext("v2:nonce:cipher");

        assertThrows(IllegalArgumentException.class, () -> envelope.decrypt(row));
    }

    @Test
    void ciphertextFromAnOlderRevisionIsRejected() {
        Credential row = row(Credential.AAD_VERSION_V2, 2, "v2");
        String revisionTwoCiphertext = envelope.encryptV2(row, "{\"token\":\"rev-2\"}");

        Credential rolledBack = row(Credential.AAD_VERSION_V2, 1, "v2");
        rolledBack.setSecretCiphertext(revisionTwoCiphertext);

        assertThrows(IllegalArgumentException.class, () -> envelope.decrypt(rolledBack));
    }

    @Test
    void ciphertextFromAnotherKindIsRejected() {
        Credential tokenRow = row(Credential.AAD_VERSION_V2, 1, "v2");
        String tokenCiphertext = envelope.encryptV2(tokenRow, "{\"token\":\"value\"}");

        Credential pairRow = row(Credential.AAD_VERSION_V2, 1, "v2");
        pairRow.setKind(Credential.KIND_KEY_PAIR);
        pairRow.setSecretCiphertext(tokenCiphertext);

        assertThrows(IllegalArgumentException.class, () -> envelope.decrypt(pairRow));
    }

    @Test
    void ciphertextFromAnotherKeyVersionIsRejected() {
        Credential row = row(Credential.AAD_VERSION_V2, 1, "v2");
        String v2Ciphertext = envelope.encryptV2(row, "{\"token\":\"value\"}");

        Credential mislabeled = row(Credential.AAD_VERSION_V2, 1, "v1");
        mislabeled.setSecretCiphertext(v2Ciphertext);

        assertThrows(IllegalArgumentException.class, () -> envelope.decrypt(mislabeled));
    }

    @Test
    void ciphertextFromAnotherOwnerIsRejected() {
        Credential row = row(Credential.AAD_VERSION_V2, 1, "v2");
        String ciphertext = envelope.encryptV2(row, "{\"token\":\"value\"}");

        Credential otherOwner = row(Credential.AAD_VERSION_V2, 1, "v2");
        otherOwner.setOwnerId(UUID.randomUUID().toString());
        otherOwner.setSecretCiphertext(ciphertext);

        assertThrows(IllegalArgumentException.class, () -> envelope.decrypt(otherOwner));
    }

    @Test
    void v1CiphertextUnderV2AadFails() {
        Credential row = row(Credential.AAD_VERSION_V2, 1, "v1");
        row.setSecretCiphertext(encryption.encrypt("{\"token\":\"legacy\"}",
                CredentialAad.formatV1(row.getId().toString(), row.getOwnerType(), row.getOwnerId())));

        assertThrows(IllegalArgumentException.class, () -> envelope.decrypt(row));
    }

    private static Credential row(short aadVersion, int revision, String keyVersion) {
        Credential row = new Credential();
        row.setId(UUID.randomUUID());
        row.setOwnerType(Credential.OWNER_USER);
        row.setOwnerId(UUID.randomUUID().toString());
        row.setKind(Credential.KIND_TOKEN);
        row.setDeliveryTier(Credential.TIER_LEASE);
        row.setRevision(revision);
        row.setKeyVersion(keyVersion);
        row.setAadVersion(aadVersion);
        return row;
    }
}
