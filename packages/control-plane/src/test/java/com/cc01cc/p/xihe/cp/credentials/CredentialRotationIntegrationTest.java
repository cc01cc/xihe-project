package com.cc01cc.p.xihe.cp.credentials;

import com.cc01cc.p.xihe.cp.crypto.EnvelopeEncryptionService;
import com.cc01cc.p.xihe.cp.entity.Credential;
import com.cc01cc.p.xihe.cp.repository.CredentialEventRepository;
import com.cc01cc.p.xihe.cp.repository.CredentialLeaseRepository;
import com.cc01cc.p.xihe.cp.repository.CredentialRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.client.DefaultResponseErrorHandler;
import org.springframework.web.client.RestTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0495 M3 key rotation + PLAN-0576 M3 crypto migration: v1→v2 AAD and
 * SHA-256→HMAC fingerprint promotion in one id-cursor run, key rotation, soft
 * delete skip, failure crossing, CAS fences against replace/delete, and
 * deliverability after migration.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Testcontainers
@ActiveProfiles("test")
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class CredentialRotationIntegrationTest {

    private static final byte[] KEY_V1 =
            "0123456789abcdef0123456789abcdef".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] KEY_V2 =
            "fedcba9876543210fedcba9876543210".getBytes(StandardCharsets.US_ASCII);

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("pgvector/pgvector:pg17")
            .withDatabaseName("xihe_cp_rotation")
            .withUsername("test")
            .withPassword("test");

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", postgres::getJdbcUrl);
        registry.add("spring.datasource.username", postgres::getUsername);
        registry.add("spring.datasource.password", postgres::getPassword);
        registry.add("spring.datasource.driver-class-name", () -> "org.postgresql.Driver");
        registry.add("cp.credentials.encryption-key", () -> "");
        registry.add("cp.credentials.key-ring", () -> "{\"v1\":\""
                + Base64.getEncoder().encodeToString(KEY_V1) + "\",\"v2\":\""
                + Base64.getEncoder().encodeToString(KEY_V2) + "\"}");
        registry.add("cp.credentials.current-version", () -> "v2");
    }

    @Autowired
    private CredentialRotationService rotationService;

    @Autowired
    private CredentialRepository credentialRepository;

    @Autowired
    private CredentialEventRepository credentialEventRepository;

    @Autowired
    private CredentialLeaseRepository credentialLeaseRepository;

    @Autowired
    private CredentialLeaseService credentialLeaseService;

    @Autowired
    private CredentialService credentialService;

    @Autowired
    private CredentialEnvelope credentialEnvelope;

    @Autowired
    @Qualifier("credentialFingerprint")
    private CredentialFingerprint credentialFingerprint;

    @Autowired
    @Qualifier("credentialEncryption")
    private EnvelopeEncryptionService credentialEncryption;

    @LocalServerPort
    private int port;

    private final EnvelopeEncryptionService legacyEncryption = new EnvelopeEncryptionService(KEY_V1);

    private ch.qos.logback.core.read.ListAppender<
            ch.qos.logback.classic.spi.ILoggingEvent> auditAppender;

    @BeforeEach
    void resetStateAndAttachAuditAppender() {
        // Rotation status/counters are global; isolate each method on the shared context.
        credentialLeaseRepository.deleteAll();
        credentialEventRepository.deleteAll();
        credentialRepository.deleteAll();

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
    void statusReportsRingAndPendingCounts() {
        seedV1Row("token-a");
        seedV1Row("token-b");
        seedCurrentRow("token-c");

        CredentialRotationService.RotationStatus status = rotationService.status();

        assertEquals("v2", status.currentVersion());
        assertEquals(List.of("v1", "v2"), status.ringVersions());
        assertEquals(2L, status.pendingByVersion().get("v1"));
        assertEquals(2L, status.pendingTotal());
        assertEquals(3L, status.countsByVersion().values().stream().mapToLong(Long::longValue).sum());
    }

    @Test
    void rotationMigratesKeyAadAndFingerprintTogether() {
        Credential first = seedV1Row("first-secret");
        Credential second = seedV1Row("second-secret");

        CredentialRotationService.BatchResult result = rotationService.rotateBatch(50);

        assertEquals(2, result.scanned());
        assertEquals(2, result.migrated());
        assertEquals(0, result.conflicts());
        assertEquals(0, result.failures());
        assertEquals(0L, result.remaining(), "retirement count is key-version based");
        assertEquals("v2", result.targetVersion());

        for (Credential seed : List.of(first, second)) {
            Credential row = credentialRepository.findById(seed.getId()).orElseThrow();
            assertEquals("v2", row.getKeyVersion());
            assertTrue(row.getSecretCiphertext().startsWith("v2:"));
            assertEquals(Credential.AAD_VERSION_V2, row.getAadVersion());
            assertEquals(Credential.FINGERPRINT_VERSION_HMAC_SHA256_V1, row.getFingerprintVersion());
            assertNotNull(row.getRotatedAt());
            assertEquals(1, row.getRevision(), "rotation must not bump the replace revision");
            assertEquals("{\"token\":\"" + seed.getLabel() + "\"}", credentialEnvelope.decrypt(row));
            assertEquals(credentialFingerprint.fingerprint(CredentialSecretCodec.canonical(
                            "token", "{\"token\":\"" + seed.getLabel() + "\"}")),
                    row.getFingerprint(), "the migration must rewrite the fingerprint with HMAC");
            assertNotEquals("fp-" + seed.getId(), row.getFingerprint());
        }

        CredentialRotationService.RotationStatus status = rotationService.status();
        assertEquals(0L, status.pendingTotal(), "retirement check: no row remains under the old key");
        assertFalse(status.pendingByVersion().containsKey("v1"));

        // Once the retire count is zero the old key may leave the ring — every
        // migrated row must still decrypt under the new key alone with AAD v2.
        EnvelopeEncryptionService v2Only =
                new EnvelopeEncryptionService(Map.of("v2", KEY_V2), "v2");
        for (Credential seed : List.of(first, second)) {
            Credential row = credentialRepository.findById(seed.getId()).orElseThrow();
            assertEquals("{\"token\":\"" + seed.getLabel() + "\"}",
                    v2Only.decrypt(row.getSecretCiphertext(),
                            CredentialAad.formatV2(row.getId().toString(), row.getOwnerType(),
                                    row.getOwnerId(), row.getKind(), row.getRevision(),
                                    row.getKeyVersion())),
                    "rows must remain readable after the retired key is removed");
        }

        String auditText = auditAppender.list.stream()
                .map(event -> event.getFormattedMessage())
                .collect(Collectors.joining("\n"));
        assertTrue(auditText.contains("action=credential_rotated"));
        assertTrue(auditText.contains("migrated=2"));
        assertTrue(auditText.contains("remaining=0"));
    }

    @Test
    void singleRunMigratesAllPagesWithBoundedPageSize() {
        for (int index = 0; index < 5; index++) {
            seedV1Row("batch-secret-" + index);
        }

        CredentialRotationService.BatchResult result = rotationService.rotateBatch(2);

        assertEquals(5, result.scanned(), "one call loops the id cursor to the end");
        assertEquals(5, result.migrated());
        assertEquals(0, result.conflicts());
        assertEquals(0, result.failures());
        assertEquals(0L, result.remaining());
        assertEquals(0L, credentialRepository.countPendingMigration("v2"));
    }

    @Test
    void currentKeyRowsWithLegacyAadAndFingerprintAreMigrated() {
        Credential seeded = seedRow(UUID.randomUUID(), "current-key-legacy-aad", "v2",
                credentialEncryption, Credential.AAD_VERSION_LEGACY,
                Credential.FINGERPRINT_VERSION_SHA256);
        assertEquals(0L, rotationService.status().pendingTotal(),
                "the key-version retirement counter starts at zero");

        CredentialRotationService.BatchResult result = rotationService.rotateBatch(50);

        assertEquals(1, result.scanned());
        assertEquals(1, result.migrated());
        Credential row = credentialRepository.findById(seeded.getId()).orElseThrow();
        assertEquals(Credential.AAD_VERSION_V2, row.getAadVersion());
        assertEquals(Credential.FINGERPRINT_VERSION_HMAC_SHA256_V1, row.getFingerprintVersion());
        assertEquals("v2", row.getKeyVersion());
        assertEquals("{\"token\":\"current-key-legacy-aad\"}", credentialEnvelope.decrypt(row));
        assertEquals(0L, credentialRepository.countPendingMigration("v2"));
    }

    @Test
    void softDeletedRowsAreSkippedAndNeverRewritten() {
        Credential deleted = seedV1Row("soft-deleted-secret");
        String originalCiphertext = deleted.getSecretCiphertext();
        deleted.setDeletedAt(Instant.now());
        credentialRepository.save(deleted);

        CredentialRotationService.BatchResult result = rotationService.rotateBatch(50);

        assertEquals(0, result.scanned());
        assertEquals(0, result.migrated());
        assertEquals(0L, credentialRepository.countPendingMigration("v2"));
        Credential row = credentialRepository.findById(deleted.getId()).orElseThrow();
        assertEquals("v1", row.getKeyVersion());
        assertEquals(Credential.AAD_VERSION_LEGACY, row.getAadVersion());
        assertEquals(originalCiphertext, row.getSecretCiphertext());
        assertNotNull(row.getDeletedAt(), "rotation must not revive a deleted row");
    }

    @Test
    void corruptedRowIsCrossedAndDoesNotBlockLaterRows() {
        Credential corrupted = seedRow(UUID.fromString("00000000-0000-0000-0000-000000000001"),
                "corrupted-secret", "v1", legacyEncryption, Credential.AAD_VERSION_LEGACY,
                Credential.FINGERPRINT_VERSION_SHA256);
        corrupted.setSecretCiphertext("v1:AAAAAAAAAAAAAAAA:BBBB");
        credentialRepository.save(corrupted);
        Credential second = seedRow(UUID.fromString("00000000-0000-0000-0000-000000000002"),
                "second-secret", "v1", legacyEncryption, Credential.AAD_VERSION_LEGACY,
                Credential.FINGERPRINT_VERSION_SHA256);
        Credential third = seedRow(UUID.fromString("00000000-0000-0000-0000-000000000003"),
                "third-secret", "v1", legacyEncryption, Credential.AAD_VERSION_LEGACY,
                Credential.FINGERPRINT_VERSION_SHA256);

        CredentialRotationService.BatchResult result = rotationService.rotateBatch(2);

        assertEquals(3, result.scanned());
        assertEquals(2, result.migrated());
        assertEquals(1, result.failures());
        assertEquals(1L, result.remaining(), "the corrupted row stays pending for manual triage");
        assertEquals("v2", credentialRepository.findById(second.getId()).orElseThrow().getKeyVersion());
        assertEquals("v2", credentialRepository.findById(third.getId()).orElseThrow().getKeyVersion(),
                "the cursor must cross the failed row and reach later ids");
        assertEquals("v1", credentialRepository.findById(corrupted.getId()).orElseThrow().getKeyVersion());
        assertEquals(Credential.AAD_VERSION_LEGACY,
                credentialRepository.findById(corrupted.getId()).orElseThrow().getAadVersion());
    }

    @Test
    void compareAndSetHonorsCiphertextAndDeleteFences() {
        Credential row = seedV1Row("cas-secret");
        String stored = credentialRepository.findById(row.getId()).orElseThrow().getSecretCiphertext();
        String replacement = credentialEncryption.encrypt("{\"token\":\"cas-rewrite\"}",
                CredentialAad.formatV2(row.getId().toString(), row.getOwnerType(), row.getOwnerId(),
                        row.getKind(), row.getRevision(), "v2"));

        int staleWrite = credentialRepository.compareAndSetSecret(row.getId(),
                "v1:not-the-stored:value", replacement, "v2", Credential.AAD_VERSION_V2,
                "hmac-fp", Credential.FINGERPRINT_VERSION_HMAC_SHA256_V1, Instant.now());
        assertEquals(0, staleWrite, "a CAS against a different ciphertext must not write");

        int freshWrite = credentialRepository.compareAndSetSecret(row.getId(),
                stored, replacement, "v2", Credential.AAD_VERSION_V2,
                "hmac-fp", Credential.FINGERPRINT_VERSION_HMAC_SHA256_V1, Instant.now());
        assertEquals(1, freshWrite);
        Credential updated = credentialRepository.findById(row.getId()).orElseThrow();
        assertEquals("v2", updated.getKeyVersion());
        assertEquals(Credential.AAD_VERSION_V2, updated.getAadVersion());
        assertEquals(Credential.FINGERPRINT_VERSION_HMAC_SHA256_V1, updated.getFingerprintVersion());
        assertEquals("hmac-fp", updated.getFingerprint());
        assertNotNull(updated.getRotatedAt());

        Credential deleted = seedV1Row("cas-deleted");
        String deletedCiphertext = deleted.getSecretCiphertext();
        deleted.setDeletedAt(Instant.now());
        credentialRepository.save(deleted);
        int softDeleted = credentialRepository.compareAndSetSecret(deleted.getId(),
                deletedCiphertext, replacement, "v2", Credential.AAD_VERSION_V2,
                "hmac-fp", Credential.FINGERPRINT_VERSION_HMAC_SHA256_V1, Instant.now());
        assertEquals(0, softDeleted, "rotation must never rewrite a soft-deleted row");
        assertEquals("v1", credentialRepository.findById(deleted.getId()).orElseThrow().getKeyVersion());
    }

    @Test
    void concurrentReplaceIsNeverOverwrittenByAStaleRotationSnapshot() {
        Credential seeded = seedV1Row("replace-race");
        String staleCiphertext = seeded.getSecretCiphertext();
        Credential replaced = credentialService.replaceSecret(seeded.getId(),
                CredentialService.SecretPayload.ofToken("replaced-value"), null);

        int staleWrite = credentialRepository.compareAndSetSecret(seeded.getId(), staleCiphertext,
                "v2:stale:rotation", "v2", Credential.AAD_VERSION_V2, "stale-fp",
                Credential.FINGERPRINT_VERSION_HMAC_SHA256_V1, Instant.now());
        assertEquals(0, staleWrite, "the rotation CAS must not clobber a concurrent replace");

        Credential row = credentialRepository.findById(seeded.getId()).orElseThrow();
        assertEquals(2, row.getRevision());
        assertEquals(replaced.getSecretCiphertext(), row.getSecretCiphertext());
        assertEquals(replaced.getFingerprint(), row.getFingerprint());
        assertEquals(Credential.AAD_VERSION_V2, row.getAadVersion());
        assertEquals("{\"token\":\"replaced-value\"}", credentialEnvelope.decrypt(row));

        CredentialRotationService.BatchResult result = rotationService.rotateBatch(50);
        assertEquals(0, result.scanned(), "a replace already wrote v2/hmac; nothing left to migrate");
        assertEquals(0, result.conflicts());
    }

    @Test
    void migratedRowsRemainDeliverableThroughTheLeasePath() {
        Credential seeded = seedV1Row("lease-after-migration");

        assertEquals(1, rotationService.rotateBatch(50).migrated());

        CredentialLeaseService.AcquiredCredential acquired = credentialLeaseService.acquire(
                seeded.getId().toString(), UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), UUID.randomUUID().toString(),
                UUID.randomUUID().toString());
        assertEquals("{\"token\":\"lease-after-migration\"}", acquired.plaintext());
        assertEquals(Credential.AAD_VERSION_V2,
                credentialRepository.findById(seeded.getId()).orElseThrow().getAadVersion());
    }

    @Test
    void httpEndpointsRequireServiceTokenAndValidateBatchSize() {
        RestTemplate client = httpClient();
        String baseUrl = "http://localhost:" + port;

        ResponseEntity<String> unauthorized = client.getForEntity(
                baseUrl + "/internal/v1/credentials/rotation/status", String.class);
        assertEquals(HttpStatus.UNAUTHORIZED, unauthorized.getStatusCode());

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth("dev-token-not-secure");
        headers.setContentType(MediaType.APPLICATION_JSON);

        ResponseEntity<String> status = client.exchange(
                baseUrl + "/internal/v1/credentials/rotation/status", HttpMethod.GET,
                new HttpEntity<>(headers), String.class);
        assertEquals(HttpStatus.OK, status.getStatusCode());
        assertTrue(status.getBody().contains("\"currentVersion\":\"v2\""));
        assertTrue(status.getBody().contains("\"ringVersions\""));
        assertTrue(status.getBody().contains("\"pendingByVersion\""));

        ResponseEntity<String> invalid = client.exchange(
                baseUrl + "/internal/v1/credentials/rotation/runs", HttpMethod.POST,
                new HttpEntity<>(Map.of("batchSize", 0), headers), String.class);
        assertEquals(HttpStatus.BAD_REQUEST, invalid.getStatusCode(),
                "out-of-range batchSize must fail with 400, not a silent clamp");

        seedV1Row("http-secret");
        ResponseEntity<String> run = client.exchange(
                baseUrl + "/internal/v1/credentials/rotation/runs", HttpMethod.POST,
                new HttpEntity<>(Map.of("batchSize", 10), headers), String.class);
        assertEquals(HttpStatus.OK, run.getStatusCode());
        assertTrue(run.getBody().contains("\"migrated\":1"));
        assertTrue(run.getBody().contains("\"remaining\":0"));
        assertTrue(run.getBody().contains("\"targetVersion\":\"v2\""));
    }

    private static RestTemplate httpClient() {
        RestTemplate client = new RestTemplate();
        client.setErrorHandler(new DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(ClientHttpResponse response) throws IOException {
                return false;
            }
        });
        return client;
    }

    private Credential seedV1Row(String tokenValue) {
        return seedRow(UUID.randomUUID(), tokenValue, "v1", legacyEncryption,
                Credential.AAD_VERSION_LEGACY, Credential.FINGERPRINT_VERSION_SHA256);
    }

    private Credential seedCurrentRow(String tokenValue) {
        return seedRow(UUID.randomUUID(), tokenValue, credentialEncryption.currentVersion(),
                credentialEncryption, Credential.AAD_VERSION_V2,
                Credential.FINGERPRINT_VERSION_HMAC_SHA256_V1);
    }

    private Credential seedRow(UUID id, String tokenValue, String keyVersion,
            EnvelopeEncryptionService service, short aadVersion, String fingerprintVersion) {
        String ownerId = UUID.randomUUID().toString();
        Credential row = new Credential();
        row.setId(id);
        row.setOwnerType(Credential.OWNER_USER);
        row.setOwnerId(ownerId);
        row.setLabel(tokenValue);
        row.setKind(Credential.KIND_TOKEN);
        row.setDeliveryTier(Credential.TIER_LEASE);
        row.setSecretCiphertext(service.encrypt("{\"token\":\"" + tokenValue + "\"}",
                aadVersion == Credential.AAD_VERSION_V2
                        ? CredentialAad.formatV2(id.toString(), Credential.OWNER_USER, ownerId,
                                Credential.KIND_TOKEN, 1, keyVersion)
                        : CredentialAad.formatV1(id.toString(), Credential.OWNER_USER, ownerId)));
        row.setKeyVersion(keyVersion);
        row.setAadVersion(aadVersion);
        row.setFingerprint("fp-" + id);
        row.setFingerprintVersion(fingerprintVersion);
        return credentialRepository.save(row);
    }
}
