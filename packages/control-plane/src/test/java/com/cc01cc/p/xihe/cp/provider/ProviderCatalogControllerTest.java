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
        assertEquals("v2", body.get("catalogRevision"));
        List<Map<String, Object>> providers = (List<Map<String, Object>>) body.get("providers");
        Map<String, Object> xiaomi = providers.stream()
                .filter(provider -> "xiaomi".equals(provider.get("id")))
                .findFirst()
                .orElseThrow();
        Map<String, Object> supports = (Map<String, Object>) xiaomi.get("supports");
        assertEquals(Boolean.TRUE, supports.get("tools"));
        assertEquals(Boolean.TRUE, supports.get("toolsPartial"));
        List<Map<String, Object>> types = (List<Map<String, Object>>) xiaomi.get("supportedApiTypes");
        Map<String, Object> mimo = types.stream()
                .filter(pair -> "mimo-responses".equals(pair.get("apiTypeId")))
                .findFirst()
                .orElseThrow();
        assertEquals(Boolean.FALSE, ((Map<String, Object>) mimo.get("capability")).get("tools"));
    }
}
