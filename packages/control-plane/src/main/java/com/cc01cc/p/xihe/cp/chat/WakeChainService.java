package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.service.SessionParticipantService;
import com.cc01cc.p.xihe.cp.service.WakeDispatchService;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.UUID;

/**
 * PLAN-0624 M3 (D24): wake-chain detection on agent output.
 *
 * <p>Single choke point: {@code ChatSubmissionService.persistAssistantResponse} forwards every
 * assistant text here. Mentions found in an agent's output wake the next link — through the
 * SAME {@link WakeDispatchService#fire} as mentions and schedules (one entry, three triggers),
 * guarded by {@link WakeChainRegistry}:</p>
 *
 * <ul>
 *   <li>depth: user message = 0, first woken agent = 1; {@code agent-runtime.wakeChainMaxDepth}
 *       (default 3) refuses the next link with a visible {@code chain_refused} audit;</li>
 *   <li>cycle: the path-scoped {@code awakened} set (key = participantId) refuses A→B→A;</li>
 *   <li>refusals never create a run — they are {@code wake_dispatch} events
 *       (outcome=chain_refused, reason=depth_exceeded|cycle), the M4 audit surface.</li>
 * </ul>
 */
@Service
public class WakeChainService {

    private static final Logger logger = LoggerFactory.getLogger(WakeChainService.class);
    static final String EVENT_WAKE_DISPATCH = "wake_dispatch";
    static final int DEFAULT_MAX_DEPTH = 3;

    private final WakeChainRegistry registry = new WakeChainRegistry();
    private final SessionRepository sessionRepository;
    private final SessionParticipantService participantService;
    private final WakeDispatchService wakeDispatchService;
    private final EventStoreService eventStoreService;
    private final ConfigService configService;
    private final ObjectMapper objectMapper;

    public WakeChainService(SessionRepository sessionRepository,
                            SessionParticipantService participantService,
                            WakeDispatchService wakeDispatchService,
                            EventStoreService eventStoreService,
                            ConfigService configService,
                            ObjectMapper objectMapper) {
        this.sessionRepository = sessionRepository;
        this.participantService = participantService;
        this.wakeDispatchService = wakeDispatchService;
        this.eventStoreService = eventStoreService;
        this.configService = configService;
        this.objectMapper = objectMapper;
    }

    /** M3 entry: an agent run's assistant text just settled. */
    public void onAssistantContent(String sessionId, String runId, String content) {
        List<SessionParticipantService.ParticipantView> views;
        try {
            views = participantService.list(sessionOwner(sessionId), workspaceOf(sessionId),
                    sessionId).participants();
        } catch (RuntimeException noRoster) {
            // The run must still settle (a wake failure may never fail the run), but the old silent
            // return made "empty roster" and "roster read failed" indistinguishable — PLAN-0630 M1
            // fixed the empty-roster half at the source (spawn children now get their PRIMARY).
            logger.warn("[LIFECYCLE] service=cp event=wake_roster_unreadable sessionId={} runId={} failureType={}",
                    sessionId, runId, noRoster.getClass().getSimpleName());
            return;
        }
        List<MentionParser.RosterEntry> roster = views.stream()
                .map(view -> new MentionParser.RosterEntry(view.participantId(),
                        view.principalKind(), view.displayName(), view.role(),
                        view.respondPolicy(), view.disabledAt()))
                .toList();
        MentionParser.ParseResult parsed = MentionParser.parse(content, roster);
        List<MentionParser.Mention> links = parsed.all()
                ? roster.stream().filter(MentionParser.RosterEntry::enabled)
                        .map(entry -> new MentionParser.Mention(entry.participantId(),
                                entry.displayName())).toList()
                : parsed.mentions();
        for (MentionParser.Mention link : links) {
            fireNextLink(sessionId, runId, link);
        }
    }

