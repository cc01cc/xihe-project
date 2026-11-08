package com.cc01cc.p.xihe.cp.plugin;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.TestPropertySource;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0691 T2.1: {@code /api/v1/mcp} {@code tools/list} serves only the plugin tools the Run was
 * admitted with, and passes the producer's {@code pluginId/version/digest} provenance through
 * verbatim.
 *
 * <p><b>Behaviour criteria.</b> (1) a tool whose provenance triple is in the Run's frozen snapshot
 * stays, one outside it is dropped, non-plugin tools are untouched; (2) the surviving map is the
 * <b>same instance</b> with the <b>exact</b> provenance values (no normalization, no re-wrapping);
 * (3) fail-closed corners: partial provenance, {@code {}} ("not captured") and unknown run ids drop
 * plugin tools, while no run context and the feature-off default are explicit no-ops.</p>
 *
 * <p><b>Ownership boundary.</b> This class asserts the CP filter seam. The Agent currently runs
 * workspace-scoped MCP discovery without a run identity, so the run-scoped path is exercised here
 * (and by the upcoming real-stack T3.1 window), not through a browser/Agent end-to-end test. The
 * handler is wired in {@code McpProxyController}; the call site is pinned by the static assertion at
 * the bottom so a wiring revert fails something instead of silently un-filtering the catalogue.</p>
 */
@TestPropertySource(properties = {
        "cp.plugin.enabled=true",
        "cp.plugin.advisory-lock=false"
})
class PluginToolCatalogTest extends AbstractH2Test {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String VERSION = "1.0.0";
    private static final String DIGEST_PREFIX = "sha256:";

    @Autowired
    private ChatRunRepository runs;

    @Autowired
    private PluginToolCatalogFilter filter;

    @Test
    void licensedPluginToolsStayAndUnlicensedOnesAreDropped() {
        String licensed = "official.licensed";
        String unlicensed = "official.unlicensed";
        String runId = runWithSnapshot(snapshot(1, licensed));

        Map<String, Object> systemTool = tool("read_file");
        Map<String, Object> licensedTool = pluginTool("plugin_official.licensed__echo", licensed);
        Map<String, Object> unlicensedTool = pluginTool("plugin_official.unlicensed__echo", unlicensed);

        PluginToolCatalogFilter.FilterResult result = filter.apply(runId,
                List.of(systemTool, licensedTool, unlicensedTool));

        assertEquals(List.of(systemTool, licensedTool), result.tools(),
                "only the snapshot-licensed plugin tool may appear; the other one is dropped");
        assertEquals(2, result.kept());
        assertEquals(1, result.dropped());
        assertTrue(result.applied(), "a run identity was present, so the filter did run");
        assertSame(systemTool, result.tools().get(0),
                "non-plugin items are never re-wrapped (same map instance)");
        assertSame(licensedTool, result.tools().get(1),
                "the surviving plugin item is the producer's map, not a copy");
        assertFalse(result.tools().contains(unlicensedTool));
    }

    @Test
    void provenanceFieldsPassThroughVerbatim() {
        // Mixed case on purpose: a normalizing filter would turn this into a mismatch.
        ObjectNode document = MAPPER.createObjectNode();
        document.put("catalogVersion", 1);
        ObjectNode item = document.putArray("items").addObject();
        item.put("bindingId", UUID.randomUUID().toString());
        item.put("pluginId", "official.demo");
        item.put("version", "1.0.0");
        item.put("digest", "sha256:AbCdEf0123");
        item.put("state", "enabled");
        item.put("revision", 1);
        String runId = runWithSnapshot(document);
        Map<String, Object> pluginTool = new LinkedHashMap<>();
        pluginTool.put("name", "plugin_official.demo__Echo");
        pluginTool.put("pluginId", "official.demo");
        pluginTool.put("version", "1.0.0");
        // Mixed case on purpose: a normalizing filter would turn this into a mismatch.
        pluginTool.put("digest", "sha256:AbCdEf0123");

        PluginToolCatalogFilter.FilterResult result = filter.apply(runId, List.of(pluginTool));

        assertEquals(1, result.kept());
        assertEquals("official.demo", result.tools().get(0).get("pluginId"));
        assertEquals("1.0.0", result.tools().get(0).get("version"));
        assertEquals("sha256:AbCdEf0123", result.tools().get(0).get("digest"),
                "provenance is read as-is: case/format must equal what the producer wrote");
        assertSame(pluginTool, result.tools().get(0));
    }

