package com.cc01cc.p.xihe.cp.provider;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class ProviderCatalogServiceTest {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final ProviderCatalogService catalog =
            new ProviderCatalogService(objectMapper, new ApiInputTypeService(objectMapper));

    @Test
    void loadsCuratedProviderDefinitions() {
        assertEquals(23, catalog.list().size());
        assertEquals("deepseek", catalog.require("deepseek").path("id").asText());
        assertEquals("native-litellm", catalog.adapter("deepseek"));
        assertEquals("https://api.deepseek.com/v1", catalog.defaultBaseUrl("deepseek"));
        assertEquals("openai-chat-completions", catalog.defaultApiType("deepseek").apiTypeId());
        assertEquals("chat", catalog.defaultApiType("deepseek").operation());
        assertEquals("anthropic-messages", catalog.defaultApiType("anthropic").apiTypeId());
        assertEquals("mimo-responses", catalog.defaultApiType("xiaomi").apiTypeId());
    }

    @Test
    void rejectsUnknownProvider() {
        assertThrows(IllegalArgumentException.class, () -> catalog.require("not-a-provider"));
    }

    @Test
    void supportedPairOverridesDefaultsWithoutChangingProviderFallback() {
        var definition = (com.fasterxml.jackson.databind.node.ObjectNode) catalog.require("deepseek");
        var type = catalog.defaultApiType("deepseek");
        assertEquals(definition.path("modelDiscovery").asText(),
                catalog.supportedPair("deepseek", type.apiTypeId(), type.version()).path("modelDiscovery").asText());
        var pair = (com.fasterxml.jackson.databind.node.ObjectNode) definition.path("supportedApiTypes").get(0);
        pair.put("defaultBaseUrl", "https://pair.example/v1");
        pair.put("modelDiscovery", "manual");
        assertEquals("https://pair.example/v1", catalog.defaultBaseUrl("deepseek"));
        assertEquals("manual",
                catalog.supportedPair("deepseek", type.apiTypeId(), type.version()).path("modelDiscovery").asText());
        assertEquals("https://api.deepseek.com/v1", definition.path("defaultBaseUrl").asText());
        pair.putNull("defaultBaseUrl");
        org.junit.jupiter.api.Assertions.assertNull(catalog.defaultBaseUrl("deepseek"));
        assertThrows(IllegalArgumentException.class,
                () -> catalog.supportedPair("deepseek", "anthropic-messages", 1));
    }
}
