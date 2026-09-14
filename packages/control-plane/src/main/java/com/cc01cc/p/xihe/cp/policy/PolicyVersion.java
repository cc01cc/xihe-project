package com.cc01cc.p.xihe.cp.policy;

import java.util.concurrent.atomic.AtomicLong;
import org.springframework.stereotype.Component;

/**
 * Per-process policy version (PLAN-0328 spec §4.3): rule and tool-face writers bump it so the
 * cached DB snapshot in {@link DbPolicyContextProvider} is reloaded. Single-instance v1 — the
 * version is not shared across processes.
 */
@Component
public class PolicyVersion {

    private final AtomicLong version = new AtomicLong();

    public long current() {
        return version.get();
    }

    public void bump() {
        version.incrementAndGet();
    }
}
