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
 * but <b>no API could produce such a value</b>: {@code POST/PATCH /api/v1/presets} always stored
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
        if (ResourceNamespaces.isRequestResource(canonical)) {
            // task-835: approve is always about THIS request's resource. Neither a blank pattern
            // (which would become the canonical default) nor `*` may be stored: either one turns a
            // single approval grant into "approve anything".
            if (raw == null || raw.isEmpty() || PermissionAtomCatalog.WILDCARD.equals(raw)
                    || ResourceNamespaces.isRequestResource(raw)) {
                throw invalid(atom.name(), raw,
                        "approve is scoped to the resource of the request; a blank or '*' pattern"
                                + " would approve every resource");
            }
        } else if (raw == null || raw.isEmpty()) {
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
        rejectUnwritableNamespace(atom.name(), raw);
        if (ResourceNamespaces.MCP.equals(ResourceNamespaces.namespaceOf(raw))) {
            return canonicalMcpPattern(atom.name(), raw);
        }
        return requireWorkspacePrefix(atom.name(), raw);
    }

    /**
     * task-870 / D-1921: {@code mcp:*} and {@code mcp:<canonicalId>} are the only writable MCP
     * shapes. A non-canonical id is refused with the canonical suggestion instead of being stored
     * inert: a grant that never matches because of a casing/spacing difference is indistinguishable
     * from a typo, and silently accepting it would hide the mistake.
     */
    private String canonicalMcpPattern(String atomName, String raw) {
        if (raw.length() > MAX_LENGTH) {
            throw invalid(atomName, raw, "the pattern must be at most " + MAX_LENGTH
                    + " characters (V87 grant_preset_atoms.resource_pattern)");
        }
        String value = ResourceNamespaces.valueOf(raw);
        if (ResourceNamespaces.WILDCARD.equals(value)) {
            return ResourceNamespaces.MCP_WILDCARD;
        }
        String canonical = ResourceNamespaces.canonicalMcpServerId(value);
        if (canonical == null) {
            throw invalid(atomName, raw, "mcp: needs a server id or '*'");
        }
        if (!canonical.equals(value)) {
            throw invalid(atomName, raw, "the server id is not canonical; write "
                    + ResourceNamespaces.MCP_PREFIX + canonical);
        }
        if (ResourceNamespaces.isBuiltinMcpServerId(canonical)) {
            throw invalid(atomName, raw, canonical + " is a built-in gateway id, not an MCP server");
        }
        return ResourceNamespaces.MCP_PREFIX + canonical;
    }

    /**
     * task-830: the registry decides which namespaces may appear in a stored grant. The three
     * refusals are distinct on purpose — they are different mistakes, and the message says which:
     *
     * <ul>
     *   <li>{@code phys:} is a host absolute path expanded from an {@code fs:} declaration at
     *       evaluation time. Storing it would pin the grant to one machine's directory layout.</li>
     *   <li>{@code workspace:}/{@code session:} are context keys. {@code workspace:admin} is a
     *       capability atom with the same spelling but it is not a resource, so it never arrives
     *       here as a pattern.</li>
     *   <li>anything else is an unregistered namespace; unknown fails closed, it does not fall back
     *       to a default.</li>
     * </ul>
     */
    private void rejectUnwritableNamespace(String atomName, String raw) {
        switch (ResourceNamespaces.grantabilityOf(raw)) {
            case EVALUATION_ONLY -> throw invalid(atomName, raw,
                    "phys: is an evaluation-time key expanded from a declared fs: key; it is never"
                            + " stored in a grant");
            case CONTEXT_RESERVED -> throw invalid(atomName, raw,
                    "workspace:/session: are visibility context, not grant resources"
                            + " (workspace:admin is a capability atom with the same spelling)");
            case UNKNOWN -> throw invalid(atomName, raw,
                    "unknown resource namespace; registered namespaces are "
                            + ResourceNamespaces.registeredNames());
            case GRANTABLE -> {
                // The namespace is writable; the per-atom shape rules below still apply.
            }
        }
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
