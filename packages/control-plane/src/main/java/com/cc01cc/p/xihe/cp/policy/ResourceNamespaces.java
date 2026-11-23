package com.cc01cc.p.xihe.cp.policy;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;
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
 *   <li>{@link Matcher#TREE} — hierarchical coverage. {@code agent-unit:} was registered by
 *       task-935 for the spawn hierarchy: it is the <b>agent's own unit subtree</b>, never the
 *       visibility scope. The visibility namespace {@code org:} stays unregistered (DEV-037 §2):
 *       "which units may I see" is conditions, "which unit may this spawn target" is the resource
 *       axis. Registering {@code agent-unit} instead of {@code org} keeps those two questions
 *       apart.</li>
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
    /**
     * task-870 / D-1921: an external MCP server as a resource. {@code mcp:<serverId>} is appended
     * to every gateway tool call's resources and ANDed with the object resource(s) the tool
     * arguments produce. It is a <b>gate</b> (the channel), never a replacement for the object: a
     * principal holding {@code write @ mcp:server} but not {@code write @ fs:ws/a} must still be
     * refused. The built-in gateway ids ({@code __system__}/{@code __cp__}) are deliberately not
     * addressed by this namespace — see {@link #BUILTIN_MCP_SERVER_IDS}.
     */
    public static final String MCP = "mcp";

    /** Context namespaces that look like resources but are not (empty on purpose). */
    public static final String WORKSPACE_CONTEXT = "workspace";
    public static final String SESSION_CONTEXT = "session";

    /** Visibility-scope namespace name; deliberately <b>not</b> registered (DEV-037 §2). */
    public static final String ORG_TREE = "org";

    /**
     * task-935: the spawn-hierarchy namespace. Value is an org-unit ltree path written with
     * {@code /} separators (the {@link Matcher#TREE} boundary), e.g. {@code agent-unit:root/team}.
     * The pattern is the caller's own unit subtree; a target under a sibling is outside it.
     * Evaluation-only: it is derived from {@code org_unit_members} at request time and never
     * persisted as a grant.
     */
    public static final String AGENT_UNIT = "agent-unit";

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
    public static final String MCP_PREFIX = MCP + ":";
    public static final String MCP_WILDCARD = MCP_PREFIX + WILDCARD;
    public static final String AGENT_UNIT_PREFIX = AGENT_UNIT + ":";

    /**
     * The CP-owned gateway ids. They are not MCP servers a user can grant: they address the
     * built-in tool surface ({@code write_file}, {@code spawn_agent}, …). Appending them as
     * {@code mcp:__system__} would make every agent preset fail the AND gate, because agent
     * presets hold no wildcard (task-870 hard condition).
     */
    public static final Set<String> BUILTIN_MCP_SERVER_IDS = Set.of("__system__", "__cp__");

    /** A server id already in canonical shape: lowercase slug, optional {@code ~<8 hex>} suffix. */
    private static final Pattern MCP_CANONICAL =
            Pattern.compile("^[a-z0-9._-]+(~[0-9a-f]{8})?$");
    private static final Pattern UUID_TEXT =
            Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
    private static final int MCP_SLUG_MAX = 48;

    private static final Map<String, Namespace> REGISTRY = registry();

    private ResourceNamespaces() {}

    private static Map<String, Namespace> registry() {
        Map<String, Namespace> namespaces = new LinkedHashMap<>();
        register(namespaces, FS, Matcher.PREFIX, Grantability.GRANTABLE);
        register(namespaces, PHYS, Matcher.PREFIX, Grantability.EVALUATION_ONLY);
        register(namespaces, CREDENTIAL, Matcher.EXACT, Grantability.GRANTABLE);
        register(namespaces, SKILL, Matcher.PREFIX, Grantability.GRANTABLE);
        register(namespaces, MCP, Matcher.EXACT, Grantability.GRANTABLE);
        register(namespaces, AGENT_UNIT, Matcher.TREE, Grantability.EVALUATION_ONLY);
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

    /** True when the id is a CP-owned gateway id, which never becomes an {@code mcp:} resource. */
    public static boolean isBuiltinMcpServerId(String serverId) {
        return serverId != null && BUILTIN_MCP_SERVER_IDS.contains(serverId.trim());
    }

    /** True when {@code resource} is in the MCP gateway namespace. */
    public static boolean isMcpResource(String resource) {
        return MCP.equals(namespaceOf(resource));
    }

    /**
     * task-935: the spawn hierarchy resource for one org-unit ltree path. The stored ltree uses
     * {@code .} as its separator; the resource axis uses {@code /} so {@link Matcher#TREE} can
     * cover descendants on segment boundaries. A blank path yields {@code null} (nothing to append).
     */
    public static String agentUnitResource(String ltreePath) {
        if (ltreePath == null || ltreePath.isBlank()) {
            return null;
        }
        return AGENT_UNIT_PREFIX + ltreePath.trim().replace('.', '/');
    }

    /**
     * The MCP channel is a <b>gate</b>: {@code *} (or any non-{@code mcp:} ceiling) must never
     * imply it, otherwise every preset holding {@code write@*} — including every agent preset —
     * would silently pass the gateway gate and the per-server default would be meaningless. Only
     * {@code mcp:*} / {@code mcp:<id>} cover an {@code mcp:} candidate.
     */
    public static boolean mcpChannelRequiresExplicitGrant(String ceiling, String candidate) {
        return isMcpResource(candidate) && !isMcpResource(ceiling);
    }

    /**
     * task-870 / D-1921: the stable canonical id for an MCP server.
     *
     * <p>Two shapes exist in the mapping: a UUID (remote server rows and sticky aliases) and the
     * legacy {@code mcp-config} string key (stdio server name). A UUID is already stable and is
     * lowercased verbatim. Anything else is reduced to a lowercase {@code [a-z0-9._-]} slug; when
     * that reduction is lossy (uppercase, spaces, punctuation, or truncation) an 8-hex SHA-256
     * suffix distinguishes it from a different key that would otherwise collapse to the same slug.
     * The function is idempotent: an already-canonical value is returned unchanged.</p>
     *
     * <p>Consequence, stated in the docs and not hidden: renaming a stdio server's config key
     * changes its canonical id, so grants naming the old id stop matching. That is fail-closed and
     * visible (the tool call is denied), never a silent widening.</p>
     */
    public static String canonicalMcpServerId(String rawServerId) {
        if (rawServerId == null) {
            return null;
        }
        String lower = rawServerId.trim().toLowerCase(java.util.Locale.ROOT);
        if (lower.isEmpty()) {
            return null;
        }
        if (UUID_TEXT.matcher(lower).matches()) {
            return lower;
        }
        if (MCP_CANONICAL.matcher(lower).matches()) {
            return lower;
        }
        String slug = lower.replaceAll("[^a-z0-9._-]+", "-")
                .replaceAll("-{2,}", "-")
                .replaceAll("^-+", "")
                .replaceAll("-+$", "");
        if (slug.isEmpty()) {
            slug = "server";
        }
        if (slug.length() > MCP_SLUG_MAX) {
            slug = slug.substring(0, MCP_SLUG_MAX).replaceAll("-+$", "");
        }
        return slug + "~" + shortHash(lower);
    }

    /**
     * The canonical resource of a gateway tool call ({@code mcp:<canonicalId>}), or {@code null}
     * for a built-in gateway id / an unusable id. {@code null} means "nothing to append"; the MCP
     * gateway treats an unusable non-builtin id as fail-closed before it reaches this method.
     */
    public static String mcpServerResource(String rawServerId) {
        if (isBuiltinMcpServerId(rawServerId)) {
            return null;
        }
        String canonical = canonicalMcpServerId(rawServerId);
        return canonical == null ? null : MCP_PREFIX + canonical;
    }

    /**
     * True when the resource is a filesystem-shaped value. Only these participate in path
     * containment / protected-file checks; {@code mcp:}, {@code credential:} and {@code skill:} are
     * identities, not paths (task-870 consumer audit).
     */
    public static boolean isPathResource(String resource) {
        String namespace = namespaceOf(resource);
        return namespace == null || FS.equals(namespace) || PHYS.equals(namespace);
    }

    private static String shortHash(String value) {
        try {
            byte[] digest = java.security.MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(8);
            for (int i = 0; i < 4; i++) {
                hex.append(String.format("%02x", digest[i]));
            }
            return hex.toString();
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is required by the JVM", impossible);
        }
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
            return !isMcpResource(value);
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
