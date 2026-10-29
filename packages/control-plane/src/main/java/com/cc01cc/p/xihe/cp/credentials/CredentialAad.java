package com.cc01cc.p.xihe.cp.credentials;

/**
 * PLAN-0495 I2 / PLAN-0576 决策 #1: AAD binding contract for credential envelopes.
 *
 * <p>v1 (legacy, {@code aad_version=1}) binds row identity and owner only:
 * {@code credentialId|ownerType|ownerId}. v2 (new writes) additionally binds
 * {@code kind|revision|keyVersion}, prefixed with {@code v2} for domain
 * separation: {@code v2|credentialId|ownerType|ownerId|kind|revision|keyVersion}.
 *
 * <p>Threat model (PLAN-0576 design #8): v2 rejects a ciphertext swapped into a
 * row whose metadata is unchanged — old revision, other kind, other key version,
 * other owner. An attacker able to rewrite the metadata columns as well is not
 * covered; that needs whole-row signing, which is out of scope.
 *
 * <p>Call sites must not build AAD strings themselves; {@link CredentialEnvelope}
 * is the single encrypt/decrypt entry point.
 */
public final class CredentialAad {

    public static final String V2_PREFIX = "v2";

    private CredentialAad() {}

    /** PLAN-0495 format, kept verbatim so existing v1 ciphertexts stay readable. */
    public static String formatV1(String credentialId, String ownerType, String ownerId) {
        return credentialId + "|" + ownerType + "|" + ownerId;
    }

    /** PLAN-0576 v2 format; revision/keyVersion must be the values written by this operation. */
    public static String formatV2(String credentialId, String ownerType, String ownerId,
            String kind, int revision, String keyVersion) {
        if (revision < 1) {
            throw new IllegalArgumentException("revision must be >= 1 for the v2 credential AAD");
        }
        return V2_PREFIX + "|" + requirePart(credentialId, "credentialId")
                + "|" + requirePart(ownerType, "ownerType")
                + "|" + requirePart(ownerId, "ownerId")
                + "|" + requirePart(kind, "kind")
                + "|" + revision
                + "|" + requirePart(keyVersion, "keyVersion");
    }

    private static String requirePart(String value, String field) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(field + " is required for the v2 credential AAD");
        }
        if (value.indexOf('|') >= 0) {
            throw new IllegalArgumentException(field + " must not contain the AAD separator '|'");
        }
        return value;
    }
}