    private void fireNextLink(String sessionId, String parentRunId, MentionParser.Mention link) {
        WakeChainRegistry.ChainNode parent = registry.nodeFor(parentRunId).orElse(null);
        WakeChainRegistry.ChainNode child = parent == null
                ? new WakeChainRegistry.ChainNode("wake:chain:" + parentRunId, 1,
                        java.util.Set.of(link.participantId()))
                : parent.child(link.participantId());
        if (parent != null && parent.wouldCycle(link.participantId())) {
            auditRefused(sessionId, link, child, "cycle");
            return;
        }
        if (child.depth() > maxDepth()) {
            auditRefused(sessionId, link, child, "depth_exceeded");
            return;
        }
        String childRoundId = "wake:chain:" + parentRunId + ":" + link.participantId();
        WakeDispatchService.WakeFireResult result = wakeDispatchService.fire(
                link.participantId(), "chain", childRoundId, UUID.fromString(sessionId));
        if (result.dispatched() && result.runId() != null) {
            registry.register(result.runId().toString(), child);
            logger.info("[LIFECYCLE] service=cp event=wake_chain_link parentRunId={} childRunId={} "
                    + "depth={} participantId={}", parentRunId, result.runId(), child.depth(),
                    link.participantId());
        }
    }

    private void auditRefused(String sessionId, MentionParser.Mention link,
                              WakeChainRegistry.ChainNode child, String reason) {
        Session session = sessionRepository.findById(UUID.fromString(sessionId)).orElse(null);
        ObjectNode payload = objectMapper.createObjectNode();
        payload.put("wakeRoundId", child.rootWakeRoundId());
        payload.put("participantId", link.participantId().toString());
        payload.put("triggerSource", "chain");
        payload.put("outcome", "chain_refused");
        payload.put("error", reason + " at depth " + child.depth());
        eventStoreService.append(sessionId, session == null ? null : session.getWorkspaceId(),
                session == null || session.getUserId() == null ? "" : session.getUserId(),
                EVENT_WAKE_DISPATCH, payload);
        logger.info("[LIFECYCLE] service=cp event=wake_chain_refused sessionId={} participantId={} "
                + "reason={} depth={}", sessionId, link.participantId(), reason, child.depth());
    }

    /**
     * PLAN-0630 M1: the depth is instance-level config ({@code agent-runtime.wakeChainMaxDepth},
     * instance only) resolved without user/workspace context — the same layer the config schema and
     * {@code ConfigService.INSTANCE_ONLY_KEYS} declare. Invalid or unreadable values fall back to the
     * strictest default (3) and are logged: a silent fallback hides a misconfiguration, and a silent
     * catch violates the exception-audit rule.
     */
    private int maxDepth() {
        try {
            String configured = configService == null ? null
                    : configService.resolve("agent-runtime", "wakeChainMaxDepth", null, null);
            if (configured == null) {
                return DEFAULT_MAX_DEPTH;
            }
            int parsed = Integer.parseInt(configured.trim());
            if (parsed < 1) {
                // 0 (or a negative) is not "unlimited" here: the schema forbids it, and clamping it to
                // 1 would silently allow exactly one wake hop. Fall back to the default instead.
                logger.warn("[LIFECYCLE] service=cp event=wake_chain_depth_invalid configured={} fallback={}",
                        configured, DEFAULT_MAX_DEPTH);
                return DEFAULT_MAX_DEPTH;
            }
            return parsed;
        } catch (RuntimeException unreadable) {
            logger.warn("[LIFECYCLE] service=cp event=wake_chain_depth_unreadable failureType={} fallback={}",
                    unreadable.getClass().getSimpleName(), DEFAULT_MAX_DEPTH);
            return DEFAULT_MAX_DEPTH;
        }
    }

    private String sessionOwner(String sessionId) {
        Session session = sessionRepository.findById(UUID.fromString(sessionId)).orElseThrow();
        return session.getUserId();
    }

    private String workspaceOf(String sessionId) {
        Session session = sessionRepository.findById(UUID.fromString(sessionId)).orElseThrow();
        return session.getWorkspaceId();
    }
}
