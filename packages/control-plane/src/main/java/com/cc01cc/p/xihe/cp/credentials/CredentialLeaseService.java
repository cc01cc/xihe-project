package com.cc01cc.p.xihe.cp.credentials;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.crypto.EnvelopeEncryptionService;
import com.cc01cc.p.xihe.cp.entity.Credential;
import com.cc01cc.p.xihe.cp.entity.CredentialEvent;
import com.cc01cc.p.xihe.cp.entity.CredentialLease;
import com.cc01cc.p.xihe.cp.repository.CredentialEventRepository;
import com.cc01cc.p.xihe.cp.repository.CredentialLeaseRepository;
import com.cc01cc.p.xihe.cp.repository.CredentialRepository;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.UUID;

/**
 * PLAN-0497 M1 (T1.2; contract: 0497 design §方案 1/2, decisions #2/#7/#10, I1-I6):
 * the generic credential lease — issue (tier gate + status gate + expected_revision
 * snapshot + hash-only token), redeem (bindings + revision + single-use TTL in one
 * compare-and-set) and one-step delivery (decrypt under the credential AAD).
 *
 * <p>Authorization ({@code credential_use} evaluation) and approval stay on the
 * tool-call boundary (M2); this service is the fail-closed delivery body. Every
 * mutation writes the credential_events rows (lease_issued / lease_redeemed, actor
 * {@code agent:<principalId>}) plus the AuditLogger stream — never a value.</p>
 */
@Service
public class CredentialLeaseService {

    static final Duration DEFAULT_TTL = Duration.ofMinutes(5);
    private static final String TOKEN_PREFIX = "cl_";

    private final CredentialLeaseRepository credentialLeaseRepository;
    private final CredentialRepository credentialRepository;
    private final CredentialEventRepository credentialEventRepository;
    private final EnvelopeEncryptionService credentialEncryption;
    private final AuditLogger auditLogger;
    private final SecureRandom random = new SecureRandom();

    public CredentialLeaseService(CredentialLeaseRepository credentialLeaseRepository,
            CredentialRepository credentialRepository,
            CredentialEventRepository credentialEventRepository,
            @Qualifier("credentialEncryption") EnvelopeEncryptionService credentialEncryption,
            AuditLogger auditLogger) {
        this.credentialLeaseRepository = credentialLeaseRepository;
        this.credentialRepository = credentialRepository;
        this.credentialEventRepository = credentialEventRepository;
        this.credentialEncryption = credentialEncryption;
        this.auditLogger = auditLogger;
    }

    public record IssuedLease(String token, UUID leaseId, Instant expiresAt, int expectedRevision) {}

    public record AcquiredCredential(String leaseId, Instant expiresAt, int revision, String plaintext) {}

    /**
     * One-step delivery (M1 final: issue and delivery run inside one handler step,
     * consistent with the spawn_agent precedent). Returns the plaintext to the tool
     * result path — M2 filters it out of model history / UI projection / audit.
     */
    @Transactional
    public AcquiredCredential acquire(String credentialId, String principalId, String sessionId,
            String runId, String workspaceId) {
        IssuedLease issued = issueLease(credentialId, principalId, sessionId, runId, workspaceId);
        redeemLease(issued.token(), principalId, sessionId, runId, workspaceId);

        Credential credential = requireCredential(credentialId);
        String plaintext = credentialEncryption.decrypt(credential.getSecretCiphertext(),
                CredentialAad.format(credential.getId().toString(), credential.getOwnerType(),
                        credential.getOwnerId()));
        return new AcquiredCredential(issued.leaseId().toString(), issued.expiresAt(),
                issued.expectedRevision(), plaintext);
    }

