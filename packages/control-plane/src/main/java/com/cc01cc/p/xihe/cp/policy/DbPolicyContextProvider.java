package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.entity.PolicyRuleEntity;
import com.cc01cc.p.xihe.cp.entity.ToolFaceEntity;
import com.cc01cc.p.xihe.cp.repository.PolicyRuleRepository;
import com.cc01cc.p.xihe.cp.repository.ToolFaceRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Primary;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Loads persisted policy rules and tool faces for one request (PLAN-0328 M1, spec §4.1/§8).
 *
 * <p>Layer order is lowest→highest: INSTANCE → USER → WORKSPACE. Workspace faces override
 * instance faces for the same tool.</p>
 *
 * <p><b>Cache</b> (spec §4.3): the DB layers and tool faces are cached per {@code (userId|workspaceId)}
 * key together with the per-process {@link PolicyVersion}; writers bump the version to invalidate.
 * SESSION rules and mode are memory-only and always read fresh from {@link SessionPolicyState}.</p>
 *
 * <p><b>Fail-closed</b>: any load failure is logged and yields {@link PolicyContext#failedClosed()}
 * (forced INSTANCE-level ask), never allow (spec §4.3); failures are never cached.</p>
 */
@Component
@Primary
public class DbPolicyContextProvider implements PolicyContextProvider {

    private static final Logger log = LoggerFactory.getLogger(DbPolicyContextProvider.class);

    private static final String LAYER_INSTANCE = "instance";
    private static final String LAYER_USER = "user";
    private static final String LAYER_WORKSPACE = "workspace";
    private static final String SCOPE_INSTANCE = "instance";
    private static final String SCOPE_WORKSPACE = "workspace";

    private final PolicyRuleRepository ruleRepository;
    private final ToolFaceRepository faceRepository;
    private final SessionPolicyState sessionState;
    private final PolicyVersion policyVersion;
    private final Map<String, CachedContext> cache = new ConcurrentHashMap<>();

    public DbPolicyContextProvider(PolicyRuleRepository ruleRepository, ToolFaceRepository faceRepository,
                                   SessionPolicyState sessionState, PolicyVersion policyVersion) {
        this.ruleRepository = ruleRepository;
        this.faceRepository = faceRepository;
        this.sessionState = sessionState;
        this.policyVersion = policyVersion;
    }

    /** DB-only snapshot; session rules and mode are never cached. */
    private record CachedContext(long version,
                                 List<LayeredPolicyResolver.LayerInput> layers,
                                 Map<String, ToolFaceRegistry.Face> faces) {
        CachedContext {
            layers = List.copyOf(layers);
            faces = Map.copyOf(faces);
        }
    }

    @Override
    @Transactional(readOnly = true)
    public PolicyContext load(String userId, String workspaceId, String sessionId) {
        try {
            long version = policyVersion.current();
            String cacheKey = cacheKey(userId, workspaceId);
            CachedContext cached = cache.get(cacheKey);
            if (cached == null || cached.version() != version) {
                cached = loadDbContext(userId, workspaceId, version);
                cache.put(cacheKey, cached);
            }

            List<LayeredPolicyResolver.LayerInput> layers = new ArrayList<>(cached.layers());

            // L4 session state is memory-only and never persisted (decision #28/#29)
            List<PolicyRule> sessionRules = sessionState.rulesOf(sessionId);
            if (!sessionRules.isEmpty()) {
                layers.add(new LayeredPolicyResolver.LayerInput(PolicyLayer.SESSION, sessionRules));
            }
            String mode = sessionState.modeOf(sessionId).orElse(null);
            PolicyLayer modeLayer = mode == null ? null : PolicyLayer.SESSION;

            return new PolicyContext(layers, cached.faces(), mode, modeLayer);
        } catch (RuntimeException e) {
            // fail-closed: an unreadable rule set must never relax the decision
            log.error("[POLICY] context load failed, falling back to forced ask (fail-closed) "
                    + "userId={} workspaceId={} sessionId={}", userId, workspaceId, sessionId, e);
            return PolicyContext.failedClosed();
        }
    }

    private CachedContext loadDbContext(String userId, String workspaceId, long version) {
        List<LayeredPolicyResolver.LayerInput> layers = new ArrayList<>();
        layers.add(layer(PolicyLayer.INSTANCE,
                ruleRepository.findByLayerAndOwnerIdIsNullOrderByCreatedAtAscIdAsc(LAYER_INSTANCE)));
        if (userId != null) {
            layers.add(layer(PolicyLayer.USER,
                    ruleRepository.findByLayerAndOwnerIdOrderByCreatedAtAscIdAsc(LAYER_USER, userId)));
        }
        if (workspaceId != null) {
            layers.add(layer(PolicyLayer.WORKSPACE,
                    ruleRepository.findByLayerAndOwnerIdOrderByCreatedAtAscIdAsc(LAYER_WORKSPACE, workspaceId)));
        }
        return new CachedContext(version, layers, loadFaces(workspaceId));
    }

    private static String cacheKey(String userId, String workspaceId) {
        return (userId == null ? "" : userId) + "|" + (workspaceId == null ? "" : workspaceId);
    }

    private Map<String, ToolFaceRegistry.Face> loadFaces(String workspaceId) {
        Map<String, ToolFaceRegistry.Face> faces = new HashMap<>();
        faceRepository.findByScopeAndOwnerIdIsNullOrderByCreatedAtAscIdAsc(SCOPE_INSTANCE)
                .forEach(face -> faces.put(face.getTool(), toFace(face)));
        if (workspaceId != null) {
            faceRepository.findByScopeAndOwnerIdOrderByCreatedAtAscIdAsc(SCOPE_WORKSPACE, workspaceId)
                    .forEach(face -> faces.put(face.getTool(), toFace(face)));
        }
        return faces;
    }

    private static LayeredPolicyResolver.LayerInput layer(PolicyLayer layer, List<PolicyRuleEntity> rows) {
        List<PolicyRule> rules = new ArrayList<>();
        long seq = 0;
        for (PolicyRuleEntity row : rows) {
            rules.add(new PolicyRule(row.getActionClass(), row.getResource(), toEffect(row.getEffect()),
                    row.getPriority(), row.isLocked(), seq++));
        }
        return new LayeredPolicyResolver.LayerInput(layer, rules);
    }

    private static ToolFaceRegistry.Face toFace(ToolFaceEntity entity) {
        return new ToolFaceRegistry.Face(entity.getActionClass(), toShape(entity.getShape()));
    }

    private static PolicyEffect toEffect(String value) {
        return PolicyEffect.valueOf(value.toUpperCase());
    }

    private static ToolShape toShape(String value) {
        return ToolShape.valueOf(value.toUpperCase());
    }
}
