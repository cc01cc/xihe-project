package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.policy.DelegationPolicyValidator;
import com.cc01cc.p.xihe.cp.policy.DelegationPolicyValidator.DelegationLimits;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.fasterxml.jackson.databind.JsonNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0630 M1: the delegation budget gate — "one agent subject may only fan out so far".
 *
 * <p>Frozen semantics (PLAN-0630 README ruling #2 + Lead rulings 2026-11-02):</p>
 * <ul>
 *   <li><b>budget root</b> — walk up the <em>spawn</em> edges from the parent session and stop at the
 *       first session whose {@code kind} is not {@code spawn}. That session is the root; it may be an
 *       ordinary session ({@code kind = NULL}) <b>or</b> a fork ({@code kind = fork}) — a fork is a new
 *       authority root (design §1.1), so a fork child spawning must not be charged to the forked-from
 *       tree. Testing {@code kind IS NULL} instead would walk straight through the fork edge.</li>
 *   <li><b>depth</b> — root = 0, each spawn edge +1; the new child's depth is {@code depth + 1} and is
 *       refused when {@code depth > maxDepth}.</li>
 *   <li><b>count</b> — the number of spawn sessions inside the root's tree that have a
 *       <b>non-terminal run</b> (the parent itself included when it is a spawn child). Refused when
 *       {@code used >= maxCount} — the concurrent reading (a child's terminal run releases its slot).
 *       The comparison is {@code >=}, not {@code >}: with {@code >} the effective allowance would be
 *       {@code maxCount + 1}.</li>
 *   <li><b>budget source</b> — only the <b>root</b> subject's {@code delegation_policy} (+ the
 *       instance-level ceilings). Reading the parent's or the delegated subject's own limits would
 *       re-enable the very thing ruling #2 forbids ("a sub-agent's own limits are inert as a
 *       subagent").</li>
 * </ul>
 *
 * <p><b>Where the call belongs</b> (INV-8): after the idempotency replay in
 * {@code createSpawnFromParent} (otherwise a retry of the <em>same</em> tool call would be refused by
 * the budget — the child itself is the last slot) and before {@code consumeApprovedGrant} (otherwise a
 * one-shot approval is burnt by a refusal). It must also run inside the parent Session+Run row locks,
 * which is the only place a stable snapshot exists (otherwise two concurrent spawns both pass).</p>
 *
 * <p><b>Cost</b>: small bounded walks, no recursive SQL. Each level costs one query per child; the
 * traversal stops as soon as the count reaches the limit, and {@link #MAX_TRAVERSAL_NODES} caps
 * pathological trees (fail-closed: treat as exhausted).</p>
 */
@Service
public class DelegationBudgetService {

    private static final Logger logger = LoggerFactory.getLogger(DelegationBudgetService.class);

    /** Anti-footgun rails: applied regardless of what the stored policy says. */
    static final int MAX_TRAVERSAL_NODES = DelegationChainWalker.MAX_TRAVERSAL_NODES;
    /** Lead ruling 2026-11-02 (Q-B): no in-repo precedent for the count; 3 mirrors the wake chain. */
    static final int DEFAULT_MAX_COUNT = 8;
    static final int DEFAULT_MAX_DEPTH = 3;

    private static final String CONFIG_DOMAIN = "agent-runtime";
    private static final String CEILING_MAX_COUNT = "delegationMaxCountCeiling";
    private static final String CEILING_MAX_DEPTH = "delegationMaxDepthCeiling";

    private final SessionRepository sessionRepository;
    private final ChatRunRepository chatRunRepository;
    private final AgentPrincipalService agentPrincipalService;
    private final ConfigService configService;
    private final DelegationChainWalker chainWalker;

    public DelegationBudgetService(SessionRepository sessionRepository,
                                   ChatRunRepository chatRunRepository,
                                   AgentPrincipalService agentPrincipalService,
                                   ConfigService configService) {
        this.sessionRepository = sessionRepository;
        this.chatRunRepository = chatRunRepository;
        this.agentPrincipalService = agentPrincipalService;
        this.configService = configService;
        // Stateless walk component; constructed in place so the service's constructor contract (and
        // every existing unit test wiring) stays unchanged.
        this.chainWalker = new DelegationChainWalker(sessionRepository, chatRunRepository);
    }

    /**
     * Pre-persist check. Returns the effective limits so the caller can log them; throws
     * {@link DelegationRefusedException} when the tree is broken, the stored policy is unreadable, or
     * the depth/count budget is exhausted.
     *
     * <p>Caller must already hold the parent Session and parent Run row locks.</p>
     */
    public DelegationLimits requireWithinBudget(Session parentSession, ChatRun parentRun, String toolCallId) {
        Walk walk = walkToRoot(parentSession);
        DelegationRefusedException.DelegationAuditContext audit = new DelegationRefusedException
                .DelegationAuditContext(walk.root().getId().toString(), parentSession.getId().toString(),
                parentRun.getId().toString(), toolCallId, walk.root().getAgentPrincipalId());

        String rootPrincipalId = walk.root().getAgentPrincipalId();
        if (rootPrincipalId == null) {
            // Not reachable through the product surface (a session always carries a principal once it
            // has runs), but the gate fails closed instead of assuming "no budget".
            throw DelegationRefusedException.policyInvalid("root_without_principal", audit,
                    "the delegation root has no agent principal");
        }

        DelegationLimits limits = effectiveLimits(rootPrincipalId, audit);
        int childDepth = walk.depth() + 1;
        // PLAN-0648 ruling A1: maxCount=0 is the explicit "delegation disabled" value. Refuse every
        // spawn under this principal with a dedicated reason (the refusal envelope stays the same
        // DELEGATION_LIMIT_EXCEEDED shape the client already handles).
        if (limits.maxCount() == 0) {
            throw DelegationRefusedException.disabled(audit, childDepth, limits.maxDepth());
        }
        if (childDepth > limits.maxDepth()) {
            throw DelegationRefusedException.refused("depth_exceeded", audit, childDepth,
                    limits.maxDepth(), 0, limits.maxCount());
        }

        int used = countInFlight(walk.root().getId(), limits.maxCount(), audit);
        if (used >= limits.maxCount()) {
            throw DelegationRefusedException.refused("count_exceeded", audit, childDepth,
                    limits.maxDepth(), used, limits.maxCount());
        }
        logger.debug("[LIFECYCLE] service=cp event=delegation_budget_ok rootSessionId={} childDepth={} used={} "
                        + "maxDepth={} maxCount={}", walk.root().getId(), childDepth, used,
                limits.maxDepth(), limits.maxCount());
        return limits;
    }

    /**
     * T3.4: the wake chain's spawn-depth ceiling — the SAME effective {@code maxDepth} this gate
     * enforces on a spawn (root principal's {@code delegation_policy} ∩ instance ceiling), so
     * "委托深度" has exactly one definition on both gates. The wake path reads only maxDepth; the
     * count budget stays spawn-only.
     *
     * <p>Throws {@link DelegationRefusedException} exactly like {@link #requireWithinBudget} does
     * for an unreadable/invalid stored policy — the wake chain catches it and refuses the link
     * fail-closed, mirroring the spawn gate's DELEGATION_POLICY_INVALID. The audit context is
     * best-effort (a wake hop has no tool call).</p>
     */
    public int maxSpawnDepth(String rootPrincipalId, String rootSessionId, String rootRunId) {
        DelegationRefusedException.DelegationAuditContext audit = new DelegationRefusedException
                .DelegationAuditContext(rootSessionId, rootSessionId, rootRunId, null, rootPrincipalId);
        return effectiveLimits(rootPrincipalId, audit).maxDepth();
    }

    /** Root + depth of the parent session (root depth = 0). */
    private record Walk(Session root, int depth) {}

    /**
     * T2.7: the walk itself now lives in {@link DelegationChainWalker} (shared with the wake chain).
     * Behavior is unchanged — same root, same depth, same 512-node cap. T2.8: a missing ancestor row
     * now refuses with {@code reason=ancestor_missing} (the shared determination) instead of the
     * generic {@code tree_broken}; a structurally broken link keeps the historical {@code tree_broken}
     * audit value.
     */
    private Walk walkToRoot(Session parentSession) {
        DelegationChainWalker.ChainWalk walk;
        try {
            walk = chainWalker.walkFromSession(parentSession);
        } catch (DelegationChainWalker.AncestorMissingException missing) {
            throw ancestorRefused(missing, parentSession);
        }
        Session root = sessionRepository.findById(walk.hops().getLast().nodeId())
                .orElseThrow(() -> treeBroken(parentSession));
        return new Walk(root, walk.spawnHops());
    }

    private static DelegationRefusedException ancestorRefused(
            DelegationChainWalker.AncestorMissingException missing, Session parentSession) {
        // M3 (T3.5): design §7.1 fixes this line to the pre-existing delegation_tree_broken name —
        // the M2 introduction of delegation_chain_broken was event-name drift, and event names are
        // the query/alert contract surface (零新事件名).
        logger.warn("[LIFECYCLE] service=cp event=delegation_tree_broken reason={} detail={}",
                missing.reason(), missing.getMessage());
        return DelegationRefusedException.raw(HttpStatus.CONFLICT, ToolRefusalCodes.DELEGATION_POLICY_INVALID,
                "Delegation ancestor is missing: " + missing.getMessage(),
                "{\"reason\":\"" + missing.reason() + "\",\"parentSessionId\":\""
                        + parentSession.getId() + "\"}");
    }

    private DelegationLimits effectiveLimits(String rootPrincipalId,
                                             DelegationRefusedException.DelegationAuditContext audit) {
        JsonNode stored = readStoredPolicy(rootPrincipalId, audit);
        DelegationLimits raw;
        try {
            raw = DelegationPolicyValidator.limits(stored, DEFAULT_MAX_COUNT, DEFAULT_MAX_DEPTH);
        } catch (CpApiException invalid) {
            // Fail closed AND keep the audit shape: the validator already answers 409
            // DELEGATION_POLICY_INVALID, but the refusal must also reach the durable agent_spawn_refused
            // line, and only DelegationRefusedException carries the audit context out of the transaction.
            throw DelegationRefusedException.policyInvalid("policy_invalid", audit, invalid.getMessage());
        }
        int countCeiling = ceiling(CEILING_MAX_COUNT);
        int depthCeiling = ceiling(CEILING_MAX_DEPTH);
        int maxCount = countCeiling > 0 ? Math.min(raw.maxCount(), countCeiling) : raw.maxCount();
        int maxDepth = depthCeiling > 0 ? Math.min(raw.maxDepth(), depthCeiling) : raw.maxDepth();
        return new DelegationLimits(maxCount, maxDepth);
    }

    /**
     * The stored policy document, or {@code null} when the subject carries none (or the principal row
     * is gone — the FK makes that unreachable in production; fixtures degrade to code defaults and say
     * so out loud). Unreadable documents fail closed, never fall back silently.
     */
    private JsonNode readStoredPolicy(String rootPrincipalId,
                                      DelegationRefusedException.DelegationAuditContext audit) {
        try {
            return agentPrincipalService.readDelegationPolicy(rootPrincipalId);
        } catch (CpApiException missing) {
            if (!"AGENT_PRINCIPAL_NOT_FOUND".equals(missing.getCode())) {
                throw DelegationRefusedException.policyInvalid("policy_unreadable", audit, missing.getMessage());
            }
            logger.warn("[LIFECYCLE] service=cp event=delegation_root_principal_missing rootPrincipalId={} "
                    + "rootSessionId={} fallback=code_defaults", rootPrincipalId, audit.rootSessionId());
            return null;
        }
    }
    /** Instance-level ceiling; {@code 0} (or absent) = no clamp, mirroring {@code runMaxTurnsCeiling}. */
    private int ceiling(String key) {
        if (configService == null) {
            return 0;
        }
        String configured = configService.resolve(CONFIG_DOMAIN, key, null, null);
        if (configured == null || configured.isBlank()) {
            return 0;
        }
        try {
            int parsed = Integer.parseInt(configured.trim());
            if (parsed < 0) {
                logger.warn("[LIFECYCLE] service=cp event=delegation_ceiling_invalid key={} configured={} "
                        + "fallback=0", key, configured);
                return 0;
            }
            return parsed;
        } catch (NumberFormatException malformed) {
            logger.warn("[LIFECYCLE] service=cp event=delegation_ceiling_invalid key={} configured={} fallback=0",
                    key, configured);
            return 0;
        }
    }

    /**
     * Breadth-first count of spawn sessions with a non-terminal run. Early exit at {@code stopAt}
     * (once the limit is reached the exact number no longer matters); a traversal overflow is treated
     * as "exhausted" so a pathologically deep or cyclic tree cannot be used to bypass the gate.
     */
    private int countInFlight(UUID rootId, int stopAt,
                              DelegationRefusedException.DelegationAuditContext audit) {
        return traverseUsage(rootId, stopAt, audit).usedSessions();
    }

    /**
     * PLAN-0655: the shared usage traversal behind both the gate's count and the read view. One
     * predicate ("spawn session with a non-terminal run"), one traversal cap, one hop accounting —
     * the read view cannot drift from the gate because there is nothing to drift: it IS the gate's
     * query, with the hop distance recorded alongside.
     *
     * @return usedSessions (non-terminal spawn sessions under the root) and deepestLiveDepth (the
     *     deepest of those sessions measured in spawn hops from the root; 0 when none are live)
     */
    private UsageTraversal traverseUsage(UUID rootId, int stopAt,
                                         DelegationRefusedException.DelegationAuditContext audit) {
        int used = 0;
        int deepestLiveDepth = 0;
        int visited = 0;
        Deque<Map.Entry<UUID, Integer>> queue = new ArrayDeque<>(List.of(Map.entry(rootId, 0)));
        while (!queue.isEmpty()) {
            Map.Entry<UUID, Integer> entry = queue.poll();
            UUID current = entry.getKey();
            int depth = entry.getValue();
            if (++visited > MAX_TRAVERSAL_NODES) {
                logger.warn("[LIFECYCLE] service=cp event=delegation_tree_traversal_capped rootSessionId={} "
                        + "visited={} maxNodes={}", rootId, visited, MAX_TRAVERSAL_NODES);
                throw DelegationRefusedException.policyInvalid("tree_broken", audit,
                        "delegation tree traversal exceeded " + MAX_TRAVERSAL_NODES + " nodes");
            }
            for (Session child : sessionRepository.findBySpawnedFromSessionIdAndKind(current, Session.KIND_SPAWN)) {
                if (chatRunRepository.existsBySessionIdAndStatusIn(child.getId().toString(),
                        ChatRunCancellationService.NON_TERMINAL_STATUSES)) {
                    deepestLiveDepth = Math.max(deepestLiveDepth, depth + 1);
                    if (++used >= stopAt) {
                        return new UsageTraversal(used, deepestLiveDepth);
                    }
                }
                queue.add(Map.entry(child.getId(), depth + 1));
            }
        }
        return new UsageTraversal(used, deepestLiveDepth);
    }

    /** BFS result of {@link #traverseUsage}: the gate's count plus the deepest live depth. */
    private record UsageTraversal(int usedSessions, int deepestLiveDepth) {}

    /**
     * PLAN-0655 read view (GET /api/v1/sessions/{sessionId}/delegation-usage). The SAME evaluation
     * point as the budget gate: same root walk, same stored-policy read, same effective-limits
     * clamp, same live-run predicate. An unreadable stored policy fails closed here exactly like
     * the gate does (409 DELEGATION_POLICY_INVALID) — the read face never silently substitutes
     * defaults for a broken document.
     */
    @org.springframework.transaction.annotation.Transactional(readOnly = true)
    public DelegationUsage usageFor(Session session) {
        Walk walk = walkToRoot(session);
        Session root = walk.root();
        String rootPrincipalId = root.getAgentPrincipalId();
        DelegationRefusedException.DelegationAuditContext audit = new DelegationRefusedException
                .DelegationAuditContext(root.getId().toString(), session.getId().toString(), null, null,
                rootPrincipalId);
        DelegationLimits limits = effectiveLimits(rootPrincipalId, audit);
        UsageTraversal traversal = traverseUsage(root.getId(), Integer.MAX_VALUE, audit);
        JsonNode stored = readStoredPolicy(rootPrincipalId, audit);
        return new DelegationUsage(root.getId().toString(), traversal.usedSessions(), limits.maxCount(),
                traversal.deepestLiveDepth(), limits.maxDepth(), rootPrincipalId, principalName(rootPrincipalId),
                stored == null ? "code-defaults" : "subject", limits.maxCount() == 0);
    }

    /** Read view row; field names mirror the OpenAPI DelegationUsageView schema. */
    /**
     * PLAN-0655 T2: read-only budget precheck for the HUMAN route, run BEFORE the ask gate.
     * Without it the gate would park an approval for a delegation that can never be created
     * (disabled by maxCount=0, or count already exhausted) and ask a human to approve a
     * guaranteed refusal. The authoritative locked check still runs inside createDelegation;
     * this only prevents the pointless approval round-trip.
     */
    public void requireUsableForDelegation(Session session) {
        DelegationUsage usage = usageFor(session);
        if (usage.disabled()) {
            throw DelegationRefusedException.disabled(auditOf(usage, session), 0, usage.maxDepth());
        }
        if (usage.usedSessions() >= usage.maxCount()) {
            throw DelegationRefusedException.refused("count_exceeded", auditOf(usage, session),
                    usage.currentDepth() + 1, usage.maxDepth(), usage.usedSessions(), usage.maxCount());
        }
    }

    private static DelegationRefusedException.DelegationAuditContext auditOf(DelegationUsage usage,
                                                                             Session session) {
        return new DelegationRefusedException.DelegationAuditContext(
                usage.rootSessionId(), session.getId().toString(), null, null, usage.principalId());
    }

    public record DelegationUsage(String rootSessionId, int usedSessions, int maxCount, int currentDepth,
                                  int maxDepth, String principalId, String principalName, String policySource,
                                  boolean disabled) {}

    /** Best-effort display name; null when the principal row is gone (the view still answers). */
    private String principalName(String rootPrincipalId) {
        if (rootPrincipalId == null) {
            return null;
        }
        try {
            return agentPrincipalService.readPrincipalName(rootPrincipalId);
        } catch (RuntimeException unreadable) {
            return null;
        }
    }

    private static DelegationRefusedException treeBroken(Session broken) {
        logger.warn("[LIFECYCLE] service=cp event=delegation_tree_broken sessionId={} spawnedFrom={}",
                broken.getId(), broken.getSpawnedFromSessionId());
        return DelegationRefusedException.raw(HttpStatus.CONFLICT, ToolRefusalCodes.DELEGATION_POLICY_INVALID,
                "Delegation tree is broken: a spawn ancestor is missing",
                "{\"reason\":\"tree_broken\",\"parentSessionId\":\"" + broken.getId() + "\"}");
    }
}
