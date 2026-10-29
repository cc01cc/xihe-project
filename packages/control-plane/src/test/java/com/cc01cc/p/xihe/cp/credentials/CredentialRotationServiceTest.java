package com.cc01cc.p.xihe.cp.credentials;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.crypto.EnvelopeEncryptionService;
import com.cc01cc.p.xihe.cp.entity.Credential;
import com.cc01cc.p.xihe.cp.repository.CredentialRepository;
import org.junit.jupiter.api.Test;
import org.springframework.data.domain.Pageable;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyShort;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0576 T3.2: run-local failure classification and cursor progress without a
 * database — CAS conflicts and undecryptable rows are counted as unmigratable
 * but never stop the scan, and there is no failure limit.
 */
class CredentialRotationServiceTest {

    private static final byte[] KEY_V1 =
            "0123456789abcdef0123456789abcdef".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] KEY_V2 =
            "fedcba9876543210fedcba9876543210".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] FINGERPRINT_KEY =
            "00112233445566778899aabbccddeeff".getBytes(StandardCharsets.US_ASCII);

    private final CredentialRepository repository = mock(CredentialRepository.class);
    private final AuditLogger auditLogger = mock(AuditLogger.class);
    private final EnvelopeEncryptionService encryption = new EnvelopeEncryptionService(
            Map.of("v1", KEY_V1, "v2", KEY_V2), "v2");
    private final CredentialRotationService service = new CredentialRotationService(
            repository, encryption, new CredentialEnvelope(encryption),
            new CredentialFingerprint(FINGERPRINT_KEY), auditLogger);

    @Test
    void casConflictsAreCountedButDoNotStopTheCursor() {
        Credential first = v1Row("conflict-row");
        Credential second = v1Row("migrated-row");
        stubPage(first, second);

        when(repository.compareAndSetSecret(any(), anyString(), anyString(), eq("v2"),
                anyShort(), anyString(), eq(Credential.FINGERPRINT_VERSION_HMAC_SHA256_V1), any()))
                .thenReturn(0);
        when(repository.compareAndSetSecret(eq(second.getId()), anyString(), anyString(), eq("v2"),
                anyShort(), anyString(), eq(Credential.FINGERPRINT_VERSION_HMAC_SHA256_V1), any()))
                .thenReturn(1);

        CredentialRotationService.BatchResult result = service.rotateBatch(2);

        assertEquals(2, result.scanned());
        assertEquals(1, result.migrated());
        assertEquals(1, result.conflicts());
        assertEquals(0, result.failures());
        assertEquals(1L, result.remaining());
        assertEquals("v2", result.targetVersion());
        verify(auditLogger).recordCredentialRotation("system", 1, 1, 0, 1L, "v2");
    }

    @Test
    void unknownAadVersionIsAFailureAndDoesNotBlockLaterRows() {
        Credential broken = v1Row("broken-row");
        broken.setAadVersion((short) 3);
        Credential healthy = v1Row("healthy-row");
        stubPage(broken, healthy);

        when(repository.compareAndSetSecret(eq(healthy.getId()), anyString(), anyString(), eq("v2"),
                anyShort(), anyString(), eq(Credential.FINGERPRINT_VERSION_HMAC_SHA256_V1), any()))
                .thenReturn(1);

        CredentialRotationService.BatchResult result = service.rotateBatch(2);

        assertEquals(2, result.scanned());
        assertEquals(1, result.migrated());
        assertEquals(1, result.failures());
        assertEquals(0, result.conflicts());
        assertEquals(1L, result.remaining());
        verify(auditLogger).recordCredentialRotation("system", 1, 0, 1, 1L, "v2");
    }

    private void stubPage(Credential... rows) {
        when(repository.findMigrationBatchAfter(any(UUID.class), eq("v2"), any(Pageable.class)))
                .thenReturn(List.of(rows), List.of());
        when(repository.countByKeyVersionNot("v2")).thenReturn(1L);
        when(repository.countPendingMigration("v2")).thenReturn(1L);
    }

    private static Credential v1Row(String token) {
        UUID id = UUID.randomUUID();
        String ownerId = UUID.randomUUID().toString();
        Credential row = new Credential();
        row.setId(id);
        row.setOwnerType(Credential.OWNER_USER);
        row.setOwnerId(ownerId);
        row.setKind(Credential.KIND_TOKEN);
        row.setRevision(1);
        row.setKeyVersion("v1");
        row.setAadVersion(Credential.AAD_VERSION_LEGACY);
        row.setFingerprintVersion(Credential.FINGERPRINT_VERSION_SHA256);
        row.setSecretCiphertext(new EnvelopeEncryptionService(KEY_V1).encrypt(
                "{\"token\":\"" + token + "\"}",
                CredentialAad.formatV1(id.toString(), Credential.OWNER_USER, ownerId)));
        return row;
    }
}
