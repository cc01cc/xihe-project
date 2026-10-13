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
        assertEquals(4, service.list().size());
        assertEquals("chat", service.operation("openai-chat-completions", 1));
        assertEquals("chat", service.operation("anthropic-messages", 1));
        assertEquals("chat", service.operation("mimo-responses", 1));
        assertEquals("embedding", service.operation("dashscope-multimodal-embedding", 1));
        assertTrue(service.contains("openai-chat-completions", 1));
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
