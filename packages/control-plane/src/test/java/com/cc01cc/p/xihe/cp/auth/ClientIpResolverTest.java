package com.cc01cc.p.xihe.cp.auth;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

import static org.junit.jupiter.api.Assertions.assertEquals;

class ClientIpResolverTest {

    @Test
    void untrustedRemote_ignoresForwardedFor() {
        ClientIpResolver resolver = new ClientIpResolver("", 64);
        MockHttpServletRequest request = request("203.0.113.5", "198.51.100.9");
        assertEquals("203.0.113.5", resolver.resolve(request));
    }

    @Test
    void trustedProxy_usesRightmostUntrustedHop() {
        ClientIpResolver resolver = new ClientIpResolver("127.0.0.1/32", 64);
        MockHttpServletRequest request = request("127.0.0.1", "198.51.100.9, 127.0.0.1");
        assertEquals("198.51.100.9", resolver.resolve(request));
    }

    @Test
    void trustedProxy_readsMultipleHeaderLines() {
        ClientIpResolver resolver = new ClientIpResolver("127.0.0.1/32", 64);
        MockHttpServletRequest request = request("127.0.0.1", "198.51.100.9");
        request.addHeader("X-Forwarded-For", "203.0.113.7");
        assertEquals("203.0.113.7", resolver.resolve(request));
    }

    @Test
    void allTrustedHops_fallBackToRemote() {
        ClientIpResolver resolver = new ClientIpResolver("127.0.0.1/32", 64);
        MockHttpServletRequest request = request("127.0.0.1", "127.0.0.1");
        assertEquals("127.0.0.1", resolver.resolve(request));
    }

    @Test
    void malformedForwardedFor_fallsBackToRemote() {
        ClientIpResolver resolver = new ClientIpResolver("127.0.0.1/32", 64);
        MockHttpServletRequest request = request("127.0.0.1", "not-an-ip");
        assertEquals("127.0.0.1", resolver.resolve(request));
    }

    @Test
    void ipv6_aggregatesTo64() throws Exception {
        ClientIpResolver resolver = new ClientIpResolver("127.0.0.1/32", 64);
        MockHttpServletRequest request = request("127.0.0.1", "2001:db8:1:2:3:4:5:6");
        String expected = java.net.InetAddress.getByName("2001:db8:1:2::").getHostAddress();
        assertEquals(expected, resolver.resolve(request));
    }

    @Test
    void ipv4MappedAddress_normalizesToIpv4() {
        assertEquals("127.0.0.1", ClientIpResolver.normalize("::ffff:127.0.0.1"));
    }

    @Test
    void resolveClientIp_directIpv6Loopback_keepsRawAndMasksBucket() {
        ClientIpResolver resolver = new ClientIpResolver("", 64);
        MockHttpServletRequest request = request("0:0:0:0:0:0:0:1", null);
        ClientIpResolver.ResolvedClientIp resolved = resolver.resolveClientIp(request);
        assertEquals("0:0:0:0:0:0:0:1", resolved.raw());
        assertEquals("0:0:0:0:0:0:0:0", resolved.bucketKey());
    }

    @Test
    void resolveClientIp_trustedProxy_rawIsForwardedLiteral() {
        ClientIpResolver resolver = new ClientIpResolver("127.0.0.1/32,::1/128", 64);
        MockHttpServletRequest request = request("0:0:0:0:0:0:0:1", "203.0.113.9");
        ClientIpResolver.ResolvedClientIp resolved = resolver.resolveClientIp(request);
        assertEquals("203.0.113.9", resolved.raw());
        assertEquals("203.0.113.9", resolved.bucketKey());
    }

    @Test
    void bracketedIpv6_normalizes() {
        assertEquals("0:0:0:0:0:0:0:1", ClientIpResolver.normalize("[::1]"));
    }

    @Test
    void invalidCidr_isIgnored() {
        ClientIpResolver resolver = new ClientIpResolver("999.1.1.1/33", 64);
        MockHttpServletRequest request = request("203.0.113.5", "198.51.100.9");
        assertEquals("203.0.113.5", resolver.resolve(request));
    }

    private static MockHttpServletRequest request(String remoteAddr, String forwardedFor) {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setRemoteAddr(remoteAddr);
        if (forwardedFor != null) {
            request.addHeader("X-Forwarded-For", forwardedFor);
        }
        return request;
    }
}
