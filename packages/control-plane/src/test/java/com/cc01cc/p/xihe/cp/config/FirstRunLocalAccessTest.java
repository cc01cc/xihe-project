package com.cc01cc.p.xihe.cp.config;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * D-1535 ③ (task-5): pins the local gate axis by axis. Each case names the one input that flips the
 * answer, so a regression cannot hide behind "some check still refuses".
 */
class FirstRunLocalAccessTest {

    private static final Function<String, String> DEV = key -> "dev";

    private static MockHttpServletRequest request(String peer, String host, String origin) {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setRemoteAddr(peer);
        if (host != null) {
            request.addHeader("Host", host);
        }
        if (origin != null) {
            request.addHeader("Origin", origin);
        }
        return request;
    }

    private static Function<String, String> env(String name) {
        return key -> FirstRunLocalAccess.ENV_NAME_KEY.equals(key) ? name : null;
    }

    @Test
    void loopbackPeerWithLoopbackHostAndNoOriginPasses() {
        assertTrue(FirstRunLocalAccess.denial(
                request("127.0.0.1", "127.0.0.1:12641", null), DEV).isEmpty());
    }

    @Test
    void ipv6LoopbackPeerAndBracketedHostPass() {
        assertTrue(FirstRunLocalAccess.denial(
                request("::1", "[::1]:12641", "http://[::1]:12640"), DEV).isEmpty());
    }

    /**
     * The dev stack proxies the UI origin to the CP origin with {@code changeOrigin}, so the product's
     * own first-run page presents {@code Origin: http://localhost:12640} with
     * {@code Host: 127.0.0.1:12641}. Both are loopback names; the gate must not close on this pair.
     */
    @Test
    void devProxyPortMismatchBetweenOriginAndHostPasses() {
        assertTrue(FirstRunLocalAccess.denial(
                request("127.0.0.1", "127.0.0.1:12641", "http://localhost:12640"), DEV).isEmpty());
    }

    @Test
    void remotePeerIsRefusedEvenWithLoopbackHost() {
        assertEquals("peer", FirstRunLocalAccess.denial(
                request("10.0.0.7", "127.0.0.1:12641", null), DEV).orElseThrow());
    }

    @Test
    void nonLoopbackHostIsRefused() {
        assertEquals("host", FirstRunLocalAccess.denial(
                request("127.0.0.1", "evil.example:12641", null), DEV).orElseThrow());
    }

    /** A rebinding name that resolves to loopback stays refused: only literal loopback names pass. */
    @Test
    void rebindingHostNameIsRefused() {
        assertEquals("host", FirstRunLocalAccess.denial(
                request("127.0.0.1", "127.0.0.1.nip.io:12641", null), DEV).orElseThrow());
    }

    @Test
    void crossSiteOriginIsRefused() {
        assertEquals("origin", FirstRunLocalAccess.denial(
                request("127.0.0.1", "127.0.0.1:12641", "https://evil.example"), DEV).orElseThrow());
    }

    @Test
    void nonHttpOriginIsRefused() {
        assertEquals("origin", FirstRunLocalAccess.denial(
                request("127.0.0.1", "127.0.0.1:12641", "file:///tmp/x.html"), DEV).orElseThrow());
    }

    @Test
    void prodClosesTheFaceAnotherwiseValidCaller() {
        assertEquals("prod", FirstRunLocalAccess.denial(
                request("127.0.0.1", "127.0.0.1:12641", null), env("prod")).orElseThrow());
    }

    @Test
    void prodSwitchIsCaseInsensitiveAndTrimmed() {
        assertEquals("prod", FirstRunLocalAccess.denial(
                request("127.0.0.1", "127.0.0.1:12641", null), env(" PROD ")).orElseThrow());
    }
}
