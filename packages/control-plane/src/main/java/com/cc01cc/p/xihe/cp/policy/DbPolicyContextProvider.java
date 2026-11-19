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

            // Tier first (D-1908 rev4): the session tier is derived from the single permission tier
            // (view/workspace -> manual, full -> auto); the workspace/inherited mode is a lower layer.
            TierResolution session = resolveTier(sessionId);
            ApprovalConfig config = approvalConfig(userId, workspaceId);
            String inheritedMode = config == null ? null : config.mode();

            // Strictest-wins (D-1908 §1): a session tier may only tighten, never relax, the inherited
            // layer. Before task-107 a non-null session value overrode the config outright.
            String mode;
            PolicyLayer modeLayer;
            if (session.mode() != null
                    && SessionPermissionTier.strictestMode(session.mode(), inheritedMode).equals(session.mode())) {
                mode = session.mode();
                modeLayer = session.layer();
            } else if (inheritedMode != null) {
                mode = inheritedMode;
                modeLayer = config.layer();
            } else {
                mode = null;
                modeLayer = null;
            }

            // Effective tier mirrors the winning mode so audit/UI can tell SESSION / WORKSPACE /
            // INSTANCE apart; a fail-closed read reports the forced tier with an INSTANCE source.
            String tier;
            PolicyLayer tierSourceLayer;
            if (session.tier() != null && mode != null && mode.equals(session.mode())) {
                tier = session.tier();
                tierSourceLayer = session.layer();
            } else if (inheritedMode != null) {
                tier = SessionPermissionTier.tierForMode(inheritedMode);
                tierSourceLayer = config.layer();
            } else {
                tier = null;
                tierSourceLayer = null;
            }

            // Ask list (PLAN-0407 T2.8): config value > code default; never session-overridden.
            List<String> ask = config == null ? null : config.askActionClasses();
            PolicyLayer askLayer = config == null || config.askActionClasses() == null
                    ? PolicyLayer.BUILTIN : config.layer();

            return new PolicyContext(cached.faces(), mode, modeLayer, session.mode(), ask, askLayer,
                    tier, tierSourceLayer, session.fallback());
        } catch (RuntimeException e) {
            log.error("[POLICY] failed to load policy context, failing closed userId={} workspaceId={} sessionId={}",
                    userId, workspaceId, sessionId, e);
            String sessionMode = sessionApprovalMode.modeOf(sessionId).orElse(null);
            return PolicyContext.failedClosed(sessionMode);
        }
    }

    /**
     * Principal-scoped overload (D-1908 prerequisite). The principal is an extension point for
     * task-107b (workspace-layer tiering + grant-side principal path); today it carries no tier of its
     * own, so the resolution is identical to the three-argument form.
     */
    @Override
    @Transactional(readOnly = true)
    public PolicyContext load(String userId, String workspaceId, String sessionId, String principalId) {
        // TODO(task-107b): fold principal-scoped strictness into resolveTier once grants carry a tier.
        return load(userId, workspaceId, sessionId);
    }

    /**
     * Resolves the session layer of the tier resolution: stored tier > legacy approval_mode column >
     * inherit. A failed read is not inherit — it fails closed to the strictest tier and is flagged so
     * the audit trail shows the degradation instead of a silent fallback.
     */
    private TierResolution resolveTier(String sessionId) {
        try {
            Optional<String> storedTier = sessionApprovalMode.tierOf(sessionId);
            if (storedTier.isPresent()) {
                String tier = storedTier.get();
                return new TierResolution(tier, SessionPermissionTier.modeForTier(tier),
                        PolicyLayer.SESSION, null);
            }
            Optional<String> legacyMode = sessionApprovalMode.modeOf(sessionId);
            if (legacyMode.isPresent()) {
                String mode = legacyMode.get();
                return new TierResolution(SessionPermissionTier.tierForMode(mode), mode,
                        PolicyLayer.SESSION, null);
            }
            return new TierResolution(null, null, null, null);
        } catch (RuntimeException e) {
            String tier = SessionPermissionTier.FAIL_CLOSED_TIER;
            log.error("[POLICY] session permission tier unreadable, failing closed to {} sessionId={}",
                    tier, sessionId, e);
            return new TierResolution(tier, SessionPermissionTier.modeForTier(tier),
                    PolicyLayer.INSTANCE, SessionPermissionTier.FALLBACK_SESSION_READ_FAILED);
        }
    }

    /** Session layer of the tier resolution; {@code fallback} is non-null only after a failed read. */
    private record TierResolution(String tier, String mode, PolicyLayer layer, String fallback) {}

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
            // PLAN-0766: the shared default layer reports its own layer between user/workspace.
            case "workspace-default" -> PolicyLayer.WORKSPACE_DEFAULT;
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