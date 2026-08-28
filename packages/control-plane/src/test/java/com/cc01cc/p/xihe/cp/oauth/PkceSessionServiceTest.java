package com.cc01cc.p.xihe.cp.oauth;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

import org.junit.jupiter.api.Test;

class PkceSessionServiceTest {

    @Test
    void startCreatesVerifierAndMatchingChallenge() {
        PkceSessionService service = new PkceSessionService();
        var session = service.start("u1", "w1", "m1", "client", "https://oauth/authorize", "https://oauth/token", "https://cp/callback", "mcp:tools");

        assertEquals(PkceSessionService.challenge(session.codeVerifier()), session.codeChallenge());
        assertNotEquals(session.state(), session.codeVerifier());
    }

    @Test
    void consumeIsBoundToTenantAndOneTime() {
        PkceSessionService service = new PkceSessionService();
        var session = service.start("u1", "w1", "m1", "client", "https://oauth/authorize", "https://oauth/token", "https://cp/callback", "mcp:tools");

        assertEquals(session.state(), service.consume(
                session.state(), "u1", "w1", "m1", "https://cp/callback").state());
        assertThrows(IllegalArgumentException.class, () -> service.consume(
                session.state(), "u1", "w1", "m1", "https://cp/callback"));
    }

    @Test
    void consumeRejectsBindingMismatch() {
        PkceSessionService service = new PkceSessionService();
        var session = service.start("u1", "w1", "m1", "client", "https://oauth/authorize", "https://oauth/token", "https://cp/callback", "mcp:tools");

        assertThrows(IllegalArgumentException.class, () -> service.consume(
                session.state(), "u2", "w1", "m1", "https://cp/callback"));
    }
}
