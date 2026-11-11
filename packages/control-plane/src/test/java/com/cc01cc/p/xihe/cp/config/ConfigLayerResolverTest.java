package com.cc01cc.p.xihe.cp.config;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * D-928 / PLAN-0766: the shared layer order is one list; every consumer (domain
 * resolution, llm profile, embedding profile, context-template defaults) walks it.
 */
class ConfigLayerResolverTest {

    @Test
    void dbOrderHighToLow_isWorkspaceDefaultBetweenWorkspaceAndUser() {
        assertEquals(List.of("workspace", "workspace-default", "user", "instance"),
                ConfigLayerResolver.DB_LAYERS_HIGH_TO_LOW);
        assertEquals(List.of("instance", "user", "workspace-default", "workspace"),
                ConfigLayerResolver.DB_LAYERS_LOW_TO_HIGH);
    }

    @Test
    void firstConfigured_stopsAtFirstNonNullLayer() {
        List<String> visited = new ArrayList<>();
        ConfigLayerResolver.LayerHit<String> hit = ConfigLayerResolver.firstConfigured(layer -> {
            visited.add(layer);
            return "workspace-default".equals(layer) ? "found" : null;
        });
        assertEquals("workspace-default", hit.layer());
        assertEquals("found", hit.value());
        // user/instance below the hit must never be read.
        assertEquals(List.of("workspace", "workspace-default"), visited);
    }

    @Test
    void firstConfigured_allAbsent_reportsNullLayer() {
        ConfigLayerResolver.LayerHit<String> hit =
                ConfigLayerResolver.firstConfigured(layer -> null);
        assertNull(hit.layer());
        assertNull(hit.value());
    }
}
