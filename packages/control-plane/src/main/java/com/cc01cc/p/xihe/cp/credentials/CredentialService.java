package com.cc01cc.p.xihe.cp.credentials;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.crypto.EnvelopeEncryptionService;
import com.cc01cc.p.xihe.cp.entity.Credential;
import com.cc01cc.p.xihe.cp.entity.CredentialEvent;
import com.cc01cc.p.xihe.cp.repository.CredentialEventRepository;
import com.cc01cc.p.xihe.cp.repository.CredentialRepository;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0495 T2.1/T2.2/T2.3 (contract: 0494 I1/I2, #1/#8/#18 + 0495 §方案 4/5):
 * credential lifecycle — create, replace-secret (id preserved, revision +1),
 * soft delete and the existsForOwner dangling-check seam consumed by 0496.
 *
 * <p>The whole secret payload is serialized to one JSON document and encrypted
 * as a single envelope through {@link CredentialEnvelope}. New writes use
 * PLAN-0576 AAD v2 ({@code v2|id|ownerType|ownerId|kind|revision|keyVersion})
 * and the keyed HMAC fingerprint; legacy v1 rows stay readable until rotation
 * migrates them. Every mutation writes a credential_events row (never a value)
 * plus the AuditLogger stream. Deletion is soft; the reference report is
 * assembled by 0496 from grant data on top of {@link #delete}.
 */
@Service
public class CredentialService {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final int LABEL_MAX_LENGTH = 128;

    private final CredentialRepository credentialRepository;
    private final CredentialEventRepository credentialEventRepository;
    private final EnvelopeEncryptionService credentialEncryption;
    private final CredentialEnvelope credentialEnvelope;
    private final CredentialFingerprint credentialFingerprint;
    private final AuditLogger auditLogger;

    public CredentialService(CredentialRepository credentialRepository,
            CredentialEventRepository credentialEventRepository,
            @Qualifier("credentialEncryption") EnvelopeEncryptionService credentialEncryption,
            CredentialEnvelope credentialEnvelope,
            @Qualifier("credentialFingerprint") CredentialFingerprint credentialFingerprint,
            AuditLogger auditLogger) {
        this.credentialRepository = credentialRepository;
        this.credentialEventRepository = credentialEventRepository;
        this.credentialEncryption = credentialEncryption;
        this.credentialEnvelope = credentialEnvelope;
        this.credentialFingerprint = credentialFingerprint;
        this.auditLogger = auditLogger;
    }

    /** v1 secret forms (0494 #6): one token or an access/secret pair. */
    public record SecretPayload(String token, String accessKey, String secretKey) {
        public static SecretPayload ofToken(String token) {
            return new SecretPayload(token, null, null);
        }

        public static SecretPayload ofKeyPair(String accessKey, String secretKey) {
            return new SecretPayload(null, accessKey, secretKey);
        }
    }

    public record CreateRequest(String ownerType, String ownerId, String label, String kind,
            String deliveryTier, SecretPayload secret) {}

    @Transactional
    public Credential create(CreateRequest request, String actorUserId) {
        if (request == null) {
            throw new IllegalArgumentException("create request is required");
        }
        String ownerType = requireOwnerType(request.ownerType());
        String ownerId = requireUuid(request.ownerId(), "ownerId");
        String label = requireLabel(request.label());
        String kind = requireKind(request.kind());
        String deliveryTier = requireTier(request.deliveryTier());
        SecretPayload secret = requireSecret(kind, request.secret());

        UUID credentialId = UUID.randomUUID();
        Credential credential = new Credential();
        credential.setId(credentialId);
        credential.setOwnerType(ownerType);
        credential.setOwnerId(ownerId);
        credential.setLabel(label);
        credential.setKind(kind);
        credential.setDeliveryTier(deliveryTier);
        // PLAN-0576 T1.5: AAD uses the values written by this operation — the
        // first revision and the current key version are set before encryption.
        credential.setRevision(1);
        credential.setKeyVersion(credentialEncryption.currentVersion());
        credential.setSecretCiphertext(credentialEnvelope.encryptV2(credential,
                toPlaintextJson(kind, secret)));
        credential.setFingerprint(fingerprint(kind, secret));
        credential.setFingerprintVersion(Credential.FINGERPRINT_VERSION_HMAC_SHA256_V1);
        credential.setCreatedBy(normalizeActorUserId(actorUserId));
        credentialRepository.save(credential);

        recordEvent(credential, CredentialEvent.TYPE_CREATED, actorUserId);
        return credential;
    }

    /** Replaces the secret value in place: same credential id, revision +1 (0495 #7/#18). */
    @Transactional
    public Credential replaceSecret(UUID credentialId, SecretPayload secret, String actorUserId) {
        Credential credential = requireActive(credentialId);
        SecretPayload checked = requireSecret(credential.getKind(), secret);

        // PLAN-0576 T1.5: freeze the AAD inputs on the post-write values —
        // revision+1 and the current key version. The managed entity is not
        // mutated before the CAS (Hibernate would flush the bump and defeat the
        // revision fence), so encryption takes the explicit written values.
        int expectedRevision = credential.getRevision();
        String keyVersion = credentialEncryption.currentVersion();
        String ciphertext = credentialEnvelope.encryptV2(credential.getId().toString(),
                credential.getOwnerType(), credential.getOwnerId(), credential.getKind(),
                expectedRevision + 1, keyVersion, toPlaintextJson(credential.getKind(), checked));
        String fingerprint = fingerprint(credential.getKind(), checked);
        Instant now = Instant.now();

        // Conditional write (round-4 fix): never clobber a concurrent delete
        // (deletedAt fence) or another replace (revision fence), and only touch
        // replace-owned columns so concurrent rotation writes survive.
        int updated = credentialRepository.replaceSecretIfRevisionMatches(credentialId,
                expectedRevision, ciphertext, fingerprint, keyVersion,
                Credential.AAD_VERSION_V2, Credential.FINGERPRINT_VERSION_HMAC_SHA256_V1, now);
        if (updated == 0) {
            throw new CredentialConcurrentModificationException(credentialId);
        }

        credential.setSecretCiphertext(ciphertext);
        credential.setFingerprint(fingerprint);
        credential.setRevision(expectedRevision + 1);
        credential.setKeyVersion(keyVersion);
        credential.setAadVersion(Credential.AAD_VERSION_V2);
        credential.setFingerprintVersion(Credential.FINGERPRINT_VERSION_HMAC_SHA256_V1);
        credential.setReplacedAt(now);
        credential.setUpdatedAt(now);

        recordEvent(credential, CredentialEvent.TYPE_REPLACED, actorUserId);
        return credential;
    }

    /**
     * Soft-deletes the credential (0495 #5/#8). The reference report is a 0496
     * concern (grant reverse lookup); this seam only marks the row and records
     * the event. Conditional write (round-4 fix): only fills deleted_at on a
     * still-active row and never rewrites the business snapshot, so a stale
     * entity can neither revive a delete nor roll back a rotation.
     */
    @Transactional
    public Credential delete(UUID credentialId, String actorUserId) {
        Credential credential = requireActive(credentialId);
        Instant now = Instant.now();
        int updated = credentialRepository.softDeleteIfActive(credentialId, now);
        if (updated == 0) {
            throw new CredentialNotFoundException(credentialId);
        }
        credential.setDeletedAt(now);
        credential.setUpdatedAt(now);

        recordEvent(credential, CredentialEvent.TYPE_DELETED, actorUserId);
        return credential;
    }

    /**
     * PLAN-0496 T3.1: active rows for one owner (management-API list); newest first.
     */
    @Transactional(readOnly = true)
    public List<Credential> listForOwner(String ownerType, String ownerId) {
        return credentialRepository.findByOwnerTypeAndOwnerIdAndDeletedAtIsNullOrderByCreatedAtDesc(
                ownerType, ownerId);
    }

    /**
     * PLAN-0495 T2.3 dangling-check contract for 0496 (frozen in the spec
     * draft): true only when the credential exists, is not soft-deleted and
     * belongs to the given owner. Malformed input returns false — callers map
     * a false result to their own validation error.
     */
    public boolean existsForOwner(String ownerType, String ownerId, String credentialId) {
        UUID id = parseUuid(credentialId);
        if (id == null || ownerType == null || ownerId == null) {
            return false;
        }
        return credentialRepository.findByIdAndDeletedAtIsNull(id)
                .map(credential -> credential.getOwnerType().equalsIgnoreCase(ownerType)
                        && credential.getOwnerId().equalsIgnoreCase(ownerId))
                .orElse(false);
    }

    private Credential requireActive(UUID credentialId) {
        if (credentialId == null) {
            throw new CredentialNotFoundException(null);
        }
        return credentialRepository.findByIdAndDeletedAtIsNull(credentialId)
                .orElseThrow(() -> new CredentialNotFoundException(credentialId));
    }

    private static String toPlaintextJson(String kind, SecretPayload secret) {
        Map<String, String> payload = new LinkedHashMap<>();
        if (Credential.KIND_TOKEN.equals(kind)) {
            payload.put("token", secret.token());
        } else {
            payload.put("accessKey", secret.accessKey());
            payload.put("secretKey", secret.secretKey());
        }
        try {
            return MAPPER.writeValueAsString(payload);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Unable to serialize credential payload", e);
        }
    }

    /** Keyed display/dedup fingerprint; derived from the raw secret value only. */
    private String fingerprint(String kind, SecretPayload secret) {
        return credentialFingerprint.fingerprint(CredentialSecretCodec.canonical(kind, secret));
    }

    private void recordEvent(Credential credential, String eventType, String actorUserId) {
        String actor = actorUserId == null || actorUserId.isBlank()
                ? CredentialEvent.ACTOR_SYSTEM
                : actorUserId;
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

    private static String requireOwnerType(String ownerType) {
        if (Credential.OWNER_USER.equalsIgnoreCase(safeTrim(ownerType))) {
            return Credential.OWNER_USER;
        }
        if (Credential.OWNER_WORKSPACE.equalsIgnoreCase(safeTrim(ownerType))) {
            return Credential.OWNER_WORKSPACE;
        }
        throw new IllegalArgumentException("ownerType must be USER or WORKSPACE");
    }

    private static String requireUuid(String value, String field) {
        UUID parsed = parseUuid(value);
        if (parsed == null) {
            throw new IllegalArgumentException(field + " must be a UUID");
        }
        return parsed.toString();
    }

    private static UUID parseUuid(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(value.trim());
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static String requireLabel(String label) {
        String trimmed = safeTrim(label);
        if (trimmed.isEmpty()) {
            throw new IllegalArgumentException("label must not be blank");
        }
        if (trimmed.length() > LABEL_MAX_LENGTH) {
            throw new IllegalArgumentException("label must be at most " + LABEL_MAX_LENGTH + " characters");
        }
        return trimmed;
    }

    private static String requireKind(String kind) {
        if (Credential.KIND_TOKEN.equalsIgnoreCase(safeTrim(kind))) {
            return Credential.KIND_TOKEN;
        }
        if (Credential.KIND_KEY_PAIR.equalsIgnoreCase(safeTrim(kind))) {
            return Credential.KIND_KEY_PAIR;
        }
        throw new IllegalArgumentException("kind must be token or key_pair");
    }

    private static String requireTier(String deliveryTier) {
        if (Credential.TIER_LEASE.equalsIgnoreCase(safeTrim(deliveryTier))) {
            return Credential.TIER_LEASE;
        }
        if (Credential.TIER_REVEAL.equalsIgnoreCase(safeTrim(deliveryTier))) {
            return Credential.TIER_REVEAL;
        }
        if ("broker".equalsIgnoreCase(safeTrim(deliveryTier))) {
            throw new IllegalArgumentException(
                    "deliveryTier broker is reserved and cannot be registered in v1");
        }
        throw new IllegalArgumentException("deliveryTier must be lease or reveal");
    }

    private static SecretPayload requireSecret(String kind, SecretPayload secret) {
        if (secret == null) {
            throw new IllegalArgumentException("secret is required");
        }
        if (Credential.KIND_TOKEN.equals(kind)) {
            if (safeTrim(secret.token()).isEmpty()) {
                throw new IllegalArgumentException("secret.token must not be blank for kind token");
            }
            return secret;
        }
        if (safeTrim(secret.accessKey()).isEmpty() || safeTrim(secret.secretKey()).isEmpty()) {
            throw new IllegalArgumentException(
                    "secret.accessKey and secret.secretKey must not be blank for kind key_pair");
        }
        return secret;
    }

    private static String normalizeActorUserId(String actorUserId) {
        UUID actor = parseUuid(actorUserId);
        return actor == null ? null : actor.toString();
    }

    private static String safeTrim(String value) {
        return value == null ? "" : value.trim();
    }
}
