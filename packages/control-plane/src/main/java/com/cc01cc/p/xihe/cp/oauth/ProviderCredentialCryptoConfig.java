package com.cc01cc.p.xihe.cp.oauth;

import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;

@Configuration
public class ProviderCredentialCryptoConfig {

    private static final Logger log = LoggerFactory.getLogger(ProviderCredentialCryptoConfig.class);

    @Bean(name = "providerCredentialEncryption")
    @Qualifier("providerCredentialEncryption")
    EnvelopeEncryptionService providerCredentialEncryption(
            @Value("${cp.provider-credentials.encryption-key:}") String configuredKey,
            @Value("${cp.provider-credentials.allow-dev-key:true}") boolean allowDevKey) {
        if (configuredKey.isBlank()) {
            if (!allowDevKey) {
                throw new IllegalStateException("cp.provider-credentials.encryption-key is required");
            }
            // PLAN-0307 T2.24 (review P1-6): the derived dev key is public and
            // must never protect real credentials — the T3.4 fail-fast gate
            // rejects it under XIHE_ENV=prod; warn everywhere else.
            log.warn("[CONFIG] provider credential dev key active - cp.provider-credentials.encryption-key is unset; "
                    + "do not store real credentials with this key");
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
