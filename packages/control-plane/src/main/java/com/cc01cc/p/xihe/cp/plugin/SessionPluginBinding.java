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
 *
 * <p><b>{@code revision} is the session's catalog sequence value this snapshot was admitted at
 * (PLAN-0691 T1.6).</b> Every change to the session's attached set takes the <i>next</i> value of
 * the session-wide high-water mark — a fresh attach starts at 1, a detach and a re-attach each take
 * the next one — so {@code max(revision)} (exposed as {@code catalogVersion}) moves exactly once per
 * catalog change, no matter which binding changed. The value is assigned by
 * {@link PluginBindingService} (which reads the high-water mark), not incremented here: a per-row
 * {@code +1} would leave the sequence standing still when another row already holds the bigger
 * value, which is why a plain per-pair counter was the wrong shape. That is also what lets a
 * client/UI tell "a run admitted before this change is still on the older catalog" without a second
 * counter or a migration: the sequence already lives in this table ({@code V136}).</p>
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
        this(sessionId, bindingId, snapshot, 1);
    }

    /**
     * @param revision the session catalog sequence value this attachment is admitted at; the caller
     *                 assigns the next value of the session high-water mark, so two attachments of one
     *                 session never share it
     */
    public SessionPluginBinding(UUID sessionId, UUID bindingId, JsonNode snapshot, int revision) {
        this.sessionId = sessionId;
        this.bindingId = bindingId;
        this.snapshot = snapshot;
        this.revision = revision;
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

    /**
     * Revive (or refresh) the row: the snapshot the next turn will be admitted with, tagged with the
     * next session catalog sequence value.
     */
    public void reattach(JsonNode freshSnapshot, int revision) {
        this.snapshot = freshSnapshot;
        this.revision = revision;
        this.attachedAt = Instant.now();
        this.detachedAt = null;
    }

    /**
     * Detach is a catalog change, so it <b>takes</b> the next session sequence value: the session's
     * {@code catalogVersion} (the max revision high-water, PLAN-0691 T1.6) must advance when a binding
     * leaves the attached set, otherwise a client comparing catalog versions could not tell a detach
     * from an attach. The caller supplies the value because it has just read the high-water mark —
     * incrementing here would stall the sequence whenever another row already holds a bigger value.
     *
     * <p>The snapshot itself is left untouched on purpose — it is the evidence of what earlier turns
     * were admitted with, and mutating it on detach would rewrite that history. An idempotent second
     * detach never reaches here: {@code PluginBindingService.detach} returns early when the row is
     * already detached, so a no-op consumes no sequence value.</p>
     */
    public void detach(int revision) {
        this.revision = revision;
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
