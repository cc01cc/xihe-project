package com.cc01cc.p.xihe.cp.provider;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ProviderCredentialGrantWireTest {

    @Test
    void grantSerializesCamelCaseToolsSupported() throws Exception {
        var grant = new ProviderCredentialLeaseService.CredentialGrant(
                "xiaomi", "xiaomi_mimo", "mimo", "https://api.example/v1", null, 1L, "remote-models",
                List.of(), "connection-key", "mimo-responses", 1, "chat", true, false);
        var json = new ObjectMapper().writeValueAsString(grant);
        assertTrue(json.contains("\"toolsSupported\":true"));
        assertFalse(json.contains("tools_supported"));
    }

    @Test
    void grantSerializesCamelCaseVisionSupported() throws Exception {
        // PLAN-0605: the Agent vision gate reads this lease field, so the wire name is a
        // cross-service contract and must stay camelCase.
        var grant = new ProviderCredentialLeaseService.CredentialGrant(
                "dashscope-qwen", "dashscope", "qwen3.8-omni-flash",
                "https://dashscope.aliyuncs.com/compatible-mode/v1", null, 1L, "manual",
                List.of("qwen3.8-omni-flash"), "connection-key", "openai-chat-completions", 1, "chat",
                true, true);
        var json = new ObjectMapper().writeValueAsString(grant);
        assertTrue(json.contains("\"visionSupported\":true"));
        assertFalse(json.contains("vision_supported"));
    }
}
