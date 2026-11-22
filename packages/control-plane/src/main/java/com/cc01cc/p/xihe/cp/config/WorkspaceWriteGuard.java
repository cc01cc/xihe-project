package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.policy.AtomNames;
import com.cc01cc.p.xihe.cp.policy.SystemGrantPresetCatalog;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;

import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

/**
 * PLAN-0559: single server-side classifier for workspace write/manage access.
 *
 * <p><b>task-859 (837a) — degraded to a preset/atom table.</b> The decision is no longer a
 * {@code WorkspaceRole.canWrite/canManage} branch: each requirement names the <b>atom</b> it needs,
 * and the matrix below is only the canonical workspace role → {@link SystemGrantPresetCatalog}
 * preset (OWNER → WS_OWNER, EDITOR → WS_EDITOR, VIEWER → WS_VIEWER) projection. The atom sets come
 * from the seed catalog — one truth, not a second hand-written copy. Behaviour is unchanged for the
 * three canonical roles (each preset holds exactly the atoms the old enum branches admitted), but
 * the authority is now expressible and testable: task-837 deletes this class once the HTTP face
 * evaluates atoms directly.</p>
 *
 * <p>It deliberately does not implement file/directory locks. A later lock
 * plan can acquire leases at this choke point (and the file mutation entry)
 * without changing routes or the role matrix.</p>
 */
public final class WorkspaceWriteGuard {

    public enum Requirement {
        READ,
        WRITE(ToolFaceRegistry.ACTION_WRITE_WORKSPACE_CONTENT),
        MANAGE(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_RUNTIME),
        /**
         * BL-174: the endpoint authorizes on its own (capability-based) and the coarse role gate must
         * not veto it. Used by {@code DELETE /api/v1/workspaces/{id}}, where ownership is only one of
         * three acceptable capabilities — grading it with {@link #MANAGE} would reject an instance
         * administrator or a workspace-scoped {@code delete} atom holder that
         * {@code WorkspaceService#deleteWorkspace} deliberately admits.
         */
        SERVICE_CHECKED;

        private final String atom;

        Requirement() {
            this(null);
        }

        Requirement(String atom) {
            this.atom = atom;
        }

        /**
         * The atom this requirement needs, or {@code null} for the membership floor ({@link #READ})
         * and the self-authorizing {@link #SERVICE_CHECKED} face.
         */
        public String atom() {
            return atom;
        }
    }

    /** Canonical workspace role → the seed preset that defines its atom set. */
    private static final Map<String, String> ROLE_TO_PRESET = Map.of(
            "OWNER", SystemGrantPresetCatalog.WS_OWNER,
            "EDITOR", SystemGrantPresetCatalog.WS_EDITOR,
            // Legacy stored values canonicalize to EDITOR upstream; kept here so a raw value that
            // reaches the guard still resolves instead of silently denying.
            "ADMIN", SystemGrantPresetCatalog.WS_EDITOR,
            "MEMBER", SystemGrantPresetCatalog.WS_EDITOR,
            "VIEWER", SystemGrantPresetCatalog.WS_VIEWER);

    /** Preset name → canonical atom set, projected once from {@link SystemGrantPresetCatalog}. */
    private static final Map<String, Set<String>> PRESET_ATOMS = presetAtoms();

    private WorkspaceWriteGuard() {
    }

    public static Requirement requirement(String method, String uri) {
        String verb = method == null ? "" : method.toUpperCase();
        if ("GET".equals(verb) || "HEAD".equals(verb) || "OPTIONS".equals(verb)) {
            return Requirement.READ;
        }
        String path = normalize(uri);
        if (isPathAddressedSessionCreation(verb, path)) {
            // PLAN-0608 C′ (review P1): this route's owning workspace is the
            // {workspaceId} in the PATH, not the header/claim/fallback the interceptor
            // resolved. Grading it with the *context* role is wrong in both directions —
            // it rejects VIEWER@context + EDITOR@path with 403 WORKSPACE_READ_ONLY, and it
            // admits EDITOR@context + VIEWER@path into a read-only workspace. The owning
            // workspace's role is enforced in SessionCreationService against the path ws;
            // the READ floor here still requires a resolved membership so workspace-less
            // callers never reach the controller.
            return Requirement.READ;
        }
        if (isWorkspaceDelete(verb, path)) {
            // BL-174: see Requirement#SERVICE_CHECKED.
            return Requirement.SERVICE_CHECKED;
        }
        if (isOwnerOnly(verb, path)) {
            return Requirement.MANAGE;
        }
        if (isWorkspaceWrite(path)) {
            return Requirement.WRITE;
        }
        return Requirement.READ;
    }

