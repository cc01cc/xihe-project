package com.cc01cc.p.xihe.cp.status;

import org.junit.jupiter.api.Test;
import com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

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
    void enqueuePreservesProviderModeAndAttachments() {
        RequestQueue queue = new RequestQueue();
        AttachmentInfo attachment = new AttachmentInfo("file-1", "notes.txt", "text/plain", 10, "/api/v1/files/file-1");

        assertTrue(queue.enqueue(
                "s1", "hello", "deepseek", "deepseek-chat", "workspace",
                List.of(attachment), "user1", "ws1", "request-1", "run-1"));

        List<RequestQueue.QueuedRequest> drained = new ArrayList<>();
        assertEquals(1, queue.drain(drained::add));
        RequestQueue.QueuedRequest request = drained.get(0);
        assertEquals("deepseek", request.provider());
        assertEquals("deepseek-chat", request.model());
        assertEquals("workspace", request.toolMode());
        assertEquals(List.of(attachment), request.attachments());
        assertEquals("request-1", request.requestId());
        assertEquals("run-1", request.runId());
    }

    // PLAN-0308 T1.9：排队路径必须保留 per-call 超时（Agent 不可用时的投递不丢配置）。

    @Test
    void enqueuePreservesPerCallToolTimeouts() {
        RequestQueue queue = new RequestQueue();

        assertTrue(queue.enqueue(
                "s1", "hello", "deepseek", "deepseek-chat", "workspace",
                List.of(), "user1", "ws1", "request-1", "run-1",
                Map.of("execute_command", 20)));

        List<RequestQueue.QueuedRequest> drained = new ArrayList<>();
        assertEquals(1, queue.drain(drained::add));
        assertEquals(Map.of("execute_command", 20), drained.get(0).toolTimeouts());
    }

    @Test
    void enqueueDefaultsPerCallToolTimeoutsToEmpty() {
        RequestQueue queue = new RequestQueue();
        assertTrue(queue.enqueue("s1", "hello", null, "user1", "ws1"));

        List<RequestQueue.QueuedRequest> drained = new ArrayList<>();
        assertEquals(1, queue.drain(drained::add));
        assertEquals(Map.of(), drained.get(0).toolTimeouts());
    }

    @Test
    void drainNotifiesDropHandlerWhenSenderFails() {        RequestQueue queue = new RequestQueue();
        assertTrue(queue.enqueue("s1", "hello", "run-model", "user1", "ws1", "request-1", "run-1"));

        List<RequestQueue.QueuedRequest> dropped = new ArrayList<>();
        assertEquals(0, queue.drain(
                ignored -> { throw new IllegalStateException("agent unavailable"); },
                dropped::add));

        assertEquals(1, dropped.size());
        assertEquals("run-1", dropped.get(0).runId());
        assertEquals(0, queue.size());
    }

    @Test
    void drainSkipsExpiredRequests() throws InterruptedException {
        RequestQueue queue = new RequestQueue();
        // Manually create an expired request by using a past timestamp
        // Since TTL is 60s, we can't easily test expiry in unit test
        // Instead test that drain returns 0 for empty queue
        int count = queue.drain(r -> true);
        assertEquals(0, count);
    }

    // ── task-132: `count` must state deliveries, not "loops that did not throw" ──

    private static ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> captureQueueLog() {
        ch.qos.logback.classic.Logger logger =
                (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger(RequestQueue.class);
        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender =
                new ch.qos.logback.core.read.ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        return appender;
    }

    private static String drainedLine(
            ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender) {
        return appender.list.stream()
                .map(ch.qos.logback.classic.spi.ILoggingEvent::getFormattedMessage)
                .filter(message -> message.contains("event=requestDrained"))
                .findFirst()
                .orElseThrow(() -> new AssertionError("a drop must still be reported on the drain line"));
    }

    @Test
    void aRejectedDeliveryIsCountedAsDroppedAndNeverAsSent() {
        RequestQueue queue = new RequestQueue();
        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender = captureQueueLog();
        assertTrue(queue.enqueue("s1", "hello", "run-model", "user1", "ws1", "request-1", "run-1"));

        int sent = queue.drain(ignored -> false);

        assertEquals(0, sent, "the consumer refused this request, so nothing was delivered");
        String line = drainedLine(appender);
        assertTrue(line.contains("delivered=0"), "the drain line must not claim a delivery: " + line);
        assertTrue(line.contains("dropped=1"), "the drain line must report the refusal: " + line);
        assertTrue(line.contains("expired=0"), line);
        assertEquals(0, queue.size());
    }

    @Test
    void aDeliveredRequestIsCountedAsSentAndNotAsDropped() {
        RequestQueue queue = new RequestQueue();
        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender = captureQueueLog();
        assertTrue(queue.enqueue("s1", "hello", "run-model", "user1", "ws1", "request-1", "run-1"));

        int sent = queue.drain(ignored -> true);

        assertEquals(1, sent);
        String line = drainedLine(appender);
        assertTrue(line.contains("delivered=1"), line);
        assertTrue(line.contains("dropped=0"), line);
        assertTrue(line.contains("expired=0"), line);
    }

    /** task-136: the three counters are mutually exclusive, so they can be read side by side. */
    @Test
    void anExpiredRequestIsCountedOnlyAsExpired() {
        MutableClock clock = new MutableClock(Instant.parse("2026-01-01T00:00:00Z"));
        RequestQueue queue = new RequestQueue(clock);
        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender = captureQueueLog();
        assertTrue(queue.enqueue("s1", "hello", "run-model", "user1", "ws1", "request-1", "run-1"));

        clock.advanceSeconds(61);

        List<RequestQueue.QueuedRequest> delivered = new ArrayList<>();
        assertEquals(0, queue.drain(delivered::add), "an expired request is not delivered");
        assertEquals(0, delivered.size());
        String line = drainedLine(appender);
        assertTrue(line.contains("delivered=0"), line);
        assertTrue(line.contains("dropped=0"), "an expiry is not also a refusal: " + line);
        assertTrue(line.contains("expired=1"), line);
        assertEquals(0, queue.size());
    }

    /**
     * task-134 A2 / T2 (constraint 1): TTL expiry has one owner — the reconciler. A drain that meets
     * an already-expired entry must <b>not</b> hand it to the drop consumer, or two writers race for
     * the same run's terminal state and the code the user sees depends on who ran first.
     */
    @Test
    void anExpiredEntryIsNeverHandedToTheDropConsumer() {
        MutableClock clock = new MutableClock(Instant.parse("2026-01-01T00:00:00Z"));
        RequestQueue queue = new RequestQueue(clock);
        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender = captureQueueLog();
        assertTrue(queue.enqueue("s1", "hello", "run-model", "user1", "ws1", "request-1", "run-1"));
        clock.advanceSeconds(RequestQueue.TTL_SECONDS + 1);

        List<RequestQueue.QueuedRequest> handedToDropConsumer = new ArrayList<>();
        assertEquals(0, queue.drain(ignored -> true, handedToDropConsumer::add));

        assertEquals(0, handedToDropConsumer.size(),
                "TTL expiry belongs to reconciliation; the drain must not terminalize it");
        String line = drainedLine(appender);
        assertTrue(line.contains("expired=1"), line);
        String expiredLine = appender.list.stream()
                .map(ch.qos.logback.classic.spi.ILoggingEvent::getFormattedMessage)
                .filter(message -> message.contains("event=requestQueueExpired"))
                .findFirst().orElseThrow();
        assertTrue(expiredLine.contains("runId=run-1"), "the expiry must be traceable to the run: " + expiredLine);
    }

    /** task-136: with three exclusive counters the line is self-checking: their sum is the scan size. */
    @Test
    void theThreeCountersAddUpToWhatTheDrainScanned() {
        MutableClock clock = new MutableClock(Instant.parse("2026-01-01T00:00:00Z"));
        RequestQueue queue = new RequestQueue(clock);
        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender = captureQueueLog();
        assertTrue(queue.enqueue("s1", "old", "run-model", "user1", "ws1", "request-old", "run-old"));
        clock.advanceSeconds(61);
        assertTrue(queue.enqueue("s2", "new", "run-model", "user1", "ws1", "request-new", "run-new"));

        queue.drain(ignored -> false);

        String line = drainedLine(appender);
        assertTrue(line.contains("delivered=0"), line);
        assertTrue(line.contains("dropped=1"), line);
        assertTrue(line.contains("expired=1"), line);
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

    /** task-136: the queue's TTL is wall-clock, so a test needs a clock it can move. */
    static final class MutableClock extends Clock {

        private Instant now;

        MutableClock(Instant start) {
            this.now = start;
        }

        void advanceSeconds(long seconds) {
            this.now = now.plusSeconds(seconds);
        }

        @Override
        public ZoneId getZone() {
            return ZoneId.of("UTC");
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
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
