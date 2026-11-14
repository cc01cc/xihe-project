package com.cc01cc.p.xihe.cp.event;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ApplicationContext;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertNotNull;

/**
 * task-65: the HUMAN TO guard was opened onto a real delivery path, so the port behind that path
 * must actually exist in a production-shaped context.
 *
 * <p>{@code WakeDispatchService} injects {@code UserChannelPort} with
 * {@code @Autowired(required = false)} and degrades to {@code detail=notify_hint_unavailable} plus an
 * ERROR {@code notify_undeliverable} when the bean is absent. That degradation is the safety net,
 * not the design: opening a user-facing TO onto a silent no-op would be worse than the 400 it
 * replaced. This test pins the design half.</p>
 *
 * <p>Caveat stated on purpose: this context uses the {@code h2} profile, not the prod profile. What
 * it proves is that the port is a component of the default scan (identical across profiles) and that
 * the only implementation is the SSE manager — if a future refactor moves the bean behind a profile
 * or a conditional, this test goes red.</p>
 */
class UserChannelPortWiringTest extends AbstractH2Test {

    @Autowired(required = false)
    private UserChannelPort userChannelPort;

    @Autowired
    private ApplicationContext context;

    @Test
    void theUserChannelPortIsAWiredBeanAndTheOnlyImplementationIsTheSseManager() {
        assertNotNull(userChannelPort,
                "task-65: a HUMAN TO target needs this port; without it every notify is undeliverable");
        assertThat(context.getBeanNamesForType(UserChannelPort.class))
                .as("exactly one delivery channel — a second one would make the hint ambiguous")
                .hasSize(1);
        assertThat(userChannelPort).isInstanceOf(UserChannelSseManager.class);
    }
}
