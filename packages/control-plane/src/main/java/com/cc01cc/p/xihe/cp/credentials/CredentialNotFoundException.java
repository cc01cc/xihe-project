package com.cc01cc.p.xihe.cp.credentials;

import java.util.UUID;

/** Raised when a credential does not exist (or is soft-deleted) for the requested operation. */
public class CredentialNotFoundException extends RuntimeException {

    private final UUID credentialId;

    public CredentialNotFoundException(UUID credentialId) {
        super("Credential not found: " + credentialId);
        this.credentialId = credentialId;
    }

    public UUID getCredentialId() {
        return credentialId;
    }
}
