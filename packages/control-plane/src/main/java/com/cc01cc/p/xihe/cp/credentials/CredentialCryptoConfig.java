package com.cc01cc.p.xihe.cp.credentials;

import com.cc01cc.p.xihe.cp.crypto.EnvelopeEncryptionService;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * PLAN-0495 T1.2/T1.3 (0494 #8): independent credential encryption domain.
 *
 * <p>Two configuration forms — a single base64 AES-256 key
 * ({@code cp.credentials.encryption-key}, registered under
 * {@code cp.credentials.current-version}, default {@code v1}) or a multi-version
 * key ring ({@code cp.credentials.key-ring}, JSON {@code {version: base64 key}}).
 * The ring must contain the current version; a missing current version refuses
 * startup (0495 V5). Dev fallback derives a public key and WARNs unless
 * {@code cp.credentials.allow-dev-key} is disabled (prod gate).
 */
@Configuration
public class CredentialCryptoConfig {

    private static final Logger log = LoggerFactory.getLogger(CredentialCryptoConfig.class);

    private static final String SINGLE_KEY_SOURCE = "cp.credentials.encryption-key";
    private static final String KEY_RING_SOURCE = "cp.credentials.key-ring";
    private static final int KEY_BYTES = 32;
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Bean(name = "credentialEncryption")
    @Qualifier("credentialEncryption")
    EnvelopeEncryptionService credentialEncryption(
            @Value("${cp.credentials.encryption-key:}") String configuredKey,
            @Value("${cp.credentials.key-ring:}") String configuredRing,
            @Value("${cp.credentials.current-version:v1}") String configuredCurrentVersion,
            @Value("${cp.credentials.allow-dev-key:true}") boolean allowDevKey) {
        String currentVersion = requireVersion(configuredCurrentVersion, "cp.credentials.current-version");
        boolean hasKey = configuredKey != null && !configuredKey.isBlank();
        boolean hasRing = configuredRing != null && !configuredRing.isBlank();
        if (hasKey && hasRing) {
            throw new IllegalStateException("configure either cp.credentials.encryption-key or "
                    + "cp.credentials.key-ring, not both");
        }
        if (!hasKey && !hasRing) {
            if (!allowDevKey) {
                throw new IllegalStateException("cp.credentials.encryption-key is required");
            }
            return devFallback(currentVersion);
        }
        Map<String, byte[]> ring = hasRing
                ? parseRing(configuredRing)
                : Map.of(currentVersion, decodeKey(configuredKey, SINGLE_KEY_SOURCE));
        if (!ring.containsKey(currentVersion)) {
            throw new IllegalStateException("cp.credentials.key-ring is missing the current version '"
                    + currentVersion + "'; registered versions: " + ring.keySet());
        }
        return new EnvelopeEncryptionService(ring, currentVersion);
    }

    private static EnvelopeEncryptionService devFallback(String currentVersion) {
        // PLAN-0495 V5: the derived dev key is public and must never protect real
        // credentials — prod is gated by SecurityDefaultsValidator; warn everywhere else.
        log.warn("[CONFIG] credential dev key active - cp.credentials.encryption-key is unset; "
                + "do not store real credentials with this key");
        try {
            byte[] devKey = MessageDigest.getInstance("SHA-256")
                    .digest("xihe-local-credentials-key-not-for-production"
                            .getBytes(StandardCharsets.UTF_8));
            return new EnvelopeEncryptionService(Map.of(currentVersion, devKey), currentVersion);
        } catch (Exception e) {
            throw new IllegalStateException("Unable to create development credential key", e);
        }
    }

    static String requireVersion(String version, String source) {
        if (version == null || version.isBlank() || version.contains(":") || version.length() > 16) {
            throw new IllegalStateException(source + " must be 1-16 characters without ':': " + version);
        }
        return version;
    }

    static Map<String, byte[]> parseRing(String configuredRing) {
        Map<String, String> raw;
        try {
            raw = MAPPER.readValue(configuredRing, new TypeReference<Map<String, String>>() {});
        } catch (JsonProcessingException e) {
            // Round-4 fix: the cause is intentionally dropped — Jackson embeds a
            // source excerpt that could quote key material from a malformed ring.
            throw new IllegalStateException(
                    KEY_RING_SOURCE + " must be a JSON object of {version: base64 key}");
        }
        if (raw == null || raw.isEmpty()) {
            throw new IllegalStateException(KEY_RING_SOURCE + " must contain at least one version");
        }
        Map<String, byte[]> ring = new LinkedHashMap<>();
        for (Map.Entry<String, String> entry : raw.entrySet()) {
            String version = requireVersion(entry.getKey(), KEY_RING_SOURCE + " version");
            ring.put(version, decodeKey(entry.getValue(), KEY_RING_SOURCE + "[" + version + "]"));
        }
        return ring;
    }

    static byte[] decodeKey(String configuredKey, String source) {
        if (configuredKey == null || configuredKey.isBlank()) {
            throw new IllegalStateException(source + " must not be blank");
        }
        byte[] key;
        try {
            key = Base64.getDecoder().decode(configuredKey.trim());
        } catch (IllegalArgumentException e) {
            throw new IllegalStateException(source + " must be base64 AES-256", e);
        }
        if (key.length != KEY_BYTES) {
            throw new IllegalStateException(source + " must be base64 AES-256 (32 bytes)");
        }
        return key;
    }
}
