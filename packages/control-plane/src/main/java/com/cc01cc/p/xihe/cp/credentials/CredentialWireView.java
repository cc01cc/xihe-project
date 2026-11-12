package com.cc01cc.p.xihe.cp.credentials;

import com.cc01cc.p.xihe.cp.entity.Credential;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * PLAN-0771 M3: the single wire projection for {@code CredentialView} (openapi.yaml).
 *
 * <p>Both credential surfaces — the user/workspace management API
 * ({@code /api/v1/credentials}) and the instance API ({@code /api/v1/instance/credentials}) — must
 * emit the same sanitized shape, so the projection lives here instead of in each controller. The
 * contract requires {@code ownerId} to be <b>present-but-null</b> for INSTANCE rows (D-1009); a
 * {@link LinkedHashMap} keeps that key in the response while never carrying ciphertext, suffixes or
 * plaintext.</p>
 */
public final class CredentialWireView {

    private CredentialWireView() {
    }

    public static Map<String, Object> toWire(Credential credential) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("id", credential.getId().toString());
        body.put("label", credential.getLabel());
        body.put("kind", credential.getKind());
        body.put("deliveryTier", credential.getDeliveryTier());
        body.put("ownerType", credential.getOwnerType());
        body.put("ownerId", credential.getOwnerId());
        body.put("status", credential.getStatus());
        body.put("fingerprint", credential.getFingerprint());
        body.put("revision", credential.getRevision());
        body.put("createdAt", credential.getCreatedAt() == null ? null : credential.getCreatedAt().toString());
        body.put("replacedAt", credential.getReplacedAt() == null ? null : credential.getReplacedAt().toString());
        return body;
    }
}
