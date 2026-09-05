package com.cc01cc.p.xihe.cp.channel;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Channel tuning properties (PLAN-245).
 *
 * <p>Registered unconditionally: {@link RuntimeChannelHandler} is a plain
 * {@code @Component} that must resolve even when the WebSocket endpoint is
 * disabled ({@code xihe.channel.enabled=false}), so this bean cannot live
 * inside the conditional {@link ChannelWebSocketConfig}.</p>
 */
@Configuration
public class ChannelPropertiesConfiguration {

    @Bean
    public ChannelProperties channelProperties(
            @Value("${xihe.channel.heartbeat-timeout-seconds:90}") long heartbeatTimeoutSeconds) {
        return new ChannelProperties(heartbeatTimeoutSeconds);
    }
}
