package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.service.SessionParticipantService;
import com.cc01cc.p.xihe.cp.service.WakeDispatchService;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0630 M3 (T3.1-T3.5): the wake chain walks the durable edges — the in-memory
 * {@code WakeChainRegistry} is gone.
 *
 * <p>Single choke point: {@code ChatSubmissionService.persistAssistantResponse} forwards every
 * assistant text here. Mentions found in an agent's output wake the next link — through the
 * SAME {@link WakeDispatchService#fire} as mentions and schedules (one entry, three triggers).
 * Every gate reads the chain fresh from the run rows ({@link DelegationChainWalker#walkFromRun},
 * &le; 10 hops, one primary-key read per hop), so a CP restart continues the same logical chain
 * instead of resetting it (design §4.2):</p>
 *
 * <ul>
 *   <li><b>depth (T3.4)</b>: two readings off one walk, each against its own ceiling, both
 *       fail-closed. The would-be child sits at {@code wakeDepth = hops} (user message = 0, the
 *       first woken agent = 1 — a root run is its own single-node path) and inherits
 *       {@code spawnDepth = spawnHops} (a wake hop never adds a spawn edge). The wake hop refuses
 *       with {@code depth_exceeded} when {@code wakeDepth > agent-runtime.wakeChainMaxDepth},
 *       and with {@code delegation_limit_exceeded} when
 *       {@code spawnDepth >} the root principal's delegation maxDepth — the SAME effective limit
 *       {@link DelegationBudgetService#maxSpawnDepth} computes for the spawn gate, so 委托深度 has
 *       one definition. The wake-depth gate runs first: it is the chain's own ceiling.</li>
 *   <li><b>cycle (T3.3)</b>: the key is the principal, not the participant — the path already
 *       carries the principal of the agent that ran each hop ({@code principalPath}), so the same
 *       agent appearing in two sessions of the path (e.g. a spawn child that inherits the parent
 *       principal) is caught. In-session this is equivalent to the old participantId key
 *       (participant→principal is 1:1); the only behavior change is the cross-session case, which
 *       is the fix (design §3.2).</li>
 *   <li><b>broken chain</b>: a missing parent run or a missing ancestor row refuses with
 *       {@code ancestor_missing}/{@code tree_broken} — an orphan is never read as a depth-0 root
 *       (D30-08, shared with the spawn gate).</li>
 *   <li><b>refusals never create a run</b> — they are {@code wake_dispatch} events
 *       ({@code outcome=chain_refused}), the M4 audit surface. Zero new event names (T3.5):
 *       the payload only gains {@code parentRunId}/{@code rootRunId}/{@code wakeDepth}/
 *       {@code spawnDepth} fields.</li>
 * </ul>
 */
@Service
public class WakeChainService {

    private static final Logger logger = LoggerFactory.getLogger(WakeChainService.class);
    static final String EVENT_WAKE_DISPATCH = "wake_dispatch";
    static final int DEFAULT_MAX_DEPTH = 3;

    private final SessionRepository sessionRepository;
    private final SessionParticipantService participantService;
    private final WakeDispatchService wakeDispatchService;
    private final EventStoreService eventStoreService;
    private final ConfigService configService;
    private final ObjectMapper objectMapper;
    private final ChatRunRepository chatRunRepository;
    private final DelegationBudgetService delegationBudgetService;
    private final DelegationChainWalker chainWalker;

    public WakeChainService(SessionRepository sessionRepository,
                            SessionParticipantService participantService,
                            WakeDispatchService wakeDispatchService,
                            EventStoreService eventStoreService,
                            ConfigService configService,
                            ObjectMapper objectMapper,
                            ChatRunRepository chatRunRepository,
                            DelegationBudgetService delegationBudgetService) {
        this.sessionRepository = sessionRepository;
        this.participantService = participantService;
        this.wakeDispatchService = wakeDispatchService;
        this.eventStoreService = eventStoreService;
        this.configService = configService;
        this.objectMapper = objectMapper;
        this.chatRunRepository = chatRunRepository;
        this.delegationBudgetService = delegationBudgetService;
        // Stateless walk component; constructed in place so the constructor contract (and the unit
        // test wiring) only gains the two repositories the walk itself needs.
        this.chainWalker = new DelegationChainWalker(sessionRepository, chatRunRepository);
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
        Map<UUID, UUID> principalByParticipant = new HashMap<>();
        for (SessionParticipantService.ParticipantView view : views) {
            principalByParticipant.put(view.participantId(), view.principalId());
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
            fireNextLink(sessionId, runId, link, principalByParticipant);
        }
    }

    private void fireNextLink(String sessionId, String parentRunId, MentionParser.Mention link,
                              Map<UUID, UUID> principalByParticipant) {
        UUID parentRunUuid;
        try {
            parentRunUuid = UUID.fromString(parentRunId);
        } catch (IllegalArgumentException notUuid) {
            auditRefused(sessionId, link, parentRunId, null, -1, -1, "ancestor_missing");
            return;
        }
        ChatRun parentRun = chatRunRepository.findById(parentRunUuid).orElse(null);
        if (parentRun == null) {
            auditRefused(sessionId, link, parentRunId, null, -1, -1, "ancestor_missing");
            return;
        }
        DelegationChainWalker.ChainWalk walk;
        try {
            walk = chainWalker.walkFromRun(parentRun);
        } catch (DelegationChainWalker.AncestorMissingException broken) {
            logger.warn("[LIFECYCLE] service=cp event=wake_chain_ancestor_missing sessionId={} "
                    + "parentRunId={} reason={} detail={}", sessionId, parentRunId,
                    broken.reason(), broken.getMessage());
            auditRefused(sessionId, link, parentRunId, null, -1, -1, broken.reason());
            return;
        }
        // The would-be child: a root run is a single-node path, so hops == the child's wake depth
        // (user message = 0 semantics preserved); the wake hop adds no spawn edge, so the child
        // inherits the walked spawn-edge count.
        int wakeDepth = walk.hops().size();
        int spawnDepth = walk.spawnHops();
        String rootRunId = walk.hops().getLast().nodeId().toString();

        // T3.3: refuse when the target's principal already owns a run on this path.
        UUID linkPrincipalId = principalByParticipant.get(link.participantId());
        String cycleKey = linkPrincipalId == null ? null : linkPrincipalId.toString();
        if (cycleKey != null && walk.principalPath().contains(cycleKey)) {
            auditRefused(sessionId, link, parentRunId, rootRunId, wakeDepth, spawnDepth, "cycle");
            return;
        }
        // T3.4: two readings, two ceilings, both fail-closed; the chain's own depth gate first.
        if (wakeDepth > maxDepth()) {
            auditRefused(sessionId, link, parentRunId, rootRunId, wakeDepth, spawnDepth,
                    "depth_exceeded");
            return;
        }
        Integer maxSpawnDepth = resolveMaxSpawnDepth(walk, rootRunId);
        if (maxSpawnDepth == null) {
            auditRefused(sessionId, link, parentRunId, rootRunId, wakeDepth, spawnDepth,
                    "delegation_policy_invalid");
            return;
        }
        if (spawnDepth > maxSpawnDepth) {
            auditRefused(sessionId, link, parentRunId, rootRunId, wakeDepth, spawnDepth,
                    "delegation_limit_exceeded");
            return;
        }

        String childRoundId = "wake:chain:" + parentRunId + ":" + link.participantId();
        // The durable chain parent rides along — dispatch re-walks inside the parent run row lock
        // and serializes duplicate hops before any wake run exists (M2 T2.8/T2.9).
        WakeDispatchService.WakeFireResult result = wakeDispatchService.fire(
                link.participantId(), "chain", childRoundId, UUID.fromString(sessionId), parentRunId);
        if (result.dispatched()) {
            logger.info("[LIFECYCLE] service=cp event=wake_chain_link parentRunId={} childRunId={} "
                    + "rootRunId={} wakeDepth={} spawnDepth={} participantId={}",
                    parentRunId, result.runId(), rootRunId, wakeDepth, spawnDepth,
                    link.participantId());
        }
    }

    /**
     * T3.4: the spawn-depth ceiling comes from the SAME resolver the spawn gate uses
     * ({@link DelegationBudgetService#maxSpawnDepth}), rooted at the walked chain root. Returns
     * {@code null} when the limit is unresolvable (root without a principal, unreadable/invalid
     * stored policy) — the caller refuses the link fail-closed, mirroring the spawn gate.
     */
    private Integer resolveMaxSpawnDepth(DelegationChainWalker.ChainWalk walk, String rootRunId) {
        String rootPrincipalId = walk.principalPath().getLast();
        if (rootPrincipalId == null) {
            logger.warn("[LIFECYCLE] service=cp event=wake_chain_root_principal_missing rootRunId={}",
                    rootRunId);
            return null;
        }
        try {
            return delegationBudgetService.maxSpawnDepth(rootPrincipalId,
                    walk.hops().getLast().sessionId().toString(), rootRunId);
        } catch (CpApiException policyBroken) {
            logger.warn("[LIFECYCLE] service=cp event=wake_chain_policy_unreadable rootRunId={} "
                    + "rootPrincipalId={} code={}", rootRunId, rootPrincipalId,
                    policyBroken.getCode());
            return null;
        }
    }

    private void auditRefused(String sessionId, MentionParser.Mention link, String parentRunId,
                              String rootRunId, int wakeDepth, int spawnDepth, String reason) {
        Session session = sessionRepository.findById(UUID.fromString(sessionId)).orElse(null);
        ObjectNode payload = objectMapper.createObjectNode();
        // The root round string the M2 registry used to carry: "wake:chain:" + the ROOT run id,
        // falling back to the refused parent when the walk could not resolve a root.
        payload.put("wakeRoundId", "wake:chain:" + (rootRunId == null ? parentRunId : rootRunId));
        payload.put("participantId", link.participantId().toString());
        payload.put("triggerSource", "chain");
        payload.put("outcome", "chain_refused");
        payload.put("parentRunId", parentRunId);
        if (rootRunId != null) {
            // T3.5 observability fields — same wake_dispatch event, more context, no new name.
            payload.put("rootRunId", rootRunId);
            payload.put("wakeDepth", wakeDepth);
            payload.put("spawnDepth", spawnDepth);
            payload.put("error", reason + " at wakeDepth " + wakeDepth
                    + " spawnDepth " + spawnDepth);
        } else {
            payload.put("error", reason);
        }
        eventStoreService.append(sessionId, session == null ? null : session.getWorkspaceId(),
                session == null || session.getUserId() == null ? "" : session.getUserId(),
                EVENT_WAKE_DISPATCH, payload);
        logger.info("[LIFECYCLE] service=cp event=wake_chain_refused sessionId={} participantId={} "
                + "reason={} parentRunId={} rootRunId={} wakeDepth={} spawnDepth={}",
                sessionId, link.participantId(), reason, parentRunId, rootRunId,
                wakeDepth, spawnDepth);
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
