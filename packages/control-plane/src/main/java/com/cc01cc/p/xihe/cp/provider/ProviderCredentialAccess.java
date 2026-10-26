package com.cc01cc.p.xihe.cp.provider;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.credentials.CredentialAad;
import com.cc01cc.p.xihe.cp.credentials.CredentialNotFoundException;
import com.cc01cc.p.xihe.cp.crypto.EnvelopeEncryptionService;
import com.cc01cc.p.xihe.cp.entity.Credential;
import com.cc01cc.p.xihe.cp.policy.GrantAuthorizationService;
import com.cc01cc.p.xihe.cp.policy.PolicyRequest;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.policy.ToolShape;
import com.cc01cc.p.xihe.cp.repository.CredentialRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0553: the only provider-side gateway to credential plaintext. Provider
 * connections store an owner-neutral credential id; every use is gated by
 * credential kind/tier/status and by the credential-domain RBAC
 * ({@code credential_use@credential:<id>} or owner match).
 */
@Service
public class ProviderCredentialAccess {

    private final CredentialRepository credentials;
    private final EnvelopeEncryptionService encryption;
    private final GrantAuthorizationService grants;
    private final ObjectMapper objectMapper;

    public ProviderCredentialAccess(
            CredentialRepository credentials,
            @Qualifier("credentialEncryption") EnvelopeEncryptionService encryption,
            GrantAuthorizationService grants,
            ObjectMapper objectMapper) {
        this.credentials = credentials;
        this.encryption = encryption;
        this.grants = grants;
        this.objectMapper = objectMapper;
    }

    /** Link/verify/use gate: active token credential, lease tier, owner or credential_use. */
    @Transactional(readOnly = true)
    public Credential requireUsable(UUID credentialId, String userId, String workspaceId) {
        Credential credential = requireUsableShape(credentialId);
        if (!canUse(credential, userId, workspaceId)) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "CREDENTIAL_USE_DENIED",
                    "The current principal cannot use this credential");
        }
        return credential;
    }

    /** Verify/use path: authorize the actor, then decrypt the token. */
    @Transactional(readOnly = true)
    public String decryptForUse(UUID credentialId, String userId, String workspaceId) {
        return decryptToken(requireUsable(credentialId, userId, workspaceId));
    }

    /** Export/delivery path: caller has already passed the export/lease gate. */
    @Transactional(readOnly = true)
    public String decryptForDelivery(UUID credentialId) {
        return decryptToken(requireUsableShape(credentialId));
    }

    /** Connection view/audit helper; never returns a secret. */
    public boolean isUsable(UUID credentialId) {
        if (credentialId == null) {
            return false;
        }
        return credentials.findByIdAndDeletedAtIsNull(credentialId)
                .filter(this::hasUsableShape)
                .isPresent();
    }

    public Optional<Credential> findUsable(UUID credentialId) {
        if (credentialId == null) {
            return Optional.empty();
        }
        return credentials.findByIdAndDeletedAtIsNull(credentialId).filter(this::hasUsableShape);
    }

    private Credential requireUsableShape(UUID credentialId) {
        Credential credential = credentialId == null ? null
                : credentials.findByIdAndDeletedAtIsNull(credentialId).orElse(null);
        if (credential == null) {
            throw new CredentialNotFoundException(credentialId);
        }
        if (!hasUsableShape(credential)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "CREDENTIAL_NOT_USABLE",
                    "Only active lease-tier token credentials can back a provider connection");
        }
        return credential;
    }

    private boolean hasUsableShape(Credential credential) {
        return Credential.KIND_TOKEN.equals(credential.getKind())
                && Credential.TIER_LEASE.equals(credential.getDeliveryTier())
                && Credential.STATUS_ACTIVE.equals(credential.getStatus());
    }

    private boolean canUse(Credential credential, String userId, String workspaceId) {
        if (userId != null && Credential.OWNER_USER.equals(credential.getOwnerType())
                && userId.equalsIgnoreCase(credential.getOwnerId())) {
            return true;
        }
        if (workspaceId != null && Credential.OWNER_WORKSPACE.equals(credential.getOwnerType())
                && workspaceId.equalsIgnoreCase(credential.getOwnerId())) {
            return true;
        }
        if (userId == null || userId.isBlank() || workspaceId == null || workspaceId.isBlank()) {
            return false;
        }
        return grants.allowsUserOnly(new PolicyRequest(
                "provider_connection",
                List.of(ToolFaceRegistry.ACTION_CREDENTIAL_USE),
                List.of("credential:" + credential.getId()),
                ToolShape.STRUCTURED,
                userId, workspaceId, null));
    }

    private String decryptToken(Credential credential) {
        String plaintext = encryption.decrypt(credential.getSecretCiphertext(),
                CredentialAad.format(credential.getId().toString(), credential.getOwnerType(),
                        credential.getOwnerId()));
        try {
            String token = objectMapper.readTree(plaintext).path("token").asText(null);
            if (token == null || token.isBlank()) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "CREDENTIAL_NOT_USABLE",
                        "Credential does not contain a token");
            }
            return token;
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new IllegalStateException("Stored credential payload is invalid", e);
        }
    }
}
