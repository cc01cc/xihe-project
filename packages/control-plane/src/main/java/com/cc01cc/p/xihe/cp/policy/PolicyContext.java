package com.cc01cc.p.xihe.cp.policy;

import java.util.List;
import java.util.Map;

/**
 * Per-request policy context: which persisted layers apply, plus tool faces declared outside the
 * code built-ins (PLAN-0328 M1, decision #38).
 *
 * <p>The built-in (L0) layer is owned by {@link PolicyEngine}; providers only supply the layers
 * above it, so the code built-ins can never be shadowed by an empty provider.</p>
 *
 * @param layers      INSTANCE / USER / WORKSPACE / SESSION rules (lowest first); may be empty
 * @param extraFaces  tool → face declarations from persistence; may be empty
 * @param mode        session mode when one is set (bypass / accept-edits / plan / managed); null = default
 * @param modeLayer   layer that supplied {@code mode} (audit field `allowed_by=bypass@Lx`)
 */
public record PolicyContext(List<LayeredPolicyResolver.LayerInput> layers,
                            Map<String, ToolFaceRegistry.Face> extraFaces,
                            String mode,
                            PolicyLayer modeLayer) {

    public static final PolicyContext EMPTY = new PolicyContext(List.of(), Map.of(), null, null);

    public PolicyContext {
        layers = List.copyOf(layers == null ? List.of() : layers);
        extraFaces = Map.copyOf(extraFaces == null ? Map.of() : extraFaces);
    }
}