    /** PLAN-0608 C′: {@code POST /api/v1/workspaces/{id}/sessions} — see {@link #requirement}. */
    private static boolean isPathAddressedSessionCreation(String verb, String path) {
        return "POST".equals(verb) && path.matches("^/api/v1/workspaces/[^/]+/sessions$");
    }

    public static boolean allows(String canonicalRole, Requirement requirement) {
        if (requirement == Requirement.SERVICE_CHECKED) {
            return true;
        }
        if (requirement == Requirement.READ) {
            // The READ floor is membership itself ("a resolved workspace role"), not a role verdict:
            // every canonical member may read, and a caller with no resolved role is not a member.
            return canonicalRole != null;
        }
        String atom = requirement.atom();
        return atom != null && atomsFor(canonicalRole).contains(AtomNames.action(atom));
    }

    /**
     * The canonical atom set a workspace role carries, projected from the seed catalog. An unknown
     * or null role answers the empty set (fail closed), never a default.
     */
    public static Set<String> atomsFor(String canonicalRole) {
        String preset = canonicalRole == null ? null : ROLE_TO_PRESET.get(canonicalRole);
        return preset == null ? Set.of() : PRESET_ATOMS.getOrDefault(preset, Set.of());
    }

    private static Map<String, Set<String>> presetAtoms() {
        Map<String, Set<String>> byPreset = new LinkedHashMap<>();
        for (SystemGrantPresetCatalog.PresetSeed seed : SystemGrantPresetCatalog.presetSeeds()) {
            Set<String> atoms = new LinkedHashSet<>();
            for (SystemGrantPresetCatalog.AtomRef atom : seed.atoms()) {
                // AtomRef.actionClass() is already canonical (action:/cap:), and the vocabulary is
                // case-sensitive, so it is deliberately NOT normalised (normalize lowercases).
                atoms.add(atom.actionClass());
            }
            byPreset.put(seed.name(), Set.copyOf(atoms));
        }
        return Map.copyOf(byPreset);
    }

    /** BL-174: {@code DELETE /api/v1/workspaces/{id}} — authorized by {@code WorkspaceService}. */
    private static boolean isWorkspaceDelete(String verb, String path) {
        return "DELETE".equals(verb) && path.matches("^/api/v1/workspaces/[^/]+$");
    }

    private static boolean isOwnerOnly(String verb, String path) {
        if ("PATCH".equals(verb)) {
            // /api/v1/workspaces/{id} (rename)
            if (path.matches("^/api/v1/workspaces/[^/]+$")) {
                return true;
            }
        }
        if ("PATCH".equals(verb) && path.matches("^/api/v1/workspaces/[^/]+/execution-mode$")) {
            return true;
        }
        return "POST".equals(verb) && path.matches("^/api/v1/workspaces/[^/]+/runtime/release$");
    }

    private static boolean isWorkspaceWrite(String path) {
        return path.startsWith("/api/v1/chat/")
                || path.equals("/api/v1/chat")
                || path.matches("^/api/v1/workspaces/[^/]+/.*")
                || path.startsWith("/api/v1/workspace-imports/")
                || path.startsWith("/api/v1/policy/")
                || path.equals("/api/v1/policy")
                || path.startsWith("/api/v1/config/workspace/")
                || path.startsWith("/api/v1/agent-templates/")
                || path.equals("/api/v1/agent-templates")
                || path.equals("/api/v1/rag/ingest");
    }

    private static String normalize(String uri) {
        if (uri == null || uri.isBlank()) {
            return "/";
        }
        int query = uri.indexOf('?');
        return query >= 0 ? uri.substring(0, query) : uri;
    }
}
