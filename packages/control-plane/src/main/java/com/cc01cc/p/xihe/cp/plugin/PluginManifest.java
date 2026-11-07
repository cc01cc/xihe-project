package com.cc01cc.p.xihe.cp.plugin;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.List;

/**
 * PLAN-0691 T1.1: the validated projection of a plugin manifest (spec/manifest.schema.json v1).
 *
 * <p>Only the fields the registry needs are projected. {@link #raw()} keeps the parsed document so
 * the digest-verified JSON is what gets persisted into {@code plugins.manifest}; it is <b>not</b> a
 * wire type (PLAN-0633 C1) — {@code PluginView} carries the scalars.</p>
 */
public record PluginManifest(
        String id,
        String version,
        String digest,
        String source,
        String manifestVersion,
        List<Action> actions,
        List<String> requestedAtoms,
        Limits limits,
        JsonNode raw) {

    /** One declared action face (schema {@code $defs/action}). */
    public record Action(String name, String title, String actionClass, String resourceType) {}

    /** Declared execution quotas with the schema defaults filled in. */
    public record Limits(int timeoutMs, int maxConcurrency) {}
}
