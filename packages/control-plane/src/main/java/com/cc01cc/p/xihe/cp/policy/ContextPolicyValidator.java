package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.http.HttpStatus;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Set;

/**
 * PLAN-0629 M1 (D29-21): shape validation for the agent subject's memory policy document stored in
 * {@code agent_principals.context_policy} (V92 created the nullable {@code jsonb} column; D23-20 keeps
 * it on the subject instead of the {@code context-policy} config domain).
 *
 * <p>Frozen shape (user ruling 2026-11-02, D29-25; extended by M1-6 / D29-26):</p>
 * <pre>{@code
 * { "memory": { "enabled": false, "writeMode": "off", "passive": "off",
 *               "types": ["profile", "fact"] } }
 * }</pre>
 *
 * <ul>
 *   <li>{@code enabled} — boolean, default {@code false}: a new subject has no memory until the user
 *       switches it on;</li>
 *   <li>{@code writeMode} — {@code off | tool} only. {@code judge} is a <b>v1-reserved</b> value: it is
 *       rejected with an explicit detail instead of being stored, because the adjudication path is
 *       planned for M2 (it will reuse the 0624 {@code JudgeDecisionService});</li>
 *   <li>{@code passive} — {@code off | summary | judge}, default {@code off} (M1-6 / D29-26). It enables
 *       the <b>system-side</b> write path rather than naming a channel: {@code summary} derives one
 *       memory from the compaction summary that already exists, {@code judge} additionally asks the
 *       existing judge seam whether that segment is worth remembering. Both land as
 *       {@code status=candidate} and are invisible until an explicit channel promotes them, which is why
 *       the value is a policy and not an {@code origin}: the writers set
 *       {@code origin=passive.summary|passive.judge} and the database pairs {@code origin LIKE
 *       'passive.%'} with {@code status='candidate'} (V99, D29-31);</li>
 *   <li>{@code types} — subset of {@code profile|fact}; an empty array means "no type", i.e. memory is
 *       effectively off. The passive writer additionally requires the type it produces ({@code fact}) to
 *       be listed: {@code types} is fail-closed, never "every type by default";</li>
 *   <li>unknown keys are rejected at both levels ({@code additionalProperties:false}) so a typo cannot
 *       silently become a no-op setting;</li>
 *   <li>{@code null} = clear the column (write SQL {@code NULL}).</li>
 * </ul>
 *
 * <p>Deliberately absent from this document: any {@code origin} field. The channel is not a setting —
 * the code path that writes decides it. D29-27 keeps the mechanical guard by pairing the durable
 * {@code origin} enum with the row status: no value goes straight to {@code active} except the three
 * explicit channels, and {@code passive.%} is a candidate by DB CHECK. D29-24's rejection of "silently
 * effective auto writes" therefore still holds: a candidate may now appear without a human asking for
 * it, but it never becomes visible without one.</p>
 *
 * <p>One validation seam, mirroring {@link HookAdvisorRegistry#validateSubscriptions(JsonNode)}: the
 * create/update write paths call only this method, so the wire and the stored document can never
 * disagree.</p>
 */
public final class ContextPolicyValidator {

    /** v1 memory types (user ruling 2026-11-02: profile + fact only). */
    public static final Set<String> MEMORY_TYPES = Set.of("profile", "fact");
    public static final String WRITE_MODE_OFF = "off";
    public static final String WRITE_MODE_TOOL = "tool";
    /** v1-reserved, planned for M2. Kept named so the refusal message can cite the roadmap value. */
    public static final String WRITE_MODE_JUDGE_RESERVED = "judge";

    /**
     * Passive (system-side) write modes, PLAN-0629 M1-6 / D29-26. {@link #PASSIVE_OFF} is the default:
     * nothing is written unless the user turns a mode on. Neither {@code summary} nor {@code judge} can
     * ever produce an {@code active} row — the DDL pairs {@code origin LIKE 'passive.%'} with
     * {@code status='candidate'} and the service refuses anything else.
     */
    public static final String PASSIVE_OFF = "off";
    public static final String PASSIVE_SUMMARY = "summary";
    public static final String PASSIVE_JUDGE = "judge";

