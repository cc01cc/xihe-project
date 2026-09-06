package com.cc01cc.p.xihe.cp.provider;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class ProviderCatalogServiceTest {

    private final ProviderCatalogService catalog = new ProviderCatalogService(new ObjectMapper());

    @Test
    void loadsCuratedProviderDefinitions() {
        assertEquals(23, catalog.list().size());
        assertEquals("deepseek", catalog.require("deepseek").path("id").asText());
        assertEquals("native-litellm", catalog.adapter("deepseek"));
        assertEquals("https://api.deepseek.com/v1", catalog.defaultBaseUrl("deepseek"));
    }

    @Test
    void rejectsUnknownProvider() {
        assertThrows(IllegalArgumentException.class, () -> catalog.require("not-a-provider"));
    }
}
