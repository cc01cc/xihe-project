package com.cc01cc.p.xihe.cp.plugin;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * PLAN-0691 T1.2 (V136 / D-65 ② / DP-6): one workspace's binding of one installed plugin version.
 *
 * <p>The binding names a plugin <b>version row</b> through {@code (pluginId, digest)}, which is the
 * composite FK to {@code plugins(id, digest)} — the DB refuses to delete a version that is still
 * bound (ON DELETE RESTRICT), so the uninstall path must fail 409 and ask for an explicit detach
 * instead of silently dropping rows (D-65 ③).</p>
 *
 * <p>{@code grantedAtoms} is a Jackson-2 node held <b>internally</b>: it is the JSON array persisted
 * in the jsonb column, and only {@code PluginBindingView} (a {@code List<String>}) reaches the wire —
 * a raw node would be serialised by Jackson 3 as a bean (PLAN-0633 C1).</p>
 *
 * <p>T1.3 keeps the effective set in {@code plugin_binding_grants} and owns the intersection; T1.2
 * therefore stores the granted atoms here and reports {@code effective = granted} as the skeleton,
 * which is why {@link #grantSource()} is recorded next to it (S5 vocabulary: {@code default} for the
 * builtin workspace default set, {@code plugin_binding} for an explicit grant).</p>
 */
@Entity
@Table(name = "plugin_bindings")
public class PluginBinding {

    /** Bindings are workspace-scoped by construction; the column is explicit, not implied by a null. */
    public static final String SCOPE_WORKSPACE = "workspace";

    /** S5 source vocabulary — identical token to {@code GrantSources.PLUGIN_BINDING} (T1.3). */
    public static final String GRANT_SOURCE_BINDING = "plugin_binding";

    /** S5 source vocabulary for the builtin workspace default grant set. */
    public static final String GRANT_SOURCE_DEFAULT = "default";

    @Id
    @Column(name = "id", columnDefinition = "uuid", nullable = false)
    private UUID id;

    @Column(name = "plugin_id", nullable = false, length = 128)
    private String pluginId;

    @Column(name = "digest", nullable = false, length = 80)
    private String digest;

    @Column(name = "version", nullable = false, length = 64)
    private String version;

    @Column(name = "workspace_id", columnDefinition = "uuid", nullable = false)
    private UUID workspaceId;

    @Column(name = "scope_type", nullable = false, length = 16)
    private String scopeType;

    @Column(name = "state", nullable = false, length = 16)
    private String state;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "granted_atoms", nullable = false, columnDefinition = "jsonb")
    private JsonNode grantedAtoms;

    @Column(name = "grant_source", nullable = false, length = 32)
    private String grantSource;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected PluginBinding() {
        // JPA
    }

    public PluginBinding(UUID workspaceId, Plugin plugin, PluginBindingState state,
            JsonNode grantedAtoms, String grantSource) {
        this.id = UUID.randomUUID();
        this.workspaceId = workspaceId;
        this.pluginId = plugin.getId();
        this.digest = plugin.getDigest();
        this.version = plugin.getVersion();
        this.scopeType = SCOPE_WORKSPACE;
        this.state = state.wire();
        this.grantedAtoms = grantedAtoms;
        this.grantSource = grantSource;
        this.createdAt = Instant.now();
        this.updatedAt = this.createdAt;
    }

    public UUID getId() {
        return id;
    }

    public String getPluginId() {
        return pluginId;
    }

    public String getDigest() {
        return digest;
    }

    public String getVersion() {
        return version;
    }

    public UUID getWorkspaceId() {
        return workspaceId;
    }

    public String getScopeType() {
        return scopeType;
    }

    public PluginBindingState state() {
        return PluginBindingState.of(state);
    }

    public JsonNode getGrantedAtoms() {
        return grantedAtoms;
    }

    /**
     * The granted atoms as plain strings.
     *
     * <p>Hand-written on purpose: the service compares against the manifest's requested atoms and
     * the view lists them, and neither may touch the node's Jackson-2 identity (PLAN-0633 C1).</p>
     */
    public List<String> grantedAtomList() {
        List<String> atoms = new ArrayList<>();
        if (grantedAtoms != null && grantedAtoms.isArray()) {
            grantedAtoms.forEach(atom -> atoms.add(atom.asText()));
        }
        return List.copyOf(atoms);
    }

    public String grantSource() {
        return grantSource;
    }

    public void setState(PluginBindingState next) {
        this.state = next.wire();
        this.updatedAt = Instant.now();
    }

    public void replaceGrantedAtoms(JsonNode atoms, String source) {
        this.grantedAtoms = atoms;
        this.grantSource = source;
        this.updatedAt = Instant.now();
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }
}
