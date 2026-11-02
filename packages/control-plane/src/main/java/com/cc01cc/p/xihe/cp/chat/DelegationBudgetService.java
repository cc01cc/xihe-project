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
    static final int MAX_TRAVERSAL_NODES = 512;
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

    public DelegationBudgetService(SessionRepository sessionRepository,
                                   ChatRunRepository chatRunRepository,
                                   AgentPrincipalService agentPrincipalService,
                                   ConfigService configService) {
        this.sessionRepository = sessionRepository;
        this.chatRunRepository = chatRunRepository;
        this.agentPrincipalService = agentPrincipalService;
        this.configService = configService;
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

    /** Root + depth of the parent session (root depth = 0). */
    private record Walk(Session root, int depth) {}

    private Walk walkToRoot(Session parentSession) {
        Session current = parentSession;
        int depth = 0;
        int hops = 0;
        while (Session.KIND_SPAWN.equals(current.getKind())) {
            if (++hops > MAX_TRAVERSAL_NODES) {
                throw treeBroken(current);
            }
            UUID up = current.getSpawnedFromSessionId();
            if (up == null) {
                // V40's CHECK makes this unreachable, but fail closed instead of inventing a root.
                throw treeBroken(current);
            }
            final Session child = current;
            current = sessionRepository.findById(up).orElseThrow(() -> treeBroken(child));
            depth++;
        }
        return new Walk(current, depth);
    }

    private DelegationLimits effectiveLimits(String rootPrincipalId,
                                             DelegationRefusedException.DelegationAuditContext audit) {
        JsonNode stored;
        try {
            stored = agentPrincipalService.readDelegationPolicy(rootPrincipalId);
        } catch (CpApiException missing) {
            if (!"AGENT_PRINCIPAL_NOT_FOUND".equals(missing.getCode())) {
                throw DelegationRefusedException.policyInvalid("policy_unreadable", audit, missing.getMessage());
            }
            // The FK (agent_principals, ON DELETE RESTRICT) makes a missing root principal unreachable in
            // production; only hand-built fixtures and hard-deleted rows get here. The budget gate must
            // not invent a new spawn outage for a state the rest of the spawn path tolerates (the child
            // cap is derived from the parent's snapshot, not from this row), so it degrades to "no
            // budget configured" and says so out loud.
            logger.warn("[LIFECYCLE] service=cp event=delegation_root_principal_missing rootPrincipalId={} "
                    + "rootSessionId={} fallback=code_defaults", rootPrincipalId, audit.rootSessionId());
            stored = null;
        }
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
        int used = 0;
        int visited = 0;
        Deque<UUID> queue = new ArrayDeque<>(List.of(rootId));
        while (!queue.isEmpty()) {
            UUID current = queue.poll();
            if (++visited > MAX_TRAVERSAL_NODES) {
                logger.warn("[LIFECYCLE] service=cp event=delegation_tree_traversal_capped rootSessionId={} "
                        + "visited={} maxNodes={}", rootId, visited, MAX_TRAVERSAL_NODES);
                throw DelegationRefusedException.policyInvalid("tree_broken", audit,
                        "delegation tree traversal exceeded " + MAX_TRAVERSAL_NODES + " nodes");
            }
            for (Session child : sessionRepository.findBySpawnedFromSessionIdAndKind(current, Session.KIND_SPAWN)) {
                if (chatRunRepository.existsBySessionIdAndStatusIn(child.getId().toString(),
                        ChatRunCancellationService.NON_TERMINAL_STATUSES)) {
                    if (++used >= stopAt) {
                        return used;
                    }
                }
                queue.add(child.getId());
            }
        }
        return used;
    }

    private static DelegationRefusedException treeBroken(Session broken) {
        logger.warn("[LIFECYCLE] service=cp event=delegation_tree_broken sessionId={} spawnedFrom={}",
                broken.getId(), broken.getSpawnedFromSessionId());
        return DelegationRefusedException.raw(HttpStatus.CONFLICT, "DELEGATION_POLICY_INVALID",
                "Delegation tree is broken: a spawn ancestor is missing",
                "{\"reason\":\"tree_broken\",\"parentSessionId\":\"" + broken.getId() + "\"}");
    }
}
