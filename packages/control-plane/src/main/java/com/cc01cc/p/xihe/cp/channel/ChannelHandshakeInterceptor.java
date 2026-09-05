package com.cc01cc.p.xihe.cp.channel;

import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.lang.NonNull;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

import java.util.Map;

/**
 * Handshake auth for the XH Channel endpoint (PLAN-245).
 *
 * <p>The Runtime presents the shared service token via the standard
 * {@code Authorization: Bearer <token>} header on the WS Upgrade request.
 * Rejecting here keeps unauthenticated connections out of the message loop.
 * UI JWT is deliberately not accepted: this is a service-plane channel.</p>
 */
@Component
public class ChannelHandshakeInterceptor implements HandshakeInterceptor {

    private final String expectedToken;

    public ChannelHandshakeInterceptor(
            @org.springframework.beans.factory.annotation.Value(
                    "${cp.agent-api-token:dev-token-not-secure}") String expectedToken) {
        this.expectedToken = expectedToken;
    }

    @Override
    public boolean beforeHandshake(@NonNull ServerHttpRequest request,
                                   @NonNull ServerHttpResponse response,
                                   @NonNull WebSocketHandler wsHandler,
                                   @NonNull Map<String, Object> attributes) {
        String auth = request.getHeaders().getFirst("Authorization");
        String token = auth != null && auth.startsWith("Bearer ")
                ? auth.substring("Bearer ".length()).trim()
                : null;
        if (token == null || token.isBlank() || !token.equals(expectedToken)) {
            return false;
        }
        attributes.put("channel.auth", "service-token");
        return true;
    }

    @Override
    public void afterHandshake(@NonNull ServerHttpRequest request,
                               @NonNull ServerHttpResponse response,
                               @NonNull WebSocketHandler wsHandler,
                               Exception exception) {
        // No-op.
    }
}
