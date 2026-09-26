package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.entity.ToolFaceEntity;
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
 * Loads persisted tool faces and the approval-policy inputs for one request (PLAN-0328 M1,
 * spec §8; PLAN-0407 T2.8 removed rule-layer loading — adjudication retired, design #18/#21).
 *
 * <p>Face order is instance → workspace; workspace faces override instance faces for the same
 * tool.</p>
 *
 * <p><b>Cache</b> (spec §4.3): tool faces are cached per {@code (userId|workspaceId)} key together
 * with the per-process {@link PolicyVersion}; writers bump the version to invalidate. The session
 * mode, approval mode and ask list are always read fresh (PLAN-0337 / PLAN-0407 T2.8), so they
 * are never cached with the face snapshot.</p>
 *
 * <p><b>Fail-closed</b>: any load failure is logged and yields {@link PolicyContext#failedClosed()}
 * (every builtin action class on the ask list), never allow (spec §4.3); failures are never cached.</p>
 */
@Component
@Primary
public class DbPolicyContextProvider implements PolicyContextProvider {

    private static final Logger log = LoggerFactory.getLogger(DbPolicyContextProvider.class);

    private static final String SCOPE_INSTANCE = "instance";
    private static final String SCOPE_WORKSPACE = "workspace";

    /** PLAN-0337: workspace-level approval mode lives in its own config domain. */
    static final String APPROVAL_POLICY_DOMAIN = "approval-policy";
    static final String APPROVAL_MODE_KEY = "mode";
    /** PLAN-0407 T2.8: the approval-policy ask list (design #19) lives in the same domain. */
    static final String APPROVAL_ASK_KEY = "askActionClasses";

    private static final com.fasterxml.jackson.databind.ObjectMapper ASK_MAPPER =
            new com.fasterxml.jackson.databind.ObjectMapper();

    private final ToolFaceRepository faceRepository;
    private final SessionApprovalMode sessionApprovalMode;
    private final PolicyVersion policyVersion;
    private final ConfigService configService;
    private final Map<String, CachedContext> cache = new ConcurrentHashMap<>();

    public DbPolicyContextProvider(ToolFaceRepository faceRepository,
                                   SessionApprovalMode sessionApprovalMode,
                                   PolicyVersion policyVersion, ConfigService configService) {
        this.faceRepository = faceRepository;
        this.sessionApprovalMode = sessionApprovalMode;
        this.policyVersion = policyVersion;
        this.configService = configService;
    }

    /** DB-only snapshot of tool faces; both mode sources and the ask list stay fresh. */
    private record CachedContext(long version,
                                 Map<String, ToolFaceRegistry.Face> faces) {
        CachedContext {
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
                cached = loadDbContext(workspaceId, version);
                cache.put(cacheKey, cached);
            }

            // Mode precedence (PLAN-0337；PLAN-0364 决策 #9): session override >
            // config 链（workspace > user > instance，env 命中视为 instance 钉死）> builtin manual.
            String sessionMode = sessionApprovalMode.modeOf(sessionId).orElse(null);
            String mode = sessionMode;
            PolicyLayer modeLayer = sessionMode == null ? null : PolicyLayer.SESSION;
            ApprovalConfig config = approvalConfig(userId, workspaceId);
            if (mode == null && config != null && config.mode() != null) {
                mode = config.mode();
                modeLayer = config.layer();
            }
            // Ask list (PLAN-0407 T2.8): config value > code default; never session-overridden.
            List<String> ask = config == null ? null : config.askActionClasses();
            PolicyLayer askLayer = config == null || config.askActionClasses() == null
                    ? PolicyLayer.BUILTIN : config.layer();

            return new PolicyContext(cached.faces(), mode, modeLayer, mode, ask, askLayer);
        } catch (RuntimeException e) {
            // fail-closed: an unreadable context must never relax the decision
            log.error("[POLICY] context load failed, falling back to forced ask (fail-closed) "
                    + "userId={} workspaceId={} sessionId={}", userId, workspaceId, sessionId, e);
            String sessionMode = sessionApprovalMode.modeOf(sessionId).orElse(null);
            return PolicyContext.failedClosed(sessionMode);
        }
    }

    /**
     * Reads the approval mode and ask list from the {@code approval-policy} config domain and
     * reports the layer that actually supplied them (PLAN-0364 决策 #9；PLAN-0407 T2.8 ask list).
     *
     * <p>Read fresh (not cached with the face snapshot): config writes do not bump
     * {@link PolicyVersion}, so caching here would serve a stale mode after a settings change.</p>
     *
     * <p>Layer mapping follows the config resolution chain
     * ({@code workspace > user > instance > code default}); an env overlay is reported as
     * {@link PolicyLayer#INSTANCE} because env is the instance-level deployment lockdown
     * (PLAN-0364 决策 #2). Reporting the real source removes the previous mislabel where an
     * instance-layer value was audited as {@code WORKSPACE}.</p>
     *
     * <p>Fail-closed: an unreadable config or an unsupported value is logged and ignored so the
     * caller falls back to {@code manual} and the code default ask list; a broken config must
     * never relax the decision.</p>
     */
    private ApprovalConfig approvalConfig(String userId, String workspaceId) {
        if (workspaceId == null || workspaceId.isBlank()) {
            return null;
        }
        try {
            ConfigService.EffectiveConfig effective = configService.effective(
                    APPROVAL_POLICY_DOMAIN, parseUuid(userId), parseUuid(workspaceId));
            String mode = null;
            String raw = effective.entries().get(APPROVAL_MODE_KEY);
            if (raw != null && !raw.isBlank()) {
                String normalized = raw.trim().toLowerCase(java.util.Locale.ROOT);
                if (SessionPolicyState.MODES.contains(normalized)) {
                    mode = normalized;
                } else {
                    log.warn("[POLICY] ignoring unsupported {}.{} (fail-closed to manual)",
                            APPROVAL_POLICY_DOMAIN, APPROVAL_MODE_KEY);
                }
            }
            List<String> ask = null;
            String rawAsk = effective.entries().get(APPROVAL_ASK_KEY);
            if (rawAsk != null && !rawAsk.isBlank()) {
                ask = parseAskClasses(rawAsk);
            }
            if (mode == null && ask == null) {
                return null;
            }
            return new ApprovalConfig(mode, ask, layerOfSource(effective.source()));
        } catch (RuntimeException e) {
            log.error("[POLICY] approval-policy lookup failed, falling back to manual/default ask list "
                    + "userId={} workspaceId={}", userId, workspaceId, e);
            return null;
        }
    }

    /** Parses {@code askActionClasses} JSON text; malformed values log and fall back to the default. */
    private List<String> parseAskClasses(String raw) {
        try {
            com.fasterxml.jackson.databind.JsonNode node =
                    ASK_MAPPER.readTree(raw.trim());
            if (!node.isArray()) {
                throw new IllegalArgumentException("askActionClasses must be an array");
            }
            List<String> values = new ArrayList<>();
            for (com.fasterxml.jackson.databind.JsonNode item : node) {
                if (!item.isTextual()) {
                    throw new IllegalArgumentException("askActionClasses entries must be strings");
                }
                String value = item.asText().trim();
                if (value.isEmpty() || value.length() > 64) {
                    throw new IllegalArgumentException("askActionClasses entries must be 1-64 chars");
                }
                if (!values.contains(value)) {
                    values.add(value);
                }
            }
            return List.copyOf(values);
        } catch (Exception e) {
            // The raw value may be arbitrary config text; log only the failure type.
            log.warn("[POLICY] ignoring malformed {}.{} failureType={} (fail-closed to default ask list)",
                    APPROVAL_POLICY_DOMAIN, APPROVAL_ASK_KEY, e.getClass().getSimpleName());
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

    /** Config-resolved approval inputs; {@code null} fields mean "not configured". */
    private record ApprovalConfig(String mode, List<String> askActionClasses, PolicyLayer layer) {}

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

    private CachedContext loadDbContext(String workspaceId, long version) {
        return new CachedContext(version, loadFaces(workspaceId));
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

    private static ToolFaceRegistry.Face toFace(ToolFaceEntity entity) {
        return new ToolFaceRegistry.Face(entity.getActionClass(), toShape(entity.getShape()));
    }

    private static ToolShape toShape(String value) {
        return ToolShape.valueOf(value.toUpperCase());
    }
}
