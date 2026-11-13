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
    // PLAN-0750 M1 (G1 = (1a), user ruling 2026-11-10): the atom returns with **new semantics** —
    // it authorizes creating one's own user-level agent principal (owner = the actor, and no
    // Workspace binding is produced). It never falls back to a workspace or instance tier action.
    // BL-312 (2026-11-09) deleted the original PLAN-0622 D8 shape on purpose (it bypassed the
    // workspace gate); that shape is NOT revived — the three creation actions stay independent and
    // are never alias-merged. BL-312's seed rows are re-planted by the PLAN-0750 migration, and the
    // atom is instance-only plus agent-principal-forbidden (an agent is a grantee, never an account
    // creator). Re-introduction is deliberate: PermissionAtomCatalog.atom(...) still fails closed for
    // any name that is not in the catalog, so this constant alone does not resurrect anything.
    public static final String ACTION_CREATE_OWN_AGENT = "CREATE_OWN_AGENT";
    // PLAN-0629 M1 (D29-24/34): the seventeenth action atom — writing an agent subject's memory
    // through the agent tool channel. Default-deny by construction: it is stored in the catalog
    // but seeded into NO default role (USER/ADMIN included), so an account can only use it after
    // an explicit grant. The UI/CLI channels do not consume this atom (they act as the user).
    public static final String ACTION_MEMORY_WRITE = "MEMORY_WRITE";
    // BL-345 (user ruling 2026-11-06): writing memory of a principal the actor owns. Kept separate
    // from MEMORY_WRITE on purpose: MEMORY_WRITE means "any subject" (workspace administrators), this
    // atom means "my own subject" (every registered user). An agent principal may never hold it.
    public static final String ACTION_MEMORY_WRITE_SELF = "MEMORY_WRITE_SELF";
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
    /**
     * V156 / D-1019: writing to one's <b>own</b> personal skill library. Instance-tier atom
     * (decision #27-style: there is no workspace dimension in a personal library), default-granted
     * to every account through the USER role — it is the shape of the face, not a privilege. Reading
     * a personal library needs no atom at all (ownership is visibility); revoking this one makes
     * personal writes 403 while personal reads stay open (P-189-3). Never grantable to an agent
     * principal: an agent holds no personal library of its own.
     */
    public static final String ACTION_MANAGE_PERSONAL_SKILLS = "MANAGE_PERSONAL_SKILLS";
    public static final String ACTION_MANAGE_PROVIDER_CONNECTIONS = "MANAGE_PROVIDER_CONNECTIONS";
    public static final String ACTION_USE_WORKSPACE_RUNTIME = "USE_WORKSPACE_RUNTIME";
    public static final String ACTION_MANAGE_WORKSPACE_RUNTIME = "MANAGE_WORKSPACE_RUNTIME";
    public static final String ACTION_MANAGE_WORKSPACE_POLICY = "MANAGE_WORKSPACE_POLICY";
    /** D-928 / PLAN-0766: write access to the shared workspace-default config layer. */
    public static final String ACTION_MANAGE_WORKSPACE_DEFAULT_CONFIG = "MANAGE_WORKSPACE_DEFAULT_CONFIG";
    /**
     * task-229 / PLAN-0773 (H1): write access to <b>one workspace's</b> configuration row
     * ({@code PUT /api/v1/config/workspace/{domain}}). The symmetric counterpart of
     * {@code WRITE_INSTANCE_CONTENT} one tier down: that atom acts on the whole instance, this one
     * acts on a workspace the caller reaches. Workspace-bindable on purpose (decision #27): the
     * grant names the workspace it is about, and the endpoint's own {@code requireAccessibleWorkspace}
     * still runs first, so a non-member keeps the 404 that hides the workspace.
     *
     * <p>Default-granted to the workspace write roles only ({@code WS_OWNER}, {@code WS_EDITOR}) —
     * a read-only member of a workspace ({@code WS_VIEWER}) may not rewrite its config, which is the
     * whole point of the gate. An instance administrator ({@code ADMIN}) holds it as well, the same
     * way it already holds the other workspace-layer management atoms.</p>
     */
    public static final String ACTION_WRITE_WORKSPACE_CONTENT = "WRITE_WORKSPACE_CONTENT";
    /**
     * task-229 / PLAN-0773 (H2 + H3): write access to a workspace's MCP surface — both the legacy
     * mixed {@code mcp-config} face and the newer {@code stdio-servers} face. Deliberately
     * <b>one</b> atom for the two endpoints: they write the same underlying
     * {@code mcp_server_catalog} rows, so two atoms would let a role hold "the new door" while being
     * refused at "the legacy door" — a drift with no user-meaning. Same default set as
     * {@link #ACTION_WRITE_WORKSPACE_CONTENT}: {@code WS_OWNER} / {@code WS_EDITOR} / {@code ADMIN}.
     */
    public static final String ACTION_MANAGE_WORKSPACE_MCP = "MANAGE_WORKSPACE_MCP";
    // PLAN-0691 T1.3 (M1): the plugin binding capability face. Four atoms, one per verb, named in
    // the UPPER_SNAKE style of every other action atom (the spec's `plugin:manage` spelling is the
    // external capability wording; see spec/authz-plugin-atoms.md). Naming rule is not cosmetic:
    // DefaultSetMatrixTest / DefaultSetMigrationParityTest assert "SUPER_ADMIN holds every atom in
    // the catalog", so a catalog with two naming conventions would fork every prefix- or
    // case-based parse and audit afterwards.
    //   PLUGIN_MANAGE = instance-level plugin administration (install/enable/disable a plugin)
    //   PLUGIN_BIND   = bind a plugin to a workspace (creates the binding row)
    //   PLUGIN_INVOKE = invoke a bound plugin's tool face (the only atom an agent may hold)
    //   PLUGIN_DATA   = read/write the plugin's data plane (service/binding-scoped, never a person)
    public static final String ACTION_PLUGIN_MANAGE = "PLUGIN_MANAGE";
    public static final String ACTION_PLUGIN_BIND = "PLUGIN_BIND";
    public static final String ACTION_PLUGIN_INVOKE = "PLUGIN_INVOKE";
    public static final String ACTION_PLUGIN_DATA = "PLUGIN_DATA";
    // PLAN-0773 M2-2 (D-1118): the three org-unit governance atoms. They are the <b>whitelist</b>
    // of OrgUnitGovernancePolicy — a role may be bound inside an org unit only when its atom set is
    // a subset of these three (M2-3 seeds ORG_LEADER exactly like that).
    //
    // Scope class: **deliberately not decided here** — see the marker in PermissionAtomCatalog
    // INSTANCE_ONLY_ATOMS. Today the three fall into the default (`both`) simply by NOT being
    // listed there, which is a state, not a ruling: whether an org-unit grant is evaluated as a
    // new scope family or projected onto an existing one is M2-8c's design question, and
    // `Atom.bindableIn` makes an `instance`-class atom unusable in any non-instance scope.
    // 〔待 M2-8c 定〕
    //
    // They are NOT attached to a tool face (like the other management atoms): the vocabulary entry
    // is what GrantIntersectionEvaluator validates a grant against.
    public static final String ACTION_MANAGE_ORG_UNITS = "MANAGE_ORG_UNITS";
    public static final String ACTION_MANAGE_ORG_UNIT_MEMBERS = "MANAGE_ORG_UNIT_MEMBERS";
    public static final String ACTION_READ_ORG_UNIT_MEMBERS = "READ_ORG_UNIT_MEMBERS";

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
            "skill_read",
            // PLAN-0686 G8: the three read-only Git tools ride the same reasoning — they read a
            // named target (status / diff / log of the workspace's own user repository), so they
            // take the existing `read` atom and STRUCTURED shape instead of a new atom or
            // `extraFaces` (spec/protocol/mcp.md §3.5).
            "git_status", "git_diff", "git_log");

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
                // PLAN-0750 M1 (G1): the user-level create atom re-joins the action-class set in the
                // same batch as its catalog entry, its role seed and its Flyway rows — the vocabulary
                // is the evaluator's validation set, so a constant without this line is invisible.
                ACTION_CREATE_OWN_AGENT,
                ACTION_MEMORY_WRITE, ACTION_MEMORY_WRITE_SELF,
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
                ACTION_GRANT_ANY_ATOM,
                // PLAN-0691 T1.3 (M1): the four plugin atoms join the action-class set in the same
                // batch as their catalog entries and their Flyway seed rows (V137). They are not
                // attached to any tool face: a plugin's tool face is created at bind time, so the
                // vocabulary entry is what the evaluator validates against.
                ACTION_PLUGIN_MANAGE, ACTION_PLUGIN_BIND, ACTION_PLUGIN_INVOKE, ACTION_PLUGIN_DATA,
                // D-928 / PLAN-0766 (task-158/159): the workspace-default write atom joins the
                // action-class set in the same batch as its catalog entry and its Flyway seed
                // rows (V153) — GrantIntersectionEvaluator validates against this vocabulary.
                ACTION_MANAGE_WORKSPACE_DEFAULT_CONFIG,
                // V156 / D-1019: the personal skill library write atom. Same batch as its catalog
                // entry, its label and its Flyway seed rows (V156 roles 1/2/3); the vocabulary is
                // what GrantIntersectionEvaluator validates a grant against.
                ACTION_MANAGE_PERSONAL_SKILLS,
                // task-229 / PLAN-0773 (V157): the two workspace write faces. Same batch as their
                // catalog entries, labels and seed rows — measured the hard way: a catalog entry
                // without its vocabulary line makes RoleGrantMaterializer throw
                // "Unknown actionClass: MANAGE_WORKSPACE_MCP" the moment a seeded role is
                // materialized, so this list is not decoration.
                ACTION_WRITE_WORKSPACE_CONTENT, ACTION_MANAGE_WORKSPACE_MCP,
                // PLAN-0773 M2-2 (V162): the three org-unit governance atoms join the action-class
                // set in the same batch as their catalog entries, labels and seed row (SUPER_ADMIN),
                // for the same mechanical reason V157 documents: a catalog entry without this line
                // makes RoleGrantMaterializer throw "Unknown actionClass" the moment a seeded role is
                // materialized, and MemoryWriteAtomTest asserts actionAtoms() == this set.
                ACTION_MANAGE_ORG_UNITS, ACTION_MANAGE_ORG_UNIT_MEMBERS, ACTION_READ_ORG_UNIT_MEMBERS);
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
