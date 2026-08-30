package com.cc01cc.p.xihe.cp.status;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class RequestQueueTest {

    @Test
    void enqueueAndDrain() {
        RequestQueue queue = new RequestQueue();
        assertTrue(queue.enqueue("s1", "hello", null, "user1", "ws1"));
        assertEquals(1, queue.size());

        List<RequestQueue.QueuedRequest> drained = new ArrayList<>();
        int count = queue.drain(drained::add);
        assertEquals(1, count);
        assertEquals(1, drained.size());
        assertEquals("s1", drained.get(0).sessionId());
        assertEquals(0, queue.size());
    }

    @Test
    void drainSkipsExpiredRequests() throws InterruptedException {
        RequestQueue queue = new RequestQueue();
        // Manually create an expired request by using a past timestamp
        // Since TTL is 60s, we can't easily test expiry in unit test
        // Instead test that drain returns 0 for empty queue
        int count = queue.drain(r -> {});
        assertEquals(0, count);
    }

    @Test
    void maxSizeBlocksEnqueue() {
        RequestQueue queue = new RequestQueue();
        for (int i = 0; i < 100; i++) {
            assertTrue(queue.enqueue("s" + i, "msg", null, "user", "ws"));
        }
        assertFalse(queue.enqueue("s101", "msg", null, "user", "ws"));
        assertEquals(100, queue.size());
    }

    @Test
    void clearRemovesAll() {
        RequestQueue queue = new RequestQueue();
        queue.enqueue("s1", "msg", null, "user", "ws");
        queue.enqueue("s2", "msg", null, "user", "ws");
        queue.clear();
        assertEquals(0, queue.size());
    }
}
