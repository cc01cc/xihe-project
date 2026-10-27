package com.cc01cc.p.xihe.cp.config;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import jakarta.persistence.EntityManager;
import com.cc01cc.p.xihe.cp.entity.ConfigAuditEntity;
import com.cc01cc.p.xihe.cp.entity.ConfigEntity;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.repository.ConfigAuditRepository;
import com.cc01cc.p.xihe.cp.repository.ConfigJpaRepository;
import com.cc01cc.p.xihe.cp.provider.ProviderCatalogService;
import com.cc01cc.p.xihe.cp.provider.ProviderConnectionService;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0307: three-tier config resolution (workspace > user > instance) with
 * layer encapsulation (decision #19). Execution modules only ever consume the
 * merged effective view; layer concepts stay inside CP and the UI.
 */
@Service
public class ConfigService {

    @Autowired
    private org.springframework.beans.factory.ObjectProvider<com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService> apiRequestTemplates;

    private static final Logger log = LoggerFactory.getLogger(ConfigService.class);

    /**
     * Config domain target set (decision #13/#17/#37, extended by PLAN-0337 and PLAN-0373):
     * {@code approval-policy} carries the workspace-level approval mode (workspace-writable only —
     * the user layer must not expose a third place to set the approval mode, and instance-level
     * lockdown is expressed by locked deny/ask rules instead); {@code job-policy} (PLAN-0373) is
     * the job runtime-limit domain — instance default + hard cap, workspace can lower within the
     * cap, user layer never writable.
     */
    public static final Set<String> DOMAINS = Set.of(
        "llm-provider", "context-policy", "embedding", "rag",
        "agent-runtime", "agent-profile", "user-preference", "logging",
          "approval-policy", "agent-templates", "context-templates", "api-request-templates", "pricing", "job-policy");

    /**
     * PLAN-0554: the 12 domains exposed by the settings UI. The legacy
     * {@code context-templates} and operations-only {@code pricing} domains
     * remain readable by their owners but are not part of the config-page
     * metadata contract.
     */
    public static final Set<String> UI_DOMAINS = Set.of(
        "llm-provider", "context-policy", "embedding", "rag", "agent-runtime",
        "agent-profile", "user-preference", "logging", "approval-policy",
        "agent-templates", "api-request-templates", "job-policy");

    /** Explicit-layer domains: no effective merge and no cross-layer fallback. */
    private static final Set<String> EXPLICIT_ONLY_DOMAINS = Set.of(
        "agent-templates", "context-templates", "api-request-templates");

    /** Whole-unit domains edited by dedicated panels, not the generic Instance rows. */
    private static final Set<String> INSTANCE_DEDICATED_DOMAINS = Set.of(
        "llm-provider", "embedding", "agent-templates", "context-templates",
        "api-request-templates", "pricing");

    private static final Set<String> USER_WRITABLE_DOMAINS = Set.of(
        "llm-provider", "context-policy", "embedding", "rag",
          "agent-runtime", "agent-profile", "user-preference", "agent-templates", "context-templates");

    private static final Set<String> WORKSPACE_WRITABLE_DOMAINS = Set.of(
        "llm-provider", "context-policy", "embedding", "rag", "agent-runtime",
          "approval-policy", "agent-templates", "context-templates", "job-policy");

    /** Decision #17: instructions is instance-level behaviour, never user/workspace writable. */
    private static final Map<String, Set<String>> INSTANCE_ONLY_KEYS = Map.of(
        "agent-runtime", Set.of("instructions",
            // PLAN-0492 决策 #19/#20: run budget hard ceilings are instance-level
            // only (0 = no ceiling); non-instance writes throw ConfigAccessException.
            "runMaxTurnsCeiling", "runMaxElapsedSecondsCeiling", "runMaxTokensCeiling",
            // PLAN-0493 决策 #12/#19: loop escalate/window ceilings are also
            // instance-only (tier-1 thresholds stay user/workspace tunable —
            // raising them only delays a gentle hint).
            "loopRepeatEscalateCeiling", "loopErrorRunEscalateCeiling",
            "loopStaleResultEscalateCeiling", "loopWindowSizeCeiling"));

    /**
     * PLAN-0343 decision #11: pricing is the single cost authority and is an
     * instance-level operations concern (bill rates), not user/workspace tunable.
     */
    private static final Set<String> INSTANCE_ONLY_DOMAINS = Set.of("pricing");

    /** PLAN-0554: explicit-layer template domains keep their read-only builtin access. */
    public static boolean isExplicitOnlyDomain(String domain) {
        return EXPLICIT_ONLY_DOMAINS.contains(domain);
    }

    /** PLAN-0554: layer writability used by both meta and non-admin read filtering. */
    public static boolean isLayerWritable(String layer, String domain) {
        return switch (layer) {
            case "instance" -> true;
            case "user" -> USER_WRITABLE_DOMAINS.contains(domain) || isExplicitOnlyDomain(domain);
            case "workspace" -> WORKSPACE_WRITABLE_DOMAINS.contains(domain) || isExplicitOnlyDomain(domain);
            default -> false;
        };
    }

    /** PLAN-0554: instance-only keys must not be exposed in user/workspace views. */
    public static boolean isInstanceOnlyKey(String domain, String key) {
        return INSTANCE_ONLY_KEYS.getOrDefault(domain, Set.of()).contains(key);
    }

    /** PLAN-0554 R10: domains a non-admin can read at all (user/workspace writable). */
    public static boolean isReadableByNonAdmin(String domain) {
        return USER_WRITABLE_DOMAINS.contains(domain)
            || WORKSPACE_WRITABLE_DOMAINS.contains(domain)
            || isExplicitOnlyDomain(domain);
    }

    /**
     * Decision #24: resolved/effective include code defaults so the UI and the
     * execution modules agree on fallback values.
     */
    private static final Map<String, Map<String, String>> CODE_DEFAULTS = Map.of(
        "rag", Map.of(
            "chunkSize", "1000",
            "chunkOverlap", "200",
            "topK", "5",
            "minScore", "0.0"),
        "logging", Map.of(
            "logLevel", "INFO",
            "levelCp", "INFO",
            "levelAgent", "INFO",
            "levelRuntime", "INFO",
            // PLAN-0522: central telemetry relay is opt-in per instance; the
            // deployment still needs XIHE_TLM_URL/XIHE_TLM_INGEST_TOKEN.
            "centralTelemetryEnabled", "false"),
        // PLAN-0373 decision #8: job-policy code defaults — default 3600s (aligned
        // with the Runtime job fallback); max 0 = no cap configured (no clamping
        // until instance/env sets a positive ceiling).
        "job-policy", Map.of(
            "defaultTimeoutSecs", "3600",
            "maxTimeoutSecs", "0"),
        // PLAN-0492 decision #17/#19/#21: agent-runtime run-budget code defaults —
        // turns 25 / elapsed 600s (user 2026-10-12); token defaults calibrated
        // 2026-10-13 from real-provider runs (p95=25535 over 15 runs; see
        // PLAN-0492 evidence/m0-token-calibration.md): 38303 = p95×1.5,
        // 51070 = 2×p95. Ceilings 100/3600 clamp turns/elapsed; token ceiling
        // clamps the calibrated default upward only.
        "agent-runtime", Map.ofEntries(
            Map.entry("runMaxTurns", "25"),
            Map.entry("runMaxElapsedSeconds", "600"),
            Map.entry("runMaxTokens", "38303"),
            Map.entry("runMaxTurnsCeiling", "100"),
            Map.entry("runMaxElapsedSecondsCeiling", "3600"),
            Map.entry("runMaxTokensCeiling", "51070"),
            // PLAN-0493 decision #11/#19: loop/no-progress defaults (M0
            // calibrated 2026-10-13, all kept — evidence/m0-observed-repeats.md);
            // escalate/window ceilings (10/10/10/50) are instance-only and
            // 0 = no ceiling.
            Map.entry("loopRepeatWarn", "2"),
            Map.entry("loopRepeatRefuse", "3"),
            Map.entry("loopRepeatEscalate", "5"),
            Map.entry("loopErrorRunWarn", "3"),
            Map.entry("loopErrorRunEscalate", "5"),
            Map.entry("loopStaleResultWarn", "2"),
            Map.entry("loopStaleResultEscalate", "5"),
            Map.entry("loopWindowSize", "20"),
            Map.entry("loopRepeatEscalateCeiling", "10"),
            Map.entry("loopErrorRunEscalateCeiling", "10"),
            Map.entry("loopStaleResultEscalateCeiling", "10"),
            Map.entry("loopWindowSizeCeiling", "50")));

    @Autowired
    private ConfigJpaRepository repo;

    @Autowired
    private ConfigAuditRepository auditRepo;

    @Autowired
    private ProviderConnectionService providerConnectionService;

    @Autowired
    private ProviderCatalogService providerCatalog;

    @Autowired
    private org.springframework.context.ApplicationEventPublisher events;

    @Autowired
    private ConfigDomainSchema schemaValidator;

    /** PLAN-0556: administrator locks (read side only; writes go through ConfigLockAdminService). */
    @Autowired
    private ConfigLockService configLocks;

    @Autowired
    private EnvOverlayRegistry envOverlay;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private EmbeddingProfileService embeddingProfiles;

    /**
     * PLAN-0552: transition switch. Default false = strict per-layer profile
     * connection resolution; true restores the legacy workspace->user fallback
     * for a short rollback window only.
     */
    @org.springframework.beans.factory.annotation.Value(
            "${cp.llm.profile-legacy-connection-fallback:false}")
    private boolean legacyConnectionFallback;

    // PLAN-0505 review D-2: transaction-scope advisory lock serializing config
    // read-modify-write (putLayerInternal) against cascade cleanup
    // (cleanupProfiles) for the same layer/domain/scope.
    @Autowired
    private EntityManager em;

    public record EffectiveConfig(String domain, String revision, String source,
                                  Map<String, String> entries) {}

    /** PLAN-0554: per-key read-only provenance for the config UI. */
    public record ConfigKeyMeta(String key, String source, boolean locked, boolean writable,
                                String reason, boolean instanceEligible, boolean defaultPresent,
                                boolean overridable, boolean adminLocked, String lockReason) {}

    /** PLAN-0556: whether a key may be locked, and why not when it may not. */
    public record Lockability(boolean lockable, String reason) {}

    static String stripJsoncComments(String jsonc) {
        String[] lines = jsonc.split("\n", -1);
        StringBuilder sb = new StringBuilder(jsonc.length());
        for (String line : lines) {
            String trimmed = line.trim();
            if (trimmed.startsWith("//")) {
                sb.append('\n');
            } else {
                sb.append(line).append('\n');
            }
        }
        if (sb.length() > 0) {
            sb.setLength(sb.length() - 1);
        }
        return sb.toString();
    }

    // ------------------------------------------------------------------
    // Reads
    // ------------------------------------------------------------------

    /** Merged view for the current context; env overlay applied (decision #22). */
    public Map<String, String> resolveDomain(String domain, UUID userId, UUID workspaceId) {
        EffectiveConfig effective = effective(domain, userId, workspaceId);
        return effective.entries();
    }

    public String resolve(String domain, String key, UUID userId, UUID workspaceId) {
        // PLAN-0307 T2.14 (P1-1): the single-key channel merges env first, so
        // env-locked keys cannot silently fall back to a DB value.
        String envValue = envOverlay.activeOverrides(domain).get(key);
        if (envValue != null) {
            return envValue;
        }
        // PLAN-0556: admin lock sits directly below env — the pinning instance
        // value outranks workspace/user rows (env still wins, decision #3).
        if (isAdminLocked(domain, key)) {
            String lockedValue = keyOf(repo.findByLayerAndDomainAndConfigKey("instance", domain, key));
            if (lockedValue != null) {
                return lockedValue;
            }
        }
        String workspaceValue = workspaceId == null ? null
            : keyOf(repo.findByWorkspaceIdAndDomainAndConfigKey(workspaceId, domain, key));
        if (workspaceValue != null) {
            return workspaceValue;
        }
        String userValue = userId == null ? null
            : keyOf(repo.findByUserIdAndDomainAndConfigKey(userId, domain, key));
        if (userValue != null) {
            return userValue;
        }
        String instanceValue = keyOf(repo.findByLayerAndDomainAndConfigKey("instance", domain, key));
        if (instanceValue != null) {
            return instanceValue;
        }
        Map<String, String> defaults = CODE_DEFAULTS.getOrDefault(domain, Map.of());
        return defaults.get(key);
    }

    /** Raw single-layer entries for the UI (?layer=...) — no env overlay, no defaults. */
    public Map<String, String> layerEntries(String layer, String domain, UUID userId, UUID workspaceId) {
        Map<String, String> result = new LinkedHashMap<>();
        for (ConfigEntity entity : rowsForLayer(layer, domain, userId, workspaceId)) {
            result.put(entity.getConfigKey(), entity.getConfigValue());
        }
        return result;
    }

    /**
     * PLAN-0307 T2.7 (decisions #3/#22/#37): run-payload delivery of explicit
     * single-layer rows for the given domains. Env-locked keys are omitted so
     * the receiver's env-derived base keeps winning (executor transparency);
     * domains without explicit rows are omitted entirely.
     */
    public Map<String, Map<String, String>> overrides(String layer, Collection<String> domains,
                                                       UUID userId, UUID workspaceId) {
        Map<String, Map<String, String>> result = new LinkedHashMap<>();
        for (String domain : domains) {
            rejectEffectiveAgentTemplates(domain);
            rejectEffectiveContextTemplates(domain);
            Map<String, String> entries = layerEntries(layer, domain, userId, workspaceId);
            if (entries.isEmpty()) {
                continue;
            }
            Set<String> envLocked = envOverriddenKeys(domain);
            if (!envLocked.isEmpty()) {
                entries.keySet().removeIf(envLocked::contains);
            }
            // PLAN-0556: locked keys are delivered by the effective chain
            // (instance pin), never as a user/workspace override.
            Set<String> adminLocked = adminLockReasons(domain).keySet();
            if (!adminLocked.isEmpty()) {
                entries.keySet().removeIf(adminLocked::contains);
            }
            if (!entries.isEmpty()) {
                result.put(domain, entries);
            }
        }
        return result;
    }

    /** Keys whose env overlay is currently active for the domain (decision #22). */
    public Set<String> envOverriddenKeys(String domain) {
        return envOverlay.activeOverrides(domain).keySet();
    }

    /** PLAN-0307 T2.14: env-effective values for the UI lock metadata (T2.17). */
    public Map<String, String> envOverridden(String domain) {
        return envOverlay.activeOverrides(domain);
    }

    // ------------------------------------------------------------------
    // PLAN-0556: administrator lock surface
    // ------------------------------------------------------------------

    /** Keys the lock page may offer: the domain's schema properties. */
    public java.util.SortedSet<String> candidateKeys(String domain) {
        return new java.util.TreeSet<>(schemaValidator.propertyNames(domain));
    }

    /**
     * Decision #8: a key is lockable only when it is a schema scalar that could
     * otherwise be overridden — not env-backed, not instance-only, not a secret
     * and not part of a whole-unit (profile/template) domain.
     */
    public Lockability lockability(String domain, String key) {
        if (!schemaValidator.propertyNames(domain).contains(key)) {
            return new Lockability(false, "NO_SCHEMA");
        }
        if (isProviderSecretKey(key)) {
            return new Lockability(false, "SECRET_KEY");
        }
        if (envOverlay.mappedKeys(domain).contains(key)) {
            return new Lockability(false, "ENV_LOCKED");
        }
        if (INSTANCE_DEDICATED_DOMAINS.contains(domain)) {
            return new Lockability(false, "WHOLE_UNIT");
        }
        if (!schemaValidator.isScalarProperty(domain, key)) {
            return new Lockability(false, "WHOLE_UNIT");
        }
        if (isInstanceOnlyKey(domain, key) || INSTANCE_ONLY_DOMAINS.contains(domain)) {
            return new Lockability(false, "INSTANCE_ONLY");
        }
        if (!USER_WRITABLE_DOMAINS.contains(domain) && !WORKSPACE_WRITABLE_DOMAINS.contains(domain)) {
            return new Lockability(false, "NOT_OVERRIDABLE");
        }
        return new Lockability(true, null);
    }

    /** Current instance-layer value for a key (lock page value display/edit seed). */
    public String instanceValue(String domain, String key) {
        return keyOf(repo.findByLayerAndDomainAndConfigKey("instance", domain, key));
    }

    public boolean isAdminLocked(String domain, String key) {
        return adminLockReasons(domain).containsKey(key);
    }

    /**
     * Lock rows for a domain, or an empty map when the domain can never hold a
     * lock (whole-unit/instance-only/non-overridable/schema-less). The guard
     * keeps hot single-key readers ({@code resolve} from usage/telemetry/summary)
     * off the lock table entirely.
     */
    private Map<String, String> adminLockReasons(String domain) {
        boolean applicable = schemaValidator.hasSchema(domain)
                && !INSTANCE_DEDICATED_DOMAINS.contains(domain)
                && (USER_WRITABLE_DOMAINS.contains(domain) || WORKSPACE_WRITABLE_DOMAINS.contains(domain));
        return applicable ? configLocks.lockReasons(domain) : Map.of();
    }

    private void rejectAdminLocked(String domain, java.util.Collection<String> keys) {
        Map<String, String> reasons = adminLockReasons(domain);
        if (reasons.isEmpty()) {
            return;
        }
        List<String> hit = keys.stream().filter(reasons::containsKey).sorted().toList();
        if (!hit.isEmpty()) {
            throw new CpApiException(org.springframework.http.HttpStatus.CONFLICT,
                    "CONFIG_KEY_LOCKED",
                    "Config keys are locked by an administrator: " + String.join(", ", hit)
                            + "; reason: " + reasons.get(hit.get(0)));
        }
    }

    public EffectiveConfig effective(String domain, UUID userId, UUID workspaceId) {
        rejectEffectiveAgentTemplates(domain);
        rejectEffectiveContextTemplates(domain);
        Map<String, String> merged = new LinkedHashMap<>();
        List<ConfigEntity> rows = new ArrayList<>();
        String source = "default";

        List<ConfigEntity> instanceRows = rowsForLayer("instance", domain, null, null);
        rows.addAll(instanceRows);
        instanceRows.forEach(e -> merged.put(e.getConfigKey(), e.getConfigValue()));
        if (!instanceRows.isEmpty()) {
            source = "instance";
        }

        List<ConfigEntity> userRows = rowsForLayer("user", domain, userId, null);
        rows.addAll(userRows);
        userRows.forEach(e -> merged.put(e.getConfigKey(), e.getConfigValue()));
        if (!userRows.isEmpty()) {
            source = "user";
        }

        List<ConfigEntity> workspaceRows = rowsForLayer("workspace", domain, null, workspaceId);
        rows.addAll(workspaceRows);
        workspaceRows.forEach(e -> merged.put(e.getConfigKey(), e.getConfigValue()));
        if (!workspaceRows.isEmpty()) {
            source = "workspace";
        }

        // PLAN-0556: an admin-locked key resolves to its instance pin, which
        // outranks user/workspace rows; the env overlay below still wins.
        Map<String, String> lockedKeys = adminLockReasons(domain);
        if (!lockedKeys.isEmpty()) {
            Map<String, String> instanceValues = new LinkedHashMap<>();
            instanceRows.forEach(e -> instanceValues.put(e.getConfigKey(), e.getConfigValue()));
            for (String lockedKey : lockedKeys.keySet()) {
                String pinned = instanceValues.get(lockedKey);
                if (pinned != null) {
                    merged.put(lockedKey, pinned);
                }
            }
        }

        if (applyEnvOverlay(domain, merged)) {
            source = "env";
        }

        CODE_DEFAULTS.getOrDefault(domain, Map.of()).forEach(merged::putIfAbsent);
        return new EffectiveConfig(domain, revisionOf(rows), source, merged);
    }

    /**
     * PLAN-0554: per-key provenance for one layer. The result is computed from
     * the same rows/env/defaults used by {@link #effective}; nothing is cached.
     * User/workspace meta never exposes instance-only keys.
     */
    public List<ConfigKeyMeta> meta(String layer, String domain, UUID userId, UUID workspaceId) {
        boolean instanceLayer = "instance".equals(layer);
        boolean userLayer = "user".equals(layer);
        boolean workspaceLayer = "workspace".equals(layer);
        boolean explicitOnly = EXPLICIT_ONLY_DOMAINS.contains(domain);

        Map<String, String> instance = rowsToMap(rowsForLayer("instance", domain, null, null));
        Map<String, String> user = userLayer || workspaceLayer
            ? rowsToMap(rowsForLayer("user", domain, userId, null))
            : Map.of();
        Map<String, String> workspace = workspaceLayer
            ? rowsToMap(rowsForLayer("workspace", domain, null, workspaceId))
            : Map.of();
        Map<String, String> env = envOverlay.activeOverrides(domain);
        Map<String, String> defaults = CODE_DEFAULTS.getOrDefault(domain, Map.of());
        Map<String, String> adminLocked = adminLockReasons(domain);

        java.util.Set<String> keys = new java.util.TreeSet<>();
        if (explicitOnly) {
            if (instanceLayer) {
                keys.addAll(instance.keySet());
            } else if (userLayer) {
                keys.addAll(user.keySet());
            } else if (workspaceLayer) {
                keys.addAll(workspace.keySet());
            }
        } else if (instanceLayer) {
            keys.addAll(instance.keySet());
            keys.addAll(defaults.keySet());
        } else if (userLayer) {
            keys.addAll(user.keySet());
            keys.addAll(instance.keySet());
            keys.addAll(defaults.keySet());
        } else if (workspaceLayer) {
            keys.addAll(workspace.keySet());
            keys.addAll(user.keySet());
            keys.addAll(instance.keySet());
            keys.addAll(defaults.keySet());
        }
        keys.addAll(env.keySet());

        List<ConfigKeyMeta> result = new ArrayList<>(keys.size());
        for (String key : keys) {
            if (!instanceLayer && isInstanceOnlyKey(domain, key)) {
                continue;
            }
            boolean locked = env.containsKey(key);
            boolean adminLockedKey = adminLocked.containsKey(key);
            String source = locked ? "env"
                : explicitOnly ? explicitSource(layer, key, instance, user, workspace)
                : sourceFor(layer, key, instance, user, workspace, defaults);
            boolean domainWritable = isLayerWritable(layer, domain);
            boolean instanceOnly = !instanceLayer && isInstanceOnlyKey(domain, key);
            boolean writable = domainWritable && !locked && !instanceOnly && !adminLockedKey;
            String reason = locked ? "ENV_LOCKED"
                : adminLockedKey ? "ADMIN_LOCKED"
                : !domainWritable ? "LAYER_NOT_WRITABLE"
                : instanceOnly ? "INSTANCE_ONLY" : null;
            boolean eligible = instanceLayer && !INSTANCE_DEDICATED_DOMAINS.contains(domain);
            boolean overridable = instanceLayer
                && !isInstanceOnlyKey(domain, key)
                && !INSTANCE_ONLY_DOMAINS.contains(domain)
                && (USER_WRITABLE_DOMAINS.contains(domain) || WORKSPACE_WRITABLE_DOMAINS.contains(domain));
            result.add(new ConfigKeyMeta(key, source, locked, writable, reason, eligible,
                defaults.containsKey(key), overridable, adminLockedKey,
                adminLockedKey ? adminLocked.get(key) : null));
        }
        return result;
    }

    private static Map<String, String> rowsToMap(List<ConfigEntity> rows) {
        Map<String, String> result = new LinkedHashMap<>();
        for (ConfigEntity row : rows) {
            result.put(row.getConfigKey(), row.getConfigValue());
        }
        return result;
    }

    private static String explicitSource(String layer, String key,
                                         Map<String, String> instance,
                                         Map<String, String> user,
                                         Map<String, String> workspace) {
        return switch (layer) {
            case "instance" -> instance.containsKey(key) ? "instance" : "none";
            case "user" -> user.containsKey(key) ? "user" : "none";
            case "workspace" -> workspace.containsKey(key) ? "workspace" : "none";
            default -> "none";
        };
    }

    private static String sourceFor(String layer, String key,
                                    Map<String, String> instance,
                                    Map<String, String> user,
                                    Map<String, String> workspace,
                                    Map<String, String> defaults) {
        return switch (layer) {
            case "instance" -> instance.containsKey(key) ? "instance"
                : defaults.containsKey(key) ? "code" : "none";
            case "user" -> user.containsKey(key) ? "user"
                : instance.containsKey(key) ? "instance"
                : defaults.containsKey(key) ? "code" : "none";
            case "workspace" -> workspace.containsKey(key) ? "workspace"
                : user.containsKey(key) ? "user"
                : instance.containsKey(key) ? "instance"
                : defaults.containsKey(key) ? "code" : "none";
            default -> "none";
        };
    }

    private static void rejectEffectiveAgentTemplates(String domain) {
        if ("agent-templates".equals(domain)) {
            throw new ConfigAccessException("Agent templates must be read from one explicit config layer");
        }
    }

    private static void rejectEffectiveContextTemplates(String domain) {
        if ("context-templates".equals(domain) || "api-request-templates".equals(domain)) {
            throw new ConfigAccessException("Context templates must be read from one explicit config layer");
        }
    }

    private boolean applyEnvOverlay(String domain, Map<String, String> merged) {
        // PLAN-0307 T2.14: overlay source is the registry (decision #22); the
        // merge chain stays env > workspace > user > instance > code default.
        Map<String, String> overrides = envOverlay.activeOverrides(domain);
        overrides.forEach(merged::put);
        return !overrides.isEmpty();
    }

    private static String revisionOf(List<ConfigEntity> rows) {
        long maxUpdatedAt = rows.stream()
            .map(ConfigEntity::getUpdatedAt)
            .filter(Objects::nonNull)
            .mapToLong(java.time.Instant::toEpochMilli)
            .max()
            .orElse(0L);
        return maxUpdatedAt + ":" + rows.size();
    }

    private static String keyOf(Optional<ConfigEntity> entity) {
        return entity.map(ConfigEntity::getConfigValue).orElse(null);
    }

    private List<ConfigEntity> rowsForLayer(String layer, String domain, UUID userId, UUID workspaceId) {
        List<ConfigEntity> rows = new ArrayList<>(switch (layer) {
            case "instance" -> repo.findByLayerAndDomain("instance", domain);
            case "user" -> userId == null ? List.of() : repo.findByUserIdAndDomain(userId, domain);
            case "workspace" -> workspaceId == null ? List.of() : repo.findByWorkspaceIdAndDomain(workspaceId, domain);
            default -> List.of();
        });
        rows.sort(Comparator.comparing(ConfigEntity::getConfigKey));
        return rows;
    }

    // ------------------------------------------------------------------
    // Writes
    // ------------------------------------------------------------------

    @Transactional
    public void putLayer(String layer, String domain, Map<String, String> entries,
                         String changedBy, UUID userId, UUID workspaceId) {
        putLayerInternal(layer, domain, entries, changedBy, userId, workspaceId, false);
    }

    /**
     * PLAN-0556: the lock endpoint is the only writer of a locked instance
     * value, so its value write bypasses the admin-lock guard while every other
     * guard (env, scope, schema, secrets, instructions) still applies.
     */
    @Transactional
    public void putInstanceLockValue(String domain, String key, String value, String changedBy) {
        putLayerInternal("instance", domain, Map.of(key, value), changedBy, null, null, true);
    }

    private void putLayerInternal(String layer, String domain, Map<String, String> entries,
                                  String changedBy, UUID userId, UUID workspaceId,
                                  boolean bypassAdminLock) {
        Set<String> envLocked = envOverriddenKeys(domain);
        if (!envLocked.isEmpty()) {
            List<String> lockedKeys = new ArrayList<>();
            for (String key : entries.keySet()) {
                if (envLocked.contains(key)) {
                    lockedKeys.add(key);
                }
            }
            if (!lockedKeys.isEmpty()) {
                lockedKeys.sort(String::compareTo);
                throw new CpApiException(org.springframework.http.HttpStatus.CONFLICT,
                    "CONFIG_ENV_LOCKED",
                    "Env-locked config keys cannot be written: " + String.join(", ", lockedKeys));
            }
        }
        if (!bypassAdminLock) {
            rejectAdminLocked(domain, entries.keySet());
        }
        if ("api-request-templates".equals(domain)) {
            apiRequestTemplates.getObject().putLayer(layer, entries, changedBy, userId, workspaceId);
            return;
        }
        validateLayerScope(layer, domain, entries, userId, workspaceId);
        rejectProviderSecrets(domain, entries);
        validateInstructionsScope(layer, domain, entries);
        Map<String, String> effectiveEntries = entries;
        Set<String> clearLlmKeys = new java.util.LinkedHashSet<>();
        if ("llm-provider".equals(domain)) {
            effectiveEntries = new LinkedHashMap<>(entries);
            // PLAN-0504: an empty profile value clears the layer row so the
            // layer inherits again (embedding round-4 item 1 semantics).
            // PLAN-0523 T2.1: imageProfile/modelParams follow the same
            // whole-unit clear semantics (blank clears; "{}" clears modelParams).
            String profileRaw = effectiveEntries.get("profile");
            if (profileRaw != null && profileRaw.isBlank()) {
                effectiveEntries.remove("profile");
                clearLlmKeys.add("profile");
            }
            String imageRaw = effectiveEntries.get("imageProfile");
            if (imageRaw != null && imageRaw.isBlank()) {
                effectiveEntries.remove("imageProfile");
                clearLlmKeys.add("imageProfile");
            }
            String modelParamsRaw = effectiveEntries.get("modelParams");
            if (modelParamsRaw != null
                    && (modelParamsRaw.isBlank() || modelParamsRaw.trim().equals("{}"))) {
                effectiveEntries.remove("modelParams");
                clearLlmKeys.add("modelParams");
            }
        }
        List<String> errors = validateBySchema(domain, effectiveEntries);
        if (!errors.isEmpty()) {
            throw new IllegalArgumentException(
                "Schema validation failed: " + String.join("; ", errors));
        }
        if ("context-templates".equals(domain)) {
            validateContextTemplateUpdate(layer, effectiveEntries, userId, workspaceId);
        }
        if ("llm-provider".equals(domain)) {
            List<String> providerErrors = validateProviderProfile(
                layer, effectiveEntries, userId, workspaceId);
            if (!providerErrors.isEmpty()) {
                throw new IllegalArgumentException(
                    "Provider validation failed: " + String.join("; ", providerErrors));
            }
        }
        if ("embedding".equals(domain)) {
            if (effectiveEntries.isEmpty()) {
                // An empty PUT replaces the layer profile with nothing: delete
                // the whole-unit row so the layer inherits again (round-4 item 1).
                deleteKey(layer, "embedding", "profile", changedBy, userId, workspaceId);
                return;
            }
            validateEmbeddingLayer(layer, effectiveEntries);
        }
        putLayerInternal(layer, domain, effectiveEntries, changedBy, userId, workspaceId);
        for (String key : clearLlmKeys) {
            deleteKey(layer, "llm-provider", key, changedBy, userId, workspaceId);
        }
        publishLoggingChanged(domain, layer);
    }

    /**
     * PLAN-0485 round-4 item 1: the embedding domain only carries the whole
     * profile unit. A PUT must replace that layer's profile atomically — an
     * empty map clears it to inherit, anything else must be exactly the
     * complete three-field profile (no partial key writes/merges).
     */
    private void validateEmbeddingLayer(String layer, Map<String, String> entries) {
        if (entries.isEmpty()) {
            return;
        }
        Set<String> keys = entries.keySet();
        if (keys.size() != 1 || !keys.contains("profile")) {
            throw new CpApiException(org.springframework.http.HttpStatus.BAD_REQUEST,
                "INVALID_REQUEST", "Embedding config accepts only the whole profile unit");
        }
        String value = entries.get("profile");
        if (value == null || value.isBlank()) {
            return;
        }
        embeddingProfiles.parseProfile(value);
    }

    private void validateContextTemplateUpdate(String layer, Map<String, String> proposedEntries,
                                               UUID userId, UUID workspaceId) {
        JsonNode proposedTemplates = parseJsonValue(proposedEntries.get("templates"), "templates");
        JsonNode oldTemplates = parseJsonValue(
                layerEntries(layer, "context-templates", userId, workspaceId).get("templates"), "templates");
        if (!proposedTemplates.isArray() || !oldTemplates.isArray()) {
            throw new IllegalArgumentException("context-templates.templates must be an array");
        }

        Map<String, JsonNode> oldRevisions = templateRevisions(oldTemplates);
        Map<String, JsonNode> newRevisions = templateRevisions(proposedTemplates);
        Map<String, Integer> oldLatest = templateLatestVersions(oldTemplates);
        Map<String, Integer> newLatest = templateLatestVersions(proposedTemplates);
        for (Map.Entry<String, JsonNode> old : oldRevisions.entrySet()) {
            if (!old.getValue().equals(newRevisions.get(old.getKey()))) {
                throw new CpApiException(org.springframework.http.HttpStatus.CONFLICT,
                        "CONTEXT_TEMPLATE_REVISION_IMMUTABLE",
                        "Existing context template revisions cannot be changed or deleted");
            }
        }
        for (Map.Entry<String, Integer> latest : newLatest.entrySet()) {
            int previous = oldLatest.getOrDefault(latest.getKey(), 0);
            if (latest.getValue() > previous && latest.getValue() != previous + 1) {
                throw new IllegalArgumentException("A context template update must append exactly the next version");
            }
        }
        validateTemplateDefaults(layer, proposedEntries, proposedTemplates);
    }

    private void validateTemplateDefaults(String layer, Map<String, String> entries, JsonNode templates) {
        if ("workspace".equals(layer)
                && (entries.containsKey("defaultTemplate") || entries.containsKey("userDefault")
                || (entries.containsKey("providerModelDefaults")
                && !parseJsonValue(entries.get("providerModelDefaults"), "providerModelDefaults").isEmpty()))) {
            throw new IllegalArgumentException("Workspace context templates cannot define defaults in v1");
        }
        if ("user".equals(layer) && entries.containsKey("defaultTemplate")) {
            throw new IllegalArgumentException("defaultTemplate is reserved for the instance layer");
        }
        if ("instance".equals(layer)
                && (entries.containsKey("userDefault") || entries.containsKey("providerModelDefaults"))) {
            throw new IllegalArgumentException("Instance context templates may define only defaultTemplate");
        }
        if (entries.containsKey("userDefault")) {
            JsonNode ref = parseJsonValue(entries.get("userDefault"), "userDefault");
            if (!"user".equals(ref.path("layer").asText())) {
                throw new IllegalArgumentException("userDefault must reference a user-layer template");
            }
            requireTemplateReference(templates, ref);
        }
        if (entries.containsKey("defaultTemplate")) {
            JsonNode ref = parseJsonValue(entries.get("defaultTemplate"), "defaultTemplate");
            if (!"instance".equals(ref.path("layer").asText())) {
                throw new IllegalArgumentException("defaultTemplate must reference an instance-layer template");
            }
            requireTemplateReference(templates, ref);
        }
        if (entries.containsKey("providerModelDefaults")) {
            JsonNode defaults = parseJsonValue(entries.get("providerModelDefaults"), "providerModelDefaults");
            Set<String> providerModels = new HashSet<>();
            for (JsonNode item : defaults) {
                String pair = item.path("provider").asText().toLowerCase(Locale.ROOT)
                        + "\u0000" + item.path("model").asText().toLowerCase(Locale.ROOT);
                if (!providerModels.add(pair)) {
                    throw new IllegalArgumentException("Duplicate provider/model context template default");
                }
                JsonNode ref = objectMapper.createObjectNode()
                        .put("templateId", item.path("templateId").asText())
                        .put("version", item.path("version").asInt());
                requireTemplateReference(templates, ref);
            }
        }
    }

    private void requireTemplateReference(JsonNode templates, JsonNode ref) {
        String id = ref.path("templateId").asText();
        int version = ref.path("version").asInt();
        for (JsonNode template : templates) {
            if (id.equalsIgnoreCase(template.path("id").asText())
                    && version == template.path("version").asInt()) {
                return;
            }
        }
        throw new IllegalArgumentException("Context template default references a missing revision");
    }

    private JsonNode parseJsonValue(String value, String key) {
        if (value == null) {
            return objectMapper.createArrayNode();
        }
        try {
            return objectMapper.readTree(value);
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("context-templates." + key + " must be valid JSON", e);
        }
    }

    private Map<String, JsonNode> templateRevisions(JsonNode templates) {
        Map<String, JsonNode> result = new HashMap<>();
        for (JsonNode template : templates) {
            String id = template.path("id").asText().toLowerCase(Locale.ROOT);
            int version = template.path("version").asInt();
            if (result.putIfAbsent(id + ":" + version, template) != null) {
                throw new IllegalArgumentException("Duplicate context template id/version");
            }
        }
        return result;
    }

    private Map<String, Integer> templateLatestVersions(JsonNode templates) {
        Map<String, Integer> result = new HashMap<>();
        for (JsonNode template : templates) {
            result.merge(template.path("id").asText().toLowerCase(Locale.ROOT),
                    template.path("version").asInt(), Math::max);
        }
        return result;
    }

    /** PLAN-0307 T2.15: notify listeners after a logging instance-layer write. */
    private void publishLoggingChanged(String domain, String layer) {
        if ("logging".equals(domain) && "instance".equals(layer)) {
            events.publishEvent(new LoggingConfigChangedEvent("config-write"));
        }
    }

    private void validateLayerScope(String layer, String domain, Map<String, String> entries,
                                    UUID userId, UUID workspaceId) {
        switch (layer) {
            case "instance" -> {
                // ADMIN-only; enforced by the controller.
                // PLAN-0364 决策 #9（supersede PLAN-0337 选项①）：取消 instance 层的
                // workspace-only 拒绝——approval-policy 在 instance 层可写默认，审计来源层
                // 由 DbPolicyContextProvider 按 effective(...).source 回填。
            }
            case "user", "workspace" -> {
                // PLAN-0343 decision #11: pricing is instance-only (bill rates
                // are an operations concern; user/workspace layers never carry them).
                if (INSTANCE_ONLY_DOMAINS.contains(domain)) {
                    throw new ConfigAccessException(
                        "Domain is instance-only and cannot be written at layer " + layer + ": " + domain);
                }
                if ("user".equals(layer)) {
                    if (userId == null) {
                        throw new ConfigAccessException("User scope requires a user_id");
                    }
                    if (!USER_WRITABLE_DOMAINS.contains(domain)) {
                        throw new ConfigAccessException("Domain is not writable at the user layer: " + domain);
                    }
                } else {
                    if (workspaceId == null) {
                        throw new ConfigAccessException("Workspace scope requires a workspace_id");
                    }
                    if (!WORKSPACE_WRITABLE_DOMAINS.contains(domain)) {
                        throw new ConfigAccessException("Domain is not writable at the workspace layer: " + domain);
                    }
                }
            }
            default -> throw new IllegalArgumentException("Unknown config layer: " + layer);
        }
    }

    private void validateInstructionsScope(String layer, String domain, Map<String, String> entries) {
        Set<String> instanceOnly = INSTANCE_ONLY_KEYS.getOrDefault(domain, Set.of());
        if (instanceOnly.isEmpty() || "instance".equals(layer)) {
            return;
        }
        for (String key : instanceOnly) {
            if (entries.containsKey(key)) {
                throw new ConfigAccessException(
                    "Key is instance-only and cannot be written at layer " + layer + ": " + key);
            }
        }
    }

    private void rejectProviderSecrets(String domain, Map<String, String> entries) {
        boolean containsSecret = entries.keySet().stream().anyMatch(ConfigService::isProviderSecretKey);
        if (containsSecret) {
            throw new ConfigOwnershipException(
                "Provider credentials are stored in provider_connections, not in config layers");
        }
    }

    private static boolean isProviderSecretKey(String key) {
        String normalized = key.toLowerCase(Locale.ROOT);
        if (normalized.contains("apikey")
                || normalized.contains("secret")
                || normalized.contains("password")) {
            return true;
        }
        // maxTokens is a generation parameter, not a credential; runMaxTokens is
        // the PLAN-0492 run-budget parameter (same rule).
        if (normalized.contains("maxtoken")) {
            return false;
        }
        return normalized.contains("token");
    }

    /**
     * PLAN-0504: the llm-provider default identity is one whole profile unit
     * (decision #2/#4 — legacy provider/base-URL keys are retired, no compat
     * reads). A present profile must parse completely; its providerId must be
     * in the CP provider catalog (PLAN-0503 single-source accept set) and
     * user/workspace layers additionally require a ready connection visible at
     * that layer (decision #11: instance writes skip the connection check —
     * the consumer scope resolves the connection at run time).
     */
    private List<String> validateProviderProfile(String layer, Map<String, String> entries,
                                                 UUID userId, UUID workspaceId) {
        List<String> errors = new ArrayList<>();
        String raw = entries.get("profile");
        if (raw != null && !raw.isBlank()) {
            LlmProfile profile = parseLlmProfile(raw);
            if (profile != null) {
                Set<String> supported = providerCatalog.providerIds();
                if (!supported.contains(profile.providerId())) {
                    errors.add("profile.providerId is unsupported: " + profile.providerId());
                } else if (requiresReadyConnection(layer)
                        && !hasReadyProfileConnection(profile, layer, userId, workspaceId)) {
                    // PLAN-0307 T2.24 (review P1-5): provider readiness is grounded
                    // in provider_connections, not config keys (decision #21/#37).
                    errors.add("No ready provider connection for profile: "
                        + profile.providerId() + "/" + profile.connectionKey());
                }
            }
        }
        String imageRaw = entries.get("imageProfile");
        if (imageRaw != null && !imageRaw.isBlank()) {
            // PLAN-0523 decision #7/#14: imageProfile is the instance-layer global
            // default; user/workspace writes are rejected. Like the instance-layer
            // profile (decision #11), connection readiness is resolved at run time.
            if (requiresReadyConnection(layer)) {
                errors.add("imageProfile is instance-layer only");
            } else {
                LlmProfile imageProfile = parseProfileUnit(imageRaw, "imageProfile");
                if (imageProfile != null
                        && !providerCatalog.providerIds().contains(imageProfile.providerId())) {
                    errors.add("imageProfile.providerId is unsupported: " + imageProfile.providerId());
                }
            }
        }
        return errors;
    }

    private static boolean requiresReadyConnection(String layer) {
        return "user".equals(layer) || "workspace".equals(layer);
    }

    /**
     * PLAN-0552: strict mode resolves the ready connection only inside the
     * profile's own layer owner. Workspace profiles never borrow user
     * connections, user profiles never borrow workspace connections, and
     * instance profiles are validated at run time (no layer connection).
     * The transition switch restores the legacy workspace->user fallback.
     */
    private boolean hasReadyProfileConnection(LlmProfile profile, String layer,
                                              UUID userId, UUID workspaceId) {
        if (legacyConnectionFallback) {
            return legacyReadyProfileConnection(profile, userId, workspaceId);
        }
        if ("workspace".equals(layer)) {
            return workspaceId != null && providerConnectionService.findReadyByKey(
                    ProviderConnection.OWNER_WORKSPACE, workspaceId.toString(),
                    profile.providerId(), profile.connectionKey()).isPresent();
        }
        if ("user".equals(layer)) {
            return userId != null && providerConnectionService.findReadyByKey(
                    ProviderConnection.OWNER_USER, userId.toString(),
                    profile.providerId(), profile.connectionKey()).isPresent();
        }
        return false;
    }

    /** Legacy (PLAN-0307) workspace-first then user fallback; rollback only. */
    private boolean legacyReadyProfileConnection(LlmProfile profile, UUID userId, UUID workspaceId) {
        if (workspaceId != null && providerConnectionService.findReadyByKey(
                ProviderConnection.OWNER_WORKSPACE, workspaceId.toString(),
                profile.providerId(), profile.connectionKey()).isPresent()) {
            return true;
        }
        return userId != null && providerConnectionService.findReadyByKey(
                ProviderConnection.OWNER_USER, userId.toString(),
                profile.providerId(), profile.connectionKey()).isPresent();
    }

    // ------------------------------------------------------------------
    // PLAN-0504: llm-provider default profile (connection-level identity)
    // ------------------------------------------------------------------

    /** One complete llm-provider default profile unit. */
    public record LlmProfile(String providerId, String connectionKey, String model) {}

    /** Effective profile with the config layer it resolved from. */
    public record EffectiveLlmProfile(LlmProfile profile, String profileScope) {}

    /** Effective profile resolved to a concrete ready connection. */
    public record ResolvedLlmProfile(String providerId, String connectionKey, String model,
                                     String providerConnectionId, String connectionOwnerType,
                                     String connectionOwnerId, long connectionRevision,
                                     String profileScope) {}

    /**
     * Parse and validate one layer's `profile` value. Empty/absent means the
     * layer inherits; anything present must be the complete three-field unit
     * (no partial writes, no field merging — decision #4).
     */
    public LlmProfile parseLlmProfile(String raw) {
        return parseProfileUnit(raw, "LLM profile");
    }

    /**
     * PLAN-0523 T2.1: shared whole-unit parser for the identical
     * providerId/connectionKey/model shape used by `profile` and
     * `imageProfile`.
     */
    private LlmProfile parseProfileUnit(String raw, String fieldName) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        JsonNode node;
        try {
            node = objectMapper.readTree(raw);
        } catch (JsonProcessingException e) {
            throw new CpApiException(org.springframework.http.HttpStatus.BAD_REQUEST,
                    "INVALID_REQUEST", fieldName + " is not valid JSON");
        }
        if (node == null || !node.isObject()) {
            throw invalidProfileUnit(fieldName);
        }
        String providerId = node.path("providerId").asText(null);
        String connectionKey = node.path("connectionKey").asText(null);
        String model = node.path("model").asText(null);
        if (providerId == null || providerId.isBlank()
                || connectionKey == null || connectionKey.isBlank()
                || model == null || model.isBlank()
                || node.size() != 3) {
            throw invalidProfileUnit(fieldName);
        }
        return new LlmProfile(providerId, connectionKey, model);
    }

    private CpApiException invalidProfileUnit(String fieldName) {
        return new CpApiException(org.springframework.http.HttpStatus.BAD_REQUEST,
                "INVALID_REQUEST",
                fieldName + " must be a complete providerId/connectionKey/model unit");
    }

    private CpApiException invalidLlmProfile() {
        return invalidProfileUnit("LLM profile");
    }

    /**
     * Effective whole-layer profile: workspace wins whole, else user, else
     * instance; layers never merge fields and a blank row counts as absent.
     */
    public EffectiveLlmProfile effectiveLlmProfile(UUID userId, UUID workspaceId) {
        for (String layer : List.of("workspace", "user", "instance")) {
            if ("workspace".equals(layer) && workspaceId == null) {
                continue;
            }
            if ("user".equals(layer) && userId == null) {
                continue;
            }
            Optional<ConfigEntity> row = findExisting(
                    layer, "llm-provider", "profile", userId, workspaceId);
            if (row.isPresent()) {
                String raw = row.get().getConfigValue();
                if (raw != null && !raw.isBlank()) {
                    return new EffectiveLlmProfile(parseLlmProfile(raw), layer);
                }
            }
        }
        return new EffectiveLlmProfile(null, null);
    }

    /**
     * Resolve the effective profile to a concrete usable connection in the
     * profile's own layer (decision #4, 2026-10-26): workspace -> workspace,
     * user -> user, instance -> the consuming user's USER connection. A profile
     * that cannot be resolved fails with LLM_PROFILE_CONFLICT instead of
     * silently falling back to another owner. The transition switch restores
     * the legacy workspace->user fallback.
     */
    public ResolvedLlmProfile resolveLlmProfile(UUID userId, UUID workspaceId) {
        EffectiveLlmProfile effective = effectiveLlmProfile(userId, workspaceId);
        if (effective.profile() == null) {
            return null;
        }
        LlmProfile profile = effective.profile();
        ProviderConnection connection = legacyConnectionFallback
                ? legacyResolveConnection(profile, userId, workspaceId)
                : strictResolveConnection(profile, effective.profileScope(), userId, workspaceId);
        if (connection == null) {
            throw new CpApiException(org.springframework.http.HttpStatus.CONFLICT,
                    "LLM_PROFILE_CONFLICT",
                    "No usable provider connection matches the profile");
        }
        return new ResolvedLlmProfile(
                profile.providerId(), profile.connectionKey(), profile.model(),
                connection.getId().toString(), connection.getOwnerType(), connection.getOwnerId(),
                connection.getRevision(), effective.profileScope());
    }

    private ProviderConnection strictResolveConnection(LlmProfile profile, String profileScope,
                                                       UUID userId, UUID workspaceId) {
        if ("workspace".equals(profileScope)) {
            return workspaceId == null ? null : providerConnectionService.findReadyByKey(
                    ProviderConnection.OWNER_WORKSPACE, workspaceId.toString(),
                    profile.providerId(), profile.connectionKey()).orElse(null);
        }
        if ("user".equals(profileScope) || "instance".equals(profileScope)) {
            return userId == null ? null : providerConnectionService.findReadyByKey(
                    ProviderConnection.OWNER_USER, userId.toString(),
                    profile.providerId(), profile.connectionKey()).orElse(null);
        }
        return null;
    }

    private ProviderConnection legacyResolveConnection(LlmProfile profile, UUID userId,
                                                       UUID workspaceId) {
        ProviderConnection connection = workspaceId == null ? null
                : providerConnectionService.findReadyByKey(
                        ProviderConnection.OWNER_WORKSPACE, workspaceId.toString(),
                        profile.providerId(), profile.connectionKey()).orElse(null);
        if (connection == null && userId != null) {
            connection = providerConnectionService.findReadyByKey(
                    ProviderConnection.OWNER_USER, userId.toString(),
                    profile.providerId(), profile.connectionKey()).orElse(null);
        }
        return connection;
    }

    public static class ConfigOwnershipException extends IllegalArgumentException {
        public ConfigOwnershipException(String message) {
            super(message);
        }
    }

    // ------------------------------------------------------------------
    // PLAN-0505: llm-provider.profile cleanup on connection delete
    // ------------------------------------------------------------------

    /** A profile row that points at the deleted connection, with its scope. */
    public record ProfileHit(String layer, UUID userId, UUID workspaceId) {}

    private boolean profileTargetsConnection(String raw, String providerId, String connectionKey) {
        if (raw == null || raw.isBlank()) {
            return false;
        }
        try {
            LlmProfile profile = parseLlmProfile(raw);
            return profile.providerId().equals(providerId) && profile.connectionKey().equals(connectionKey);
        } catch (CpApiException malformed) {
            // A malformed profile row is skipped (M1): it neither counts as a
            // hit nor blocks the delete; the row stays for its owner to fix.
            return false;
        }
    }

    /**
     * PLAN-0505 review fix (decision #1 supersede): {@code connectionKey} is
     * only unique per {@code (owner_type, owner_id, provider_id)} and a
     * user/workspace profile resolves against its OWNER's own connection
     * ({@code findReadyByKey} in the row owner's scope), so a same-key row of
     * another user points at a different, surviving connection. Only the
     * instance layer is global; user/workspace rows count as hits only when
     * their owner scope matches the deleted connection's owner.
     */
    private boolean profileOwnedByDeletedConnection(ProfileHit hit, String ownerType, UUID ownerId) {
        if ("instance".equals(hit.layer())) {
            return true;
        }
        if ("user".equals(hit.layer())) {
            return "USER".equalsIgnoreCase(ownerType) && ownerId.equals(hit.userId());
        }
        return "WORKSPACE".equalsIgnoreCase(ownerType) && ownerId.equals(hit.workspaceId());
    }

    /**
     * PLAN-0505 delete-impact profile scan (T2.1): rows in the instance, user
     * and workspace layers whose {@code profile} unit points at this
     * connection (providerId + connectionKey match, owner-correlated for the
     * user/workspace layers — see {@link #profileOwnedByDeletedConnection}).
     * Malformed rows are skipped. Read-only.
     */
    public List<ProfileHit> profileImpact(String providerId, String connectionKey,
            String ownerType, UUID ownerId) {
        List<ProfileHit> hits = new ArrayList<>();
        for (ConfigEntity row : repo.findByLayerAndDomain("instance", "llm-provider")) {
            if ("profile".equals(row.getConfigKey())
                    && profileTargetsConnection(row.getConfigValue(), providerId, connectionKey)) {
                hits.add(new ProfileHit("instance", null, null));
            }
        }
        for (ConfigEntity row : repo.findByLayerAndDomain("user", "llm-provider")) {
            if ("profile".equals(row.getConfigKey())
                    && profileTargetsConnection(row.getConfigValue(), providerId, connectionKey)) {
                var hit = new ProfileHit("user", row.getUserId(), null);
                if (profileOwnedByDeletedConnection(hit, ownerType, ownerId)) {
                    hits.add(hit);
                }
            }
        }
        for (ConfigEntity row : repo.findByLayerAndDomain("workspace", "llm-provider")) {
            if ("profile".equals(row.getConfigKey())
                    && profileTargetsConnection(row.getConfigValue(), providerId, connectionKey)) {
                var hit = new ProfileHit("workspace", null, row.getWorkspaceId());
                if (profileOwnedByDeletedConnection(hit, ownerType, ownerId)) {
                    hits.add(hit);
                }
            }
        }
        return hits;
    }

    /**
     * PLAN-0505 cascade cleanup for one connection (T2.2): deletes every
     * profile row that {@link #profileImpact} would report. Idempotent on
     * missing rows; malformed rows are skipped (they neither match nor block).
     * Runs inside the caller's delete transaction; config audit rows are
     * written by the shared deleteKey path. The owner scope is locked with the
     * same domain advisory lock that {@code putLayerInternal} takes, so a
     * concurrent profile write cannot resurrect a row pointing at the deleted
     * connection (review D-2).
     */
    public int cleanupProfiles(String providerId, String connectionKey,
            String ownerType, UUID ownerId, String changedBy) {
        for (ProfileHit candidate : profileImpact(providerId, connectionKey, ownerType, ownerId)) {
            lockDomainScope(candidate.layer(), "llm-provider", candidate.userId(), candidate.workspaceId());
        }
        int removed = 0;
        for (ProfileHit hit : profileImpact(providerId, connectionKey, ownerType, ownerId)) {
            Optional<ConfigEntity> existing = findExisting(hit.layer(), "llm-provider", "profile",
                    hit.userId(), hit.workspaceId());
            if (existing.isPresent()
                    && profileTargetsConnection(existing.get().getConfigValue(), providerId, connectionKey)) {
                deleteKey(hit.layer(), "llm-provider", "profile", changedBy, hit.userId(), hit.workspaceId());
                removed++;
            }
        }
        return removed;
    }

    /**
     * PLAN-0505 review D-2: transaction advisory lock keyed by
     * {@code layer:scope:domain}, same derivation shape as
     * {@code ApiRequestTemplateService.lockScope} (different domain string, so
     * the two lock families never collide). Serializes config
     * read-modify-write ({@code putLayerInternal}) against cascade cleanup for
     * one scope; a writer holds at most its own scope's lock, and the delete
     * path takes owner scopes only, so no lock cycle is possible.
     */
    private void lockDomainScope(String layer, String domain, UUID userId, UUID workspaceId) {
        // PostgreSQL-only advisory lock, same dialect guard as
        // ApiRequestTemplateService.lockScope (H2 test databases lack the
        // function; there the pessimistic-row-lock-only semantics remain).
        if (em.getEntityManagerFactory().unwrap(org.hibernate.engine.spi.SessionFactoryImplementor.class)
                .getJdbcServices().getDialect() instanceof org.hibernate.dialect.PostgreSQLDialect) {
            String owner = layer + ":"
                    + ("user".equals(layer) ? userId : "workspace".equals(layer) ? workspaceId : "instance")
                    + ":" + domain;
            em.createNativeQuery("SELECT pg_advisory_xact_lock(hashtextextended(:owner, 0))")
                    .setParameter("owner", owner).getSingleResult();
        }
    }

    /** Layer/domain/scope violation (mapped to 403 by the controller). */
    public static class ConfigAccessException extends IllegalArgumentException {
        public ConfigAccessException(String message) {
            super(message);
        }
    }

    private void putLayerInternal(String layer, String domain, Map<String, String> entries,
                                  String changedBy, UUID userId, UUID workspaceId) {
        if ("api-request-templates".equals(domain)) {
            apiRequestTemplates.getObject().putLayer(layer, entries, changedBy, userId, workspaceId);
            return;
        }
        lockDomainScope(layer, domain, userId, workspaceId);
        for (Map.Entry<String, String> entry : entries.entrySet()) {
            String key = entry.getKey();
            String value = entry.getValue();

            Optional<ConfigEntity> existing = findExisting(layer, domain, key, userId, workspaceId);
            if (existing.isPresent()) {
                ConfigEntity entity = existing.get();
                String oldValue = entity.getConfigValue();
                entity.setConfigValue(value);
                entity.setUpdatedBy(changedBy);
                repo.save(entity);
                createAudit(entity, oldValue, value, changedBy);
            } else {
                ConfigEntity entity = new ConfigEntity();
                entity.setLayer(layer);
                entity.setUserId("user".equals(layer) ? userId : null);
                entity.setWorkspaceId("workspace".equals(layer) ? workspaceId : null);
                entity.setDomain(domain);
                entity.setConfigKey(key);
                entity.setConfigValue(value);
                entity.setUpdatedBy(changedBy);
                repo.save(entity);
                createAudit(entity, null, value, changedBy);
            }
        }
    }

    private Optional<ConfigEntity> findExisting(String layer, String domain, String key,
                                                UUID userId, UUID workspaceId) {
        return switch (layer) {
            case "instance" -> repo.findByLayerAndDomainAndConfigKey("instance", domain, key);
            case "user" -> repo.findByUserIdAndDomainAndConfigKey(userId, domain, key);
            case "workspace" -> repo.findByWorkspaceIdAndDomainAndConfigKey(workspaceId, domain, key);
            default -> Optional.empty();
        };
    }

    @Transactional
    public void deleteKey(String layer, String domain, String configKey, String changedBy,
                          UUID userId, UUID workspaceId) {
        deleteKeyInternal(layer, domain, configKey, changedBy, userId, workspaceId, false);
    }

    /**
     * PLAN-0556: unlock-with-clear path — the lock row is deleted first, so this
     * removal is allowed to skip the admin-lock guard.
     */
    @Transactional
    public void deleteInstanceKeyUnlocked(String domain, String configKey, String changedBy) {
        deleteKeyInternal("instance", domain, configKey, changedBy, null, null, true);
    }

    private void deleteKeyInternal(String layer, String domain, String configKey, String changedBy,
                                   UUID userId, UUID workspaceId, boolean bypassAdminLock) {
        if (!bypassAdminLock && isAdminLocked(domain, configKey)) {
            throw new CpApiException(org.springframework.http.HttpStatus.CONFLICT,
                    "CONFIG_KEY_LOCKED",
                    "Config key is locked by an administrator: " + configKey
                            + "; reason: " + adminLockReasons(domain).get(configKey));
        }
        if ("api-request-templates".equals(domain)) {
            throw new CpApiException(org.springframework.http.HttpStatus.CONFLICT,
                    "API_REQUEST_TEMPLATE_REVISION_IMMUTABLE", "Use the dedicated template/binding writer");
        }
        if ("embedding".equals(domain) && !"profile".equals(configKey)) {
            throw new CpApiException(org.springframework.http.HttpStatus.BAD_REQUEST,
                    "INVALID_REQUEST", "Embedding config only has the whole profile unit");
        }
        Optional<ConfigEntity> existing = findExisting(layer, domain, configKey, userId, workspaceId);
        if (existing.isPresent()) {
            ConfigEntity entity = existing.get();
            createAudit(entity, entity.getConfigValue(), null, changedBy);
            repo.delete(entity);
            publishLoggingChanged(domain, layer);
        }
    }

    public List<ConfigAuditEntity> getAuditLogByConfigId(String configId) {
        return auditRepo.findByConfigIdOrderByChangedAtDesc(configId);
    }

    // ------------------------------------------------------------------
    // Import / export (management plane, instance layer)
    // ------------------------------------------------------------------

    @Transactional
    public void importJsoncFromClasspath(String classpath, String layer, UUID userId, UUID workspaceId) {
        try {
            ClassPathResource resource = new ClassPathResource(classpath);
            if (!resource.exists()) {
                log.warn("JSONC file not found: {}", classpath);
                return;
            }
            try (InputStream is = resource.getInputStream()) {
                String content = new String(is.readAllBytes(), StandardCharsets.UTF_8);
                JsonNode root = objectMapper.readTree(stripJsoncComments(content));
                ImportReport report = importJsoncNode(root, layer, userId, workspaceId, "import");
                if (!report.warnings().isEmpty()) {
                    log.warn("Config import warnings from {}: {}", classpath, report.warnings());
                }
            }
        } catch (IOException e) {
            log.error("Failed to import JSONC from {}: {}", classpath, e.getMessage(), e);
        }
    }

    /** PLAN-0307 T2.21: import outcome (credentials are never restored). */
    public record ImportReport(int imported, int skipped, List<String> warnings) {}

    @Transactional
    public ImportReport importJsonc(String jsoncContent, String layer, UUID userId, UUID workspaceId) {
        return importJsonc(jsoncContent, layer, userId, workspaceId, "import");
    }

    @Transactional
    public ImportReport importJsonc(String jsoncContent, String layer, UUID userId, UUID workspaceId,
                                    String changedBy) {
        String stripped = stripJsoncComments(jsoncContent);
        try {
            JsonNode root = objectMapper.readTree(stripped);
            return importJsoncNode(root, layer, userId, workspaceId, changedBy);
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("Invalid JSONC content: " + e.getMessage(), e);
        }
    }

    public Optional<Map<String, String>> importDomainEntries(String jsoncContent, String domain) {
        String stripped = stripJsoncComments(jsoncContent);
        try {
            JsonNode root = objectMapper.readTree(stripped);
            JsonNode domainNode = root == null ? null : root.get(domain);
            if (domainNode == null) {
                return Optional.empty();
            }
            if (!domainNode.isObject()) {
                throw new IllegalArgumentException("Imported config domain must be an object: " + domain);
            }
            return Optional.of(configEntries(domainNode));
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("Invalid JSONC content: " + e.getMessage(), e);
        }
    }

    private ImportReport importJsoncNode(JsonNode root, String layer, UUID userId, UUID workspaceId,
                                         String changedBy) {
        int imported = 0;
        int skipped = 0;
        List<String> warnings = new ArrayList<>();
        Iterator<Map.Entry<String, JsonNode>> fields = root.fields();
        while (fields.hasNext()) {
            Map.Entry<String, JsonNode> entry = fields.next();
            String domain = entry.getKey();
            JsonNode domainNode = entry.getValue();
            if ("provider-connections".equals(domain)) {
                // PLAN-0307 T2.21 (decision #37): never restore credentials on
                // import — owner/workspace ids are not portable across instances.
                if (domainNode.isArray() && !domainNode.isEmpty()) {
                    skipped += domainNode.size();
                    warnings.add("provider-connections: " + domainNode.size()
                        + " credential(s) skipped - imports never restore credentials; "
                        + "rebuild them via the provider connections API/UI");
                }
                continue;
            }
            if (domainNode.isObject()) {
                Map<String, String> entries = configEntries(domainNode);
                int before = entries.size();
                Set<String> envLocked = envOverriddenKeys(domain);
                if (!envLocked.isEmpty()) {
                    entries.keySet().removeIf(envLocked::contains);
                }
                int removed = before - entries.size();
                if (removed > 0) {
                    skipped += removed;
                    warnings.add(domain + ": " + removed + " env-locked key(s) skipped");
                }
                // PLAN-0556: an admin lock is not bypassed by import either.
                Set<String> adminLocked = adminLockReasons(domain).keySet();
                if (!adminLocked.isEmpty()) {
                    int lockedBefore = entries.size();
                    entries.keySet().removeIf(adminLocked::contains);
                    int lockedSkipped = lockedBefore - entries.size();
                    if (lockedSkipped > 0) {
                        skipped += lockedSkipped;
                        warnings.add(domain + ": " + lockedSkipped + " admin-locked key(s) skipped");
                    }
                }
                if (!entries.isEmpty()) {
                    putLayer(layer, domain, entries, changedBy, userId, workspaceId);
                    imported += entries.size();
                }
            }
        }
        return new ImportReport(imported, skipped, warnings);
    }

    private static Map<String, String> configEntries(JsonNode domainNode) {
        Map<String, String> entries = new LinkedHashMap<>();
        Iterator<Map.Entry<String, JsonNode>> fields = domainNode.fields();
        while (fields.hasNext()) {
            Map.Entry<String, JsonNode> field = fields.next();
            // PLAN-0307 T2.17: nested values round-trip as JSON text, not empty scalars.
            JsonNode valueNode = field.getValue();
            String value = valueNode.isNull()
                ? ""
                : (valueNode.isContainerNode() ? valueNode.toString() : valueNode.asText());
            entries.put(field.getKey(), value);
        }
        return entries;
    }

    @Transactional
    public String exportJsonc(String layer, UUID userId, UUID workspaceId) {
        return exportJsonc(layer, userId, workspaceId, true);
    }

    /**
     * PLAN-0307 T2.21/T2.25: export = config KV (never key columns) + provider
     * connection metadata; `includeSecrets=false` additionally drops plaintext
     * credentials (ciphertext and key version are never exported either way).
     */
    @Transactional
    public String exportJsonc(String layer, UUID userId, UUID workspaceId, boolean includeSecrets) {
        List<ConfigEntity> configs = new ArrayList<>();
        if ("instance".equals(layer)) {
            for (String domain : DOMAINS) {
                configs.addAll(rowsForLayer(layer, domain, null, null));
            }
        } else {
            for (String domain : DOMAINS) {
                configs.addAll(rowsForLayer(layer, domain, userId, workspaceId));
            }
        }
        Map<String, Map<String, String>> byDomain = new LinkedHashMap<>();
        for (ConfigEntity c : configs) {
            byDomain.computeIfAbsent(c.getDomain(), k -> new LinkedHashMap<>())
                .put(c.getConfigKey(), c.getConfigValue());
        }
        try {
            ObjectNode root = objectMapper.createObjectNode();
            for (Map.Entry<String, Map<String, String>> domainEntry : byDomain.entrySet()) {
                ObjectNode domainNode = root.putObject(domainEntry.getKey());
                domainEntry.getValue().forEach(domainNode::put);
            }
            List<ProviderConnectionService.ConfigExportView> connections =
                    providerConnectionService.listForConfigExport(includeSecrets);
            if (!connections.isEmpty()) {
                ArrayNode connectionNodes = objectMapper.createArrayNode();
                for (ProviderConnectionService.ConfigExportView connection : connections) {
                    ObjectNode node = objectMapper.createObjectNode();
                    node.put("providerId", connection.providerId());
                    node.put("label", connection.label());
                    node.put("ownerType", connection.ownerType());
                    node.put("ownerId", connection.ownerId());
                    if (connection.baseUrl() != null) {
                        node.put("baseUrl", connection.baseUrl());
                    }
                    node.put("status", connection.status());
                    node.put("enabled", connection.enabled());
                    node.put("modelDiscovery", connection.modelDiscovery());
                    if (connection.manualModels() != null) {
                        node.set("manualModels", objectMapper.readTree(connection.manualModels()));
                    }
                    if (includeSecrets && connection.apiKey() != null) {
                        node.put("apiKey", connection.apiKey());
                    }
                    connectionNodes.add(node);
                }
                root.set("provider-connections", connectionNodes);
            }
            return objectMapper.writerWithDefaultPrettyPrinter().writeValueAsString(root);
        } catch (JsonProcessingException e) {
            throw new RuntimeException("Failed to serialize export", e);
        }
    }

    /** PLAN-0307 T2.25: connection count for the export audit record. */
    public long countProviderConnections() {
        return providerConnectionService.countForConfigExport();
    }

    private void createAudit(ConfigEntity entity, String oldValue,
                             String newValue, String changedBy) {
        ConfigAuditEntity audit = new ConfigAuditEntity();
        audit.setConfigId(entity.getId().toString());
        audit.setLayer(entity.getLayer());
        audit.setDomain(entity.getDomain());
        audit.setConfigKey(entity.getConfigKey());
        audit.setOldValue(auditValue(entity, oldValue));
        audit.setNewValue(auditValue(entity, newValue));
        audit.setChangedBy(changedBy);
        auditRepo.save(audit);
    }

    private String auditValue(ConfigEntity entity, String value) {
        if ("agent-templates".equals(entity.getDomain()) || "context-templates".equals(entity.getDomain())
                || "api-request-templates".equals(entity.getDomain())) {
            if (value == null || value.isBlank()) {
                return "missing";
            }
            return "present:" + sha256(value);
        }
        if (!"llm-provider".equals(entity.getDomain())
                || !isProviderSecretKey(entity.getConfigKey())) {
            return value;
        }
        if (value == null || value.isBlank()) {
            return "missing";
        }
        return "present:" + sha256(value);
    }

    private static String sha256(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }

    private List<String> validateBySchema(String domain, Map<String, String> entries) {
        if (!DOMAINS.contains(domain)) {
            return List.of("Unsupported domain: " + domain);
        }
        if (!schemaValidator.hasSchema(domain)) {
            return List.of();
        }
        // PLAN-0307 T2.17: structured values are stored as JSON text (decision
        // #24 storage contract). Container text must be parsed before schema
        // validation so nested domains (context-policy) validate as shapes
        // rather than strings; scalar text stays a string.
        Map<String, Object> raw = new LinkedHashMap<>();
        for (Map.Entry<String, String> entry : entries.entrySet()) {
            String value = entry.getValue();
            String trimmed = value == null ? "" : value.trim();
            if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
                try {
                    raw.put(entry.getKey(), objectMapper.readTree(trimmed));
                } catch (JsonProcessingException e) {
                    return List.of(entry.getKey() + " is not valid JSON");
                }
            } else {
                raw.put(entry.getKey(), value);
            }
        }
        JsonNode body = objectMapper.convertValue(raw, JsonNode.class);
        return schemaValidator.validate(domain, body);
    }
}