    private static final Set<String> ALLOWED_TOP_LEVEL_KEYS = Set.of("memory");
    private static final Set<String> ALLOWED_MEMORY_KEYS =
            Set.of("enabled", "writeMode", "types", "passive");
    private static final Set<String> ALLOWED_WRITE_MODES = Set.of(WRITE_MODE_OFF, WRITE_MODE_TOOL);
    private static final Set<String> ALLOWED_PASSIVE_MODES =
            Set.of(PASSIVE_OFF, PASSIVE_SUMMARY, PASSIVE_JUDGE);

    private ContextPolicyValidator() {}

    /**
     * Validates one {@code contextPolicy} document.
     *
     * @return the normalised document (deep copy), or {@code null} when the caller sent {@code null}
     *     (clear the column)
     * @throws CpApiException 400 {@code INVALID_REQUEST} on any shape or value violation
     */
    public static JsonNode validate(JsonNode policy) {
        if (policy == null || policy.isNull()) {
            return null;
        }
        if (!policy.isObject()) {
            throw invalid("contextPolicy must be an object with a memory section, or null");
        }
        rejectUnknownKeys(policy, ALLOWED_TOP_LEVEL_KEYS,
                "contextPolicy accepts only the memory section");

        JsonNode memory = policy.get("memory");
        if (memory == null) {
            // `{}` = no memory section, i.e. memory off. Accepted so a future section can be added
            // without redefining the empty document as invalid.
            return policy.deepCopy();
        }
        if (!memory.isObject()) {
            throw invalid("contextPolicy.memory must be an object with enabled/writeMode/types/passive");
        }
        rejectUnknownKeys(memory, ALLOWED_MEMORY_KEYS,
                "contextPolicy.memory accepts only enabled, writeMode, types and passive");

        JsonNode enabled = memory.get("enabled");
        if (enabled != null && !enabled.isBoolean()) {
            throw invalid("contextPolicy.memory.enabled must be a boolean (default false)");
        }

        JsonNode writeMode = memory.get("writeMode");
        if (writeMode != null) {
            if (!writeMode.isTextual()) {
                throw invalid("contextPolicy.memory.writeMode must be \"off\" or \"tool\"");
            }
            String mode = writeMode.asText();
            if (WRITE_MODE_JUDGE_RESERVED.equals(mode)) {
                // v1 reserved: refuse instead of storing a mode nothing can execute yet.
                throw invalid("writeMode judge is not implemented in v1 (planned for M2)");
            }
            if (!ALLOWED_WRITE_MODES.contains(mode)) {
                throw invalid("contextPolicy.memory.writeMode must be \"off\" or \"tool\"; "
                        + "\"judge\" is reserved for M2");
            }
        }

        JsonNode types = memory.get("types");
        if (types != null) {
            if (!types.isArray()) {
                throw invalid("contextPolicy.memory.types must be an array of \"profile\"|\"fact\"");
            }
            List<String> rejected = new ArrayList<>();
            for (JsonNode entry : types) {
                if (!entry.isTextual() || !MEMORY_TYPES.contains(entry.asText())) {
                    rejected.add(entry.isTextual() ? "\"" + entry.asText() + "\"" : entry.toString());
                }
            }
            if (!rejected.isEmpty()) {
                throw invalid("contextPolicy.memory.types may only contain \"profile\" and \"fact\"; "
                        + "rejected: " + String.join(", ", rejected));
            }
        }

        JsonNode passive = memory.get("passive");
        if (passive != null) {
            if (!passive.isTextual() || !ALLOWED_PASSIVE_MODES.contains(passive.asText())) {
                // D29-26: exactly three values, no "auto"/"always" alias — an unlisted word must not
                // silently degrade into a mode nobody implemented.
                throw invalid("contextPolicy.memory.passive must be \"off\", \"summary\" or \"judge\"");
            }
        }
        return policy.deepCopy();
    }

    private static void rejectUnknownKeys(JsonNode node, Set<String> allowed, String detail) {
        List<String> unknown = new ArrayList<>();
        Iterator<String> names = node.fieldNames();
        while (names.hasNext()) {
            String name = names.next();
            if (!allowed.contains(name)) {
                unknown.add(name);
            }
        }
        if (!unknown.isEmpty()) {
            throw invalid(detail + "; unknown key(s): " + String.join(", ", unknown)
                    + "; allowed: " + String.join(", ", allowed.stream().sorted().toList()));
        }
    }

    private static CpApiException invalid(String detail) {
        return new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", detail);
    }
}
