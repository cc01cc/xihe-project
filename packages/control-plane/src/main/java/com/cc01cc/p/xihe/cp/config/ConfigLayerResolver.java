package com.cc01cc.p.xihe.cp.config;

import java.util.List;
import java.util.function.Function;

/**
 * D-928 / PLAN-0766: the single source of truth for the database config layer order.
 *
 * <p>Order (highest precedence first): workspace > workspace-default > user > instance.
 * Every consumer that resolves a value across config layers — {@link ConfigService} domain
 * resolution and the effective view, the llm-provider whole-unit profile, the embedding
 * profile, and context-template defaults — must iterate {@link #DB_LAYERS_HIGH_TO_LOW} via
 * this helper instead of keeping a hand-written copy of the list. BL-581 was exactly two
 * services maintaining "the same" order independently; the rule here is one list, many
 * readers.
 *
 * <p>Peripherals are unchanged and deliberately not part of this list: env overlays and
 * administrator lock pins outrank every database layer; code defaults stay below all of
 * them; EXPLICIT_ONLY domains resolve whole-unit per layer.
 */
public final class ConfigLayerResolver {

    public static final String LAYER_WORKSPACE = "workspace";
    public static final String LAYER_WORKSPACE_DEFAULT = "workspace-default";
    public static final String LAYER_USER = "user";
    public static final String LAYER_INSTANCE = "instance";

    /** Database layer order, highest precedence first (D-931). */
    public static final List<String> DB_LAYERS_HIGH_TO_LOW = List.of(
            LAYER_WORKSPACE, LAYER_WORKSPACE_DEFAULT, LAYER_USER, LAYER_INSTANCE);

    /** The same order low-to-high, for merge-style readers (later entries override earlier). */
    public static final List<String> DB_LAYERS_LOW_TO_HIGH = List.of(
            LAYER_INSTANCE, LAYER_USER, LAYER_WORKSPACE_DEFAULT, LAYER_WORKSPACE);

    private ConfigLayerResolver() {}

    /** One resolved layer plus its value; {@code layer} is null when every layer was absent. */
    public record LayerHit<T>(String layer, T value) {}

    /**
     * First configured layer wins: read each layer high-to-low through {@code reader}
     * (returning null for "absent" or "not applicable in this context") and stop at the
     * first non-null value. Whole-unit semantics stay with the caller: a blank stored unit
     * must be normalized to null by the reader, exactly like before.
     */
    public static <T> LayerHit<T> firstConfigured(Function<String, T> reader) {
        for (String layer : DB_LAYERS_HIGH_TO_LOW) {
            T value = reader.apply(layer);
            if (value != null) {
                return new LayerHit<>(layer, value);
            }
        }
        return new LayerHit<>(null, null);
    }
}
