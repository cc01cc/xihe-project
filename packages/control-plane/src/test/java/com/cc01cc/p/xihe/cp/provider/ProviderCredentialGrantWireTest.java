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
                List.of(), "connection-key", "mimo-responses", 1, "chat", true);
        var json = new ObjectMapper().writeValueAsString(grant);
        assertTrue(json.contains("\"toolsSupported\":true"));
        assertFalse(json.contains("tools_supported"));
    }
}
