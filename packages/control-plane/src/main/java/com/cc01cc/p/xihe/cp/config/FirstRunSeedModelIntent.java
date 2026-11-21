package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.provider.ProviderCatalogService;
import com.fasterxml.jackson.databind.JsonNode;

import java.util.LinkedHashSet;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;

/**
 * task-18 J4: the first-run subjects' model intent is taken from the <b>provider catalog</b>, never
 * from a literal model name. The catalog is the same document the provider face serves
 * ({@code GET /api/v1/provider-catalog}), so "resolvable" means "this document declares the id".
 *
 * <h2>Why a tolerant reader instead of one fixed field</h2>
 * <p>The catalog is strict JSON whose runtime schema is contract-tested, so a new schema field is a
 * contract change, not a convenience add. Model ids may therefore appear in one of the shapes a
 * provider entry already tolerates: a {@code models} array of ids/objects, a {@code defaultModel}, or
 * a per-api-type {@code models} array. Every position is read; the first <b>declared</b> id (sorted,
 * so the choice is deterministic) wins.</p>
 *
 * <h2>What the shipped catalog says today</h2>
 * <p>{@code ollama} is {@code modelDiscovery=remote-models} and declares no model ids at all — the
 * build-time document cannot know what the local Ollama daemon has pulled. The honest first-run
 * answer is therefore {@code Intent.pending()} ("待绑定"): both provider and model stay {@code null}
 * (the principal API requires them to be set together) until an operator binds a real one. Hard-coding
 * {@code llama3.2} is what task-18 exists to remove: that name is resolvable by nothing in this
 * build.</p>
 */
final class FirstRunSeedModelIntent {

    /**
     * A model intent that can actually be resolved: {@code provider}/{@code model} are both set, or
     * both {@code null} ({@link #pending()}) because the catalog declared nothing.
     */
    record Intent(String provider, String model) {

        /** "待绑定": nothing in the catalog can be bound yet. */
        boolean pendingBinding() {
            return provider == null && model == null;
        }

        static Intent pending() {
            return new Intent(null, null);
        }
    }

    private FirstRunSeedModelIntent() {
    }

    /** Resolve one provider's intent from the real classpath catalog. */
    static Intent fromCatalog(ProviderCatalogService catalog, String providerId) {
        return resolve(providerId, catalog.require(providerId));
    }

    /**
     * Resolve from an already-loaded entry. Package-visible so the unit test can feed a synthetic
     * entry without a Spring context or a second catalog file.
     */
    static Intent resolve(String providerId, JsonNode definition) {
        if (providerId == null || providerId.isBlank() || definition == null) {
            return Intent.pending();
        }
        return firstModelId(definition)
                .map(model -> new Intent(providerId.trim(), model))
                .orElseGet(Intent::pending);
    }

    /** Every model id the entry declares, sorted so the caller's pick is deterministic. */
    static Set<String> modelIds(JsonNode definition) {
        Set<String> ids = new TreeSet<>();
        if (definition == null) {
            return ids;
        }
        collect(definition.get("models"), ids);
        collect(definition.get("defaultModel"), ids);
        JsonNode pairs = definition.get("supportedApiTypes");
        if (pairs != null && pairs.isArray()) {
            for (JsonNode pair : pairs) {
                collect(pair.get("models"), ids);
                collect(pair.get("defaultModel"), ids);
            }
        }
        return new LinkedHashSet<>(ids);
    }

    private static Optional<String> firstModelId(JsonNode definition) {
        return modelIds(definition).stream().findFirst();
    }

    /**
     * One tolerant collection step: a textual id, an array of ids/objects, or a single object with
     * {@code id}/{@code model}/{@code name}.
     */
    private static void collect(JsonNode node, Set<String> ids) {
        if (node == null || node.isNull() || node.isMissingNode()) {
            return;
        }
        if (node.isTextual()) {
            add(ids, node.asText());
            return;
        }
        if (node.isArray()) {
            for (JsonNode entry : node) {
                collect(entry, ids);
            }
            return;
        }
        if (node.isObject()) {
            for (String field : new String[] {"id", "model", "name"}) {
                JsonNode value = node.get(field);
                if (value != null && value.isTextual()) {
                    add(ids, value.asText());
                    return;
                }
            }
        }
    }

    private static void add(Set<String> ids, String value) {
        if (value != null && !value.isBlank()) {
            ids.add(value.trim());
        }
    }
}
