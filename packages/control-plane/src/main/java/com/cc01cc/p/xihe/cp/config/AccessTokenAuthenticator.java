package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * PLAN-0580 decision #14: the single access-token decision point.
 *
 * <p>A request is authenticated only when <b>all</b> of the following hold, and
 * every failure mode is a plain "no authentication" — never an exception, so the
 * security chain answers 401 {@code AUTHORIZATION_REQUIRED} instead of a 500:
 *
 * <table>
 *   <caption>three fail-closed states (spec §6)</caption>
 *   <tr><th>态</th><th>condition</th></tr>
 *   <tr><td>T1</td><td>{@code sub} is not a UUID ({@code UUID.fromString} would throw)</td></tr>
 *   <tr><td>T2</td><td>{@code sub} is a UUID but no such user row exists</td></tr>
 *   <tr><td>T3</td><td>{@code tv} is missing, or {@code tv != users.token_version}</td></tr>
 * </table>
 *
 * <p>Both {@link JwtAuthenticationFilter} (Authentication) and
 * {@link TenantContextInterceptor} (tenant context) call this one method, so the
 * two layers cannot drift (decision #21). There is no cache: the row is read by
 * primary key per request (decision #7).
 */
@Component
public class AccessTokenAuthenticator {

    private static final Logger logger = LoggerFactory.getLogger(AccessTokenAuthenticator.class);

    /** Resolved caller facts; the role comes from the signed claim, the epoch from the row. */
    public record AuthenticatedUser(String userId, String role, int tokenVersion) {}

    private final JwtTokenProvider jwtTokenProvider;
    private final UserRepository userRepository;

    public AccessTokenAuthenticator(JwtTokenProvider jwtTokenProvider, UserRepository userRepository) {
        this.jwtTokenProvider = jwtTokenProvider;
        this.userRepository = userRepository;
    }

    /** Empty means "do not authenticate this request" (T1/T2/T3 or invalid signature). */
    public Optional<AuthenticatedUser> authenticate(String token) {
        if (token == null || token.isBlank() || !jwtTokenProvider.validateToken(token)) {
            return Optional.empty();
        }
        String subject;
        try {
            subject = jwtTokenProvider.getUserIdFromToken(token);
        } catch (RuntimeException e) {
            // A signed token whose payload cannot be read is not a 500: it is a
            // failed authentication, exactly like an invalid signature.
            logger.debug("[AUTH] access token payload unreadable: {}", e.getMessage());
            return Optional.empty();
        }
        UUID userId;
        try {
            userId = UUID.fromString(subject);
        } catch (IllegalArgumentException | NullPointerException e) {
            // T1: non-UUID subject (tests/legacy service tokens). Must not bubble
            // up as a 500 — the filter has no try/catch of its own.
            logger.debug("[AUTH] access token rejected reason=non_uuid_subject");
            return Optional.empty();
        }

        User user = userRepository.findById(userId).orElse(null);
        if (user == null) {
            // T2: deleted/never-persisted subject.
            logger.debug("[AUTH] access token rejected reason=unknown_subject userId={}", userId);
            return Optional.empty();
        }

        Integer claimVersion;
        try {
            claimVersion = jwtTokenProvider.getTokenVersionFromToken(token);
        } catch (RuntimeException e) {
            logger.debug("[AUTH] access token epoch unreadable: {}", e.getMessage());
            return Optional.empty();
        }
        if (claimVersion == null || claimVersion != user.getTokenVersion()) {
            // T3: pre-epoch token (no `tv`) or a token issued before the last bump.
            logger.debug("[AUTH] access token rejected reason=token_version_mismatch userId={}"
                    + " claim={} current={}", userId, claimVersion, user.getTokenVersion());
            return Optional.empty();
        }

        return Optional.of(new AuthenticatedUser(userId.toString(),
                jwtTokenProvider.getRoleFromToken(token), claimVersion));
    }
}
