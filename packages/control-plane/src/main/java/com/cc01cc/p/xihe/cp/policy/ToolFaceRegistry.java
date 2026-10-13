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

    /** PLAN-0496 #2: the credential resource namespace ({@code credential:<uuid>} / {@code credential:*}). */
    public static final String CREDENTIAL_ACTION_PREFIX = "credential_";
    public static final String CREDENTIAL_RESOURCE_PREFIX = "credential:";
    public static final String CREDENTIAL_RESOURCE_WILDCARD = "credential:*";

    private static final Set<String> READ_TOOLS = Set.of(
            "read_file", "read_file_range", "list_directory", "glob", "grep",
            "get_file_info", "watch_directory", "extract_pdf_text",
            "read_command_output", "list_background_processes", "get_background_process");

    private static final Set<String> WRITE_TOOLS = Set.of(
            "write_file", "edit_file", "delete_file", "delete_directory",
            "move_file", "copy_file", "mkdir", "apply_patch");

    private static final Set<String> EXEC_TOOLS = Set.of(
            "execute_command", "start_background_process", "cancel_background_process");

    private static final Set<String> NETWORK_TOOLS = Set.of("web_fetch");

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
                ACTION_CREATE_SCHEDULED_TASK, ACTION_MANAGE_SCHEDULED_TASK);
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
