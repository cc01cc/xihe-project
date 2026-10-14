package com.cc01cc.p.xihe.cp.credentials;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.crypto.EnvelopeEncryptionService;
import com.cc01cc.p.xihe.cp.entity.Credential;
import com.cc01cc.p.xihe.cp.entity.CredentialEvent;
import com.cc01cc.p.xihe.cp.entity.CredentialLease;
import com.cc01cc.p.xihe.cp.repository.CredentialEventRepository;
import com.cc01cc.p.xihe.cp.repository.CredentialLeaseRepository;
import com.cc01cc.p.xihe.cp.repository.CredentialRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpStatus;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0497 M1 (T1.1/T1.2; contract: 0497 design §方案 1/2, I1/I2/I5/I6, decisions #2/#7/#10):
 * the generic credential lease — one-step issue+delivery with tier/status gates,
 * hash-only tokens, single-use TTL consumption, binding and revision fences,
 * fail-closed error semantics, dual audits (credential_events + AuditLogger)
 * and no plaintext in any durable or audited surface.
 */
class CredentialLeaseIntegrationTest extends AbstractIntegrationTest {

    @Autowired private CredentialLeaseService leaseService;
    @Autowired private CredentialService credentialService;
    @Autowired private CredentialRepository credentialRepository;
    @Autowired private CredentialLeaseRepository credentialLeaseRepository;
    @Autowired private CredentialEventRepository credentialEventRepository;
    @Autowired
    @Qualifier("credentialEncryption")
    private EnvelopeEncryptionService credentialEncryption;

    private static final String PRINCIPAL_ID = UUID.randomUUID().toString();
    private static final String SESSION_ID = UUID.randomUUID().toString();
    private static final String RUN_ID = UUID.randomUUID().toString();
    private static final String WORKSPACE_ID = UUID.randomUUID().toString();

    private final List<UUID> credentialIds = new ArrayList<>();
    private ch.qos.logback.core.read.ListAppender<
            ch.qos.logback.classic.spi.ILoggingEvent> auditAppender;

    @BeforeEach
    void attachAuditAppender() {
        credentialLeaseRepository.deleteAll();
        auditAppender = new ch.qos.logback.core.read.ListAppender<>();
        auditAppender.start();
        ((ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger("AUDIT"))
                .addAppender(auditAppender);
    }

    @AfterEach
    void cleanFixtures() {
        ((ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger("AUDIT"))
                .detachAppender(auditAppender);
        auditAppender.stop();
        credentialLeaseRepository.deleteAll();
        credentialIds.forEach(credentialRepository::deleteById);
    }

    @Test
    void acquireDeliversPlaintextWithSingleUseLeaseAndDualAudits() {
        String secret = "lease-delivery-secret-8675309";
        Credential credential = createLeaseCredential("leased-token", secret, Credential.TIER_LEASE);

        CredentialLeaseService.AcquiredCredential acquired = leaseService.acquire(
                credential.getId().toString(), PRINCIPAL_ID, SESSION_ID, RUN_ID, WORKSPACE_ID);

        assertEquals("{\"token\":\"" + secret + "\"}", acquired.plaintext());
        assertEquals(1, acquired.revision());
        assertNotNull(acquired.leaseId());
        assertTrue(acquired.expiresAt().isAfter(Instant.now()));

        CredentialLease lease = leasesOf(credential.getId()).get(0);
        assertNotNull(lease.getRedeemedAt(), "one-step delivery consumes the lease");
        assertEquals(1, lease.getExpectedRevision());
        assertEquals(PRINCIPAL_ID, lease.getPrincipalId());
        assertFalse(lease.getLeaseHash().contains(secret),
                "I2: only the token hash is stored, never the token or value");

        List<CredentialEvent> events = credentialEventRepository
                .findByCredentialIdOrderByCreatedAtDesc(credential.getId().toString());
        java.util.Set<String> eventTypes = events.stream()
                .map(CredentialEvent::getEventType)
                .collect(Collectors.toSet());
        assertEquals(java.util.Set.of(
                        CredentialEvent.TYPE_CREATED,
                        CredentialEvent.TYPE_LEASE_ISSUED,
                        CredentialEvent.TYPE_LEASE_REDEEMED),
                eventTypes);
        events.stream()
                .filter(event -> !CredentialEvent.TYPE_CREATED.equals(event.getEventType()))
                .forEach(event -> assertEquals("agent:" + PRINCIPAL_ID, event.getActor()));

        String auditText = auditAppender.list.stream()
                .map(event -> event.getFormattedMessage())
                .collect(Collectors.joining("\n"));
        assertTrue(auditText.contains("action=credential_lease_issued"));
        assertTrue(auditText.contains("action=credential_lease_redeemed"));
        assertFalse(auditText.contains(secret), "I5: no plaintext in the audit stream");
    }

    @Test
    void acquireFailsClosedForRevealTierDisabledAndMissingCredentials() {
        Credential revealTier = createLeaseCredential("reveal-tier", "reveal-secret", Credential.TIER_REVEAL);
        CpApiException tierError = assertThrows(CpApiException.class, () -> leaseService.acquire(
                revealTier.getId().toString(), PRINCIPAL_ID, SESSION_ID, RUN_ID, WORKSPACE_ID));
        assertEquals(HttpStatus.UNPROCESSABLE_ENTITY, tierError.getStatus());
        assertEquals("CREDENTIAL_TIER_MISMATCH", tierError.getCode());

        Credential disabled = createLeaseCredential("disabled-lease", "disabled-secret", Credential.TIER_LEASE);
        disabled.setStatus(Credential.STATUS_DISABLED);
        credentialRepository.save(disabled);
        CpApiException disabledError = assertThrows(CpApiException.class, () -> leaseService.acquire(
                disabled.getId().toString(), PRINCIPAL_ID, SESSION_ID, RUN_ID, WORKSPACE_ID));
        assertEquals(HttpStatus.FORBIDDEN, disabledError.getStatus());
        assertEquals("CREDENTIAL_DISABLED", disabledError.getCode());

        CpApiException missingError = assertThrows(CpApiException.class, () -> leaseService.acquire(
                UUID.randomUUID().toString(), PRINCIPAL_ID, SESSION_ID, RUN_ID, WORKSPACE_ID));
        assertEquals(HttpStatus.NOT_FOUND, missingError.getStatus());
        assertEquals("CREDENTIAL_NOT_FOUND", missingError.getCode());
    }

    @Test
    void leaseCanBeRedeemedExactlyOnce() {
        Credential credential = createLeaseCredential("single-use", "single-use-secret", Credential.TIER_LEASE);
        CredentialLeaseService.IssuedLease issued = leaseService.issueLease(
                credential.getId().toString(), PRINCIPAL_ID, SESSION_ID, RUN_ID, WORKSPACE_ID);

        leaseService.redeemLease(issued.token(), PRINCIPAL_ID, SESSION_ID, RUN_ID, WORKSPACE_ID);

        CpApiException second = assertThrows(CpApiException.class, () -> leaseService.redeemLease(
                issued.token(), PRINCIPAL_ID, SESSION_ID, RUN_ID, WORKSPACE_ID));
        assertEquals(HttpStatus.CONFLICT, second.getStatus());
        assertEquals("LEASE_ALREADY_REDEEMED", second.getCode());
    }

    @Test
    void expiredLeaseIsRejected() {
        Credential credential = createLeaseCredential("expired", "expired-secret", Credential.TIER_LEASE);
        CredentialLeaseService.IssuedLease issued = leaseService.issueLease(
                credential.getId().toString(), PRINCIPAL_ID, SESSION_ID, RUN_ID, WORKSPACE_ID);
        CredentialLease lease = credentialLeaseRepository.findById(issued.leaseId()).orElseThrow();
        lease.setExpiresAt(Instant.now().minusSeconds(1));
        credentialLeaseRepository.save(lease);

        CpApiException error = assertThrows(CpApiException.class, () -> leaseService.redeemLease(
                issued.token(), PRINCIPAL_ID, SESSION_ID, RUN_ID, WORKSPACE_ID));
        assertEquals(HttpStatus.GONE, error.getStatus());
        assertEquals("LEASE_EXPIRED", error.getCode());
    }

    @Test
    void leaseBindingMismatchIsRejected() {
        Credential credential = createLeaseCredential("bound", "bound-secret", Credential.TIER_LEASE);
        CredentialLeaseService.IssuedLease issued = leaseService.issueLease(
                credential.getId().toString(), PRINCIPAL_ID, SESSION_ID, RUN_ID, WORKSPACE_ID);

        CpApiException wrongSession = assertThrows(CpApiException.class, () -> leaseService.redeemLease(
                issued.token(), PRINCIPAL_ID, UUID.randomUUID().toString(), RUN_ID, WORKSPACE_ID));
        assertEquals(HttpStatus.FORBIDDEN, wrongSession.getStatus());
        assertEquals("LEASE_BINDING_MISMATCH", wrongSession.getCode());

        CpApiException wrongPrincipal = assertThrows(CpApiException.class, () -> leaseService.redeemLease(
                issued.token(), UUID.randomUUID().toString(), SESSION_ID, RUN_ID, WORKSPACE_ID));
        assertEquals("LEASE_BINDING_MISMATCH", wrongPrincipal.getCode());
    }

    @Test
    void staleExpectedRevisionIsRejected() {
        Credential credential = createLeaseCredential("stale-rev", "stale-secret", Credential.TIER_LEASE);
        CredentialLeaseService.IssuedLease issued = leaseService.issueLease(
                credential.getId().toString(), PRINCIPAL_ID, SESSION_ID, RUN_ID, WORKSPACE_ID);

        // A concurrent replace bumps the credential revision after issue.
        Credential row = credentialRepository.findById(credential.getId()).orElseThrow();
        row.setRevision(2);
        row.setSecretCiphertext(credentialEncryption.encrypt("{\"token\":\"replaced\"}",
                CredentialAad.format(row.getId().toString(), row.getOwnerType(), row.getOwnerId())));
        credentialRepository.save(row);

        CpApiException error = assertThrows(CpApiException.class, () -> leaseService.redeemLease(
                issued.token(), PRINCIPAL_ID, SESSION_ID, RUN_ID, WORKSPACE_ID));
        assertEquals(HttpStatus.CONFLICT, error.getStatus());
        assertEquals("CREDENTIAL_REVISION_CHANGED", error.getCode());
    }

    private Credential createLeaseCredential(String label, String secret, String tier) {
        Credential credential = credentialService.create(new CredentialService.CreateRequest(
                "USER", UUID.randomUUID().toString(), label, "token", tier,
                CredentialService.SecretPayload.ofToken(secret)), null);
        credentialIds.add(credential.getId());
        return credential;
    }

    private List<CredentialLease> leasesOf(UUID credentialId) {
        return credentialLeaseRepository.findAll().stream()
                .filter(lease -> credentialId.toString().equals(lease.getCredentialId()))
                .toList();
    }
}
