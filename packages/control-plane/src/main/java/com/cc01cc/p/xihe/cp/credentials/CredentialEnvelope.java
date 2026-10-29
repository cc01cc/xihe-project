package com.cc01cc.p.xihe.cp.credentials;

import com.cc01cc.p.xihe.cp.crypto.EnvelopeEncryptionService;
import com.cc01cc.p.xihe.cp.entity.Credential;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Component;

/**
 * PLAN-0576 T1.4 (decision #5): the single encrypt/decrypt entry point for the
 * credential domain. Dispatches on {@code row.aadVersion} — 1 = PLAN-0495 legacy
 * AAD, 2 = v2 AAD — and never guesses: any other value fails explicitly.
 *
 * <p>{@link #encryptV2} stamps {@code aad_version=2} on the row (new writes must
 * not rely on the V84 column default) and always builds the AAD from the values
 * written by the operation: create uses revision 1; replace uses
 * {@code oldRevision + 1} and the current key version.
 */
@Component
public class CredentialEnvelope {

    private final EnvelopeEncryptionService encryption;

    public CredentialEnvelope(
            @Qualifier("credentialEncryption") EnvelopeEncryptionService encryption) {
        this.encryption = encryption;
    }

    /** New writes (create/replace): always v2, stamping the row's aad_version. */
    public String encryptV2(Credential row, String plaintext) {
        row.setAadVersion(Credential.AAD_VERSION_V2);
        return encrypt(row, plaintext);
    }

    /**
     * Replace path: encrypts under v2 AAD built from the values that will be
     * written, without mutating the managed entity (a pre-write revision bump
     * would be flushed before the CAS statement). The caller writes the same
     * revision/key version back in the conditional update.
     */
    public String encryptV2(String credentialId, String ownerType, String ownerId, String kind,
            int revision, String keyVersion, String plaintext) {
        return encryption.encrypt(plaintext,
                CredentialAad.formatV2(credentialId, ownerType, ownerId, kind, revision, keyVersion));
    }

    /**
     * Re-encrypts under the row's current AAD version. Rotation must set the
     * target {@code keyVersion} on the row first so the v2 AAD matches the
     * version that is written back.
     */
    public String encrypt(Credential row, String plaintext) {
        return encryption.encrypt(plaintext, aad(row));
    }

    /** Decrypts according to {@code row.aadVersion}; unknown versions fail explicitly. */
    public String decrypt(Credential row) {
        if (row == null) {
            throw new IllegalArgumentException("credential row is required");
        }
        return encryption.decrypt(row.getSecretCiphertext(), aad(row));
    }

    static String aad(Credential row) {
        if (row == null) {
            throw new IllegalArgumentException("credential row is required");
        }
        short version = row.getAadVersion();
        if (version == Credential.AAD_VERSION_LEGACY) {
            return CredentialAad.formatV1(row.getId().toString(), row.getOwnerType(), row.getOwnerId());
        }
        if (version == Credential.AAD_VERSION_V2) {
            return CredentialAad.formatV2(row.getId().toString(), row.getOwnerType(), row.getOwnerId(),
                    row.getKind(), row.getRevision(), row.getKeyVersion());
        }
        throw new IllegalArgumentException("Unsupported credential AAD version: " + version);
    }
}
