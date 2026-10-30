package com.cc01cc.p.xihe.cp.provider;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ByteArrayResource;

import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

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
    void xiaomiSupportsBothChatCompletionsAndResponsesContracts() {
        // PLAN-0548 / BL-116: MiMo serves both POST /v1/chat/completions and POST /v1/responses
        // (probed 2026-10-24; /v1/messages is 404). Default stays mimo-responses.
        assertEquals(2, catalog.require("xiaomi").path("supportedApiTypes").size());
        assertEquals("mimo-responses", catalog.defaultApiType("xiaomi").apiTypeId());
        assertEquals("openai-chat-completions", catalog.supportedPair("xiaomi", "openai-chat-completions", 1)
                .path("apiTypeId").asText());
        assertEquals("mimo-responses", catalog.supportedPair("xiaomi", "mimo-responses", 1)
                .path("apiTypeId").asText());
        assertEquals("https://api.xiaomimimo.com/v1", catalog.defaultBaseUrl("xiaomi"));
        assertThrows(IllegalArgumentException.class,
                () -> catalog.supportedPair("xiaomi", "anthropic-messages", 1));
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

    // PLAN-0591 T1.2/T1.3: capability data, test-only resource seam and gate inputs.
    private ProviderCatalogService catalogWith(String json) {
        return new ProviderCatalogService(objectMapper, new ApiInputTypeService(objectMapper),
                new ByteArrayResource(json.getBytes(StandardCharsets.UTF_8)));
    }

    private static final String PROVIDER_HEAD =
            "[{\"id\":\"p\",\"supportedApiTypes\":[";

    private static final String PROVIDER_TAIL =
            "],\"defaultApiType\":{\"apiTypeId\":\"openai-chat-completions\",\"version\":1},"
                    + "\"credential\":{\"type\":\"api-key\",\"required\":true},\"supports\":{\"tools\":true}}]";

    @Test
    void xiaomiCapabilityIsPerApiTypeAndRolledUp() {
        // PLAN-0591 T4.3 (decision C): pins the mixed-state semantics this test guards.
        // capability.tools is the single decision source (per apiType); provider-level
        // supports.tools is an any-route rollup and supports.toolsPartial is `any && !all`.
        // Any change to these xiaomi values is catalog data and must carry an evidence
        // pointer in provider-catalog/README.md (next to providers.json).
        assertFalse(catalog.toolsSupported("xiaomi", "mimo-responses", 1));
        assertTrue(catalog.toolsSupported("xiaomi", "openai-chat-completions", 1));
        var supports = catalog.require("xiaomi").path("supports");
        assertTrue(supports.path("tools").asBoolean());
        assertTrue(supports.path("toolsPartial").asBoolean());
        assertFalse(catalog.toolsSupported("dashscope-qwen", "dashscope-multimodal-embedding", 1));
    }

    @Test
    void missingCapabilityLoadsWithUnsupportedDefault() {
        var service = catalogWith(PROVIDER_HEAD
                + "{\"apiTypeId\":\"openai-chat-completions\",\"version\":1}" + PROVIDER_TAIL);
        assertFalse(service.toolsSupported("p", "openai-chat-completions", 1));
    }

    @Test
    void partiallyDeclaredCapabilitySkipsAggregateCheckAndLoads() {
        var service = catalogWith(PROVIDER_HEAD
                + "{\"apiTypeId\":\"openai-chat-completions\",\"version\":1,\"capability\":{\"tools\":true}},"
                + "{\"apiTypeId\":\"dashscope-multimodal-embedding\",\"version\":1}" + PROVIDER_TAIL);
        assertTrue(service.toolsSupported("p", "openai-chat-completions", 1));
        assertFalse(service.toolsSupported("p", "dashscope-multimodal-embedding", 1));
    }

    @Test
    void nonBooleanCapabilityFailsFast() {
        assertThrows(IllegalStateException.class, () -> catalogWith(PROVIDER_HEAD
                + "{\"apiTypeId\":\"openai-chat-completions\",\"version\":1,\"capability\":{\"tools\":\"yes\"}}"
                + PROVIDER_TAIL));
    }

    @Test
    void disagreesWithRollupFailsFastWhenAllDeclared() {
        assertThrows(IllegalStateException.class, () -> catalogWith(PROVIDER_HEAD
                + "{\"apiTypeId\":\"openai-chat-completions\",\"version\":1,\"capability\":{\"tools\":false}}"
                + PROVIDER_TAIL));
    }
}