    /**
     * Issue a lease for an active lease-tier credential: fail-closed tier/status
     * gates, binding snapshot, expected_revision snapshot (0495) and a hash-only
     * token (I1/I2). Writes the lease_issued audit event.
     */
    @Transactional
    public IssuedLease issueLease(String credentialId, String principalId, String sessionId,
            String runId, String workspaceId) {
        Credential credential = requireCredential(credentialId);
        if (!Credential.STATUS_ACTIVE.equals(credential.getStatus())) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "CREDENTIAL_DISABLED",
                    "Only active credentials can be leased");
        }
        if (!Credential.TIER_LEASE.equals(credential.getDeliveryTier())) {
            throw new CpApiException(HttpStatus.UNPROCESSABLE_ENTITY, "CREDENTIAL_TIER_MISMATCH",
                    "acquire_credential only serves the lease delivery tier (decision #7)");
        }
        String token = TOKEN_PREFIX + randomToken();
        CredentialLease lease = new CredentialLease();
        lease.setId(UUID.randomUUID());
        lease.setLeaseHash(hash(token));
        lease.setCredentialId(credential.getId().toString());
        lease.setPrincipalId(principalId);
        lease.setSessionId(sessionId);
        lease.setRunId(runId);
        lease.setWorkspaceId(workspaceId);
        lease.setExpectedRevision(credential.getRevision());
        lease.setExpiresAt(Instant.now().plus(DEFAULT_TTL));
        credentialLeaseRepository.save(lease);

        recordDeliveryEvent(credential, agentActor(principalId), CredentialEvent.TYPE_LEASE_ISSUED);
        return new IssuedLease(token, lease.getId(), lease.getExpiresAt(), lease.getExpectedRevision());
    }

    /**
     * Redeem body for the single-use + TTL + binding + revision constraints (I1):
     * bindings must match the issuing context, the credential revision must still
     * equal the issued snapshot, and consumption is one compare-and-set update —
     * already-redeemed (409) and expired (410) leases fail closed. Writes the
     * lease_redeemed audit event on success.
     */
    @Transactional
    public void redeemLease(String leaseToken, String principalId, String sessionId,
            String runId, String workspaceId) {
        CredentialLease lease = credentialLeaseRepository.findByLeaseHash(hash(leaseToken))
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "LEASE_NOT_FOUND",
                        "Credential lease not found"));
        if (!lease.getPrincipalId().equals(principalId)
                || !lease.getSessionId().equals(sessionId)
                || !lease.getRunId().equals(runId)
                || !lease.getWorkspaceId().equals(workspaceId)) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "LEASE_BINDING_MISMATCH",
                    "Credential lease binding does not match the request context");
        }
        Credential credential = requireCredential(lease.getCredentialId());
        // Wave review: redeem stays fail-closed on its own — a credential disabled
        // after issue must not deliver (mirrors the issue-time status gate).
        if (!Credential.STATUS_ACTIVE.equals(credential.getStatus())) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "CREDENTIAL_DISABLED",
                    "Only active credentials can be redeemed");
        }
        if (credential.getRevision() != lease.getExpectedRevision()) {
            throw new CpApiException(HttpStatus.CONFLICT, "CREDENTIAL_REVISION_CHANGED",
                    "Credential revision changed after the lease was issued");
        }
        int consumed = credentialLeaseRepository.consumeIfValid(lease.getId(), Instant.now());
        if (consumed == 0) {
            CredentialLease current = credentialLeaseRepository.findById(lease.getId())
                    .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "LEASE_NOT_FOUND",
                            "Credential lease not found"));
            if (current.getRedeemedAt() != null) {
                throw new CpApiException(HttpStatus.CONFLICT, "LEASE_ALREADY_REDEEMED",
                        "Credential lease was already redeemed");
            }
            throw new CpApiException(HttpStatus.GONE, "LEASE_EXPIRED",
                    "Credential lease has expired");
        }
        recordDeliveryEvent(credential, agentActor(principalId), CredentialEvent.TYPE_LEASE_REDEEMED);
    }

    private Credential requireCredential(String credentialId) {
        UUID id;
        try {
            id = UUID.fromString(credentialId);
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_CREDENTIAL_ID",
                    "credentialId must be a valid UUID", e);
        }
        return credentialRepository.findByIdAndDeletedAtIsNull(id)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "CREDENTIAL_NOT_FOUND",
                        "Credential not found"));
    }

    private void recordDeliveryEvent(Credential credential, String actor, String eventType) {
        CredentialEvent event = new CredentialEvent();
        event.setId(UUID.randomUUID());
        event.setCredentialId(credential.getId().toString());
        event.setEventType(eventType);
        event.setActor(actor);
        event.setOwnerType(credential.getOwnerType());
        event.setOwnerId(credential.getOwnerId());
        credentialEventRepository.save(event);

        auditLogger.recordCredentialEvent(actor, "credential_" + eventType,
                credential.getId().toString(), credential.getOwnerType(), credential.getOwnerId(),
                credential.getKind(), credential.getDeliveryTier(), credential.getFingerprint());
    }

    private static String agentActor(String principalId) {
        return "agent:" + principalId;
    }

    private String randomToken() {
        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static String hash(String token) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(token.getBytes(StandardCharsets.UTF_8));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(digest);
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }
}
