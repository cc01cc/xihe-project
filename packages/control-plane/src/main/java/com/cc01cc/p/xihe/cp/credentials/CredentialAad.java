package com.cc01cc.p.xihe.cp.credentials;

/**
 * PLAN-0495 I2: AAD binding contract for credential envelopes — every
 * ciphertext binds its row identity and owner ({@code credentialId|ownerType|ownerId}),
 * so a ciphertext copied to another credential (or owner) fails decryption.
 */
public final class CredentialAad {

    private CredentialAad() {}

    public static String format(String credentialId, String ownerType, String ownerId) {
        return credentialId + "|" + ownerType + "|" + ownerId;
    }
}
