package com.cc01cc.p.xihe.cp.auth;

import org.junit.jupiter.api.Test;
import org.springframework.http.*;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class AuthIntegrationTest extends AbstractIntegrationTest {

    @Test
    void registerCreatesUserAndReturnsTokens() {
        RegisterRequest request = new RegisterRequest("register-test@test.com", "password123", "Register Test");

        ResponseEntity<AuthResponse> response = restTemplate.postForEntity(
                baseUrl + "/auth/register", request, AuthResponse.class);

        assertEquals(HttpStatus.CREATED.value(), response.getStatusCode().value());
        AuthResponse body = response.getBody();
        assertNotNull(body);
        assertNotNull(body.getAccessToken());
        assertNotNull(body.getRefreshToken());
        assertEquals("Bearer", body.getTokenType());
        assertTrue(body.getExpiresIn() > 0);
    }

    @Test
    void registerRejectsDuplicateEmail() {
        RegisterRequest request = new RegisterRequest("dup@test.com", "password123", "Register Test");

        ResponseEntity<AuthResponse> first = restTemplate.postForEntity(
                baseUrl + "/auth/register", request, AuthResponse.class);
        assertEquals(HttpStatus.CREATED.value(), first.getStatusCode().value());

        ResponseEntity<Map> second = restTemplate.postForEntity(
                baseUrl + "/auth/register", request, Map.class);
        assertEquals(HttpStatus.BAD_REQUEST.value(), second.getStatusCode().value());
    }

    @Test
    void loginWithValidCredentialsReturnsTokens() {
        String email = "login-success-" + System.currentTimeMillis() + "@test.com";
        RegisterRequest register = new RegisterRequest(email, "password123", "Login Test");
        restTemplate.postForEntity(baseUrl + "/auth/register", register, AuthResponse.class);

        LoginRequest login = new LoginRequest(email, "password123");
        ResponseEntity<AuthResponse> response = restTemplate.postForEntity(
                baseUrl + "/auth/login", login, AuthResponse.class);

        assertEquals(HttpStatus.OK.value(), response.getStatusCode().value());
        assertNotNull(response.getBody());
        assertNotNull(response.getBody().getAccessToken());
        assertNotNull(response.getBody().getRefreshToken());
    }

    @Test
    void loginWithInvalidPasswordReturns401() {
        String email = "login-fail-" + System.currentTimeMillis() + "@test.com";
        RegisterRequest register = new RegisterRequest(email, "password123", "Login Test");
        restTemplate.postForEntity(baseUrl + "/auth/register", register, AuthResponse.class);

        LoginRequest badLogin = new LoginRequest(email, "wrong-password");
        ResponseEntity<Map> response = restTemplate.postForEntity(
                baseUrl + "/auth/login", badLogin, Map.class);
        assertEquals(HttpStatus.UNAUTHORIZED.value(), response.getStatusCode().value());
    }

    @Test
    void loginWithNonExistentEmailReturns401() {
        LoginRequest login = new LoginRequest("nonexistent@test.com", "password123");
        ResponseEntity<Map> response = restTemplate.postForEntity(
                baseUrl + "/auth/login", login, Map.class);
        assertEquals(HttpStatus.UNAUTHORIZED.value(), response.getStatusCode().value());
    }

    @Test
    void refreshWithValidTokenReturnsNewTokens() {
        String email = "refresh-valid-" + System.currentTimeMillis() + "@test.com";
        RegisterRequest register = new RegisterRequest(email, "password123", "Refresh Test");
        ResponseEntity<AuthResponse> regResponse = restTemplate.postForEntity(
                baseUrl + "/auth/register", register, AuthResponse.class);
        String refreshToken = regResponse.getBody().getRefreshToken();

        RefreshRequest refreshRequest = new RefreshRequest(refreshToken);
        ResponseEntity<AuthResponse> response = restTemplate.postForEntity(
                baseUrl + "/auth/refresh", refreshRequest, AuthResponse.class);

        assertEquals(HttpStatus.OK.value(), response.getStatusCode().value());
        assertNotNull(response.getBody());
        assertNotNull(response.getBody().getAccessToken());
    }

    @Test
    void refreshWithInvalidTokenReturns401() {
        RefreshRequest refreshRequest = new RefreshRequest("invalid-refresh-token");
        ResponseEntity<Map> response = restTemplate.postForEntity(
                baseUrl + "/auth/refresh", refreshRequest, Map.class);
        assertEquals(HttpStatus.UNAUTHORIZED.value(), response.getStatusCode().value());
    }

    @Test
    void meReturnsCurrentUser() {
        String email = "me-valid-" + System.currentTimeMillis() + "@test.com";
        RegisterRequest register = new RegisterRequest(email, "password123", "Me Test");
        ResponseEntity<AuthResponse> regResponse = restTemplate.postForEntity(
                baseUrl + "/auth/register", register, AuthResponse.class);
        String token = regResponse.getBody().getAccessToken();

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        HttpEntity<?> entity = new HttpEntity<>(headers);

        ResponseEntity<UserResponse> response = restTemplate.exchange(
                baseUrl + "/auth/me", HttpMethod.GET, entity, UserResponse.class);

        assertEquals(HttpStatus.OK.value(), response.getStatusCode().value());
        assertEquals(email, response.getBody().getEmail());
    }

    @Test
    void meWithoutAuthReturns401() {
        ResponseEntity<Map> response = restTemplate.getForEntity(
                baseUrl + "/auth/me", Map.class);

        assertEquals(HttpStatus.UNAUTHORIZED.value(), response.getStatusCode().value());
    }
}
