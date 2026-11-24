package com.cc01cc.p.xihe.cp.provider;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import tools.jackson.databind.ObjectMapper;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;

/** task-975 (R17): an invalid modelDiscoveryUrl must be a 400 that names the offending field. */
class ProviderConnectionModelDiscoveryUrlControllerTest {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final ProviderConnectionService service = mock(ProviderConnectionService.class);
    private final ProviderConnectionController controller =
            new ProviderConnectionController(service, mock(ProviderCatalogService.class));

    @Test
    void createMapsInvalidModelDiscoveryUrlTo400WithField() throws Exception {
        var request = objectMapper.readValue(
                """
                {
                  "providerId": "custom-openai-compatible",
                  "label": "Custom",
                  "connectionKey": "primary",
                  "modelDiscovery": "remote-models",
                  "modelDiscoveryUrl": "ftp://files.example/list"
                }
                """, ProviderConnectionController.ConnectionRequest.class);
        doThrow(new ProviderConnectionService.ModelDiscoveryUrlInvalidException(
                "modelDiscoveryUrl must use http or https"))
                .when(service).create(any(), any(), any());

        ResponseEntity<?> response = controller.create(request);

        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode());
        Map<?, ?> body = (Map<?, ?>) response.getBody();
        assertEquals("modelDiscoveryUrl", body.get("field"));
    }

    @Test
    void requestCarriesModelDiscoveryUrlIntoServiceInput() throws Exception {
        var request = objectMapper.readValue(
                """
                {
                  "providerId": "custom-openai-compatible",
                  "label": "Custom",
                  "connectionKey": "primary",
                  "modelDiscoveryUrl": "https://models.example.com/list"
                }
                """, ProviderConnectionController.ConnectionRequest.class);

        assertEquals("https://models.example.com/list", request.toInput().modelDiscoveryUrl());
    }
}
