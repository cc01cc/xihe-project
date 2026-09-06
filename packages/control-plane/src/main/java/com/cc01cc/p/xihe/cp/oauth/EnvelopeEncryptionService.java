package com.cc01cc.p.xihe.cp.oauth;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.Base64;
import java.util.Map;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** AES-256-GCM envelope primitive for refresh-token ciphertext. */
public final class EnvelopeEncryptionService {

    private static final String CIPHER = "AES/GCM/NoPadding";
    private static final int KEY_BYTES = 32;
    private static final int NONCE_BYTES = 12;
    private static final int TAG_BITS = 128;
    private static final String VERSION = "v1";

    private final Map<String, SecretKeySpec> keys;
    private final String currentVersion;

    public EnvelopeEncryptionService(byte[] masterKey) {
        this(Map.of("v1", masterKey), "v1");
    }

    public EnvelopeEncryptionService(Map<String, byte[]> masterKeys, String currentVersion) {
        if (masterKeys == null || masterKeys.isEmpty() || currentVersion == null
                || !masterKeys.containsKey(currentVersion)) {
            throw new IllegalArgumentException("Envelope key ring and current version are required");
        }
        this.keys = masterKeys.entrySet().stream().collect(java.util.stream.Collectors.toUnmodifiableMap(
                Map.Entry::getKey, entry -> key(entry.getValue())));
        this.currentVersion = currentVersion;
    }

    private static SecretKeySpec key(byte[] masterKey) {
        if (masterKey == null || masterKey.length != KEY_BYTES) {
            throw new IllegalArgumentException("Envelope master key must be exactly 32 bytes");
        }
        return new SecretKeySpec(masterKey.clone(), "AES");
    }

    public String encrypt(String plaintext, String associatedData) {
        if (plaintext == null) {
            throw new IllegalArgumentException("plaintext must not be null");
        }
        try {
            byte[] nonce = new byte[NONCE_BYTES];
            new java.security.SecureRandom().nextBytes(nonce);
            Cipher cipher = Cipher.getInstance(CIPHER);
            cipher.init(Cipher.ENCRYPT_MODE, keys.get(currentVersion), new GCMParameterSpec(TAG_BITS, nonce));
            cipher.updateAAD(aad(associatedData));
            byte[] ciphertext = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            return currentVersion + ":" + encode(nonce) + ":" + encode(ciphertext);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("Unable to encrypt envelope", e);
        }
    }

    public String currentVersion() {
        return currentVersion;
    }

    public String decrypt(String envelope, String associatedData) {
        if (envelope == null) {
            throw new IllegalArgumentException("envelope must not be null");
        }
        String[] parts = envelope.split(":", -1);
        if (parts.length != 3 || !keys.containsKey(parts[0])) {
            throw new IllegalArgumentException("Unsupported envelope format");
        }
        try {
            byte[] nonce = decode(parts[1]);
            if (nonce.length != NONCE_BYTES) {
                throw new IllegalArgumentException("Invalid envelope nonce");
            }
            Cipher cipher = Cipher.getInstance(CIPHER);
            cipher.init(Cipher.DECRYPT_MODE, keys.get(parts[0]), new GCMParameterSpec(TAG_BITS, nonce));
            cipher.updateAAD(aad(associatedData));
            return new String(cipher.doFinal(decode(parts[2])), StandardCharsets.UTF_8);
        } catch (GeneralSecurityException | IllegalArgumentException e) {
            throw new IllegalArgumentException("Unable to decrypt envelope", e);
        }
    }

    private static byte[] aad(String associatedData) {
        return (associatedData == null ? "" : associatedData).getBytes(StandardCharsets.UTF_8);
    }

    private static String encode(byte[] value) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value);
    }

    private static byte[] decode(String value) {
        return Base64.getUrlDecoder().decode(value);
    }
}
