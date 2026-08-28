package com.cc01cc.p.xihe.cp.oauth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class OAuthCryptoConfig {

    @Bean
    EnvelopeEncryptionService envelopeEncryptionService(
            @Value("${cp.oauth.encryption-key:}") String configuredKey,
            @Value("${cp.oauth.allow-dev-key:true}") boolean allowDevKey) {
        if (configuredKey.isBlank()) {
            if (!allowDevKey) {
                throw new IllegalStateException("cp.oauth.encryption-key is required");
            }
            try {
                byte[] devKey = MessageDigest.getInstance("SHA-256")
                        .digest("xihe-local-oauth-key-not-for-production".getBytes(StandardCharsets.UTF_8));
                return new EnvelopeEncryptionService(devKey);
            } catch (Exception e) {
                throw new IllegalStateException("Unable to create development OAuth key", e);
            }
        }
        try {
            return new EnvelopeEncryptionService(java.util.Base64.getDecoder().decode(configuredKey));
        } catch (IllegalArgumentException e) {
            throw new IllegalStateException("cp.oauth.encryption-key must be base64 AES-256", e);
        }
    }
}
