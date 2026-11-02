package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.service.WakeDispatchService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * PLAN-0624 M4 (D24-10/15): the serial fan-out behind one wake round.
 *
 * <p>One single-thread executor per session guarantees the 0623 R4 order
 * ({@code session_participants.order_index}) without any locking. Continuation is driven by
 * {@link ChatRunTerminalizedEvent} — the existing terminal choke point — so "wait for
 * recipient i before i+1" never sleeps a thread blindly; the bounded wait (D24: 超时 failed
 * 续行, Q3) is a config key, not a constant.</p>
 *
 * <p>Runs on the caller's thread only until the first submission is queued; everything after
 * that lives on the session executor, so the user's POST /chat returns immediately.</p>
 */
@Service
public class WakeFanOutService {

    private static final Logger logger = LoggerFactory.getLogger(WakeFanOutService.class);
    static final long DEFAULT_WAIT_SECONDS = 600;

    private final WakeDispatchService wakeDispatchService;
    private final ConfigService configService;
    private final Map<String, CompletableFuture<Void>> terminalAwaiters = new ConcurrentHashMap<>();
    private final Map<UUID, ExecutorService> sessionExecutors = new ConcurrentHashMap<>();

    public WakeFanOutService(WakeDispatchService wakeDispatchService, ConfigService configService) {
        this.wakeDispatchService = wakeDispatchService;
        this.configService = configService;
    }

    /** Test/observer seam: is a terminal awaiter registered for this run right now. */
    boolean isAwaiting(String runId) {
        return terminalAwaiters.containsKey(runId);
    }

    /** Terminal choke point → complete every waiter (idempotent per listener contract). */
    @EventListener
    public void onRunTerminalized(ChatRunTerminalizedEvent event) {
        CompletableFuture<Void> awaiter = terminalAwaiters.remove(event.runId());
        if (awaiter != null) {
            awaiter.complete(null);
        }
    }

    /**
     * Parses {@code content} and fans the wake out serially over the resolved recipients.
     * {@code roster} must already be ordered by order_index (the caller sorts).
     */
    public void fanOut(UUID sessionId, String workspaceId, String userId, String rootRunId,
                       String content, List<MentionParser.RosterEntry> roster) {
        if (roster == null || roster.isEmpty()) {
            return;
        }
        MentionParser.ParseResult parsed = MentionParser.parse(content, roster);
        List<MentionParser.RosterEntry> recipients = parsed.all()
                ? roster.stream().filter(MentionParser.RosterEntry::enabled).toList()
                : parsed.mentions().stream()
                        .map(mention -> roster.stream()
                                .filter(entry -> entry.participantId().equals(mention.participantId()))
                                .findFirst().orElse(null))
                        .filter(entry -> entry != null && entry.enabled())
                        .toList();
        if (recipients.isEmpty() && parsed.unresolvedTokens().isEmpty()) {
            return;
        }
        String wakeRoundId = "wake:mention:" + rootRunId;
        executorFor(sessionId).submit(() -> runSerial(sessionId, wakeRoundId, recipients,
                parsed.unresolvedTokens()));
    }

    private void runSerial(UUID sessionId, String wakeRoundId,
                           List<MentionParser.RosterEntry> recipients,
                           List<String> unresolvedTokens) {
        for (String token : unresolvedTokens) {
            logger.info("[LIFECYCLE] service=cp event=wake_mention_unresolved sessionId={} "
                    + "token={} round={}", sessionId, token, wakeRoundId);
        }
        for (MentionParser.RosterEntry recipient : recipients) {
            WakeDispatchService.WakeFireResult result;
            try {
                result = wakeDispatchService.fire(recipient.participantId(), "mention",
                        wakeRoundId, sessionId);
            } catch (RuntimeException failure) {
                // Q3: one recipient's failure never aborts the round.
                logger.error("[LIFECYCLE] service=cp event=wake_recipient_failed sessionId={} "
                        + "participantId={} round={} failureType={}", sessionId,
                        recipient.participantId(), wakeRoundId, failure.getClass().getSimpleName(),
                        failure);
                continue;
            }
            if (result.dispatched() && result.runId() != null) {
                awaitTerminal(result.runId().toString(), waitSeconds());
            }
        }
    }

    /** Bounded wait for the run's terminal event; a timeout just logs (Q3 续行 already done). */
    private void awaitTerminal(String runId, long waitSeconds) {
        CompletableFuture<Void> awaiter = new CompletableFuture<>();
        terminalAwaiters.put(runId, awaiter);
        try {
            awaiter.get(waitSeconds, TimeUnit.SECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            logger.warn("[LIFECYCLE] service=cp event=wake_await_interrupted runId={}", runId);
        } catch (Exception timedOut) {
            logger.warn("[LIFECYCLE] service=cp event=wake_await_timeout runId={} waitSeconds={}",
                    runId, waitSeconds);
        } finally {
            terminalAwaiters.remove(runId, awaiter);
        }
    }

    private long waitSeconds() {
        try {
            String configured = configService == null ? null
                    : configService.resolve("agent-runtime", "wakeDispatchWaitSeconds", null, null);
            return configured == null ? DEFAULT_WAIT_SECONDS
                    : Math.max(1, Long.parseLong(configured.trim()));
        } catch (RuntimeException unreadable) {
            return DEFAULT_WAIT_SECONDS;
        }
    }

    private ExecutorService executorFor(UUID sessionId) {
        return sessionExecutors.computeIfAbsent(sessionId,
                key -> Executors.newSingleThreadExecutor(runnable -> {
                    Thread thread = new Thread(runnable, "wake-fanout-" + key);
                    thread.setDaemon(true);
                    return thread;
                }));
    }
}
