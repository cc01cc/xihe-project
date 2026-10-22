package com.cc01cc.p.xihe.cp.chat;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * PLAN-0528 one-shot startup sweep: guidance left pending on already-terminal
 * runs (CP crash window between run settlement and the same-transaction
 * expire — e.g. rows created before this PLAN deployed) converges to
 * terminal_expired. Runs after the Follow-up recovery listener.
 *
 * <p>PLAN-0543: the listener itself is non-transactional and fail-open. The
 * transaction belongs to {@link ChatRunGuidanceService#recoverPendingOnTerminalRuns()};
 * a failed sweep only warns, because startup must never be blocked by recovery.
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
    public void recoverGuidanceOnStartup(ApplicationReadyEvent event) {
        try {
            int expired = service.recoverPendingOnTerminalRuns();
            logger.info("[LIFECYCLE] service=cp event=guidance_recovery_completed affected={} "
                    + "readyEvent=ApplicationReadyEvent", expired);
        } catch (Exception failure) {
            logger.warn("[LIFECYCLE] service=cp event=guidance_recovery_failed error={}",
                    failure.toString());
        }
    }
}
