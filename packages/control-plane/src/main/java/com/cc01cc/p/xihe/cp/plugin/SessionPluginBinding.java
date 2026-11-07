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
import java.util.UUID;

/**
 * PLAN-0691 T1.2 (V136 / DP-6): the frozen per-session view of one binding.
 *
 * <p>Attach copies the binding's identity into {@code snapshot} ({@code bindingId/pluginId/version/
 * digest/state}) so an in-flight run keeps seeing exactly what was attached even after the binding
 * changes state or the plugin upgrades — "next turn, not this one" (design S4). Detach stamps
 * {@code detachedAt} and keeps the row: the delivered tool set is evidence, not a cache entry, so it
 * must stay answerable which snapshot a given turn was admitted with.</p>
 *
 * <p>The row only points at {@code bindingId} (DP-6): {@code workspace_id}/{@code user_id} live on
 * the binding, and copying them here would create a second ownership axis that can drift.</p>
 */
@Entity
@Table(name = "session_plugin_bindings")
@IdClass(SessionPluginBinding.AttachmentKey.class)
public class SessionPluginBinding {

    @Id
    @Column(name = "session_id", columnDefinition = "uuid", nullable = false)
    private UUID sessionId;

    @Id
    @Column(name = "binding_id", columnDefinition = "uuid", nullable = false)
    private UUID bindingId;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "snapshot", nullable = false, columnDefinition = "jsonb")
    private JsonNode snapshot;

    @Column(name = "revision", nullable = false)
    private int revision;

    @Column(name = "attached_at", nullable = false)
    private Instant attachedAt;

    @Column(name = "detached_at")
    private Instant detachedAt;

    protected SessionPluginBinding() {
        // JPA
    }

    public SessionPluginBinding(UUID sessionId, UUID bindingId, JsonNode snapshot) {
        this.sessionId = sessionId;
        this.bindingId = bindingId;
        this.snapshot = snapshot;
        this.revision = 1;
        this.attachedAt = Instant.now();
    }

    public UUID getSessionId() {
        return sessionId;
    }

    public UUID getBindingId() {
        return bindingId;
    }

    public JsonNode getSnapshot() {
        return snapshot;
    }

    public int getRevision() {
        return revision;
    }

    public Instant getAttachedAt() {
        return attachedAt;
    }

    public Instant getDetachedAt() {
        return detachedAt;
    }

    public boolean isActive() {
        return detachedAt == null;
    }

    /** Revive (or refresh) the row: a new revision is what the next turn will be admitted with. */
    public void reattach(JsonNode freshSnapshot) {
        this.snapshot = freshSnapshot;
        this.revision = this.revision + 1;
        this.attachedAt = Instant.now();
        this.detachedAt = null;
    }

    public void detach() {
        this.detachedAt = Instant.now();
    }

    /** {@code @IdClass} key for the {@code (session_id, binding_id)} primary key. */
    public static class AttachmentKey implements Serializable {

        private static final long serialVersionUID = 1L;

        private UUID sessionId;
        private UUID bindingId;

        public AttachmentKey() {
            // JPA
        }

        public AttachmentKey(UUID sessionId, UUID bindingId) {
            this.sessionId = sessionId;
            this.bindingId = bindingId;
        }

        @Override
        public boolean equals(Object other) {
            if (this == other) {
                return true;
            }
            if (!(other instanceof AttachmentKey key)) {
                return false;
            }
            return Objects.equals(sessionId, key.sessionId)
                    && Objects.equals(bindingId, key.bindingId);
        }

        @Override
        public int hashCode() {
            return Objects.hash(sessionId, bindingId);
        }
    }
}
