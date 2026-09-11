package com.cc01cc.p.xihe.cp.config;

/**
 * PLAN-0307 T2.15 (decision #23): published after a successful `logging`
 * instance-layer write so the runtime can re-apply log levels dynamically.
 */
public record LoggingConfigChangedEvent(String source) {}
