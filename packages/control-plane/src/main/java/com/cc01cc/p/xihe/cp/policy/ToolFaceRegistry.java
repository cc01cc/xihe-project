package com.cc01cc.p.xihe.cp.policy;

import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * Tool face registry: maps a tool name to its {@code actionClass} and {@link ToolShape}
 * (PLAN-0328 decision #30/#38, spec §8).
 *
 * <p>Action classes are <em>extensible strings</em> — the built-in set below is a starting point,
 * not a closed enum. Tools that are known but not classified resolve to
 * {@link PolicyLayer#UNCLASSIFIED_ACTION} with {@link ToolShape#OPAQUE} (default ask + no reuse).</p>
 */
public class ToolFaceRegistry {

    public record Face(String actionClass, ToolShape shape) {}

    public static final String ACTION_READ = "read";
    public static final String ACTION_WRITE = "write";
    public static final String ACTION_DELETE = "delete";
    public static final String ACTION_EXEC = "exec";
    public static final String ACTION_NETWORK = "network";
    // PLAN-0496 #1 (0494 #3/#9): the credential namespace splits into three atoms with the
    // `credential:<uuid>` / `credential:*` resource namespace; the legacy single `credential`
    // word was retired in the same dev-phase cutover (0496 #5).
    public static final String ACTION_CREDENTIAL_USE = "credential_use";
    public static final String ACTION_CREDENTIAL_REVEAL = "credential_reveal";
    public static final String ACTION_CREDENTIAL_MANAGE = "credential_manage";
    public static final String ACTION_CREATE_ACCOUNT = "CREATE_ACCOUNT";
    public static final String ACTION_CREATE_TEMPLATE = "CREATE_TEMPLATE";
    public static final String ACTION_MANAGE_WORKSPACE_AGENTS = "MANAGE_WORKSPACE_AGENTS";
    public static final String ACTION_SPAWN_AGENT = "SPAWN_AGENT";
    // PLAN-0489 T1.4 (0486 #9/#10): scheduled-task create and non-creator disposition
    // are independent opt-in action classes, default deny like CREATE_ACCOUNT above.
    public static final String ACTION_CREATE_SCHEDULED_TASK = "CREATE_SCHEDULED_TASK";
    public static final String ACTION_MANAGE_SCHEDULED_TASK = "MANAGE_SCHEDULED_TASK";
    // PLAN-0610 (T1.2): the fifteenth action atom — who may create/edit access roles and
    // bindings. It is a normal action atom (evaluated through grants), not a capability atom.
    public static final String ACTION_MANAGE_ROLES = "MANAGE_ROLES";
    // PLAN-0673 M2 (D-166): the bypass atom for the grant-side subset rule ("escalate"/"bind" in
    // Kubernetes terms). Instance-only; default SUPER_ADMIN only; every use must be audited.
    // Never a role-name check — the bypass is an atom like any other.
    public static final String ACTION_GRANT_ANY_ATOM = "GRANT_ANY_ATOM";
    // PLAN-0622 (D8, M0.3): the sixteenth action atom — a user tier action that lets an
    // ordinary account create its own PERSONAL agent principal. It is never alias-merged with
    // CREATE_ACCOUNT (instance tier) or MANAGE_WORKSPACE_AGENTS (workspace tier).
    public static final String ACTION_OWN_AGENT = "CREATE_OWN_AGENT";
    // PLAN-0629 M1 (D29-24/34): the seventeenth action atom — writing an agent subject's memory
    // through the agent tool channel. Default-deny by construction: it is stored in the catalog
    // but seeded into NO default role (USER/ADMIN included), so an account can only use it after
    // an explicit grant. The UI/CLI channels do not consume this atom (they act as the user).
    public static final String ACTION_MEMORY_WRITE = "MEMORY_WRITE";
    // PLAN-0651 M1 (D51-26/D51-27): two management atoms replacing the coarse
    // instance-administrator bypass on the agent-principal face and the member face.
    // MANAGE_AGENT_PRINCIPALS is instance-only (it acts on the instance);
    // MANAGE_WORKSPACE_MEMBERS is bindable in both scopes (a workspace role may be handed member
    // management later, WS_OWNER is deliberately not).
    // Neither may ever be granted to an agent principal (see agentPrincipalForbiddenAtoms()).
    public static final String ACTION_MANAGE_AGENT_PRINCIPALS = "MANAGE_AGENT_PRINCIPALS";
    public static final String ACTION_MANAGE_WORKSPACE_MEMBERS = "MANAGE_WORKSPACE_MEMBERS";
    // PLAN-0651 M2 T2.1 (D51-27): the remaining P1 atoms. Each answers one administrative face;
    // all of them are forbidden to agent principals, and N2/N3/N4 are instance-bindable only.
    public static final String ACTION_READ_INSTANCE_CONTENT = "READ_INSTANCE_CONTENT";
    public static final String ACTION_WRITE_INSTANCE_CONTENT = "WRITE_INSTANCE_CONTENT";
    public static final String ACTION_VIEW_SECRET_CONTENT = "VIEW_SECRET_CONTENT";
    public static final String ACTION_MANAGE_SKILL_LIBRARY = "MANAGE_SKILL_LIBRARY";
    public static final String ACTION_MANAGE_PROVIDER_CONNECTIONS = "MANAGE_PROVIDER_CONNECTIONS";
    public static final String ACTION_USE_WORKSPACE_RUNTIME = "USE_WORKSPACE_RUNTIME";
    public static final String ACTION_MANAGE_WORKSPACE_RUNTIME = "MANAGE_WORKSPACE_RUNTIME";
    public static final String ACTION_MANAGE_WORKSPACE_POLICY = "MANAGE_WORKSPACE_POLICY";

    /** PLAN-0496 #2: the credential resource namespace ({@code credential:<uuid>} / {@code credential:*}).
     */
    public static final String CREDENTIAL_ACTION_PREFIX = "credential_";
    public static final String CREDENTIAL_RESOURCE_PREFIX = "credential:";
    public static final String CREDENTIAL_RESOURCE_WILDCARD = "credential:*";

    /**
     * PLAN-0628 M2b (D28-36): the skill resource namespace, spelled like the credential one —
     * {@code skill:<uuid>}. Only the spelling is new; {@code skill_read} keeps the existing {@code read}
     * atom and {@code STRUCTURED} shape, so no seeder/UI/CLI vocabulary has to move.
     */
    public static final String SKILL_RESOURCE_PREFIX = "skill:";

    private static final Set<String> READ_TOOLS = Set.of(
            "read_file", "read_file_range", "list_directory", "glob", "grep",
            "get_file_info", "watch_directory", "extract_pdf_text",
            "read_command_output", "list_background_processes", "get_background_process",
            // PLAN-0628 M2b: reading one bound skill's body is the same action as reading a file —
            // a bounded, named target. It goes into READ_TOOLS instead of getting a new atom: the
            // atom table already carries 17 entries, and adding one costs a seeder plus UI and CLI
            // word lists. Paying that for a read is not warranted (README D28-36).
            "skill_read");

    private static final Set<String> WRITE_TOOLS = Set.of(
            "write_file", "edit_file", "delete_file", "delete_directory",
            "move_file", "copy_file", "mkdir", "apply_patch");

    private static final Set<String> EXEC_TOOLS = Set.of(
            "execute_command", "start_background_process", "cancel_background_process");

    private static final Set<String> NETWORK_TOOLS = Set.of("web_fetch");

    /**
     * PLAN-0627 D27-20 (Q2 = C′): file names whose mutation is always approval-gated,
     * whatever the session mode is. Agents read these files as project conventions, so a
     * silent rewrite would let a run rewrite its own rules.
     *
     * <p>Path patterns are matched with {@link LayeredPolicyResolver#matches} under
     * {@link ToolShape#STRUCTURED} semantics (that is the existing path vocabulary), and the
     * comparison is case-insensitive because the workspace may live on a case-insensitive
     * filesystem.
     */
    public static final Set<String> PROTECTED_WRITE_FILENAMES = Set.of("AGENTS.md");

    private static final java.util.List<String> PROTECTED_WRITE_PATTERNS = java.util.List.of(
            "agents.md", "**/agents.md");

    /** True when any extracted resource mutates a protected file name at any depth. */
    public static boolean mutatesProtectedFile(java.util.List<String> resources) {
        if (resources == null || resources.isEmpty()) {
            return false;
        }
        for (String resource : resources) {
            if (resource == null || resource.isBlank()) {
                continue;
            }
            String normalized = resource.replace('\\', '/').toLowerCase(java.util.Locale.ROOT);
            for (String pattern : PROTECTED_WRITE_PATTERNS) {
                if (LayeredPolicyResolver.matches(pattern, normalized, ToolShape.STRUCTURED)) {
                    return true;
                }
            }
        }
        return false;
    }

    private final Map<String, Face> faces;

    public ToolFaceRegistry() {
        this(Map.of());
    }

    /** Extra faces (e.g. classified third-party MCP tools) layered on top of the built-ins. */
    public ToolFaceRegistry(Map<String, Face> extraFaces) {
        var builder = new java.util.HashMap<String, Face>();
        READ_TOOLS.forEach(tool -> builder.put(tool, new Face(ACTION_READ, ToolShape.STRUCTURED)));
        WRITE_TOOLS.forEach(tool -> builder.put(tool, new Face(ACTION_WRITE, ToolShape.STRUCTURED)));
        NETWORK_TOOLS.forEach(tool -> builder.put(tool, new Face(ACTION_NETWORK, ToolShape.STRUCTURED)));
        EXEC_TOOLS.forEach(tool -> builder.put(tool, new Face(ACTION_EXEC, ToolShape.INTERPRETER)));
        builder.put("spawn_agent", new Face(ACTION_SPAWN_AGENT, ToolShape.STRUCTURED));
        // PLAN-0497 M0 冻结：CP-owned credential delivery tool — face=credential_use,
        // STRUCTURED; authorization runs the credential_use evaluation on the
        // credential:<id> resource extracted from the tool arguments.
        builder.put("acquire_credential", new Face(ACTION_CREDENTIAL_USE, ToolShape.STRUCTURED));
        builder.putAll(extraFaces);
        this.faces = Map.copyOf(builder);
    }

    /** True when the tool is present in the registry (built-in or explicitly classified). */
    public boolean known(String tool) {
        return tool != null && faces.containsKey(tool);
    }

    public Face faceOf(String tool) {
        Face face = tool == null ? null : faces.get(tool);
        return face != null ? face : new Face(PolicyLayer.UNCLASSIFIED_ACTION, ToolShape.OPAQUE);
    }

    public Optional<Face> configuredFace(String tool) {
        return Optional.ofNullable(tool == null ? null : faces.get(tool));
    }

    public Set<String> knownTools() {
        return faces.keySet();
    }

    /** Built-in action classes; callers may add their own (e.g. {@code db-migration}). */
    public static Set<String> builtinActionClasses() {
        return Set.of(ACTION_READ, ACTION_WRITE, ACTION_DELETE, ACTION_EXEC, ACTION_NETWORK,
                ACTION_CREDENTIAL_USE, ACTION_CREDENTIAL_REVEAL, ACTION_CREDENTIAL_MANAGE,
                ACTION_CREATE_ACCOUNT, ACTION_CREATE_TEMPLATE, ACTION_MANAGE_WORKSPACE_AGENTS, ACTION_SPAWN_AGENT,
                ACTION_CREATE_SCHEDULED_TASK, ACTION_MANAGE_SCHEDULED_TASK, ACTION_MANAGE_ROLES,
                ACTION_OWN_AGENT, ACTION_MEMORY_WRITE,
                // PLAN-0651 M1 (D51-26): management atoms. They join the built-in vocabulary because
                // it is the catalog's action-class set (PermissionAtomCatalog.actionAtoms() must stay
                // equal to it, see MemoryWriteAtomTest); they are not attached to any tool face.
                ACTION_MANAGE_AGENT_PRINCIPALS, ACTION_MANAGE_WORKSPACE_MEMBERS,
                // PLAN-0651 M2 T2.1: the P1 atoms join the action-class set in the same batch
                // (D51-36 — GrantIntersectionEvaluator snapshots this list, and
                // MemoryWriteAtomTest asserts actionAtoms() == builtinActionClasses()).
                ACTION_READ_INSTANCE_CONTENT, ACTION_WRITE_INSTANCE_CONTENT,
                ACTION_VIEW_SECRET_CONTENT, ACTION_MANAGE_SKILL_LIBRARY,
                ACTION_MANAGE_PROVIDER_CONNECTIONS, ACTION_USE_WORKSPACE_RUNTIME,
                ACTION_MANAGE_WORKSPACE_RUNTIME, ACTION_MANAGE_WORKSPACE_POLICY,
                // PLAN-0673 M2 (D-166): the subset-bypass atom joins the built-in action-class set
                // in the same batch (MemoryWriteAtomTest asserts actionAtoms() == this set).
                ACTION_GRANT_ANY_ATOM);
    }

    /** PLAN-0496 #2: credential-namespace action classes (the three atoms share resource rules). */
    public static boolean isCredentialActionClass(String actionClass) {
        return actionClass != null && actionClass.startsWith(CREDENTIAL_ACTION_PREFIX);
    }

    /**
     * PLAN-0496 #2/#4 (round-4): the canonical credential resource forms —
     * {@code credential:*} (wide grant) or {@code credential:<uuid>} (exact, lowercase
     * canonical form only). Partial globs such as {@code credential:ab*} are not part
     * of the namespace; uppercase uuid spellings are rejected at write time so a stored
     * atom can never fall out of every downstream comparison (all of them are
     * case-sensitive).
     */
    public static boolean isCanonicalCredentialResource(String resource) {
        if (resource == null || !resource.startsWith(CREDENTIAL_RESOURCE_PREFIX)) {
            return false;
        }
        if (CREDENTIAL_RESOURCE_WILDCARD.equals(resource)) {
            return true;
        }
        String candidate = resource.substring(CREDENTIAL_RESOURCE_PREFIX.length());
        try {
            UUID parsed = UUID.fromString(candidate);
            return parsed.toString().equals(candidate);
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    /** PLAN-0496 #4 (I2): requests must carry a concrete {@code credential:<uuid>}, never the wildcard. */
    public static boolean isConcreteCredentialResource(String resource) {
        return isCanonicalCredentialResource(resource) && !CREDENTIAL_RESOURCE_WILDCARD.equals(resource);
    }

    /**
     * PLAN-0496 #2 (0494 #11; round-4 keying fix): resource coverage used by write
     * boundaries and derivation — keyed by the atom's actionClass so a non-credential
     * atom with a {@code credential:}-prefixed resource keeps the legacy rule (the
     * namespace is bound to the credential atoms, not to the string prefix alone).
     * In the credential namespace the wide {@code credential:*} ceiling covers any
     * {@code credential:<id>} and exact ids are equal-only; every other atom keeps
     * the exact-or-bare-'*' rule unchanged.
     */
    public static boolean resourceCovers(String actionClass, String ceilingResource, String candidateResource) {
        if (isCredentialActionClass(actionClass) && candidateResource != null
                && candidateResource.startsWith(CREDENTIAL_RESOURCE_PREFIX)) {
            return CREDENTIAL_RESOURCE_WILDCARD.equals(ceilingResource)
                    || ceilingResource.equals(candidateResource);
        }
        return "*".equals(ceilingResource) || ceilingResource.equals(candidateResource);
    }
}
