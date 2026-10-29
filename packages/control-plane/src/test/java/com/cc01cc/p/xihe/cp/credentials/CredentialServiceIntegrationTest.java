package com.cc01cc.p.xihe.cp.credentials;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.Credential;
import com.cc01cc.p.xihe.cp.entity.CredentialEvent;
import com.cc01cc.p.xihe.cp.repository.CredentialEventRepository;
import com.cc01cc.p.xihe.cp.repository.CredentialRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0495 T2.1/T2.2/T2.3（契约: 0494 I1/I2 + 0495 §方案 4/5, V2/V4/V7）：
 * 生命周期服务——创建/replace（保 ID、revision+1、重指纹）/软删/existsForOwner
 * 作用域；每次变更落 credential_events（永不落值）与 AuditLogger；明文与后缀
 * 扫描断言（DB 非密文列 + 审计流）。
 */
class CredentialServiceIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private CredentialService credentialService;

    @Autowired
    private CredentialRepository credentialRepository;

    @Autowired
    private CredentialEventRepository credentialEventRepository;

    @Autowired
    private CredentialEnvelope credentialEnvelope;

    @Autowired
    @Qualifier("credentialFingerprint")
    private CredentialFingerprint credentialFingerprint;

    private ch.qos.logback.core.read.ListAppender<
            ch.qos.logback.classic.spi.ILoggingEvent> auditAppender;

    // Attached per test method: Spring Boot initializes the logging system when
    // the test context is created (after @BeforeAll), which reloads the logback
    // configuration and drops appenders attached too early.
    @BeforeEach
    void attachAuditAppender() {
        auditAppender = new ch.qos.logback.core.read.ListAppender<>();
        auditAppender.start();
        ((ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger("AUDIT"))
                .addAppender(auditAppender);
    }

    @AfterEach
    void detachAuditAppender() {
        ((ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger("AUDIT"))
                .detachAppender(auditAppender);
        auditAppender.stop();
    }

    @Test
    void createPersistsEncryptedRowEventsAndAudit() {
        String ownerId = UUID.randomUUID().toString();
        String actor = UUID.randomUUID().toString();
        String secret = "sk-live-integration-create-0123456789";

        Credential created = credentialService.create(new CredentialService.CreateRequest(
                "USER", ownerId, "primary-token", "token", "lease",
                CredentialService.SecretPayload.ofToken(secret)), actor);

        Credential row = credentialRepository.findByIdAndDeletedAtIsNull(created.getId()).orElseThrow();
        assertEquals(Credential.OWNER_USER, row.getOwnerType());
        assertEquals(ownerId, row.getOwnerId());
        assertEquals(1, row.getRevision());
        assertEquals(Credential.STATUS_ACTIVE, row.getStatus());
        assertEquals(Credential.TIER_LEASE, row.getDeliveryTier());
        assertEquals("v1", row.getKeyVersion());
        assertTrue(row.getSecretCiphertext().startsWith("v1:"));
        assertFalse(row.getSecretCiphertext().contains(secret));
        assertEquals(64, row.getFingerprint().length());
        assertEquals(Credential.AAD_VERSION_V2, row.getAadVersion());
        assertEquals(Credential.FINGERPRINT_VERSION_HMAC_SHA256_V1, row.getFingerprintVersion());

        String decrypted = credentialEnvelope.decrypt(row);
        assertEquals("{\"token\":\"" + secret + "\"}", decrypted);

        List<CredentialEvent> events = credentialEventRepository
                .findByCredentialIdOrderByCreatedAtDesc(created.getId().toString());
        assertEquals(1, events.size());
        assertEquals(CredentialEvent.TYPE_CREATED, events.get(0).getEventType());
        assertEquals(actor, events.get(0).getActor());
        assertEquals(ownerId, events.get(0).getOwnerId());

        String auditLine = lastAuditMessage();
        assertTrue(auditLine.contains("action=credential_created"));
        assertTrue(auditLine.contains(created.getId().toString()));
        assertTrue(auditLine.contains(row.getFingerprint()));
        assertFalse(auditLine.contains(secret));
    }

    @Test
    void createRejectsReservedBrokerTierAndInvalidInputs() {
        String ownerId = UUID.randomUUID().toString();
        CredentialService.SecretPayload token = CredentialService.SecretPayload.ofToken("token-value-123");

        assertThrows(IllegalArgumentException.class, () -> credentialService.create(
                new CredentialService.CreateRequest("USER", ownerId, "l", "token", "broker", token),
                null), "broker tier must be rejected at the write layer (0495 #9)");
        assertThrows(IllegalArgumentException.class, () -> credentialService.create(
                new CredentialService.CreateRequest("USER", ownerId, "l", "oauth_bundle", "lease", token),
                null));
        assertThrows(IllegalArgumentException.class, () -> credentialService.create(
                new CredentialService.CreateRequest("SYSTEM", ownerId, "l", "token", "lease", token),
                null), "SYSTEM is not a v1 credential owner (0494 #5)");
        assertThrows(IllegalArgumentException.class, () -> credentialService.create(
                new CredentialService.CreateRequest("USER", ownerId, " ", "token", "lease", token),
                null));
        assertThrows(IllegalArgumentException.class, () -> credentialService.create(
                new CredentialService.CreateRequest("USER", ownerId, "l", "key_pair", "lease", token),
                null), "key_pair requires an access/secret pair payload");
        assertThrows(IllegalArgumentException.class, () -> credentialService.create(
                new CredentialService.CreateRequest("USER", "not-a-uuid", "l", "token", "lease", token),
                null));
    }

    @Test
    void replaceKeepsIdBumpsRevisionAndRefingerprints() {
        String ownerId = UUID.randomUUID().toString();
        String actor = UUID.randomUUID().toString();
        Credential created = credentialService.create(new CredentialService.CreateRequest(
                "USER", ownerId, "rotating", "token", "lease",
                CredentialService.SecretPayload.ofToken("first-secret-value-1")), actor);

        Credential replaced = credentialService.replaceSecret(created.getId(),
                CredentialService.SecretPayload.ofToken("second-secret-value-2"), actor);

        assertEquals(created.getId(), replaced.getId());
        assertEquals(2, replaced.getRevision());
        assertNotNull(replaced.getReplacedAt());
        assertNotEquals(created.getFingerprint(), replaced.getFingerprint());
        assertEquals(Credential.AAD_VERSION_V2, replaced.getAadVersion());
        assertEquals(Credential.FINGERPRINT_VERSION_HMAC_SHA256_V1, replaced.getFingerprintVersion());
        String decrypted = credentialEnvelope.decrypt(replaced);
        assertEquals("{\"token\":\"second-secret-value-2\"}", decrypted);

        List<CredentialEvent> events = credentialEventRepository
                .findByCredentialIdOrderByCreatedAtDesc(created.getId().toString());
        assertEquals(2, events.size());
        assertEquals(CredentialEvent.TYPE_REPLACED, events.get(0).getEventType());
        assertTrue(allAuditText().contains("action=credential_replaced"),
                "the audit stream must distinguish the replaced action (V4)");
    }

    @Test
    void replaceAndDeleteMissingOrDeletedCredentialFail() {
        assertThrows(CredentialNotFoundException.class, () -> credentialService.replaceSecret(
                UUID.randomUUID(), CredentialService.SecretPayload.ofToken("v"), null));

        Credential created = credentialService.create(new CredentialService.CreateRequest(
                "USER", UUID.randomUUID().toString(), "temp", "token", "lease",
                CredentialService.SecretPayload.ofToken("temp-secret")), null);
        credentialService.delete(created.getId(), null);

        assertThrows(CredentialNotFoundException.class, () -> credentialService.replaceSecret(
                created.getId(), CredentialService.SecretPayload.ofToken("v2"), null));
        assertThrows(CredentialNotFoundException.class, () -> credentialService.delete(
                created.getId(), null));

        assertNotNull(credentialRepository.findById(created.getId()).orElseThrow().getDeletedAt());
        List<CredentialEvent> events = credentialEventRepository
                .findByCredentialIdOrderByCreatedAtDesc(created.getId().toString());
        assertEquals(2, events.size());
        assertEquals(CredentialEvent.TYPE_DELETED, events.get(0).getEventType());
        assertEquals(CredentialEvent.ACTOR_SYSTEM, events.get(0).getActor());
        assertTrue(allAuditText().contains("action=credential_deleted"),
                "the audit stream must distinguish the deleted action (V4)");
    }

    @Test
    void existsForOwnerIsScopedAndSoftDeleteAware() {
        String ownerId = UUID.randomUUID().toString();
        Credential created = credentialService.create(new CredentialService.CreateRequest(
                "USER", ownerId, "scoped", "token", "lease",
                CredentialService.SecretPayload.ofToken("scoped-secret")), null);
        String id = created.getId().toString();

        assertTrue(credentialService.existsForOwner("USER", ownerId, id));
        assertTrue(credentialService.existsForOwner("user", ownerId.toUpperCase(), id));
        assertFalse(credentialService.existsForOwner("WORKSPACE", ownerId, id));
        assertFalse(credentialService.existsForOwner("USER", UUID.randomUUID().toString(), id));
        assertFalse(credentialService.existsForOwner("USER", ownerId, UUID.randomUUID().toString()));
        assertFalse(credentialService.existsForOwner("USER", ownerId, "not-a-uuid"));
        assertFalse(credentialService.existsForOwner(null, null, null));

        credentialService.delete(created.getId(), null);
        assertFalse(credentialService.existsForOwner("USER", ownerId, id),
                "soft-deleted rows must not satisfy the dangling check");
    }

    @Test
    void plaintextAndSuffixNeverReachDbOrAuditStreams() {
        String ownerId = UUID.randomUUID().toString();
        String secret = "integration-scan-secret-tail7Zq9md-abcdef";
        String suffix = "tail7Zq9md";

        Credential created = credentialService.create(new CredentialService.CreateRequest(
                "USER", ownerId, "scan-target", "token", "lease",
                CredentialService.SecretPayload.ofToken(secret)), null);
        credentialService.replaceSecret(created.getId(),
                CredentialService.SecretPayload.ofToken(secret + "-v2"), null);
        credentialService.delete(created.getId(), null);

        for (Credential row : credentialRepository.findAll()) {
            assertFalse(row.getSecretCiphertext().contains(secret), "ciphertext must not embed plaintext");
            assertFalse(row.getSecretCiphertext().contains(suffix), "ciphertext must not embed the suffix");
            assertFalse(row.getFingerprint().contains(suffix));
            assertFalse(row.getLabel().contains(suffix));
            assertFalse(row.getKeyVersion().contains(suffix));
        }
        for (CredentialEvent event : credentialEventRepository.findAll()) {
            assertFalse(event.getActor().contains(suffix));
            assertFalse(event.getEventType().contains(suffix));
        }
        assertFalse(allAuditText().contains(secret), "audit stream must not carry the plaintext");
        assertFalse(allAuditText().contains(suffix), "audit stream must not carry the plaintext suffix");
    }

    @Test
    void fingerprintIsDeterministicAndDistinct() {
        String tokenCanonical = CredentialSecretCodec.canonical("token",
                CredentialService.SecretPayload.ofToken("abc"));
        String a1 = credentialFingerprint.fingerprint(tokenCanonical);
        String a2 = credentialFingerprint.fingerprint(CredentialSecretCodec.canonical("token",
                CredentialService.SecretPayload.ofToken("abc")));
        String b = credentialFingerprint.fingerprint(CredentialSecretCodec.canonical("token",
                CredentialService.SecretPayload.ofToken("abd")));
        String pair = credentialFingerprint.fingerprint(CredentialSecretCodec.canonical("key_pair",
                CredentialService.SecretPayload.ofKeyPair("abc", "def")));

        assertEquals(a1, a2);
        assertNotEquals(a1, b);
        assertNotEquals(a1, pair);
        assertEquals(64, a1.length());
        assertNotEquals(CredentialFingerprint.legacySha256(tokenCanonical), a1,
                "the keyed fingerprint must differ from the legacy bare SHA-256 (V5)");
    }

    @Test
    void replaceSecretFencesAgainstStaleRevisionWrites() {
        Credential created = credentialService.create(new CredentialService.CreateRequest(
                "USER", UUID.randomUUID().toString(), "fenced", "token", "lease",
                CredentialService.SecretPayload.ofToken("fence-secret-1")), null);

        int stale = credentialRepository.replaceSecretIfRevisionMatches(created.getId(), 99,
                "v1:stale:write", "fp-stale", "v1", Credential.AAD_VERSION_LEGACY,
                Credential.FINGERPRINT_VERSION_SHA256, Instant.now());
        assertEquals(0, stale, "a stale revision must never overwrite a concurrent change");

        int fresh = credentialRepository.replaceSecretIfRevisionMatches(created.getId(), 1,
                "v1:fresh:write", "fp-fresh", "v1", Credential.AAD_VERSION_LEGACY,
                Credential.FINGERPRINT_VERSION_SHA256, Instant.now());
        assertEquals(1, fresh);
        assertEquals(2, credentialRepository.findById(created.getId()).orElseThrow().getRevision());
    }

    @Test
    void softDeleteFencesAgainstRepeatAndNeverRewritesTheRow() {
        Credential created = credentialService.create(new CredentialService.CreateRequest(
                "USER", UUID.randomUUID().toString(), "delete-fence", "token", "lease",
                CredentialService.SecretPayload.ofToken("delete-fence-secret")), null);

        assertEquals(1, credentialRepository.softDeleteIfActive(created.getId(), Instant.now()));
        assertEquals(0, credentialRepository.softDeleteIfActive(created.getId(), Instant.now()),
                "an already soft-deleted row must never be rewritten (no revive, no rollback)");
        assertNotNull(credentialRepository.findById(created.getId()).orElseThrow().getDeletedAt());
    }

    @Test
    void keyPairPayloadRoundTripsThroughCreateAndReplace() {
        String ownerId = UUID.randomUUID().toString();
        Credential created = credentialService.create(new CredentialService.CreateRequest(
                "WORKSPACE", ownerId, "pair-secret", "key_pair", "reveal",
                CredentialService.SecretPayload.ofKeyPair("AKIA-example-access", "pair-secret-x9")), null);

        Credential row = credentialRepository.findByIdAndDeletedAtIsNull(created.getId()).orElseThrow();
        assertEquals(Credential.OWNER_WORKSPACE, row.getOwnerType());
        assertEquals(Credential.KIND_KEY_PAIR, row.getKind());
        assertEquals(Credential.TIER_REVEAL, row.getDeliveryTier());
        assertEquals("{\"accessKey\":\"AKIA-example-access\",\"secretKey\":\"pair-secret-x9\"}",
                credentialEnvelope.decrypt(row));

        Credential replaced = credentialService.replaceSecret(created.getId(),
                CredentialService.SecretPayload.ofKeyPair("AKIA-rotated-access", "pair-secret-y7"), null);
        assertEquals("{\"accessKey\":\"AKIA-rotated-access\",\"secretKey\":\"pair-secret-y7\"}",
                credentialEnvelope.decrypt(replaced));
        assertEquals(2, replaced.getRevision());
    }

    private String lastAuditMessage() {
        assertFalse(auditAppender.list.isEmpty(), "expected at least one AUDIT line");
        return auditAppender.list.get(auditAppender.list.size() - 1).getFormattedMessage();
    }

    private String allAuditText() {
        return auditAppender.list.stream()
                .map(event -> event.getFormattedMessage())
                .collect(Collectors.joining("\n"));
    }
}
