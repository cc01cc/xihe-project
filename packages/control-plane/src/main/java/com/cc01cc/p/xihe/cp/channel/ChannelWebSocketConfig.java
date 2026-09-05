package com.cc01cc.p.xihe.cp.channel;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

/**
 * Registers the XH Channel WebSocket endpoint (PLAN-245).
 *
 * <p>Active only when {@code xihe.channel.enabled=true} (default false). With
 * the switch off, no WS endpoint exists and Runtime keeps the plain-HTTP
 * heartbeat/poll behaviour — the channel is an addition, not a replacement.
 * {@link ChannelProperties} lives in {@link ChannelPropertiesConfiguration}
 * so the handler stays constructible when this config is skipped.</p>
 */
@Configuration
@ConditionalOnProperty(name = "xihe.channel.enabled", havingValue = "true")
@EnableWebSocket
public class ChannelWebSocketConfig implements WebSocketConfigurer {

    private final RuntimeChannelHandler runtimeChannelHandler;
    private final ChannelHandshakeInterceptor handshakeInterceptor;

    public ChannelWebSocketConfig(RuntimeChannelHandler runtimeChannelHandler,
                                  ChannelHandshakeInterceptor handshakeInterceptor) {
        this.runtimeChannelHandler = runtimeChannelHandler;
        this.handshakeInterceptor = handshakeInterceptor;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(runtimeChannelHandler, "/internal/v1/channel")
                .addInterceptors(handshakeInterceptor);
    }
}
