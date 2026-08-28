package com.cc01cc.p.xihe.cp.logging;

import ch.qos.logback.classic.encoder.PatternLayoutEncoder;
import ch.qos.logback.classic.spi.ILoggingEvent;

import java.nio.charset.StandardCharsets;

/**
 * PatternLayoutEncoder that redacts secrets from console output (PLAN-196 M1).
 */
public class RedactingPatternLayoutEncoder extends PatternLayoutEncoder {

    @Override
    public byte[] encode(ILoggingEvent event) {
        byte[] raw = super.encode(event);
        if (raw == null) {
            return null;
        }
        return LogRedactor.redact(new String(raw, StandardCharsets.UTF_8))
            .getBytes(StandardCharsets.UTF_8);
    }
}
