package com.cc01cc.p.xihe.cp.plugin;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.TestPropertySource;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

/**
 * PLAN-0691 T2.1 / D-66: with the shipped default {@code cp.plugin.enabled=false}, the run-snapshot
 * catalogue filter is a <b>no-op</b> — the plugin surface must not appear while its routes are 404.
 *
 * <p>The other half of the two-state pair is {@code PluginToolCatalogTest} (flag on: licensed tools
 * stay, unlicensed ones drop). The feature-off route contract itself stays where it was asserted
 * first, in {@code PluginSessionAttachmentFeatureOffTest} (session/binding/catalog routes 404) — this
 * class only pins the filter's gate, so a later "just filter always" change cannot silently make a
 * disabled feature affect the shared tools/list.</p>
 */
@TestPropertySource(properties = {
        "cp.plugin.enabled=false",
        "cp.plugin.advisory-lock=false"
})
class PluginToolCatalogFeatureOffTest extends AbstractH2Test {

    @Autowired
    private PluginToolCatalogFilter filter;

    @Test
    void featureOffKeepsTheToolsListUntouched() {
        Map<String, Object> systemTool = new LinkedHashMap<>();
        systemTool.put("name", "read_file");
        Map<String, Object> pluginTool = new LinkedHashMap<>();
        pluginTool.put("name", "plugin_official.demo__echo");
        pluginTool.put("pluginId", "official.demo");
        pluginTool.put("version", "1.0.0");
        pluginTool.put("digest", "sha256:official.demo");

        PluginToolCatalogFilter.FilterResult result = filter.apply(
                java.util.UUID.randomUUID().toString(), List.of(systemTool, pluginTool));

        assertFalse(result.applied(), "feature off: the filter must not run at all");
        assertEquals(0, result.dropped(), "nothing may be dropped by a disabled feature");
        assertEquals(List.of(systemTool, pluginTool), result.tools(),
                "the catalogue is returned byte-identical to the merged one");
    }

    @Test
    void featureOffIgnoringARunIdentityIsStillANoOp() {
        Map<String, Object> pluginTool = new LinkedHashMap<>();
        pluginTool.put("name", "plugin_official.demo__echo");
        pluginTool.put("pluginId", "official.demo");
        pluginTool.put("version", "1.0.0");
        pluginTool.put("digest", "sha256:official.demo");

        PluginToolCatalogFilter.FilterResult result = filter.apply(null, List.of(pluginTool));

        assertFalse(result.applied());
        assertEquals(List.of(pluginTool), result.tools());
    }
}
