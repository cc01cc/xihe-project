package com.cc01cc.p.xihe.cp.provider;

import org.junit.jupiter.api.Test;

import tools.jackson.databind.ObjectMapper;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ProviderConnectionControllerRequestTest {

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    void readonlyContractFieldsAreDeserializedRatherThanIgnored() throws Exception {
        var request = objectMapper.readValue(
                """
                {"apiTypeId":"openai-chat-completions","apiTypeVersion":1,"operation":null}
                """, ProviderConnectionController.ConnectionRequest.class);

        assertEquals("openai-chat-completions", request.apiTypeId().asText());
        assertEquals(1, request.apiTypeVersion().asInt());
        assertTrue(request.operation().isNull());
        assertEquals(null, request.toInput().connectionKey());
    }

    @Test
    void connectionRequestDeserializesJackson3JsonNode() throws Exception {
        ProviderConnectionController.ConnectionRequest request = objectMapper.readValue(
                """
                {
                  "providerId": "custom-openai-compatible",
                  "label": "Custom",
                  "connectionKey": "primary"
                }
                """,
                ProviderConnectionController.ConnectionRequest.class);

        assertEquals("primary", request.toInput().connectionKey());
    }

    @Test
    void connectionRequestRejectsExplicitNullKey() throws Exception {
        ProviderConnectionController.ConnectionRequest request = objectMapper.readValue(
                """
                {
                  "providerId": "custom-openai-compatible",
                  "label": "Custom",
                  "connectionKey": null
                }
                """,
                ProviderConnectionController.ConnectionRequest.class);

        ProviderConnectionService.KeyInvalidException error = assertThrows(
                ProviderConnectionService.KeyInvalidException.class,
                request::toInput);
        assertTrue(error.getMessage().contains("must not be null"));
    }

    @Test
    void connectionRequestTreatsMissingKeyAsOmitted() throws Exception {
        ProviderConnectionController.ConnectionRequest request = objectMapper.readValue(
                """
                {
                  "providerId": "custom-openai-compatible",
                  "label": "Custom"
                }
                """,
                ProviderConnectionController.ConnectionRequest.class);

        assertEquals(null, request.toInput().connectionKey());
    }
}
