package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.ConfigService;
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
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Loads persisted policy rules and tool faces for one request (PLAN-0328 M1, spec §4.1/§8).
 *
 * <p>Layer order is lowest→highest: INSTANCE → USER → WORKSPACE. Workspace faces override
 * instance faces for the same tool.</p>
 *
 * <p><b>Cache</b> (spec §4.3): the DB layers and tool faces are cached per {@code (userId|workspaceId)}
 * key together with the per-process {@link PolicyVersion}; writers bump the version to invalidate.
 * Session rules are memory-only ({@link SessionPolicyState}) and the session/workspace modes are
 * always read fresh (PLAN-0337), so neither is cached with the rule snapshot.</p>
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

    /** PLAN-0337: workspace-level approval mode lives in its own config domain. */
    static final String APPROVAL_POLICY_DOMAIN = "approval-policy";
    static final String APPROVAL_MODE_KEY = "mode";

    private final PolicyRuleRepository ruleRepository;
    private final ToolFaceRepository faceRepository;
    private final SessionPolicyState sessionState;
    private final SessionApprovalMode sessionApprovalMode;
    private final PolicyVersion policyVersion;
    private final ConfigService configService;
    private final Map<String, CachedContext> cache = new ConcurrentHashMap<>();

    public DbPolicyContextProvider(PolicyRuleRepository ruleRepository, ToolFaceRepository faceRepository,
                                   SessionPolicyState sessionState, SessionApprovalMode sessionApprovalMode,
                                   PolicyVersion policyVersion, ConfigService configService) {
        this.ruleRepository = ruleRepository;
        this.faceRepository = faceRepository;
        this.sessionState = sessionState;
        this.sessionApprovalMode = sessionApprovalMode;
        this.policyVersion = policyVersion;
        this.configService = configService;
    }

    /** DB-only snapshot of rules and tool faces; session rules and both mode sources stay fresh. */
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
        Optional<SessionPolicyState.Entry> sessionSnapshot = Optional.empty();
        try {
            sessionSnapshot = sessionState.snapshot(sessionId);
            long version = policyVersion.current();
            String cacheKey = cacheKey(userId, workspaceId);
            CachedContext cached = cache.get(cacheKey);
            if (cached == null || cached.version() != version) {
                cached = loadDbContext(userId, workspaceId, version);
                cache.put(cacheKey, cached);
            }

            List<LayeredPolicyResolver.LayerInput> layers = new ArrayList<>(cached.layers());

            // L4 session state is memory-only and never persisted (decision #28/#29)
            List<PolicyRule> sessionRules = sessionSnapshot.map(SessionPolicyState.Entry::rules).orElse(List.of());
            if (!sessionRules.isEmpty()) {
                layers.add(new LayeredPolicyResolver.LayerInput(PolicyLayer.SESSION, sessionRules));
            }
            // Mode precedence (PLAN-0337；PLAN-0364 决策 #9): session override >
            // config 链（workspace > user > instance，env 命中视为 instance 钉死）> builtin manual.
            String sessionMode = sessionApprovalMode.modeOf(sessionId).orElse(null);
            String mode = sessionMode;
            PolicyLayer modeLayer = sessionMode == null ? null : PolicyLayer.SESSION;
            if (mode == null) {
                ModeResolution configMode = approvalMode(userId, workspaceId);
                if (configMode != null) {
                    mode = configMode.mode();
                    modeLayer = configMode.layer();
                }
            }

            return new PolicyContext(layers, cached.faces(), mode, modeLayer);
        } catch (RuntimeException e) {
            // fail-closed: an unreadable rule set must never relax the decision
            log.error("[POLICY] context load failed, falling back to forced ask (fail-closed) "
                    + "userId={} workspaceId={} sessionId={}", userId, workspaceId, sessionId, e);
            String sessionMode = sessionApprovalMode.modeOf(sessionId).orElse(null);
            return PolicyContext.failedClosed(sessionMode);
        }
    }

    /**
     * Reads the approval mode from the {@code approval-policy} config domain and reports the
     * layer that actually supplied it (PLAN-0364 决策 #9).
     *
     * <p>Read fresh (not cached with the rule snapshot): config writes do not bump
     * {@link PolicyVersion}, so caching here would serve a stale mode after a settings change.</p>
     *
     * <p>Layer mapping follows the config resolution chain
     * ({@code workspace > user > instance > code default}); an env overlay is reported as
     * {@link PolicyLayer#INSTANCE} because env is the instance-level deployment lockdown
     * (PLAN-0364 决策 #2). Reporting the real source removes the previous mislabel where an
     * instance-layer value was audited as {@code WORKSPACE}.</p>
     *
     * <p>Fail-closed: an unreadable config or an unsupported value is logged and ignored so the
     * caller falls back to {@code manual}; a broken config must never relax the decision.</p>
     */
    private ModeResolution approvalMode(String userId, String workspaceId) {
        if (workspaceId == null || workspaceId.isBlank()) {
            return null;
        }
        try {
            ConfigService.EffectiveConfig effective = configService.effective(
                    APPROVAL_POLICY_DOMAIN, parseUuid(userId), parseUuid(workspaceId));
            String raw = effective.entries().get(APPROVAL_MODE_KEY);
            if (raw == null || raw.isBlank()) {
                return null;
            }
            String normalized = raw.trim().toLowerCase(java.util.Locale.ROOT);
            if (!SessionPolicyState.MODES.contains(normalized)) {
                log.warn("[POLICY] ignoring unsupported {}.{}={} (fail-closed to manual)",
                        APPROVAL_POLICY_DOMAIN, APPROVAL_MODE_KEY, raw);
                return null;
            }
            return new ModeResolution(normalized, layerOfSource(effective.source()));
        } catch (RuntimeException e) {
            log.error("[POLICY] approval-policy mode lookup failed, falling back to manual "
                    + "userId={} workspaceId={}", userId, workspaceId, e);
            return null;
        }
    }

    private static PolicyLayer layerOfSource(String source) {
        if (source == null) {
            return null;
        }
        return switch (source) {
            case "workspace" -> PolicyLayer.WORKSPACE;
            case "user" -> PolicyLayer.USER;
            case "instance", "env" -> PolicyLayer.INSTANCE;
            default -> null;
        };
    }

    private record ModeResolution(String mode, PolicyLayer layer) {}

    private static java.util.UUID parseUuid(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return java.util.UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            return null;
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
