package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.PolicyRuleEntity;
import com.cc01cc.p.xihe.cp.repository.PolicyRuleRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Authorization rule administration (PLAN-0328 M1, spec §5/§8, decisions #53/#56).
 *
 * <p>Guardrails:</p>
 * <ul>
 *   <li>layer 只允许 instance / user / workspace；instance 层需 ADMIN（且 owner 恒为 null）；</li>
 *   <li>user 层 owner 取本人；workspace 层 owner 取当前 workspace（L3 写入需 owner，决策 #58）；</li>
 *   <li>locked 仅 ADMIN 可设，且只能 deny/ask（与 V15 的 DB CHECK 一致）；</li>
 *   <li>删除按层校验归属，跨层/跨 owner 一律 404（不泄露存在性）。</li>
 * </ul>
 */
@Service
public class PolicyRuleService {

    public static final String LAYER_INSTANCE = "instance";
    public static final String LAYER_USER = "user";
    public static final String LAYER_WORKSPACE = "workspace";
    private static final Set<String> LAYERS = Set.of(LAYER_INSTANCE, LAYER_USER, LAYER_WORKSPACE);
    private static final Set<String> EFFECTS = Set.of("allow", "ask", "deny");
    private static final int MAX_ACTION_CLASS = 64;
    private static final int MAX_RESOURCE = 512;

    private final PolicyRuleRepository repository;

    public PolicyRuleService(PolicyRuleRepository repository) {
        this.repository = repository;
    }

    public record RuleInput(String actionClass, String resource, String effect, Integer priority, Boolean locked) {}

    public record RuleView(UUID id, String layer, String ownerId, String actionClass, String resource,
                           String effect, int priority, boolean locked, boolean effective, String conflict) {}

    public record DomainView(String actionClass, String effectiveLayer, List<String> configuredLayers,
                             Map<String, Integer> ruleCounts) {}

    @Transactional(readOnly = true)
    public List<RuleView> list(String layer, String userId, String workspaceId, boolean admin) {
        String owner = ownerFor(layer, userId, workspaceId, admin, false);
        List<PolicyRuleEntity> rules = owner == null
                ? repository.findByLayerAndOwnerIdIsNullOrderByCreatedAtAscIdAsc(layer)
                : repository.findByLayerAndOwnerIdOrderByCreatedAtAscIdAsc(layer, owner);
        Map<String, String> conflicts = conflictIndex(layer, owner);
        Set<String> effectiveDomains = effectiveDomains(layer, userId, workspaceId);
        List<RuleView> views = new ArrayList<>();
        for (PolicyRuleEntity rule : rules) {
            String conflict = conflicts.get(rule.getId().toString());
            boolean effective = effectiveDomains.contains(rule.getActionClass());
            views.add(new RuleView(rule.getId(), rule.getLayer(), rule.getOwnerId(), rule.getActionClass(),
                    rule.getResource(), rule.getEffect(), rule.getPriority(), rule.isLocked(),
                    effective, conflict));
        }
        return views;
    }

    @Transactional
    public RuleView create(String layer, String userId, String workspaceId, boolean admin, RuleInput input) {
        String owner = ownerFor(layer, userId, workspaceId, admin, true);
        String actionClass = requireText(input.actionClass(), "actionClass", MAX_ACTION_CLASS);
        String resource = requireText(input.resource(), "resource", MAX_RESOURCE);
        String effect = input.effect() == null ? "" : input.effect().toLowerCase();
        if (!EFFECTS.contains(effect)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "effect must be one of allow/ask/deny");
        }
        boolean locked = Boolean.TRUE.equals(input.locked());
        if (locked && !admin) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", "locked rules require ADMIN");
        }
        if (locked && "allow".equals(effect)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "locked rules may only be deny or ask");
        }
        int priority = input.priority() == null ? 0 : input.priority();

        PolicyRuleEntity entity = new PolicyRuleEntity(UUID.randomUUID(), layer, owner, actionClass,
                resource, effect, priority, locked, userId == null ? "system" : userId);
        repository.save(entity);
        return new RuleView(entity.getId(), layer, owner, actionClass, resource, effect, priority, locked,
                true, conflictOf(layer, owner, entity));
    }

    @Transactional
    public void delete(UUID id, String layer, String userId, String workspaceId, boolean admin) {
        String owner = ownerFor(layer, userId, workspaceId, admin, false);
        PolicyRuleEntity entity = repository.findById(id)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Rule not found"));
        boolean sameScope = layer.equals(entity.getLayer())
                && (owner == null ? entity.getOwnerId() == null : owner.equals(entity.getOwnerId()));
        if (!sameScope) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Rule not found");
        }
        repository.delete(entity);
    }

    /** Per-domain view: which layer is effective and how many rules each layer holds. */
    @Transactional(readOnly = true)
    public List<DomainView> domains(String userId, String workspaceId) {
        Map<String, List<PolicyRuleEntity>> byLayer = Map.of(
                LAYER_INSTANCE, repository.findByLayerAndOwnerIdIsNullOrderByCreatedAtAscIdAsc(LAYER_INSTANCE),
                LAYER_USER, userId == null ? List.of()
                        : repository.findByLayerAndOwnerIdOrderByCreatedAtAscIdAsc(LAYER_USER, userId),
                LAYER_WORKSPACE, workspaceId == null ? List.of()
                        : repository.findByLayerAndOwnerIdOrderByCreatedAtAscIdAsc(LAYER_WORKSPACE, workspaceId));

        Set<String> domains = new LinkedHashSet<>(ToolFaceRegistry.builtinActionClasses());
        byLayer.values().forEach(rules -> rules.forEach(rule -> domains.add(rule.getActionClass())));

        List<DomainView> views = new ArrayList<>();
        for (String domain : domains) {
            Map<String, Integer> counts = new LinkedHashMap<>();
            byLayer.forEach((layer, rules) -> {
                int count = (int) rules.stream().filter(rule -> domain.equals(rule.getActionClass())).count();
                if (count > 0) {
                    counts.put(layer, count);
                }
            });
            String effective = counts.containsKey(LAYER_WORKSPACE) ? LAYER_WORKSPACE
                    : counts.containsKey(LAYER_USER) ? LAYER_USER
                    : counts.containsKey(LAYER_INSTANCE) ? LAYER_INSTANCE : "builtin";
            views.add(new DomainView(domain, effective, List.copyOf(counts.keySet()), counts));
        }
        return views;
    }

    /** Static conflict check: an ALLOW that a same-layer, at-least-as-specific DENY kills. */
    @Transactional(readOnly = true)
    public List<RuleView> conflicts(String layer, String userId, String workspaceId, boolean admin) {
        return list(layer, userId, workspaceId, admin).stream()
                .filter(view -> view.conflict() != null)
                .toList();
    }

    /**
     * Domains for which {@code layer} is the effective layer (i.e. no higher layer configures that
     * domain) — mirrors "先选层再求值" so the UI can mark rules that actually take effect.
     */
    private Set<String> effectiveDomains(String layer, String userId, String workspaceId) {
        Set<String> workspaceDomains = domainsOf(LAYER_WORKSPACE, workspaceId);
        Set<String> userDomains = domainsOf(LAYER_USER, userId);
        Set<String> instanceDomains = domainsOf(LAYER_INSTANCE, null);
        return switch (layer) {
            case LAYER_WORKSPACE -> workspaceDomains;
            case LAYER_USER -> {
                Set<String> result = new LinkedHashSet<>(userDomains);
                result.removeAll(workspaceDomains);
                yield result;
            }
            default -> {
                Set<String> result = new LinkedHashSet<>(instanceDomains);
                result.removeAll(userDomains);
                result.removeAll(workspaceDomains);
                yield result;
            }
        };
    }

    private Set<String> domainsOf(String layer, String owner) {
        List<PolicyRuleEntity> rules = owner == null
                ? repository.findByLayerAndOwnerIdIsNullOrderByCreatedAtAscIdAsc(layer)
                : repository.findByLayerAndOwnerIdOrderByCreatedAtAscIdAsc(layer, owner);
        Set<String> domains = new LinkedHashSet<>();
        rules.forEach(rule -> domains.add(rule.getActionClass()));
        return domains;
    }

    private Map<String, String> conflictIndex(String layer, String owner) {
        List<PolicyRuleEntity> rules = owner == null
                ? repository.findByLayerAndOwnerIdIsNullOrderByCreatedAtAscIdAsc(layer)
                : repository.findByLayerAndOwnerIdOrderByCreatedAtAscIdAsc(layer, owner);
        Map<String, String> conflicts = new LinkedHashMap<>();
        for (PolicyRuleEntity rule : rules) {
            String conflict = conflictOf(layer, owner, rule);
            if (conflict != null) {
                conflicts.put(rule.getId().toString(), conflict);
            }
        }
        return conflicts;
    }

    private String conflictOf(String layer, String owner, PolicyRuleEntity rule) {
        if (!"allow".equals(rule.getEffect())) {
            return null;
        }
        List<PolicyRuleEntity> rules = owner == null
                ? repository.findByLayerAndOwnerIdIsNullOrderByCreatedAtAscIdAsc(layer)
                : repository.findByLayerAndOwnerIdOrderByCreatedAtAscIdAsc(layer, owner);
        for (PolicyRuleEntity other : rules) {
            if (!"deny".equals(other.getEffect()) || other.getId().equals(rule.getId())) {
                continue;
            }
            if (shadows(other.getResource(), rule.getResource())) {
                return "该 allow 不会生效：存在更具体的 deny \"" + other.getResource() + "\"";
            }
        }
        return null;
    }

    /**
     * True when {@code denyResource} covers the region of {@code allowResource} at least as
     * specifically — i.e. the ALLOW can never win for the requests the DENY matches.
     */
    private static boolean shadows(String denyResource, String allowResource) {
        if (denyResource.equals(allowResource)) {
            return true;
        }
        if (!allowResource.contains("*")) {
            // an exact ALLOW can only be killed by an identical DENY
            return false;
        }
        if (specificity(denyResource) < specificity(allowResource)) {
            // a broader DENY does not shadow a more specific ALLOW
            return false;
        }
        String sample = denyResource.replace("*", "");
        if (sample.isEmpty()) {
            return false;
        }
        return LayeredPolicyResolver.matches(allowResource, sample, ToolShape.INTERPRETER)
                || LayeredPolicyResolver.matches(allowResource, sample, ToolShape.STRUCTURED);
    }

    private static int specificity(String resource) {
        if (!resource.contains("*")) {
            return 2;
        }
        if (resource.endsWith("*") && resource.indexOf('*') == resource.length() - 1) {
            return 1;
        }
        return 0;
    }

    private static String requireText(String value, String field, int max) {
        if (value == null || value.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", field + " is required");
        }
        if (value.length() > max) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    field + " exceeds " + max + " characters");
        }
        return value.trim();
    }

    /**
     * Resolves the ownership scope for a layer.
     *
     * @param requireOwner when true, a missing identity for user/workspace layers is an error
     *                     (create path); list/delete tolerate it by returning null owner
     */
    private static String ownerFor(String layer, String userId, String workspaceId, boolean admin,
                                   boolean requireOwner) {
        if (layer == null || !LAYERS.contains(layer)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "layer must be one of instance/user/workspace");
        }
        return switch (layer) {
            case LAYER_INSTANCE -> {
                if (requireOwner && !admin) {
                    throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                            "instance-layer rules require ADMIN");
                }
                yield null;
            }
            case LAYER_USER -> {
                if (requireOwner && userId == null) {
                    throw new CpApiException(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED",
                            "User context is required");
                }
                yield userId;
            }
            default -> {
                if (requireOwner && workspaceId == null) {
                    throw new CpApiException(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED",
                            "Workspace context is required");
                }
                yield workspaceId;
            }
        };
    }
}
