package com.cc01cc.p.xihe.cp.chat;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * PLAN-0528 one-shot startup sweep: guidance left pending on already-terminal
 * runs (CP crash window between run settlement and the same-transaction
 * expire — e.g. rows created before this PLAN deployed) converges to
 * terminal_expired. Runs after the Follow-up recovery listener.
 */
@Component
public class ChatRunGuidanceRecovery {

    private static final Logger logger = LoggerFactory.getLogger(ChatRunGuidanceRecovery.class);

    private final ChatRunGuidanceService service;

    public ChatRunGuidanceRecovery(ChatRunGuidanceService service) {
        this.service = service;
    }

    @Order(Ordered.LOWEST_PRECEDENCE)
    @EventListener(ApplicationReadyEvent.class)
    @Transactional
    public void recoverGuidanceOnStartup(ApplicationReadyEvent event) {
        int expired = service.recoverPendingOnTerminalRuns();
        logger.info("[LIFECYCLE] service=cp event=guidance_recovery_completed terminalExpired={} "
                + "readyEvent=ApplicationReadyEvent", expired);
    }
}
