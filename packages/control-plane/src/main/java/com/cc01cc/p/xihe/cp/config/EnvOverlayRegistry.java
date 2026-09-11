package com.cc01cc.p.xihe.cp.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;

/**
 * PLAN-0307 decision #22 (G7): the env ↔ DB key mapping registry.
 *
 * Primary path: business keys live in the DB only and must stay out of `.env*`.
 * This registry is the documented fallback for unavoidable overlaps: the CP
 * resolved/effective channels merge the env value with
 * `env > workspace > user > instance > code default`, the UI locks the field and
 * shows the env-effective value (T2.17), and startup logs active overlays so the
 * deployment owner can see the conflict (transparency, decision #22).
 */
@Component
public class EnvOverlayRegistry {

    private static final Logger log = LoggerFactory.getLogger(EnvOverlayRegistry.class);

    /** domain.key -> ordered env variable names (first non-blank value wins). */
    private static final Map<String, List<String>> MAPPING;

    static {
        Map<String, List<String>> mapping = new LinkedHashMap<>();
        mapping.put("embedding.model", List.of("XIHE_EMBEDDING_MODEL"));
        MAPPING = Map.copyOf(mapping);
    }

    private final Function<String, String> env;

    public EnvOverlayRegistry() {
        this(System::getenv);
    }

    /** Test seam: inject a stub environment lookup. */
    EnvOverlayRegistry(Function<String, String> env) {
        this.env = env;
    }

    /** Active env-effective values for the domain (empty when no overlay fires). */
    public Map<String, String> activeOverrides(String domain) {
        Map<String, String> overrides = new LinkedHashMap<>();
        for (Map.Entry<String, List<String>> entry : MAPPING.entrySet()) {
            String[] parts = entry.getKey().split("\\.", 2);
            if (parts.length != 2 || !parts[0].equals(domain)) {
                continue;
            }
            for (String name : entry.getValue()) {
                String value = env.apply(name);
                if (value != null && !value.isBlank()) {
                    overrides.put(parts[1], value);
                    break;
                }
            }
        }
        return overrides;
    }

    /** Env-effective value for one DB key, when an overlay variable is active. */
    public Optional<String> overlayValue(String domain, String key) {
        return Optional.ofNullable(activeOverrides(domain).get(key));
    }

    /** Startup detection: log every active overlay with its env source and value. */
    @EventListener(ApplicationReadyEvent.class)
    public void logStartupOverlays() {
        List<String> active = new ArrayList<>();
        for (String domainKey : MAPPING.keySet()) {
            String[] parts = domainKey.split("\\.", 2);
            if (parts.length != 2) {
                continue;
            }
            String value = activeOverrides(parts[0]).get(parts[1]);
            if (value != null) {
                active.add(domainKey + " <- " + String.join("|", MAPPING.get(domainKey)) + " = " + value);
            }
        }
        if (active.isEmpty()) {
            log.info("[CONFIG] env overlay registry active, no overlapping env values detected");
        } else {
            log.warn("[CONFIG] env overlays active (env wins over DB, UI fields locked): {}", active);
        }
    }
}
