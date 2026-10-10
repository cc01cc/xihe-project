package com.cc01cc.p.xihe.cp.controller;

import java.time.Instant;
import org.springframework.stereotype.Component;

/**
 * Device-wide Runtime heartbeat observation shared by the Runtime ingress adapter
 * and the Workspace environment read adapter; neither adapter calls the other.
 */
@Component
public class RuntimeHeartbeatState {

    private volatile RuntimeHeartbeatRequest latestHeartbeat;

    public void record(RuntimeHeartbeatRequest request) {
        this.latestHeartbeat = request;
    }

    public RuntimeHeartbeatRequest latest() {
        return latestHeartbeat;
    }

    public record RuntimeHeartbeatRequest(String deviceId, String status, Instant observedAt) {
    }
}