    @Test
    void partialProvenanceFailsClosed() {
        String runId = runWithSnapshot(snapshot(1, "official.partial"));
        Map<String, Object> onlyPluginId = tool("plugin_official.partial__echo");
        onlyPluginId.put("pluginId", "official.partial");
        Map<String, Object> blankDigest = tool("plugin_official.partial__echo2");
        blankDigest.put("pluginId", "official.partial");
        blankDigest.put("version", "1.0.0");
        blankDigest.put("digest", "  ");

        PluginToolCatalogFilter.FilterResult result = filter.apply(runId,
                List.of(tool("read_file"), onlyPluginId, blankDigest));

        assertEquals(1, result.kept(), "a half-copied triple cannot be licensed and must not slip"
                + " through as 'not a plugin tool'");
        assertEquals(2, result.dropped());
        assertSame(tool("read_file").getClass(), result.tools().get(0).getClass());
        assertEquals("read_file", result.tools().get(0).get("name"));
    }

    @Test
    void uncapturedOrUnknownRunDropsPluginToolsButKeepsTheRest() {
        String uncapturedRunId = runWithSnapshot(MAPPER.createObjectNode());
        Map<String, Object> systemTool = tool("read_file");
        Map<String, Object> pluginTool = pluginTool("plugin_official.demo__echo", "official.demo");

        PluginToolCatalogFilter.FilterResult uncaptured =
                filter.apply(uncapturedRunId, List.of(systemTool, pluginTool));
        assertEquals(List.of(systemTool), uncaptured.tools(),
                "{} means 'not captured', which is not 'no plugins': fail closed");
        assertEquals(1, uncaptured.dropped());

        PluginToolCatalogFilter.FilterResult unknown =
                filter.apply(UUID.randomUUID().toString(), List.of(systemTool, pluginTool));
        assertEquals(List.of(systemTool), unknown.tools(), "an unknown run licenses nothing");

        PluginToolCatalogFilter.FilterResult noRunContext =
                filter.apply(null, List.of(systemTool, pluginTool));
        assertFalse(noRunContext.applied(),
                "no X-Chat-Run-Id (workspace-scoped discovery) is a no-op, never a mass drop");
        assertEquals(List.of(systemTool, pluginTool), noRunContext.tools());
    }

    @Test
    void toolsListHandlerWiresTheFilterThroughTheRunHeader() throws IOException {
        Path controller = Path.of("src/main/java/com/cc01cc/p/xihe/cp/mcp/McpProxyController.java");
        assertTrue(Files.isRegularFile(controller), "run from packages/control-plane: " + controller);
        String source = Files.readString(controller, StandardCharsets.UTF_8);
        assertTrue(source.contains("com.cc01cc.p.xihe.cp.plugin.PluginToolCatalogFilter"
                        + " pluginToolCatalogFilter;"),
                "McpProxyController must hold the filter bean (constructor-injected)");
        assertTrue(source.contains("pluginToolCatalogFilter.apply(headers.getFirst(\"X-Chat-Run-Id\"),"
                        + " allTools)"),
                "tools/list must call the filter with the run identity header; a silent revert"
                        + " would un-filter the plugin catalogue");
    }

    // ------------------------------------------------------------------ fixtures

    private String runWithSnapshot(ObjectNode pluginSnapshot) {
        String runId = UUID.randomUUID().toString();
        ChatRun run = new ChatRun(runId, UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), UUID.randomUUID().toString(), "idem-" + runId,
                "request-hash", "provider", "model", "none", "accepted");
        run.setBranchId(UUID.randomUUID().toString());
        run.setPluginSnapshot(pluginSnapshot);
        runs.saveAndFlush(run);
        return runId;
    }

    /** {@code {"catalogVersion":N,"items":[bindingId/pluginId/version/digest/state/revision]}}. */
    private ObjectNode snapshot(int catalogVersion, String... pluginIds) {
        ObjectNode document = MAPPER.createObjectNode();
        document.put("catalogVersion", catalogVersion);
        document.put("capturedAt", "2026-11-08T14:00:00Z");
        document.put("snapshotSource", "admission");
        ArrayNode items = document.putArray("items");
        int revision = 0;
        for (String pluginId : pluginIds) {
            revision++;
            ObjectNode item = items.addObject();
            item.put("bindingId", UUID.randomUUID().toString());
            item.put("pluginId", pluginId);
            item.put("version", VERSION);
            item.put("digest", DIGEST_PREFIX + pluginId);
            item.put("state", "enabled");
            item.put("revision", revision);
        }
        return document;
    }

    private Map<String, Object> tool(String name) {
        Map<String, Object> tool = new LinkedHashMap<>();
        tool.put("name", name);
        tool.put("description", "test tool");
        return tool;
    }

    private Map<String, Object> pluginTool(String name, String pluginId) {
        Map<String, Object> tool = tool(name);
        tool.put("pluginId", pluginId);
        tool.put("version", VERSION);
        tool.put("digest", DIGEST_PREFIX + pluginId);
        return tool;
    }
}
