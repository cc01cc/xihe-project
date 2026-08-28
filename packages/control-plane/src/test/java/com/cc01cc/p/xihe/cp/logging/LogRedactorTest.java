package com.cc01cc.p.xihe.cp.logging;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class LogRedactorTest {

    @Test
    void redactsBearerAndJwt() {
        String out = LogRedactor.redact("auth failed with Bearer sk-live-abcdef123456");
        assertFalse(out.contains("sk-live"));
        assertTrue(out.contains(LogRedactor.REDACTED));

        String jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dGVzdHNpZw";
        assertFalse(LogRedactor.redact("token=" + jwt).contains("eyJhbGciOiJIUzI1NiJ9"));
    }

    @Test
    void redactsJsonSensitiveFieldsKeepsOthers() {
        String line = "{\"msg\":\"ok\",\"refresh_token\":\"rt-secret-123\",\"note\":\"visible\"}";
        String out = LogRedactor.redact(line);
        assertFalse(out.contains("rt-secret-123"));
        assertTrue(out.contains("visible"));
        assertTrue(out.contains("\"refresh_token\":\"" + LogRedactor.REDACTED + "\""));
    }

    @Test
    void handlesNullAndEmpty() {
        assertEquals(null, LogRedactor.redact(null));
        assertEquals("", LogRedactor.redact(""));
    }
}
