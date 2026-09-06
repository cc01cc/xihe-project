package com.cc01cc.p.xihe.cp.oauth;

import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;

@Configuration
public class ProviderCredentialCryptoConfig {

    @Bean(name = "providerCredentialEncryption")
    @Qualifier("providerCredentialEncryption")
    EnvelopeEncryptionService providerCredentialEncryption(
            @Value("${cp.provider-credentials.encryption-key:}") String configuredKey,
            @Value("${cp.provider-credentials.allow-dev-key:true}") boolean allowDevKey) {
        if (configuredKey.isBlank()) {
            if (!allowDevKey) {
                throw new IllegalStateException("cp.provider-credentials.encryption-key is required");
            }
            try {
                byte[] devKey = MessageDigest.getInstance("SHA-256")
                        .digest("xihe-local-provider-credentials-key-not-for-production"
                                .getBytes(StandardCharsets.UTF_8));
                return new EnvelopeEncryptionService(devKey);
            } catch (Exception e) {
                throw new IllegalStateException("Unable to create development provider credential key", e);
            }
        }
        try {
            byte[] key = Base64.getDecoder().decode(configuredKey);
            return new EnvelopeEncryptionService(key);
        } catch (IllegalArgumentException e) {
            throw new IllegalStateException(
                    "cp.provider-credentials.encryption-key must be base64 AES-256", e);
        }
    }
}
