package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.http.HttpStatus;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Set;

/**
 * PLAN-0630 M1: shape validation for the agent subject's delegation budget document stored in
 * {@code agent_principals.delegation_policy} (V100; NULL = code defaults).
 *
 * <p>Frozen shape (PLAN-0630 README ruling #2 — {@code limits = {maxCount, maxDepth}}):</p>
 * <pre>{@code
 * { "maxCount": 8, "maxDepth": 3 }
 * }</pre>
 *
 * <ul>
 *   <li>both keys are optional — a missing key means "use the code default";</li>
 *   <li>each present value must be a <b>JSON integer ≥ 1</b>. {@code 0} is <b>not</b> "unlimited"
 *       here, unlike the {@code runMaxTurns} family ({@code ConfigService} run-budget comment): a
 *       zero delegation budget would mean "may never delegate", which is expressed by not granting
 *       {@code SPAWN_AGENT} at all, not by a policy value;</li>
 *   <li>unknown keys are rejected ({@code additionalProperties:false}) so a typo cannot silently
 *       become a no-op setting;</li>
 *   <li>{@code null} = clear the column (falls back to the code defaults).</li>
 * </ul>
 *
 * <p>Two callers, one parser (the shape and the error text must never drift):</p>
 * <ul>
 *   <li>{@link #validate(JsonNode)} — the write face ({@code PATCH /agent-principals/{id}}), which
 *       answers {@code 400 INVALID_REQUEST} for a malformed document;</li>
 *   <li>{@link #limits(JsonNode, int, int)} — the read gate, which answers
 *       {@code 409 DELEGATION_POLICY_INVALID} and fails closed instead of silently using the
 *       defaults (a stored-but-unreadable policy is an operator error, not a user typo).</li>
 * </ul>
 */
public final class DelegationPolicyValidator {

    public static final String KEY_MAX_COUNT = "maxCount";
    public static final String KEY_MAX_DEPTH = "maxDepth";

    /** Anti-footgun rails, applied by the read path regardless of configuration. */
    public static final int HARD_MAX_COUNT = 1000;
    public static final int HARD_MAX_DEPTH = 10;

    private static final Set<String> ALLOWED_KEYS = Set.of(KEY_MAX_COUNT, KEY_MAX_DEPTH);

    private DelegationPolicyValidator() {}

    /** The resolved delegation budget (already clamped to the hard rails by the caller). */
    public record DelegationLimits(int maxCount, int maxDepth) {}

    /**
     * Validates one {@code delegationPolicy} document for the write face.
     *
     * @return the normalised document (deep copy), or {@code null} when the caller sent {@code null}
     *     (clear the column)
     * @throws CpApiException 400 {@code INVALID_REQUEST} on any shape or value violation
     */
    public static JsonNode validate(JsonNode policy) {
        parse(policy, HttpStatus.BAD_REQUEST, "INVALID_REQUEST");
        return policy == null || policy.isNull() ? null : policy.deepCopy();
    }

    /**
     * Reads the effective limits for the gate. Missing keys fall back to the supplied defaults;
     * a malformed stored document fails closed with {@code 409 DELEGATION_POLICY_INVALID}.
     *
     * @throws CpApiException 409 {@code DELEGATION_POLICY_INVALID} when the stored document is invalid
     */
    public static DelegationLimits limits(JsonNode policy, int defaultMaxCount, int defaultMaxDepth) {
        parse(policy, HttpStatus.CONFLICT, "DELEGATION_POLICY_INVALID");
        int maxCount = readInt(policy, KEY_MAX_COUNT, defaultMaxCount);
        int maxDepth = readInt(policy, KEY_MAX_DEPTH, defaultMaxDepth);
        return new DelegationLimits(Math.min(maxCount, HARD_MAX_COUNT), Math.min(maxDepth, HARD_MAX_DEPTH));
    }

    private static void parse(JsonNode policy, HttpStatus status, String code) {
        if (policy == null || policy.isNull()) {
            return;
        }
        if (!policy.isObject()) {
            throw invalid(status, code, "delegationPolicy must be an object with maxCount/maxDepth, or null");
        }
        List<String> unknown = new ArrayList<>();
        Iterator<String> names = policy.fieldNames();
        while (names.hasNext()) {
            String name = names.next();
            if (!ALLOWED_KEYS.contains(name)) {
                unknown.add(name);
            }
        }
        if (!unknown.isEmpty()) {
            throw invalid(status, code, "delegationPolicy accepts only maxCount and maxDepth; unknown key(s): "
                    + String.join(", ", unknown));
        }
        requirePositiveInteger(policy, KEY_MAX_COUNT, status, code);
        requirePositiveInteger(policy, KEY_MAX_DEPTH, status, code);
    }

    private static void requirePositiveInteger(JsonNode policy, String key, HttpStatus status, String code) {
        JsonNode value = policy.get(key);
        if (value == null || value.isNull()) {
            return;
        }
        if (!value.isIntegralNumber()) {
            throw invalid(status, code, "delegationPolicy." + key + " must be an integer >= 1");
        }
        if (value.asInt() < 1) {
            throw invalid(status, code, "delegationPolicy." + key + " must be >= 1 (0 is not \"unlimited\"; "
                    + "withdraw the SPAWN_AGENT authorisation instead)");
        }
        // Refuse (rather than clamp) on the write face: silently storing a value that every read will
        // clamp is exactly the "writable but never effective" no-op this plan set out to remove.
        if (value.asInt() > hardRail(key)) {
            throw invalid(status, code, "delegationPolicy." + key + " must not exceed the hard ceiling "
                    + hardRail(key));
        }
    }

    private static int hardRail(String key) {
        return KEY_MAX_COUNT.equals(key) ? HARD_MAX_COUNT : HARD_MAX_DEPTH;
    }

    private static int readInt(JsonNode policy, String key, int fallback) {
        JsonNode value = policy == null ? null : policy.get(key);
        // parse() above has already applied the hard rail (and refused above-rail values on BOTH exits):
        // the write face answers 400, the read gate answers 409. V100 ships with no backfill, so an
        // above-rail document can never legitimately exist - refusing beats a silent clamp.
        return value == null || value.isNull() ? fallback : value.asInt();
    }

    private static CpApiException invalid(HttpStatus status, String code, String detail) {
        return new CpApiException(status, code, detail);
    }
}
