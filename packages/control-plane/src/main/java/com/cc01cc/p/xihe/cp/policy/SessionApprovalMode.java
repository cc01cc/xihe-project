package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * Persisted session approval mode (PLAN-0337 T1.4) — the single source of truth for the session
 * tier of the approval mode.
 *
 * <p>Only the mode is persisted ({@code sessions.approval_mode}); session rules and reuse grants
 * stay in {@link SessionPolicyState} for the lifetime of the session. A {@code null} column means
 * "inherit the workspace {@code approval-policy.mode}", which keeps existing rows and newly created
 * sessions on the workspace default without a data backfill.</p>
 *
 * <p>Fail-closed: unreadable state yields {@link Optional#empty()} so the caller falls back to the
 * workspace default and finally to {@code manual} — a broken read must never relax the decision.</p>
 */
@Component
public class SessionApprovalMode {

    private static final Logger log = LoggerFactory.getLogger(SessionApprovalMode.class);

    private final SessionRepository sessionRepository;

    public SessionApprovalMode(SessionRepository sessionRepository) {
        this.sessionRepository = sessionRepository;
    }

    /** Stored override for one session; empty when unset (inherit) or unreadable. */
    @Transactional(readOnly = true)
    public Optional<String> modeOf(String sessionId) {
        UUID id = parseUuid(sessionId);
        if (id == null) {
            return Optional.empty();
        }
        try {
            return sessionRepository.findById(id)
                    .map(Session::getApprovalMode)
                    .filter(mode -> mode != null && !mode.isBlank())
                    .map(mode -> mode.trim().toLowerCase(Locale.ROOT))
                    .filter(mode -> {
                        if (!SessionPolicyState.MODES.contains(mode)) {
                            log.warn("[POLICY] ignoring unsupported sessions.approval_mode={}", mode);
                            return false;
                        }
                        return true;
                    });
        } catch (RuntimeException e) {
            log.error("[POLICY] session approval mode lookup failed, falling back to workspace default "
                    + "sessionId={}", sessionId, e);
            return Optional.empty();
        }
    }

    /**
     * Persists the mode for one session. Callers must already have checked tenant ownership
     * ({@code SessionService.requireCurrent}); a missing row is rejected here as well.
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
        Session session = sessionRepository.findById(id)
                .orElseThrow(() -> new IllegalStateException("session not found: " + sessionId));
        session.setApprovalMode(mode);
        sessionRepository.save(session);
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
