package com.cc01cc.p.xihe.cp.logging;

import ch.qos.logback.classic.spi.ILoggingEvent;
import net.logstash.logback.encoder.LogstashEncoder;

import java.nio.charset.StandardCharsets;

/**
 * LogstashEncoder that redacts secrets from the serialized JSON output (PLAN-196 M1).
 */
public class RedactingLogstashEncoder extends LogstashEncoder {

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
