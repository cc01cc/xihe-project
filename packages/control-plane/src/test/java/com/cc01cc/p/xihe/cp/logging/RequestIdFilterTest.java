package com.cc01cc.p.xihe.cp.logging;

import org.junit.jupiter.api.Test;
import org.slf4j.MDC;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;

import java.io.IOException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

class RequestIdFilterTest {

    @Test
    void generatesRequestIdWhenAbsent() throws Exception {
        RequestIdFilter filter = new RequestIdFilter();
        MockHttpServletRequest request = new MockHttpServletRequest();
        MockHttpServletResponse response = new MockHttpServletResponse();
        String[] seen = new String[1];
        FilterChain chain = (ServletRequest req, ServletResponse res) -> {
            seen[0] = MDC.get(RequestIdFilter.MDC_KEY);
        };
        filter.doFilter(request, response, chain);
        assertNotNull(seen[0]);
        assertEquals(seen[0], response.getHeader(RequestIdFilter.HEADER));
        assertNull(MDC.get(RequestIdFilter.MDC_KEY));
    }

    @Test
    void propagatesInboundRequestId() throws Exception {
        RequestIdFilter filter = new RequestIdFilter();
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.addHeader(RequestIdFilter.HEADER, "req-abc-123");
        MockHttpServletResponse response = new MockHttpServletResponse();
        String[] seen = new String[1];
        FilterChain chain = (ServletRequest req, ServletResponse res) -> {
            seen[0] = MDC.get(RequestIdFilter.MDC_KEY);
        };
        filter.doFilter(request, response, chain);
        assertEquals("req-abc-123", seen[0]);
        assertEquals("req-abc-123", response.getHeader(RequestIdFilter.HEADER));
    }

    @Test
    void rejectsOversizedInboundId() throws Exception {
        RequestIdFilter filter = new RequestIdFilter();
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.addHeader(RequestIdFilter.HEADER, "x".repeat(200));
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = (ServletRequest req, ServletResponse res) -> {
        };
        filter.doFilter(request, response, chain);
        String header = response.getHeader(RequestIdFilter.HEADER);
        assertNotNull(header);
        assertEquals(36, header.length());
    }
}
