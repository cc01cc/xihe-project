package com.cc01cc.p.xihe.cp.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.UUID;

/**
 * PLAN-0624 M2 boundary (D24-03/D24-10): what fires when a wake schedule matures.
 *
 * <p><b>M4 owns the implementation.</b> M2 wires everything up TO this seam — the scheduler,
 * the governor ceiling, the projection sync — and deliberately stops here: this stub only
 * records that a wake fired, so the M2 tests can assert the full path without inventing M4's
 * dispatch semantics (respond_policy evaluation, JUDGE, run creation, SSE).</p>
 *
 * <p>{@code wakeRoundId} is the judge dedupe key (D24-02): one judge per (participant, round).</p>
 */
@Service
public class WakeDispatchService {

    private static final Logger logger = LoggerFactory.getLogger(WakeDispatchService.class);

    /** M4 replaces this body; the signature is the M2→M4 contract. */
    public WakeFireResult fire(UUID participantId, String triggerSource, String wakeRoundId) {
        logger.info("[LIFECYCLE] service=cp event=wake_dispatch_deferred_to_m4 participantId={} "
                + "triggerSource={} wakeRoundId={}", participantId, triggerSource, wakeRoundId);
        return new WakeFireResult(false);
    }

    /** false until M4 actually dispatches (the stub never does). */
    public record WakeFireResult(boolean dispatched) {}
}
