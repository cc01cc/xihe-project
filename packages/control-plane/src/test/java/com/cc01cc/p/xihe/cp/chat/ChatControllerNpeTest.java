package com.cc01cc.p.xihe.cp.chat;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.web.client.RestTemplate;
import com.cc01cc.p.xihe.cp.AbstractH2Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"cp.agent-url="}
)
@ActiveProfiles("h2")
class ChatControllerNpeTest extends AbstractH2Test {

    @Test
    void execAsync_catchBlockHandlesNullMessageWithoutNpe() {
        var headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        var body = Map.of("sessionId", "npe-test", "content", "Hello");
        var request = new HttpEntity<>(body, headers);

        assertDoesNotThrow(() -> {
            ResponseEntity<Map> response = restTemplate.postForEntity(url("/api/v1/exec"), request, Map.class);
            assertTrue(
                response.getStatusCode().is4xxClientError() || response.getStatusCode().is2xxSuccessful(),
                "Should return either 409 (no SSE) or 202 (accepted)"
            );
        }, "Endpoint should not throw when agentUrl is invalid");
    }
}
