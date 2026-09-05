package com.cc01cc.p.xihe.cp.channel;

/** Channel tuning properties (PLAN-245). */
public record ChannelProperties(long heartbeatTimeoutSeconds) {

    public ChannelProperties {
        if (heartbeatTimeoutSeconds <= 0) {
            heartbeatTimeoutSeconds = 90;
        }
    }
}
