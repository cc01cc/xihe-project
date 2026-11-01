package com.cc01cc.p.xihe.cp.config;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0615 (BL-182): a context guard that sees no principal is an <b>invariant fuse</b>.
 *
 * <p>{@code @PreAuthorize} guarantees a principal, so this branch should never run. When it does, the
 * response must be {@code 403 FORBIDDEN} (not 401 — the caller is authenticated and clients treat 401
 * as session expiry) and the trip must leave a warn line behind, including the detail and the request
 * path, otherwise the fuse is invisible in production.</p>
 */
class ProblemDetailsHandlerMissingPrincipalTest {

    private Logger handlerLogger;
    private ListAppender<ILoggingEvent> appender;

    @BeforeEach
    void attachAppender() {
        handlerLogger = (Logger) LoggerFactory.getLogger(ProblemDetailsHandler.class);
        appender = new ListAppender<>();
        appender.start();
        handlerLogger.addAppender(appender);
    }

    @AfterEach
    void detachAppender() {
        handlerLogger.detachAppender(appender);
        appender.stop();
    }

    @Test
    void missingPrincipalAnswersForbiddenAndWarns() {
        ResponseEntity<Map<String, Object>> response =
                ProblemDetailsHandler.missingPrincipal("User context is required");

        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode(),
                "an authenticated caller reaching the fuse is a permission problem, never an auth failure");
        assertEquals("FORBIDDEN", response.getBody().get("code"));
        assertEquals("User context is required", response.getBody().get("detail"));

        List<ILoggingEvent> warnings = appender.list.stream()
                .filter(event -> event.getLevel() == Level.WARN)
                .toList();
        assertEquals(1, warnings.size(), "the fuse must leave exactly one warn line");
        String line = warnings.getFirst().getFormattedMessage();
        assertTrue(line.contains("context_guard_without_principal"), line);
        assertTrue(line.contains("status=403"), line);
        assertTrue(line.contains("User context is required"), line);
    }

    @Test
    void missingPrincipalExceptionCarriesTheSameSemantics() {
        CpApiException error = ProblemDetailsHandler.missingPrincipalException("Authentication context is required");

        assertEquals(HttpStatus.FORBIDDEN, error.getStatus());
        assertEquals("FORBIDDEN", error.getCode());
        assertEquals("Authentication context is required", error.getMessage());
        assertTrue(appender.list.stream()
                        .anyMatch(event -> event.getLevel() == Level.WARN
                                && event.getFormattedMessage().contains("context_guard_without_principal")),
                "the service-layer twin warns as well");
    }
}
