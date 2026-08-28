package com.cc01cc.p.xihe.cp.config;

import org.junit.jupiter.api.Test;
import org.springframework.http.*;

import com.cc01cc.p.xihe.cp.AbstractH2Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class SecurityConfigTest extends AbstractH2Test {

    @Test
    void healthEndpointIsPublic() {
        ResponseEntity<Map> response = restTemplate.getForEntity(
                baseUrl + "/api/v1/health", Map.class);
        assertEquals(200, response.getStatusCode().value());
    }

    @Test
    void registerEndpointIsPublic() {
        ResponseEntity<Map> response = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register",
                Map.of("email", "sec-test@test.com", "password", "Test1234!", "name", "SecTest"),
                Map.class);
        assertEquals(HttpStatus.CREATED.value(), response.getStatusCode().value());
    }

    @Test
    void protectedEndpointRejectsNoAuth() {
        ResponseEntity<Map> response = restTemplate.postForEntity(
                baseUrl + "/api/v1/exec", Map.of(), Map.class);
        assertEquals(HttpStatus.UNAUTHORIZED.value(), response.getStatusCode().value());
    }

    @Test
    void protectedMcpEndpointRejectsNoAuth() {
        ResponseEntity<Map> response = restTemplate.postForEntity(
                baseUrl + "/api/v1/mcp", Map.of(), Map.class);
        assertEquals(HttpStatus.UNAUTHORIZED.value(), response.getStatusCode().value());
    }

    @Test
    void authenticatedRequestToProtectedEndpointSucceeds() {
        String token = registerAndGetToken("auth-endpoint-test@test.com");

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        HttpEntity<Void> entity = new HttpEntity<>(headers);

        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/exec", HttpMethod.POST, entity, Map.class);
        assertNotEquals(HttpStatus.UNAUTHORIZED.value(), response.getStatusCode().value());
    }

    @Test
    void chatEndpointRejectsNoAuth() {
        ResponseEntity<Map> response = restTemplate.postForEntity(
                baseUrl + "/api/v1/chat", Map.of(), Map.class);
        assertEquals(HttpStatus.UNAUTHORIZED.value(), response.getStatusCode().value());
    }

    @Test
    void chatEndpointWithAuthSucceeds() {
        String token = registerAndGetToken("chat-auth-test@test.com");

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        HttpEntity<Void> entity = new HttpEntity<>(headers);

        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/chat", HttpMethod.POST, entity, Map.class);
        assertNotEquals(HttpStatus.UNAUTHORIZED.value(), response.getStatusCode().value());
    }

    @Test
    void eventsEndpointRejectsNoAuth() {
        ResponseEntity<Map> response = restTemplate.getForEntity(
                baseUrl + "/api/v1/events", Map.class);
        assertEquals(HttpStatus.UNAUTHORIZED.value(), response.getStatusCode().value());
    }

    @Test
    void healthWithAnyRoleSucceeds() {
        ResponseEntity<Map> response = restTemplate.getForEntity(
                baseUrl + "/api/v1/health", Map.class);
        assertEquals(200, response.getStatusCode().value());
    }

    private String registerAndGetToken(String email) {
        ResponseEntity<Map> regResponse = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register",
                Map.of("email", email, "password", "Test1234!", "name", "AuthTest"),
                Map.class);
        assertEquals(HttpStatus.CREATED.value(), regResponse.getStatusCode().value());
        @SuppressWarnings("unchecked")
        Map<String, Object> regBody = regResponse.getBody();
        assertNotNull(regBody);
        String token = (String) regBody.get("accessToken");
        assertNotNull(token);
        return token;
    }
}
