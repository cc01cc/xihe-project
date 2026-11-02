package com.cc01cc.p.xihe.cp.policy;

import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Collection;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;

/**
 * PLAN-0625 M2 (D25-13): in-memory verdict cache — fingerprint {@code SHA-256(kind ‖ actionClass ‖
 * sorted(resources) ‖ canonical whitelist key)} with a 300s TTL. Wrong-cache loss is one extra
 * model call, which is exactly what the budget ruling accepts; the durable, auditable record of
 * advice remains the approval's {@code policySummary.hooks} section.
 */
@Component
public class HookVerdictCache {

    /** D25-13 ruling: 300 seconds. */
    public static final long TTL_MILLIS = 300_000;

    private record Entry(HookVerdict verdict, long expiresAt) {
    }

    private final ConcurrentHashMap<String, Entry> cache = new ConcurrentHashMap<>();

    public HookVerdict get(String fingerprint) {
        Entry entry = fingerprint == null ? null : cache.get(fingerprint);
        if (entry == null) {
            return null;
        }
        if (entry.expiresAt() < System.currentTimeMillis()) {
            cache.remove(fingerprint, entry);
            return null;
        }
        return entry.verdict();
    }

    public void put(String fingerprint, HookVerdict verdict) {
        if (fingerprint == null || verdict == null) {
            return;
        }
        cache.put(fingerprint, new Entry(verdict, System.currentTimeMillis() + TTL_MILLIS));
    }

    /** Test/diagnostics seam. */
    public int size() {
        return cache.size();
    }

    /**
     * The D25-13 fingerprint. Resources are sorted so set-order never changes the key; the
     * whitelist key is normalized (trim + lowercase) like the 0612 path normalization precedent.
     */
    public static String fingerprint(String kind, String actionClass,
                                     Collection<String> resources, String whitelistKey) {
        List<String> sorted = resources == null ? List.of()
                : resources.stream().filter(resource -> resource != null && !resource.isBlank())
                        .map(resource -> resource.trim().toLowerCase(Locale.ROOT)).sorted().toList();
        String canonicalWhitelist = whitelistKey == null ? "" : whitelistKey.trim().toLowerCase(Locale.ROOT);
        String material = (kind == null ? "" : kind) + "\n"
                + (actionClass == null ? "" : actionClass) + "\n"
                + String.join(",", sorted) + "\n"
                + canonicalWhitelist;
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(material.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(hash.length * 2);
            for (byte b : hash) {
                hex.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }
}
