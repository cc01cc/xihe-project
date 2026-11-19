package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.service.SessionApprovalModeStore;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * Persisted session permission tier and its derived approval mode (D-1908 rev4; PLAN-0337 T1.4).
 *
 * <p>Since V176 the source of truth is {@code sessions.permission_tier}
 * ({@link SessionPermissionTier}: view | workspace | full, null = inherit the workspace policy).
 * The {@code sessions.approval_mode} column is DERIVED (view/workspace -> manual, full -> auto) and
 * stays readable for rows written before V176; a stored tier always wins over that legacy column,
 * never the reverse.</p>
 *
 * <p>PLAN-0470 (T3.2): this policy view no longer injects {@code SessionRepository}; reads and the
 * write go through the session domain's {@link SessionApprovalModeStore}.</p>
 *
 * <p>Fail-closed: {@link #modeOf} keeps its historical "unreadable means empty" contract so callers
 * fall back to the workspace default, while {@link #tierOf} deliberately propagates the failure —
 * the context provider must distinguish "inherit" from "unreadable" and force the strictest tier on
 * the latter.</p>
 */
@Component
public class SessionApprovalMode {

    private static final Logger log = LoggerFactory.getLogger(SessionApprovalMode.class);

    private final SessionApprovalModeStore store;

    public SessionApprovalMode(SessionApprovalModeStore store) {
        this.store = store;
    }

    /**
     * Effective stored mode for one session: the tier-derived mode when a tier is stored, else the
     * legacy {@code approval_mode} column. Empty when unset (inherit) or unreadable.
     */
    @Transactional(readOnly = true)
    public Optional<String> modeOf(String sessionId) {
        UUID id = parseUuid(sessionId);
        if (id == null) {
            return Optional.empty();
        }
        try {
            Optional<String> tierMode = store.findPermissionTier(id)
                    .flatMap(SessionPermissionTier::normalize)
                    .map(SessionPermissionTier::modeForTier);
            return tierMode.isPresent() ? tierMode : legacyMode(id);
        } catch (RuntimeException e) {
            log.error("[POLICY] session approval mode lookup failed, falling back to workspace default "
                    + "sessionId={}", sessionId, e);
            return Optional.empty();
        }
    }

    /**
     * Stored permission tier for one session (D-1908). Empty when unset or the value is not in
     * {@link SessionPermissionTier#TIERS}; a failed read <b>propagates</b> so the caller can fail
     * closed instead of silently inheriting a possibly looser workspace layer.
     */
    @Transactional(readOnly = true)
    public Optional<String> tierOf(String sessionId) {
        UUID id = parseUuid(sessionId);
        if (id == null) {
            return Optional.empty();
        }
        return store.findPermissionTier(id)
                .flatMap(tier -> {
                    Optional<String> normalized = SessionPermissionTier.normalize(tier);
                    if (normalized.isEmpty() && tier != null && !tier.isBlank()) {
                        log.warn("[POLICY] ignoring unsupported sessions.permission_tier={}", tier);
                    }
                    return normalized;
                });
    }

    /**
     * Legacy-compatible mode switch. The tier is the source of truth, so this writes the tier whose
     * derived mode equals {@code mode} (manual -> workspace, auto -> full) unless the stored tier
     * already derives that mode, in which case the finer value (e.g. view) is preserved.
     *
     * <p>Callers must already have checked tenant ownership
     * ({@code SessionService.requireCurrent}); a missing row is rejected here as well.</p>
     *
     * @throws IllegalArgumentException when the mode is not {@code manual} / {@code auto}
     * @throws IllegalStateException    when the session row does not exist
     */
    @Transactional
    public void setMode(String sessionId, String mode) {
        if (mode == null || !SessionPolicyState.MODES.contains(mode)) {
            throw new IllegalArgumentException("unsupported policy mode: " + mode);
        }
        UUID id = parseUuid(sessionId);
        if (id == null) {
            throw new IllegalStateException("session not found: " + sessionId);
        }
        String tier = store.findPermissionTier(id)
                .flatMap(SessionPermissionTier::normalize)
                .filter(current -> SessionPermissionTier.modeForTier(current).equals(mode))
                .orElseGet(() -> SessionPermissionTier.tierForMode(mode));
        store.setPermissionTier(id, tier, mode);
    }

    /**
     * Sets the session permission tier (D-1908) and its derived approval mode in the same write.
     *
     * @throws IllegalArgumentException when the tier is not {@code view} / {@code workspace} / {@code full}
     * @throws IllegalStateException    when the session row does not exist
     */
    @Transactional
    public void setTier(String sessionId, String tier) {
        String normalized = SessionPermissionTier.normalize(tier)
                .orElseThrow(() -> new IllegalArgumentException("unsupported permission tier: " + tier));
        UUID id = parseUuid(sessionId);
        if (id == null) {
            throw new IllegalStateException("session not found: " + sessionId);
        }
        store.setPermissionTier(id, normalized, SessionPermissionTier.modeForTier(normalized));
    }

    /** Legacy column read: trimmed, lower-cased, whitelisted, empty for unsupported values. */
    private Optional<String> legacyMode(UUID id) {
        return store.findApprovalMode(id)
                .filter(mode -> mode != null && !mode.isBlank())
                .map(mode -> mode.trim().toLowerCase(Locale.ROOT))
                .filter(mode -> {
                    if (!SessionPolicyState.MODES.contains(mode)) {
                        log.warn("[POLICY] ignoring unsupported sessions.approval_mode={}", mode);
                        return false;
                    }
                    return true;
                });
    }

    private static UUID parseUuid(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
