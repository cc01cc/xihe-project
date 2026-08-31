package com.cc01cc.p.xihe.cp.util;

import com.fasterxml.jackson.databind.MapperFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;

public final class SandboxSpecHashUtil {

    private static final ObjectMapper MAPPER = new ObjectMapper()
            .configure(MapperFeature.SORT_PROPERTIES_ALPHABETICALLY, true)
            .configure(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS, true);

    private SandboxSpecHashUtil() {}

    /**
     * Canonical JSON SHA256 per grill Q12 A.
     * Sorts keys alphabetically, then SHA256 hex.
     */
    public static String hash(String sandboxSpecJson) {
        try {
            Object tree = MAPPER.readValue(sandboxSpecJson, Object.class);
            String canonical = MAPPER.writeValueAsString(tree);
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(canonical.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hash);
        } catch (Exception e) {
            throw new IllegalArgumentException("Failed to hash SandboxSpec: " + e.getMessage(), e);
        }
    }

    public static String hashObject(Object spec) {
        try {
            String canonical = MAPPER.writeValueAsString(spec);
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(canonical.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hash);
        } catch (Exception e) {
            throw new IllegalArgumentException("Failed to hash SandboxSpec object: " + e.getMessage(), e);
        }
    }
}
