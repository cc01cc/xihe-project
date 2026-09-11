package com.cc01cc.p.xihe.cp.mcp;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import java.lang.reflect.Field;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest
class McpForwardTimeoutTest {

    @Autowired
    private McpProxyController controller;

    private long forwardTimeout() throws Exception {
        Field f = McpProxyController.class.getDeclaredField("forwardTimeoutS");
        f.setAccessible(true);
        return f.getLong(controller);
    }

    @Test
    void forwardTimeoutDefaultsTo30() throws Exception {
        // PLAN-301 M1: forward-hop timeout defaults to 30s and is
        // independently configurable via xihe.mcp.forward-timeout-s.
        assertThat(forwardTimeout()).isEqualTo(30L);
    }

    @Test
    void forwardTimeoutIsNonZero() throws Exception {
        // fail-closed sanity: the bound exists (never an unbounded wait).
        assertThat(forwardTimeout()).isGreaterThan(0L);
    }
}
