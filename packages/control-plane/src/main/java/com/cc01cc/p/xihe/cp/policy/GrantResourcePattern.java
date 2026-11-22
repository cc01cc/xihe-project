package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

import java.util.UUID;

/**
 * task-81 / DSD-1485: the <b>write face</b> of a grant resource pattern.
 *
 * <p>Until this class existed the intersection kernel could already compare a declaration key
 * ({@code fs:<workspaceId>/<rel>}) against a request ({@link ResourceIdentity#matchesDeclaration}),
 * but <b>no API could produce such a value</b>: {@code POST/PATCH /api/v1/roles} always stored
 * {@link PermissionAtomCatalog.Atom#canonicalResource()} ({@code *} or {@code credential:*}), so the
 * only reachable branch in production was the wildcard. The gap was on the writer, not on the
 * evaluator — see the C1/C2 pair in
 * {@code internal/A03-xihe/evidence/2026-11-20-permission-system-design/README.md} §5.</p>
 *
 * <p>Rules (fail-closed, one place so create/update cannot drift):</p>
 *
 * <ul>
 *   <li><b>Absent or blank resource</b> ⇒ the atom's canonical pattern. This is the invariant that
 *       keeps every existing client byte-identical: {@code atoms:["read"]} still writes {@code *}.</li>
 *   <li><b>Capability atoms</b> never carry a resource (they answer "is this subject an admin", not
 *       "may it touch this resource"); instance-scoped atoms are rejected for the same reason — a
 *       workspace path cannot narrow an instance-domain atom.</li>
 *   <li><b>Credential atoms</b> keep their own namespace ({@code credential:*} /
 *       {@code credential:<uuid>}); the canonical-form check is the existing
 *       {@link ToolFaceRegistry#isCanonicalCredentialResource}.</li>
 *   <li><b>Every other atom</b> accepts {@code *} or {@code fs:<workspaceId>[/<rel>]}.</li>
 * </ul>
 *
 * <p>The {@code fs:} branch is where the write face gets its teeth: the root scope must be an
 * <b>existing</b> workspace, the relative part must be a plain path (no dot segments, no
 * backslashes, no wildcard, no drive letter, no empty segment — {@link ResourceIdentity#parseDeclaration}
 * plus the segment loop below), the whole key must fit {@code grant_preset_atoms.resource_pattern}
 * ({@code VARCHAR(255)}, V87), and the caller must be allowed to administer bindings <b>in that
 * workspace</b>. That last gate is deliberately separate from {@link GrantabilityGuard}: its
 * {@code heldCovers} asks "does the caller hold {@code read} at some resource", and a caller holding
 * {@code read@*} covers any narrow pattern, so it can never answer "may this caller hand out write
 * access to workspace B's files".</p>
 */
@Component
public class GrantResourcePattern {

    /** RFC 9457 {@code code} for a rejected pattern (400). */
    public static final String CODE_INVALID = "INVALID_GRANT_RESOURCE";

    /** V87: {@code grant_preset_atoms.resource_pattern VARCHAR(255) NOT NULL}. */
    static final int MAX_LENGTH = 255;

    private final WorkspaceRepository workspaces;
    private final RequesterAuthority requester;

    public GrantResourcePattern(WorkspaceRepository workspaces, RequesterAuthority requester) {
        this.workspaces = workspaces;
        this.requester = requester;
    }

    /**
     * The pattern to store for {@code atom}, or a 400 when {@code requested} is not a form this
     * write face can honour. Never returns {@code null}.
     */
    public String resolve(PermissionAtomCatalog.Atom atom, String requested) {
        String canonical = atom.canonicalResource();
        String raw = requested == null ? null : requested.trim();
        if (raw == null || raw.isEmpty()) {
            return canonical;
        }
        if (raw.equals(canonical)) {
            return canonical;
        }
        if (atom.capability()) {
            throw invalid(atom.name(), raw,
                    "a capability atom never carries a resource pattern");
        }
        if (ToolFaceRegistry.isCredentialActionClass(atom.name())) {
            if (!ToolFaceRegistry.isCanonicalCredentialResource(raw)) {
                throw invalid(atom.name(), raw,
                        "credential atoms only accept credential:* or credential:<uuid> (lowercase)");
            }
            return raw;
        }
        if (PermissionAtomCatalog.WILDCARD.equals(raw)) {
            return canonical;
        }
        if (atom.instanceOnly()) {
            throw invalid(atom.name(), raw, "the atom is instance-scoped, so no workspace path can"
                    + " narrow it");
        }
        return requireWorkspacePrefix(atom.name(), raw);
    }

    private String requireWorkspacePrefix(String atomName, String raw) {
        if (raw.length() > MAX_LENGTH) {
            throw invalid(atomName, raw, "the pattern must be at most " + MAX_LENGTH
                    + " characters (V87 grant_preset_atoms.resource_pattern)");
        }
        ResourceIdentity.FsKey key = ResourceIdentity.parseDeclaration(raw);
        if (key == null) {
            throw invalid(atomName, raw, "path patterns must be fs:<workspaceId>[/<relative path>]"
                    + " without dot segments, wildcards, backslashes or a leading slash");
        }
        UUID workspaceId;
        try {
            workspaceId = UUID.fromString(key.rootScopeId());
        } catch (IllegalArgumentException notUuid) {
            throw invalid(atomName, raw, "the fs: root scope must be a workspace UUID");
        }
        if (workspaces.findByIdAndDeletedAtIsNull(workspaceId).isEmpty()) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "WORKSPACE_NOT_FOUND",
                    "Workspace not found: " + workspaceId);
        }
        String relative = key.relativePath();
        if (!relative.isEmpty()) {
            for (String segment : relative.split("/", -1)) {
                if (segment.isEmpty() || segment.indexOf(':') >= 0) {
                    throw invalid(atomName, raw, "the relative path must not contain empty"
                            + " segments or colons");
                }
            }
        }
        // Separate gate on purpose: "may hand out a pattern rooted at this workspace" is a
        // workspace-scoped authority question, and a wildcard holder cannot answer it.
        requester.requireWorkspaceBindingAuthority(workspaceId);
        // Store the same normal form FsResourceKeys produces (lowercase, '/' separators, no
        // trailing slash) so two spellings of one prefix cannot become two role rows.
        String normalized = PathKey.lexical(raw);
        return normalized == null ? raw : normalized;
    }

    private static CpApiException invalid(String atomName, String requested, String why) {
        return new CpApiException(HttpStatus.BAD_REQUEST, CODE_INVALID,
                "resource pattern '" + requested + "' is not valid for atom " + atomName + ": " + why);
    }
}
