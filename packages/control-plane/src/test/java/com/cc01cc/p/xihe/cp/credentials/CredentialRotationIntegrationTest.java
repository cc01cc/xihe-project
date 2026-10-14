package com.cc01cc.p.xihe.cp.credentials;

import com.cc01cc.p.xihe.cp.crypto.EnvelopeEncryptionService;
import com.cc01cc.p.xihe.cp.entity.Credential;
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
import java.util.UUID;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0495 T3.2 / V3 首次演练：两版本环注入（v1=v1 旧 + v2=current）→
 * 批量重加密（解密-重加密 + compare-and-set 回写，分批续跑）→ 退役前缀计数
 * 为零；CAS 防覆盖与损坏密文容错；批次审计（不含值）。
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
    private com.cc01cc.p.xihe.cp.repository.CredentialEventRepository credentialEventRepository;

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
        assertEquals(java.util.List.of("v1", "v2"), status.ringVersions());
        assertEquals(2L, status.pendingByVersion().get("v1"));
        assertEquals(2L, status.pendingTotal());
        assertEquals(3L, status.countsByVersion().values().stream().mapToLong(Long::longValue).sum());
    }

    @Test
    void rotationMigratesAllRowsAndRetireCheckReachesZero() {
        Credential first = seedV1Row("first-secret");
        Credential second = seedV1Row("second-secret");

        CredentialRotationService.BatchResult result = rotationService.rotateBatch(50);

        assertEquals(2, result.scanned());
        assertEquals(2, result.migrated());
        assertEquals(0, result.conflicts());
        assertEquals(0, result.failures());
        assertEquals(0L, result.remaining());
        assertEquals("v2", result.targetVersion());

        for (Credential seed : java.util.List.of(first, second)) {
            Credential row = credentialRepository.findById(seed.getId()).orElseThrow();
            assertEquals("v2", row.getKeyVersion());
            assertTrue(row.getSecretCiphertext().startsWith("v2:"));
            assertNotNull(row.getRotatedAt());
            assertEquals(1, row.getRevision(), "rotation must not bump the replace revision");
            String decrypted = credentialEncryption.decrypt(row.getSecretCiphertext(),
                    CredentialAad.format(row.getId().toString(), row.getOwnerType(), row.getOwnerId()));
            assertEquals("{\"token\":\"" + seed.getLabel() + "\"}", decrypted);
        }

        CredentialRotationService.RotationStatus status = rotationService.status();
        assertEquals(0L, status.pendingTotal(), "retirement check: no row remains under the old key");
        assertFalse(status.pendingByVersion().containsKey("v1"));

        // V3 (round-4): once the retire count is zero the old key may leave the
        // ring — every migrated row must still decrypt under the new key alone.
        EnvelopeEncryptionService v2Only =
                new EnvelopeEncryptionService(java.util.Map.of("v2", KEY_V2), "v2");
        for (Credential seed : java.util.List.of(first, second)) {
            Credential row = credentialRepository.findById(seed.getId()).orElseThrow();
            assertEquals("{\"token\":\"" + seed.getLabel() + "\"}",
                    v2Only.decrypt(row.getSecretCiphertext(),
                            CredentialAad.format(row.getId().toString(), row.getOwnerType(),
                                    row.getOwnerId())),
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
    void rotationIsResumableAcrossBatches() {
        for (int index = 0; index < 5; index++) {
            seedV1Row("batch-secret-" + index);
        }

        assertEquals(3L, rotationService.rotateBatch(2).remaining());
        assertEquals(1L, rotationService.rotateBatch(2).remaining());
        assertEquals(0L, rotationService.rotateBatch(2).remaining());
        assertEquals(0L, rotationService.status().pendingTotal());
    }

    @Test
    void compareAndSetRefusesToOverwriteChangedCiphertext() {
        Credential row = seedV1Row("cas-secret");
        String stored = credentialRepository.findById(row.getId()).orElseThrow().getSecretCiphertext();
        String replacement = credentialEncryption.encrypt("{\"token\":\"cas-rewrite\"}",
                CredentialAad.format(row.getId().toString(), row.getOwnerType(), row.getOwnerId()));

        int staleWrite = credentialRepository.compareAndSetSecret(row.getId(),
                "v1:not-the-stored:value", replacement, "v2", Instant.now());
        assertEquals(0, staleWrite, "a CAS against a different ciphertext must not write");

        int freshWrite = credentialRepository.compareAndSetSecret(row.getId(),
                stored, replacement, "v2", Instant.now());
        assertEquals(1, freshWrite);
        Credential updated = credentialRepository.findById(row.getId()).orElseThrow();
        assertEquals("v2", updated.getKeyVersion());
        assertNotNull(updated.getRotatedAt());
    }

    @Test
    void corruptedCiphertextIsCountedAsFailureWithoutAbortingTheBatch() {
        Credential healthy = seedV1Row("healthy-secret");
        Credential corrupted = seedV1Row("corrupted-secret");
        corrupted.setSecretCiphertext("v1:AAAAAAAAAAAAAAAA:BBBB");
        credentialRepository.save(corrupted);

        CredentialRotationService.BatchResult result = rotationService.rotateBatch(50);

        assertEquals(1, result.migrated());
        assertEquals(1, result.failures());
        assertEquals(1L, result.remaining(), "the corrupted row stays pending for manual triage");
        assertEquals("v2", credentialRepository.findById(healthy.getId()).orElseThrow().getKeyVersion());
        assertEquals("v1", credentialRepository.findById(corrupted.getId()).orElseThrow().getKeyVersion());
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
                new HttpEntity<>(java.util.Map.of("batchSize", 0), headers), String.class);
        assertEquals(HttpStatus.BAD_REQUEST, invalid.getStatusCode(),
                "out-of-range batchSize must fail with 400, not a silent clamp");

        seedV1Row("http-secret");
        ResponseEntity<String> run = client.exchange(
                baseUrl + "/internal/v1/credentials/rotation/runs", HttpMethod.POST,
                new HttpEntity<>(java.util.Map.of("batchSize", 10), headers), String.class);
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
        return seedRow(tokenValue, "v1", legacyEncryption);
    }

    private Credential seedCurrentRow(String tokenValue) {
        return seedRow(tokenValue, credentialEncryption.currentVersion(), credentialEncryption);
    }

    private Credential seedRow(String tokenValue, String keyVersion, EnvelopeEncryptionService service) {
        String ownerId = UUID.randomUUID().toString();
        Credential row = new Credential();
        row.setId(UUID.randomUUID());
        row.setOwnerType(Credential.OWNER_USER);
        row.setOwnerId(ownerId);
        row.setLabel(tokenValue);
        row.setKind(Credential.KIND_TOKEN);
        row.setDeliveryTier(Credential.TIER_LEASE);
        row.setSecretCiphertext(service.encrypt("{\"token\":\"" + tokenValue + "\"}",
                CredentialAad.format(row.getId().toString(), Credential.OWNER_USER, ownerId)));
        row.setKeyVersion(keyVersion);
        row.setFingerprint("fp-" + row.getId());
        return credentialRepository.save(row);
    }
}
