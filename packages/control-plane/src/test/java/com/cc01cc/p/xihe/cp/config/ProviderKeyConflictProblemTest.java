package com.cc01cc.p.xihe.cp.config;

import jakarta.servlet.http.HttpServletRequest;
import org.hibernate.exception.ConstraintViolationException;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ProviderKeyConflictProblemTest {
    private final ProblemDetailsHandler handler = new ProblemDetailsHandler(5000);

    @Test
    void exactProviderKeyConstraintMapsToStableConflict() {
        HttpServletRequest request = mock(HttpServletRequest.class);
        when(request.getRequestURI()).thenReturn("/api/v1/provider-connections");
        ConstraintViolationException cause = mock(ConstraintViolationException.class);
        when(cause.getConstraintName()).thenReturn("uq_provider_connections_owner_provider_key");
        var response = handler.integrityViolation(new DataIntegrityViolationException("duplicate", cause), request);
        assertEquals(HttpStatus.CONFLICT, response.getStatusCode());
        assertEquals("PROVIDER_CONNECTION_KEY_CONFLICT", response.getBody().get("code"));
    }

    @Test
    void unrelatedIntegrityFailureIsNotReportedAsDuplicateKey() {
        HttpServletRequest request = mock(HttpServletRequest.class);
        when(request.getRequestURI()).thenReturn("/api/v1/provider-connections");
        ConstraintViolationException cause = mock(ConstraintViolationException.class);
        when(cause.getConstraintName()).thenReturn("unrelated_constraint");
        var response = handler.integrityViolation(new DataIntegrityViolationException("invalid", cause), request);
        assertEquals(HttpStatus.INTERNAL_SERVER_ERROR, response.getStatusCode());
        assertEquals("INTERNAL_ERROR", response.getBody().get("code"));
    }
}
