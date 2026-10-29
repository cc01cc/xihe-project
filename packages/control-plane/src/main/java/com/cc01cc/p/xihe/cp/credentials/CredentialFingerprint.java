package com.cc01cc.p.xihe.cp.credentials;

import com.cc01cc.p.xihe.cp.entity.Credential;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/**
 * PLAN-0576 T2.2 (decision #2): keyed fingerprint for credential display/dedup.
 *
 * <p>New fingerprints are {@code HMAC-SHA256(fingerprintKey, canonical)} rendered
 * as 64 lowercase hex characters, written with
 * {@code fingerprint_version=hmac-sha256-v1}. The key is an independent
 * credential-domain secret ({@code cp.credentials.fingerprint-key}) — never the
 * encryption key — so a DB dump alone cannot be used to verify guessed
 * low-entropy tokens offline.
 *
 * <p>{@link #legacySha256} keeps the unkeyed PLAN-0495 algorithm only for
 * reading/verifying legacy rows ({@code fingerprint_version=sha256}); it is
 * retired for new writes and scheduled to disappear once rotation migrates
 * every row.
 */
public final class CredentialFingerprint {

    /** Exposed for callers that must write the version alongside the value. */
    public static final String VERSION_HMAC_SHA256_V1 = Credential.FINGERPRINT_VERSION_HMAC_SHA256_V1;
    public static final String VERSION_SHA256_LEGACY = Credential.FINGERPRINT_VERSION_SHA256;

    private static final String ALGORITHM = "HmacSHA256";
    private static final String LEGACY_ALGORITHM = "SHA-256";
    private static final int KEY_BYTES = 32;

    private final SecretKeySpec key;

    public CredentialFingerprint(byte[] fingerprintKey) {
        if (fingerprintKey == null || fingerprintKey.length != KEY_BYTES) {
            throw new IllegalArgumentException("credential fingerprint key must be exactly 32 bytes");
        }
        this.key = new SecretKeySpec(fingerprintKey.clone(), ALGORITHM);
    }

    /** 64 hex characters; the only supported new-write fingerprint. */
    public String fingerprint(String canonical) {
        if (canonical == null) {
            throw new IllegalArgumentException("canonical credential secret is required");
        }
        try {
            Mac mac = Mac.getInstance(ALGORITHM);
            mac.init(key);
            return HexFormat.of().formatHex(mac.doFinal(canonical.getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("Unable to compute the credential fingerprint", e);
        }
    }

    /**
     * PLAN-0495 legacy fingerprint (unkeyed SHA-256). Kept only to verify
     * {@code fingerprint_version=sha256} rows until rotation migrates them.
     */
    @Deprecated(forRemoval = true)
    public static String legacySha256(String canonical) {
        if (canonical == null) {
            throw new IllegalArgumentException("canonical credential secret is required");
        }
        try {
            byte[] digest = MessageDigest.getInstance(LEGACY_ALGORITHM)
                    .digest(canonical.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }
}
