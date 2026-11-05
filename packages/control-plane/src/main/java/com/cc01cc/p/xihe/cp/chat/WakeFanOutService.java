package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.service.WakeDispatchService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
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
    static final long DEFAULT_WAIT_SECONDS = 60;
    /**
     * Same durable event name WakeDispatchService audits wake outcomes under (its constant is
     * package-private in {@code service}); a cc notify deliberately reuses the envelope —
     * {@code triggerSource="cc", outcome="notify"} — instead of inventing a second event type.
     */
    static final String EVENT_WAKE_DISPATCH = "wake_dispatch";

    private final WakeDispatchService wakeDispatchService;
    private final ConfigService configService;
    /** PLAN-0630 M5b: cc observer notifications; {@code null} in the legacy 2-arg construction. */
    private final EventStoreService eventStoreService;
    private final Map<String, CompletableFuture<Void>> terminalAwaiters = new ConcurrentHashMap<>();
    /** PLAN-0648 task-34: shared dispatch pool (replaces the per-session single thread). */
    private static final java.util.concurrent.ExecutorService WAKE_POOL =
            java.util.concurrent.Executors.newFixedThreadPool(4, runnable -> {
                Thread thread = new Thread(runnable, "wake-fanout");
                thread.setDaemon(true);
                return thread;
            });
    /**
     * Observability-only workers: each wake-run observation gets its own thread, so one slow run can
     * never delay the observation (or the log line) of another. These threads never dispatch.
     */
    private static final java.util.concurrent.ExecutorService OBSERVER =
            java.util.concurrent.Executors.newCachedThreadPool(runnable -> {
                Thread thread = new Thread(runnable, "wake-observer");
                thread.setDaemon(true);
                return thread;
            });
    /** A round that waited longer than this in the pool is worth a log line (never silent). */
    private static final long QUEUE_WAIT_LOG_THRESHOLD_MS = 200;

    /** Optional: lets the awaiter see a run that already finished (tests may leave it null). */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private ChatRunStatusReadService chatRunStatus;

    /** PLAN-0660 T5.5: user-channel hint target and the participant lookup it needs (both optional). */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private com.cc01cc.p.xihe.cp.event.UserChannelPort userChannel;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository participantRepository;

    /** Legacy test seam (WakeFanOutServiceTest builds with dispatch + config only). */
    public WakeFanOutService(WakeDispatchService wakeDispatchService, ConfigService configService) {
        this(wakeDispatchService, configService, null);
    }

    /**
     * PLAN-0660 T5.3: the cc notify no longer touches a cursor — unread is derived from
     * {@code wake_dispatch ∧ outcome=notify ∧ sequence > last_read_event_seq}
     * (`spec/session/user-channel.md` §3). The 4-arg shape drops its cursor repository with it.
     */
    @Autowired
    public WakeFanOutService(WakeDispatchService wakeDispatchService, ConfigService configService,
                             EventStoreService eventStoreService) {
        this.wakeDispatchService = wakeDispatchService;
        this.configService = configService;
        this.eventStoreService = eventStoreService;
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
    public WakeHandoff fanOut(UUID sessionId, String workspaceId, String userId, String rootRunId,
                              String content, List<MentionParser.RosterEntry> roster) {
        return fanOut(sessionId, workspaceId, userId, rootRunId, content, roster, null);
    }

    /**
     * PLAN-0630 M5b (D30-14): the composer's optional {@code cc} observer list rides the same
     * wake round. Semantics = 旁听名单: an observer gets the durable notify signal
     * ({@code wake_dispatch} outcome {@code notify}) — which advances the participant's
     * <b>derived</b> unread count (V112 dropped the {@code mention_count} column; the count is
     * re-derived from these events past the read pointer), the same signal a human mention
     * produces — but <b>never a Run</b>; an agent observer still answers when actually
     * {@code @}-mentioned (WHEN_MENTIONED equivalent), which the mention fan-out above already
     * handles. Observers already woken as mention recipients this round are not notified twice.
     */
    public WakeHandoff fanOut(UUID sessionId, String workspaceId, String userId, String rootRunId,
                              String content, List<MentionParser.RosterEntry> roster,
                              List<UUID> ccParticipantIds) {
        return fanOut(sessionId, workspaceId, userId, rootRunId, content, roster, ccParticipantIds, null);
    }

    /**
     * PLAN-0665 M1: a TO request owns its targets. When the same participant is both {@code @}-mentioned
     * and TO-selected, the TO path must be the only one that creates a run — otherwise one message
     * would produce two runs for one participant and {@code runIds[] + failedTargets[]} would no
     * longer add up to the requested target count. The mention round therefore skips TO targets.
     */
    public WakeHandoff fanOut(UUID sessionId, String workspaceId, String userId, String rootRunId,
                              String content, List<MentionParser.RosterEntry> roster,
                              List<UUID> ccParticipantIds, Set<UUID> skipParticipantIds) {
        // PLAN-0648 task-33: every branch of this method reports what it did. The suppression path
        // promises a hand-off ("I do not answer" must never mean "nobody answers"), so a round that
        // silently finds nothing is a lost message — it used to be unobservable, which is exactly how
        // the as=PRIMARY rounds of session e1d08857 lost their wake with no trace at all.
        if (roster == null || roster.isEmpty()) {
            logger.warn("[LIFECYCLE] service=cp event=wake_handoff_skipped sessionId={} round={} "
                            + "reason=empty_roster rosterSize=0",
                    sessionId, "wake:mention:" + rootRunId);
            return WakeHandoff.skipped("empty_roster");
        }
        MentionParser.ParseResult parsed = MentionParser.parse(content, roster);
        Set<UUID> skip = skipParticipantIds == null ? Set.of() : skipParticipantIds;
        List<MentionParser.RosterEntry> recipients = (parsed.all()
                ? roster.stream().filter(MentionParser.RosterEntry::enabled).toList()
                : parsed.mentions().stream()
                        .map(mention -> roster.stream()
                                .filter(entry -> entry.participantId().equals(mention.participantId()))
                                .findFirst().orElse(null))
                        .filter(entry -> entry != null && entry.enabled())
                        .toList())
                .stream()
                .filter(entry -> !skip.contains(entry.participantId()))
                .toList();
        List<MentionParser.RosterEntry> ccObservers = resolveCcObservers(sessionId, ccParticipantIds,
                roster, recipients).stream()
                .filter(entry -> !skip.contains(entry.participantId()))
                .toList();
        String wakeRoundId = "wake:mention:" + rootRunId;
        if (recipients.isEmpty() && parsed.unresolvedTokens().isEmpty() && ccObservers.isEmpty()) {
            logger.warn("[LIFECYCLE] service=cp event=wake_handoff_skipped sessionId={} round={} "
                            + "reason=no_recipients rosterSize={} contentLength={}",
                    sessionId, wakeRoundId, roster.size(),
                    content == null ? 0 : content.length());
            return WakeHandoff.skipped("no_recipients");
        }
        // PLAN-0648 task-34: rounds are independent messages, so a slow round must never starve the
        // next one. The per-session single-thread executor used to serialize *rounds* (and then
        // blocked inside the round on a terminal wait), which is exactly how three hand-offs ended
        // with one drain. Ordering stays inside the round (runSerial fires recipients in order).
        long enqueuedAt = System.currentTimeMillis();
        wakePool().submit(() -> {
            long waitedMs = System.currentTimeMillis() - enqueuedAt;
            if (waitedMs > QUEUE_WAIT_LOG_THRESHOLD_MS) {
                logger.warn("[LIFECYCLE] service=cp event=wake_handoff_queued sessionId={} round={} waitMs={}",
                        sessionId, wakeRoundId, waitedMs);
            }
            runSerial(sessionId, workspaceId, userId, wakeRoundId, recipients,
                    parsed.unresolvedTokens(), ccObservers, content);
        });
        logger.info("[LIFECYCLE] service=cp event=wake_handoff_enqueued sessionId={} round={} "
                        + "recipients={} ccObservers={} unresolved={}",
                sessionId, wakeRoundId, recipients.size(), ccObservers.size(),
                parsed.unresolvedTokens().size());
        return WakeHandoff.enqueued(wakeRoundId, recipients.size(), ccObservers.size());
    }

    /**
     * PLAN-0665 M1 (D1 a'): the <b>single</b> entry for explicit TO targets. A one-element and an
     * N-element selection both go through this method — the only difference is the target-set size,
     * so the single-TO and multi-TO paths cannot drift (Lead's hard requirement).
     *
     * <p>Unlike {@link #fanOut} (fire-and-forget, mention/cc round), the runs here are created
     * <b>synchronously in the caller's thread</b> and in selection order, because the caller has to
     * answer {@code runIds[]} (Q1: {@code runId = runIds[0]}). Each target's audit rides the existing
     * {@code wake_dispatch} envelope with {@code triggerSource="to"}; {@code parent_run_id} stays
     * NULL on purpose — it carries delegation-chain semantics (Q2), and fan-out targets are siblings
     * of one user submission, not delegates.</p>
     *
     * <p><b>Never silent (2026-11-05 real-stack finding)</b>: a target that cannot be dispatched is
     * returned in {@link TargetedWake#failedTargets()} and logged at ERROR, so the caller can report
     * it in the 202 body. A DB constraint violation here used to be swallowed into a dropped log line
     * while the response still looked complete — {@code runIds.size() + failedTargets.size() +
     * deferredTargets.size()} must always equal the requested target count (BL-283 split "queued"
     * out of "failed").</p>
     */
    public TargetedWake targetedFanOut(UUID sessionId, String workspaceId, String userId,
                                       String rootRunId, String content,
                                       List<UUID> targetParticipantIds) {
        if (targetParticipantIds == null || targetParticipantIds.isEmpty()) {
            return new TargetedWake(List.of(), List.of(), List.of(), 0);
        }
        String wakeRoundId = "wake:to:" + rootRunId;
        List<UUID> runIds = new ArrayList<>();
        List<TargetedFailure> failedTargets = new ArrayList<>();
        List<TargetedFailure> deferredTargets = new ArrayList<>();
        for (UUID participantId : targetParticipantIds) {
            WakeDispatchService.WakeFireResult result;
            try {
                // Column value "user" (a TO target run IS user-triggered; chat_runs.trigger_source
                // CHECK only allows user/mention/schedule/judge/guard/chain), audit label "to".
                result = wakeDispatchService.fire(participantId, "user", "to", wakeRoundId, sessionId,
                        null, content);
            } catch (RuntimeException failure) {
                // Q3 (task-34 invariant): one target's failure never aborts the fan-out round, but it
                // is never silent either — the caller reports it as failedTargets[].
                failedTargets.add(new TargetedFailure(participantId.toString(),
                        failure.getClass().getSimpleName()));
                logger.error("[LIFECYCLE] service=cp event=to_target_dispatch_failed sessionId={} "
                                + "targetParticipantId={} round={} reason={} runIds={}", sessionId,
                        participantId, wakeRoundId, failure.getClass().getSimpleName(), runIds, failure);
                continue;
            }
            if (result.dispatched() && result.runId() != null) {
                runIds.add(result.runId());
                observeTerminalAsync(result.runId().toString(), waitSeconds());
            } else {
                // BL-283 (Lead ruling 2026-11-05): deferred is QUEUED, not failed. The target has a
                // follow-up item waiting for a slot, so it belongs in deferredTargets[] — counting it
                // as a failure made "concurrency full" indistinguishable from a real dispatch error.
                String reason = result.outcome() == null ? "not_dispatched" : result.outcome();
                if ("deferred".equals(reason)) {
                    deferredTargets.add(new TargetedFailure(participantId.toString(), reason));
                    logger.info("[LIFECYCLE] service=cp event=to_target_deferred sessionId={} "
                                    + "targetParticipantId={} round={} runIds={}", sessionId,
                            participantId, wakeRoundId, runIds);
                } else {
                    failedTargets.add(new TargetedFailure(participantId.toString(), reason));
                    logger.error("[LIFECYCLE] service=cp event=to_target_dispatch_failed sessionId={} "
                                    + "targetParticipantId={} round={} reason={} runIds={}", sessionId,
                            participantId, wakeRoundId, reason, runIds);
                }
            }
        }
        logger.info("[LIFECYCLE] service=cp event=wake_to_handoff sessionId={} round={} targets={} "
                        + "dispatched={} deferred={} failed={}", sessionId, wakeRoundId,
                targetParticipantIds.size(), runIds.size(), deferredTargets.size(), failedTargets.size());
        return new TargetedWake(List.copyOf(runIds), List.copyOf(failedTargets),
                List.copyOf(deferredTargets), targetParticipantIds.size());
    }

    /**
     * What one explicit TO fan-out did: the created run ids, in selection order (Q1 {@code runIds[]}),
     * and the targets that could not be dispatched (runtime failures — pre-validation failures reject
     * the whole request instead).
     */
    public record TargetedWake(List<UUID> runIds, List<TargetedFailure> failedTargets,
                               List<TargetedFailure> deferredTargets, int targets) {
        public TargetedWake {
            runIds = List.copyOf(runIds);
            failedTargets = List.copyOf(failedTargets);
            deferredTargets = List.copyOf(deferredTargets);
        }

        /**
         * Total targets accounted for: every requested target is exactly one of "dispatched (run)",
         * "queued (deferred)" or "failed" — BL-283 made deferred a first-class outcome, so the
         * conservation invariant is {@code runIds + failedTargets + deferredTargets == targets}.
         */
        public int accounted() {
            return runIds.size() + failedTargets.size() + deferredTargets.size();
        }
    }

    /** One TO target that did not get a run: {@code reason} is the outcome/exception simple name. */
    public record TargetedFailure(String participantId, String reason) {}

    /**
     * What one fan-out did. Callers on the suppression path assert {@code enqueued} so a message
     * that nobody will answer cannot be committed silently.
     */
    public record WakeHandoff(boolean enqueued, String roundId, int recipients, int ccObservers,
                              String skipReason) {

        static WakeHandoff enqueued(String roundId, int recipients, int ccObservers) {
            return new WakeHandoff(true, roundId, recipients, ccObservers, null);
        }

        static WakeHandoff skipped(String reason) {
            return new WakeHandoff(false, null, 0, 0, reason);
        }
    }

    /**
     * Resolves the caller-supplied cc ids against the roster, fail-closed the same way
     * {@link MentionParser} treats tokens: an id that is not an enabled session participant
     * is logged and ignored — the fan-out never guesses, and a disabled member can never be
     * notified. Duplicates and mention recipients of the same round are dropped.
     */
    private List<MentionParser.RosterEntry> resolveCcObservers(UUID sessionId, List<UUID> ccParticipantIds,
            List<MentionParser.RosterEntry> roster, List<MentionParser.RosterEntry> mentionRecipients) {
        if (ccParticipantIds == null || ccParticipantIds.isEmpty()) {
            return List.of();
        }
        Set<UUID> alreadyWoken = new HashSet<>();
        for (MentionParser.RosterEntry recipient : mentionRecipients) {
            alreadyWoken.add(recipient.participantId());
        }
        Map<UUID, MentionParser.RosterEntry> byId = new LinkedHashMap<>();
        for (MentionParser.RosterEntry entry : roster) {
            byId.putIfAbsent(entry.participantId(), entry);
        }
        List<MentionParser.RosterEntry> observers = new ArrayList<>();
        Set<UUID> seen = new HashSet<>();
        for (UUID participantId : ccParticipantIds) {
            if (participantId == null || !seen.add(participantId) || alreadyWoken.contains(participantId)) {
                continue;
            }
            MentionParser.RosterEntry entry = byId.get(participantId);
            if (entry == null) {
                logger.warn("[LIFECYCLE] service=cp event=wake_dispatch triggerSource=cc "
                                + "outcome=ignored reason=not_in_roster sessionId={} participantId={}",
                        sessionId, participantId);
                continue;
            }
            if (!entry.enabled()) {
                logger.info("[LIFECYCLE] service=cp event=wake_dispatch triggerSource=cc "
                                + "outcome=ignored reason=disabled sessionId={} participantId={}",
                        sessionId, participantId);
                continue;
            }
            observers.add(entry);
        }
        return observers;
    }

    private void runSerial(UUID sessionId, String workspaceId, String userId, String wakeRoundId,
                           List<MentionParser.RosterEntry> recipients,
                           List<String> unresolvedTokens,
                           List<MentionParser.RosterEntry> ccObservers,
                           String triggeringContent) {
        for (String token : unresolvedTokens) {
            logger.info("[LIFECYCLE] service=cp event=wake_mention_unresolved sessionId={} "
                    + "token={} round={}", sessionId, token, wakeRoundId);
        }
        int started = 0;
        int deferred = 0;
        int dropped = 0;
        for (MentionParser.RosterEntry recipient : recipients) {
            WakeDispatchService.WakeFireResult result;
            try {
                // PLAN-0648 task-31 (P0): the woken agent needs the message that woke it.
                result = wakeDispatchService.fire(recipient.participantId(), "mention",
                        wakeRoundId, sessionId, null, triggeringContent);
            } catch (RuntimeException failure) {
                // Q3: one recipient's failure never aborts the round — but it is never silent either:
                // every hand-off must end as started / deferred / dropped (task-34 invariant).
                dropped++;
                logger.error("[LIFECYCLE] service=cp event=wake_handoff_dropped sessionId={} "
                        + "participantId={} round={} reason={}", sessionId, recipient.participantId(),
                        wakeRoundId, failure.getClass().getSimpleName(), failure);
                continue;
            }
            if (result.dispatched() && result.runId() != null) {
                started++;
                // PLAN-0648 task-34: dispatching and waiting are different jobs. `runSerial` fires
                // the next recipient immediately; the terminal observation runs on its own thread and
                // only produces log lines. Blocking here (600 s default, completion source that never
                // fired) is what starved every later round of the session.
                observeTerminalAsync(result.runId().toString(), waitSeconds());
            } else {
                deferred++;
                logger.info("[LIFECYCLE] service=cp event=wake_handoff_deferred sessionId={} "
                                + "participantId={} round={} reason={}", sessionId,
                        recipient.participantId(), wakeRoundId, result.outcome());
            }
        }
        lastRound = new WakeRoundStats(wakeRoundId, recipients.size(), recipients.size(), started,
                deferred, dropped, unresolvedTokens.size(), ccObservers.size());
        logger.info("[LIFECYCLE] service=cp event=wake_handoff_completed sessionId={} round={} "
                        + "recipients={} started={} deferred={} dropped={} unresolved={} cc={}",
                sessionId, wakeRoundId, recipients.size(), started, deferred, dropped,
                unresolvedTokens.size(), ccObservers.size());
        for (MentionParser.RosterEntry observer : ccObservers) {
            try {
                notifyObserver(sessionId, workspaceId, userId, wakeRoundId, observer);
            } catch (RuntimeException failure) {
                // Q3: a failed notification never aborts the round either. Same frozen event name as
                // every other cc outcome; the failure is the `failed` outcome, not a new event.
                logger.error("[LIFECYCLE] service=cp event=wake_dispatch triggerSource=cc "
                                + "outcome=failed sessionId={} participantId={} round={} failureType={}",
                        sessionId, observer.participantId(), wakeRoundId,
                        failure.getClass().getSimpleName(), failure);
            }
        }
    }

    /**
     * PLAN-0630 M5b: the cc notify — durable {@code wake_dispatch} outcome {@code notify}
     * (fields mirror {@code WakeDispatchService}'s audit envelope: wakeRoundId, participantId,
     * triggerSource, outcome). No Run is created and nothing speaks as the observer.
     *
     * <p>PLAN-0660 T5.3: the cursor advance is gone on purpose — the "@N" unread badge is a
     * derived value (`spec/session/user-channel.md` §3), so this path only records the notify.</p>
     *
     * <p>PLAN-0660 T5.5: after the durable row, push the minimal hint
     * `{sessionId, participantId}` to the observer's own user channel (§4). Both collaborators are
     * optional — without them this method behaves exactly as before; a push failure is logged with an
     * incrementable event name and never retried on the dispatch path.</p>
     */
    private void notifyObserver(UUID sessionId, String workspaceId, String userId, String wakeRoundId,
                                MentionParser.RosterEntry observer) {
        if (eventStoreService != null) {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("wakeRoundId", wakeRoundId);
            payload.put("participantId", observer.participantId().toString());
            payload.put("triggerSource", "cc");
            payload.put("outcome", "notify");
            eventStoreService.append(sessionId.toString(), workspaceId, userId, EVENT_WAKE_DISPATCH, payload);
        }
        pushObserverHint(sessionId, observer);
        logger.info("[LIFECYCLE] service=cp event=wake_dispatch triggerSource=cc outcome=notify "
                        + "sessionId={} participantId={} round={}",
                sessionId, observer.participantId(), wakeRoundId);
    }

    /**
     * T5.5 seam: resolve the observer's principal (the roster entry carries no principal id) and push
     * the hint. No-op when the user channel or the participant lookup is absent.
     */
    private void pushObserverHint(UUID sessionId, MentionParser.RosterEntry observer) {
        if (userChannel == null || participantRepository == null) {
            return;
        }
        participantRepository.findById(observer.participantId()).ifPresent(row -> {
            if (row.getPrincipalId() == null) {
                return;
            }
            try {
                userChannel.participantNotified(row.getPrincipalId().toString(),
                        sessionId.toString(), row.getId().toString());
            } catch (RuntimeException failure) {
                logger.warn("[LIFECYCLE] service=cp event=user_channel_push_failed userId={} "
                                + "reason={} sessionId={}", row.getPrincipalId(),
                        failure.getClass().getSimpleName(), sessionId);
            }
        });
    }

    /**
     * PLAN-0648 task-34: the run may already be terminal when we start waiting (a fast answer, or the
     * terminal event published before this registration). Reading the row first turns that race into
     * a no-op instead of a full timeout — the timeout itself is only observability now, never the
     * ordering mechanism.
     */
    private boolean alreadyTerminal(String runId) {
        if (chatRunStatus == null) {
            return false;
        }
        try {
            return chatRunStatus.findById(UUID.fromString(runId))
                    .map(view -> isTerminalStatus(view.status()))
                    .orElse(false);
        } catch (RuntimeException unreadable) {
            return false;
        }
    }

    private static boolean isTerminalStatus(String status) {
        return status != null && (status.equals("succeeded") || status.equals("failed")
                || status.equals("partial") || status.equals("ambiguous") || status.equals("cancelled"));
    }

    /** Last finished round's counters: enqueued == started + deferred + dropped (task-34 invariant). */
    record WakeRoundStats(String roundId, int enqueued, int recipients, int started, int deferred,
                          int dropped, int unresolved, int ccObservers) {
        boolean balanced() {
            return enqueued == started + deferred + dropped;
        }
    }

    private volatile WakeRoundStats lastRound;

    /** Package-private read seam for the invariant assertion (no production caller). */
    WakeRoundStats lastRoundStats() {
        return lastRound;
    }

    /**
     * PLAN-0648 task-34: observation only. A single observer thread per process drains these waits,
     * so a slow run can never occupy a fan-out thread; each wait logs its own outcome, including the
     * structured timeout line, so "did the woken run ever finish" is answerable from logs alone.
     */
    private void observeTerminalAsync(String runId, long waitSeconds) {
        OBSERVER.submit(() -> {
            try {
                awaitTerminal(runId, waitSeconds);
            } catch (RuntimeException observerFailed) {
                logger.warn("[LIFECYCLE] service=cp event=wake_observe_failed runId={} reason={}",
                        runId, observerFailed.getClass().getSimpleName());
            }
        });
    }

    /** Bounded wait for the run's terminal event; a timeout only logs (dispatching already happened). */
    private void awaitTerminal(String runId, long waitSeconds) {
        if (alreadyTerminal(runId)) {
            logger.info("[LIFECYCLE] service=cp event=wake_await_already_terminal runId={}", runId);
            return;
        }
        CompletableFuture<Void> awaiter = new CompletableFuture<>();
        terminalAwaiters.put(runId, awaiter);
        // Close the register/finish race: an event published between fire() and the put above would
        // otherwise be missed and we would block for the whole timeout.
        if (alreadyTerminal(runId)) {
            terminalAwaiters.remove(runId, awaiter);
            logger.info("[LIFECYCLE] service=cp event=wake_await_raced_terminal runId={}", runId);
            return;
        }
        try {
            awaiter.get(waitSeconds, TimeUnit.SECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            logger.warn("[LIFECYCLE] service=cp event=wake_await_interrupted runId={}", runId);
        } catch (Exception timedOut) {
            logger.warn("[LIFECYCLE] service=cp event=wake_await_timeout runId={} waitSeconds={} "
                    + "reason=no_terminal_event", runId, waitSeconds);
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

    /**
     * PLAN-0648 task-34: one shared pool for every round. Rounds are independent (each carries its
     * own message), so they must not queue behind each other; ordering inside a round is kept by the
     * sequential loop in runSerial. Bounded so a wedged round cannot spawn threads without limit,
     * and daemon so shutdown never waits on an in-flight wake.
     */
    private static java.util.concurrent.ExecutorService wakePool() {
        return WAKE_POOL;
    }
}
