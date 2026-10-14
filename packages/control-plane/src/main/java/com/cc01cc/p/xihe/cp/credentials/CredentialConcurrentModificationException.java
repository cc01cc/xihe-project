package com.cc01cc.p.xihe.cp.credentials;

import java.util.UUID;

/**
 * PLAN-0495 review round-4: raised when a credential mutation loses its
 * revision/state fence because the row changed concurrently (another replace,
 * delete or rotation committed first). Callers re-read and retry or surface a
 * conflict; a stale snapshot must never be written back.
 */
public class CredentialConcurrentModificationException extends RuntimeException {

    private final UUID credentialId;

    public CredentialConcurrentModificationException(UUID credentialId) {
        super("Credential was modified concurrently: " + credentialId);
        this.credentialId = credentialId;
    }

    public UUID getCredentialId() {
        return credentialId;
    }
}
