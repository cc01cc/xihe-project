package com.cc01cc.p.xihe.cp.plugin;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * PLAN-0691 T2.1 (design S4 / D-62): filter the merged {@code /api/v1/mcp} {@code tools/list}
 * catalog down to the plugin tools the <b>Run's frozen snapshot</b> licenses, and pass the
 * {@code pluginId/version/digest} provenance fields through untouched.
 *
 * <p><b>Where the license comes from.</b> T1.6b froze the session plugin catalog into
 * {@code chat_runs.plugin_snapshot} at admission; {@link PluginRunCatalogSnapshotService} reads it.
 * A plugin tool item is licensed iff its provenance triple is one of that snapshot's items. The
 * live {@code session_plugin_bindings} rows are deliberately <b>not</b> consulted: an attach/detach
 * that lands while the Run is in flight takes effect on the next turn (D-62), so the live set is
 * the wrong answer for "this Run's tool face".</p>
 *
 * <p><b>Fail-closed corners.</b></p>
 * <ul>
 *   <li>no provenance keys at all ⇒ not a plugin tool ⇒ untouched;</li>
 *   <li>partial/blank/non-text provenance ⇒ the item cannot be licensed ⇒ dropped
 *       ({@code malformed}); a half-copied triple must not slip through as "not a plugin tool";</li>
 *   <li>run id present but the Run has no captured snapshot ({@code {}} / unknown run) ⇒ every
 *       plugin tool is dropped ({@code snapshot-absent}); "not captured" is not "no plugins";</li>
 *   <li>run id absent ⇒ <b>no-op</b> ({@code no-run-context}). The header is the licence source; a
 *       workspace-scoped discovery call (the Agent's current shard discovery does not carry a run
 *       id) must not be silently reduced to "all plugin tools dropped" — that would hide plugins
 *       from every workspace the moment one is registered. The run-scoped path is what T3.1's
 *       real-stack validation exercises.</li>
 *   <li>{@code cp.plugin.enabled=false} (D-66 shipped default) ⇒ no-op ({@code feature-off}); the
 *       filter is plugin behaviour and must not appear while the plugin surface is 404.</li>
 * </ul>
 *
 * <p>Non-plugin tools are never re-wrapped: the returned list holds the same map instances, so
 * existing {@code tools/list} items keep byte-identical shape (the provenance fields are the only
 * plugin-facing addition, and they come from the producer, not from this class).</p>
 */
@Service
public class PluginToolCatalogFilter {

    private static final Logger log = LoggerFactory.getLogger(PluginToolCatalogFilter.class);

    public static final String FIELD_PLUGIN_ID = "pluginId";
    public static final String FIELD_VERSION = "version";
    public static final String FIELD_DIGEST = "digest";

    private final PluginRunCatalogSnapshotService snapshots;
    private final boolean enabled;

    public PluginToolCatalogFilter(PluginRunCatalogSnapshotService snapshots,
            @Value("${cp.plugin.enabled:false}") boolean enabled) {
        this.snapshots = Objects.requireNonNull(snapshots, "snapshots");
        this.enabled = enabled;
    }

    /**
     * @param runId the {@code X-Chat-Run-Id} of the call whose catalogue is being served; blank/null
     *              means "no run context" and the list is returned untouched
     * @param tools the merged {@code tools/list} items (mutated never; the surviving maps are the
     *              same instances)
     */
    public FilterResult apply(String runId, List<Map<String, Object>> tools) {
        Objects.requireNonNull(tools, "tools");
        if (!enabled) {
            log.info("[LIFECYCLE] service=cp event=plugin_tool_catalog_filtered outcome=feature-off");
            return new FilterResult(List.copyOf(tools), tools.size(), 0, false);
        }
        if (runId == null || runId.isBlank()) {
            log.info("[LIFECYCLE] service=cp event=plugin_tool_catalog_filtered outcome=no-run-context"
                    + " tools={}", tools.size());
            return new FilterResult(List.copyOf(tools), tools.size(), 0, false);
        }
        Optional<PluginRunCatalogSnapshotService.PluginRunSnapshot> frozen =
                snapshots.snapshotForRun(runId);
        if (frozen.isEmpty()) {
            return dropAllPluginTools(runId, tools, "snapshot-absent");
        }
        List<Map<String, Object>> kept = new ArrayList<>();
        int dropped = 0;
        for (Map<String, Object> tool : tools) {
            ProvenanceTriple provenance = provenanceOrNull(tool);
            if (provenance == null) {
                kept.add(tool);
                continue;
            }
            if (provenance.malformed()) {
                dropped++;
                continue;
            }
            if (frozen.get().contains(provenance.pluginId(), provenance.version(),
                    provenance.digest())) {
                kept.add(tool);
            } else {
                dropped++;
            }
        }
        log.info("[LIFECYCLE] service=cp event=plugin_tool_catalog_filtered runId={} outcome=filtered"
                + " catalogVersion={} kept={} dropped={}", runId, frozen.get().catalogVersion(),
                kept.size(), dropped);
        return new FilterResult(List.copyOf(kept), kept.size(), dropped, true);
    }

    private FilterResult dropAllPluginTools(String runId, List<Map<String, Object>> tools,
            String outcome) {
        List<Map<String, Object>> kept = new ArrayList<>();
        int dropped = 0;
        for (Map<String, Object> tool : tools) {
            if (provenanceOrNull(tool) == null) {
                kept.add(tool);
            } else {
                dropped++;
            }
        }
        log.info("[LIFECYCLE] service=cp event=plugin_tool_catalog_filtered runId={} outcome={}"
                + " kept={} dropped={}", runId, outcome, kept.size(), dropped);
        return new FilterResult(List.copyOf(kept), kept.size(), dropped, true);
    }

    /**
     * Reads the three provenance keys off one tool item.
     *
     * @return {@code null} when the item carries none of the keys (not a plugin tool); a triple
     *     flagged {@code malformed} when some but not all of them are usable text
     */
    private static ProvenanceTriple provenanceOrNull(Map<String, Object> tool) {
        boolean hasAny = tool.containsKey(FIELD_PLUGIN_ID) || tool.containsKey(FIELD_VERSION)
                || tool.containsKey(FIELD_DIGEST);
        if (!hasAny) {
            return null;
        }
        String pluginId = textOf(tool.get(FIELD_PLUGIN_ID));
        String version = textOf(tool.get(FIELD_VERSION));
        String digest = textOf(tool.get(FIELD_DIGEST));
        boolean malformed = pluginId == null || version == null || digest == null;
        return new ProvenanceTriple(pluginId, version, digest, malformed);
    }

    private static String textOf(Object value) {
        if (!(value instanceof String text) || text.isBlank()) {
            return null;
        }
        return text;
    }

    /** @param applied false for the feature-off / no-run-context no-ops */
    public record FilterResult(List<Map<String, Object>> tools, int kept, int dropped,
            boolean applied) {
    }

    private record ProvenanceTriple(String pluginId, String version, String digest,
            boolean malformed) {
    }
}
