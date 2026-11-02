package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * PLAN-0625 M2 (D25-10/12/14): the hook registry — the seam the gate asks for advice.
 *
 * <p>Spring injects every {@link HookAdvisor} bean; implementing the interface is the whole
 * plugin contract (no loading mechanism, per the YAGNI ruling). The registry filters advisors
 * by the subscribing principal's {@code hooks} row (the runtime single-read surface; templates
 * remain the declaration source).
 *
 * <p>Shape (stored on {@code agent_principals.hooks}, camelCase):
 * <pre>{@code
 * { "advisors": [ { "kind": "guard", "on": ["approval.ask"] } ] }
 * }</pre>
 * Validation is one place — {@link #validateSubscriptions(JsonNode)} — shared by the create and
 * update write paths so the wire and the service can never disagree.
 */
@Component
public class HookAdvisorRegistry {

    /** First event-class of the frozen action vocabulary (D25-12); more classes extend this set. */
    public static final String ACTION_APPROVAL_ASK = "approval.ask";

    /** The frozen action-class vocabulary. Exact match only — globs are rejected by ruling. */
    public static final Set<String> ALLOWED_ACTION_CLASSES = Set.of(ACTION_APPROVAL_ASK);

    private final List<HookAdvisor> advisors;

    public HookAdvisorRegistry(List<HookAdvisor> advisors) {
        this.advisors = List.copyOf(advisors);
    }

    /** All registered advisors (unfiltered) — the diagnostics/testing seam. */
    public List<HookAdvisor> advisors() {
        return advisors;
    }

    /**
     * Advisors the given principal subscribed for this action class: an advisor is returned when
     * its {@link HookAdvisor#kind()} appears in {@code hooks.advisors[]} with {@code actionClass}
     * in that entry's {@code on} list.
     */
    public List<HookAdvisor> advisorsFor(JsonNode hooks, String actionClass) {
        Set<String> kinds = subscribedKinds(hooks, actionClass);
        if (kinds.isEmpty()) {
            return List.of();
        }
        return advisors.stream().filter(advisor -> kinds.contains(advisor.kind())).toList();
    }

    /** The subscribed advisor kinds for one action class (exact match against the whitelist). */
    public static Set<String> subscribedKinds(JsonNode hooks, String actionClass) {
        if (hooks == null || actionClass == null || !hooks.isObject()) {
            return Set.of();
        }
        Set<String> kinds = new LinkedHashSet<>();
        for (JsonNode entry : hooks.path("advisors")) {
            JsonNode on = entry.path("on");
            if (!on.isArray()) {
                continue;
            }
            for (JsonNode action : on) {
                if (actionClass.equals(action.asText())) {
                    kinds.add(entry.path("kind").asText());
                }
            }
        }
        kinds.remove("");
        return Set.copyOf(kinds);
    }

    /**
     * Validates a {@code hooks} document for the write paths (D25-12). {@code null} means "no
     * subscriptions" and is valid. Anything else must be an object whose {@code advisors} array
     * carries entries with a non-blank {@code kind} and a non-empty {@code on} list whose values
     * all hit the frozen whitelist — otherwise the subscription would silently never fire.
     *
     * @return the normalized document (deep copy), or null when absent
     * @throws CpApiException 400 INVALID_REQUEST on any shape violation
     */
    public static JsonNode validateSubscriptions(JsonNode hooks) {
        if (hooks == null || hooks.isNull()) {
            return null;
        }
        if (!hooks.isObject()) {
            throw invalid("hooks must be an object with an advisors array");
        }
        JsonNode advisors = hooks.path("advisors");
        if (!advisors.isArray() || advisors.isEmpty()) {
            throw invalid("hooks.advisors must be a non-empty array of {kind, on}");
        }
        for (JsonNode entry : advisors) {
            if (!entry.isObject()) {
                throw invalid("each hooks.advisors entry must be an object {kind, on}");
            }
            String kind = entry.path("kind").asText("");
            if (kind.isBlank()) {
                throw invalid("hooks.advisors[].kind must be a non-empty string");
            }
            JsonNode on = entry.path("on");
            if (!on.isArray() || on.isEmpty()) {
                throw invalid("hooks.advisors[].on must be a non-empty array of action classes");
            }
            for (JsonNode action : on) {
                if (!ALLOWED_ACTION_CLASSES.contains(action.asText())) {
                    throw invalid("hooks.advisors[].on contains an unknown action class '"
                            + action.asText() + "'; allowed: " + ALLOWED_ACTION_CLASSES);
                }
            }
        }
        return hooks.deepCopy();
    }

    private static CpApiException invalid(String detail) {
        return new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", detail);
    }
}
