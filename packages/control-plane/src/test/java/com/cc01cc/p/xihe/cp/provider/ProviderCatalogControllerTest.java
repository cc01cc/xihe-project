package com.cc01cc.p.xihe.cp.provider;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

class ProviderCatalogControllerTest {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final ProviderCatalogController controller = new ProviderCatalogController(
            new ProviderCatalogService(objectMapper, new ApiInputTypeService(objectMapper)));

    @SuppressWarnings("unchecked")
    @Test
    void exposesV2RevisionAndPerApiTypeCapability() {
        Map<String, Object> body = (Map<String, Object>) controller.list().getBody();
        assertNotNull(body);
        assertEquals("v3", body.get("catalogRevision"));
        List<Map<String, Object>> providers = (List<Map<String, Object>>) body.get("providers");
        Map<String, Object> xiaomi = providers.stream()
                .filter(provider -> "xiaomi".equals(provider.get("id")))
                .findFirst()
                .orElseThrow();
        Map<String, Object> supports = (Map<String, Object>) xiaomi.get("supports");
        // PLAN-0591 T4.3 (decision C) — mixed-state semantics, pinned here on the public
        // wire: one provider can support tools on some apiTypes and not others, so the
        // rollup `supports.tools` is true while `supports.toolsPartial` marks it partial.
        // capability.tools per apiType stays the only decision source; data changes must
        // carry an evidence pointer in provider-catalog/README.md.
        assertEquals(Boolean.TRUE, supports.get("tools"));
        assertEquals(Boolean.TRUE, supports.get("toolsPartial"));
        List<Map<String, Object>> types = (List<Map<String, Object>>) xiaomi.get("supportedApiTypes");
        Map<String, Object> mimo = types.stream()
                .filter(pair -> "mimo-responses".equals(pair.get("apiTypeId")))
                .findFirst()
                .orElseThrow();
        assertEquals(Boolean.FALSE, ((Map<String, Object>) mimo.get("capability")).get("tools"));

        // PLAN-0605: per-apiType vision capability on the same wire. Only the dashscope-qwen
        // chat pair is verified (M4b real evidence); the six declared vision providers stay
        // false ("待证") so `supports.vision` alone never grants dispatch.
        Map<String, Object> dash = providers.stream()
                .filter(provider -> "dashscope-qwen".equals(provider.get("id")))
                .findFirst()
                .orElseThrow();
        Map<String, Object> dashChat = ((List<Map<String, Object>>) dash.get("supportedApiTypes")).stream()
                .filter(pair -> "openai-chat-completions".equals(pair.get("apiTypeId")))
                .findFirst()
                .orElseThrow();
        assertEquals(Boolean.TRUE, ((Map<String, Object>) dashChat.get("capability")).get("vision"));
        assertEquals(Boolean.TRUE, ((Map<String, Object>) dash.get("supports")).get("visionPartial"));

        Map<String, Object> openai = providers.stream()
                .filter(provider -> "openai".equals(provider.get("id")))
                .findFirst()
                .orElseThrow();
        Map<String, Object> openaiChat = ((List<Map<String, Object>>) openai.get("supportedApiTypes")).getFirst();
        assertEquals(Boolean.TRUE, ((Map<String, Object>) openai.get("supports")).get("vision"));
        assertEquals(Boolean.FALSE, ((Map<String, Object>) openaiChat.get("capability")).get("vision"));
    }
}

