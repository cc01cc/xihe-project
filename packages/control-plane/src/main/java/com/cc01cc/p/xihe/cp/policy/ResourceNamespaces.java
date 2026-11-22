package com.cc01cc.p.xihe.cp.policy;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * task-830 / DEV-037: the <b>one</b> registry of grant-resource namespaces.
 *
 * <p>A grant resource is a <b>namespace + value</b> canonical string ({@code fs:<workspaceId>/<rel>},
 * {@code credential:<uuid>}, {@code skill:<uuid>}). Before this class every prefix was a literal in
 * its consumer ({@code ResourceIdentity}, {@code ToolFaceRegistry}), so a new family meant touching
 * several parsers and nothing forced an unknown namespace to fail closed. The registry declares,
 * per namespace, the matcher that decides coverage and whether the namespace may be written to a
 * grant at all:</p>
 *
 * <ul>
 *   <li>{@link Matcher#EXACT} — equal values, plus a {@code ns:*} ceiling. {@code credential} keeps
 *       its own stricter rule in {@link ToolFaceRegistry#isCanonicalCredentialResource}.</li>
 *   <li>{@link Matcher#PREFIX} — equal value or a slash-segment prefix ({@code fs:ws/a} covers
 *       {@code fs:ws/a/b}). This is why the legacy single-segment {@code fs:<workspaceId>} covers the
 *       whole workspace.</li>
 *   <li>{@link Matcher#TREE} — reserved for a hierarchical family (an org-unit ltree, say). It is a
 *       declared type here, but <b>no {@code org:} namespace is registered</b>: visibility scope
 *       stays in conditions, not in the resource axis (DEV-037 §2).</li>
 * </ul>
 *
 * <p><b>Grantability</b> is separate from the matcher. {@code phys:} is evaluation-only (the
 * physical key is derived from an {@code fs:} declaration at evaluation time and must never be
 * persisted — it would pin a grant to one host's absolute path). {@code workspace:} and
 * {@code session:} are <b>context</b>, not resources; {@code workspace:admin} is a capability atom,
 * same spelling, different meaning. Anything else is unknown and fails closed.</p>
 */
public final class ResourceNamespaces {

    /** How a namespace decides coverage. {@code TREE} is the reserved hierarchical type. */
    public enum Matcher { EXACT, PREFIX, TREE }

    /** Whether a namespace may appear in a persisted grant resource. */
    public enum Grantability {
        /** May be written to {@code grant_preset_atoms}/grants. */
        GRANTABLE,
        /** Constructed during evaluation only; never persisted, never accepted from an API. */
        EVALUATION_ONLY,
        /** A context key (workspace/session), not a resource key. */
        CONTEXT_RESERVED,
        /** Not registered at all — fail closed. */
        UNKNOWN
    }

    public record Namespace(String name, Matcher matcher, Grantability grantability) {}

    public static final String FS = "fs";
    public static final String PHYS = "phys";
    public static final String CREDENTIAL = "credential";
    public static final String SKILL = "skill";

    /** Context namespaces that look like resources but are not (empty on purpose). */
    public static final String WORKSPACE_CONTEXT = "workspace";
    public static final String SESSION_CONTEXT = "session";

    /** Reserved hierarchical namespace name; deliberately <b>not</b> registered (DEV-037 §2). */
    public static final String ORG_TREE = "org";

    public static final String WILDCARD = "*";
    /**
     * task-835: the canonical resource of {@code action:approve}. Approving is always about
     * <b>this</b> request's object, so the atom must never default to {@link #WILDCARD} (one
     * approve grant would then approve every resource). The sentinel is the marker the evaluator
     * reads as "match the request's own resource"; the write face refuses it from an API.
     */
    public static final String REQUEST_RESOURCE = "$request";
    public static final String FS_PREFIX = FS + ":";
    public static final String PHYS_PREFIX = PHYS + ":";
    public static final String CREDENTIAL_PREFIX = CREDENTIAL + ":";
    public static final String CREDENTIAL_WILDCARD = CREDENTIAL_PREFIX + WILDCARD;
    public static final String SKILL_PREFIX = SKILL + ":";

    private static final Map<String, Namespace> REGISTRY = registry();

    private ResourceNamespaces() {}

    private static Map<String, Namespace> registry() {
        Map<String, Namespace> namespaces = new LinkedHashMap<>();
        register(namespaces, FS, Matcher.PREFIX, Grantability.GRANTABLE);
        register(namespaces, PHYS, Matcher.PREFIX, Grantability.EVALUATION_ONLY);
        register(namespaces, CREDENTIAL, Matcher.EXACT, Grantability.GRANTABLE);
        register(namespaces, SKILL, Matcher.PREFIX, Grantability.GRANTABLE);
        return Collections.unmodifiableMap(namespaces);
    }

    private static void register(Map<String, Namespace> into, String name, Matcher matcher,
                                 Grantability grantability) {
        into.put(name, new Namespace(name, matcher, grantability));
    }

    /** Every registered namespace, in registration order. */
    public static Set<Namespace> registered() {
        return Set.copyOf(REGISTRY.values());
    }

    public static Optional<Namespace> find(String namespace) {
        return Optional.ofNullable(namespace == null ? null : REGISTRY.get(namespace));
    }

    /**
     * The namespace token of a resource ({@code fs}, {@code credential}, …), or {@code null} for a
     * bare path / wildcard. Shares the scheme detection with {@link PathKey} so a Windows drive
     * letter is never mistaken for a namespace.
     */
    public static String namespaceOf(String resource) {
        if (resource == null) {
            return null;
        }
        String value = resource.trim();
        if (!PathKey.isSchemeValue(value)) {
            return null;
        }
        return value.substring(0, value.indexOf(':'));
    }

    public static String valueOf(String resource) {
        if (resource == null || !PathKey.isSchemeValue(resource.trim())) {
            return null;
        }
        return resource.trim().substring(resource.trim().indexOf(':') + 1);
    }

    /** Fail-closed classification of a resource for the grant write face. */
    public static Grantability grantabilityOf(String resource) {
        if (resource == null || resource.isBlank()) {
            return Grantability.UNKNOWN;
        }
        String value = resource.trim();
        if (WILDCARD.equals(value)) {
            return Grantability.GRANTABLE;
        }
        String namespace = namespaceOf(value);
        if (namespace == null) {
            // Legacy bare path resource (e.g. `notes/today.md`): legal, matched as a path.
            return Grantability.GRANTABLE;
        }
        Optional<Namespace> registered = find(namespace);
        if (registered.isPresent()) {
            return registered.get().grantability();
        }
        if (WORKSPACE_CONTEXT.equals(namespace) || SESSION_CONTEXT.equals(namespace)) {
            return Grantability.CONTEXT_RESERVED;
        }
        return Grantability.UNKNOWN;
    }

    /** True when {@code resource} carries a namespace this registry does not know (and is not a
     *  context key), i.e. the fail-closed case the write face must reject. */
    public static boolean isUnknownNamespace(String resource) {
        return grantabilityOf(resource) == Grantability.UNKNOWN;
    }

    /** The matcher of a resource's namespace; {@code null} for a bare path / wildcard. */
    public static Matcher matcherOf(String resource) {
        return find(namespaceOf(resource)).map(Namespace::matcher).orElse(null);
    }

    /**
     * The canonical resource of an action atom: {@code credential:*} for the credential family,
     * else {@code *}. This is the single derivation; the atom catalog and the grant guard both read
     * it instead of spelling the prefixes themselves.
     */
    public static String canonicalResourceFor(String actionClass) {
        if (ToolFaceRegistry.isApproveActionClass(actionClass)) {
            return REQUEST_RESOURCE;
        }
        return ToolFaceRegistry.isCredentialActionClass(actionClass)
                ? CREDENTIAL_WILDCARD
                : WILDCARD;
    }

    /** True when {@code resource} is the request-scoped approve sentinel. */
    public static boolean isRequestResource(String resource) {
        return REQUEST_RESOURCE.equals(resource);
    }

    /**
     * Namespace-aware coverage. Used by {@link ToolFaceRegistry#resourceCovers} for registered
     * namespaces; the credential family keeps its stricter canonical-form rule.
     */
    public static boolean matches(Matcher matcher, String pattern, String value) {
        if (matcher == null || pattern == null || value == null) {
            return false;
        }
        if (WILDCARD.equals(pattern)) {
            return true;
        }
        String patternNamespace = namespaceOf(pattern);
        String valueNamespace = namespaceOf(value);
        if (patternNamespace == null || valueNamespace == null) {
            return pattern.equals(value);
        }
        if (!patternNamespace.equals(valueNamespace)) {
            return false;
        }
        String patternValue = valueOf(pattern);
        String candidate = valueOf(value);
        if (patternValue == null || candidate == null) {
            return false;
        }
        if (WILDCARD.equals(patternValue)) {
            return true;
        }
        boolean equal = patternValue.equals(candidate);
        if (matcher == Matcher.EXACT) {
            return equal;
        }
        // PREFIX and the reserved TREE both cover slash-delimited descendants. TREE exists as a
        // declared type so a future `org:` line only adds a registration row.
        return equal || candidate.startsWith(patternValue + "/");
    }

    /**
     * Canonical spelling: lowercase, {@code /} separators, no trailing slash, wildcard preserved.
     * Returns {@code null} for a value {@link PathKey#lexicalPattern} refuses (dot segments, UNC).
     */
    public static String normalize(String resource) {
        if (resource == null) {
            return null;
        }
        String value = resource.trim();
        if (WILDCARD.equals(value)) {
            return WILDCARD;
        }
        String namespace = namespaceOf(value);
        if (namespace == null) {
            return PathKey.lexicalPattern(value);
        }
        String normalizedValue = PathKey.lexicalPattern(valueOf(value));
        return normalizedValue == null
                ? null
                : namespace.toLowerCase(java.util.Locale.ROOT) + ":" + normalizedValue;
    }

    /** Human-readable list of registered namespaces, for 400 messages and evidence. */
    public static String registeredNames() {
        return REGISTRY.keySet().stream().collect(Collectors.joining("/"));
    }
}
