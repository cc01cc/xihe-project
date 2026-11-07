package com.cc01cc.p.xihe.cp.plugin;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.IdClass;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.io.Serializable;
import java.time.Instant;
import java.util.Objects;

/**
 * PLAN-0691 T1.1 (V135 / D-65): one installed plugin <b>version row</b>.
 *
 * <p>The identity is {@code (id, digest)} — a plugin may keep several versions side by side so a
 * rollback is just a flag flip ({@code is_current}) instead of a re-install. {@code manifest} is
 * the canonical JSON exactly as it was validated at install time; it is a Jackson-2 node held
 * <b>internally</b> (the same discipline as {@code Skill.attachments}) and must never reach the wire
 * — {@code PluginView} projects the scalar fields (PLAN-0633 C1).</p>
 */
@Entity
@Table(name = "plugins")
@IdClass(Plugin.PluginKey.class)
public class Plugin {

    /** D-66 vocabulary: a plugin row is either enabled or disabled (fail-closed default). */
    public static final String STATE_ENABLED = "enabled";
    public static final String STATE_DISABLED = "disabled";

    /** B-3: builtin packages live under {@code plugins/official/}, third-party under {@code plugins/local/}. */
    public static final String SOURCE_BUILTIN = "builtin";
    public static final String SOURCE_THIRD_PARTY = "third-party";

    @Id
    @Column(name = "id", nullable = false, length = 128)
    private String id;

    @Id
    @Column(name = "digest", nullable = false, length = 80)
    private String digest;

    @Column(name = "version", nullable = false, length = 64)
    private String version;

    @Column(name = "state", nullable = false, length = 16)
    private String state;

    @Column(name = "source", nullable = false, length = 16)
    private String source;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "manifest", nullable = false, columnDefinition = "jsonb")
    private JsonNode manifest;

    @Column(name = "is_current", nullable = false)
    private boolean current;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected Plugin() {
        // JPA
    }

    public Plugin(String id, String digest, String version, String source, JsonNode manifest) {
        this.id = id;
        this.digest = digest;
        this.version = version;
        this.source = source;
        this.manifest = manifest;
        this.state = STATE_DISABLED;
        this.createdAt = Instant.now();
        this.updatedAt = this.createdAt;
    }

    public String getId() {
        return id;
    }

    public String getDigest() {
        return digest;
    }

    public String getVersion() {
        return version;
    }

    public String getState() {
        return state;
    }

    public void setState(String state) {
        this.state = state;
        this.updatedAt = Instant.now();
    }

    public String getSource() {
        return source;
    }

    public JsonNode getManifest() {
        return manifest;
    }

    public boolean isCurrent() {
        return current;
    }

    public void setCurrent(boolean current) {
        this.current = current;
        this.updatedAt = Instant.now();
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }

    /** {@code @IdClass} key for the {@code (id, digest)} primary key (D-65). */
    public static class PluginKey implements Serializable {

        private static final long serialVersionUID = 1L;

        private String id;
        private String digest;

        public PluginKey() {
            // JPA
        }

        public PluginKey(String id, String digest) {
            this.id = id;
            this.digest = digest;
        }

        @Override
        public boolean equals(Object other) {
            if (this == other) {
                return true;
            }
            if (!(other instanceof PluginKey key)) {
                return false;
            }
            return Objects.equals(id, key.id) && Objects.equals(digest, key.digest);
        }

        @Override
        public int hashCode() {
            return Objects.hash(id, digest);
        }
    }
}
