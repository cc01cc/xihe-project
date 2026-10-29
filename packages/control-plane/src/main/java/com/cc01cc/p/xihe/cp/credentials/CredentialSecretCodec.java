package com.cc01cc.p.xihe.cp.credentials;

import com.cc01cc.p.xihe.cp.entity.Credential;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * PLAN-0576 T2.2 (decision #9): the single canonical-string implementation used
 * by create/replace ({@link CredentialService.SecretPayload}) and by rotation
 * (the decrypted JSON payload), so one credential can never have two fingerprints.
 *
 * <p>Canonical form: {@code token} for {@code kind=token}; {@code accessKey +
 * "\n" + secretKey} for {@code kind=key_pair} — identical to PLAN-0495.
 */
public final class CredentialSecretCodec {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private CredentialSecretCodec() {}

    /** create/replace entry point. */
    public static String canonical(String kind, CredentialService.SecretPayload secret) {
        if (secret == null) {
            throw new IllegalArgumentException("secret is required");
        }
        return canonical(kind, secret.token(), secret.accessKey(), secret.secretKey());
    }

    /** rotation entry point: the decrypted JSON plaintext. */
    public static String canonical(String kind, String jsonPlaintext) {
        if (jsonPlaintext == null) {
            throw new IllegalArgumentException("credential plaintext is required");
        }
        JsonNode payload;
        try {
            payload = MAPPER.readTree(jsonPlaintext);
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("stored credential payload is not valid JSON", e);
        }
        if (payload == null || !payload.isObject()) {
            throw new IllegalArgumentException("stored credential payload must be a JSON object");
        }
        return canonical(kind, text(payload, "token"), text(payload, "accessKey"), text(payload, "secretKey"));
    }

    private static String canonical(String kind, String token, String accessKey, String secretKey) {
        if (Credential.KIND_TOKEN.equals(kind)) {
            if (token == null) {
                throw new IllegalArgumentException("token payload is missing for kind token");
            }
            return token;
        }
        if (accessKey == null || secretKey == null) {
            throw new IllegalArgumentException("key_pair payload requires accessKey and secretKey");
        }
        return accessKey + "\n" + secretKey;
    }

    private static String text(JsonNode payload, String field) {
        JsonNode value = payload.get(field);
        return value == null || value.isNull() ? null : value.asText();
    }
}
