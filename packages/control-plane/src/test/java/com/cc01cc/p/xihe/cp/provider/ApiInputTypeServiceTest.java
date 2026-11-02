package com.cc01cc.p.xihe.cp.provider;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ApiInputTypeServiceTest {

    private final ApiInputTypeService service = new ApiInputTypeService(new ObjectMapper());

    @Test
    void loadsBuiltInTargetTypes() {
        // No hard-coded total: the constructor already rejects duplicate id/version entries,
        // so the registry size is validated structurally, not by a magic number.
        assertEquals("chat", service.operation("openai-chat-completions", 1));
        assertEquals("chat", service.operation("anthropic-messages", 1));
        assertEquals("chat", service.operation("mimo-responses", 1));
        assertEquals("embedding", service.operation("dashscope-multimodal-embedding", 1));
        assertTrue(service.contains("openai-chat-completions", 1));
        // PLAN-0624 D24-04: DashScope native generation (decision-model-preview) joins the registry.
        assertEquals("chat", service.operation("dashscope-generation", 1));
        assertEquals("/api/v1",
                service.require("dashscope-generation", 1).get("requiredBaseSuffix"));
        assertEquals("/services/aigc/text-generation/generation",
                service.require("dashscope-generation", 1).get("path"));
    }

    @Test
    void rejectsUnknownType() {
        assertThrows(IllegalArgumentException.class, () -> service.require("not-a-type", 1));
    }

    @Test
    void registryDefinitionsCannotBeMutatedThroughReads() {
        assertThrows(UnsupportedOperationException.class,
                () -> service.list().clear());
        assertThrows(UnsupportedOperationException.class,
                () -> service.require("openai-chat-completions", 1).put("operation", "embedding"));
        assertThrows(UnsupportedOperationException.class,
                () -> service.find("openai-chat-completions", 1).orElseThrow().put("version", 2));
        assertEquals("chat", service.operation("openai-chat-completions", 1));
    }
}
