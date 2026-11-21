package com.cc01cc.p.xihe.cp.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * task-18 J1/J2: binds the first-run content seed to the <b>product path</b> without inventing an
 * endpoint. The onboarding registration ({@code POST /api/v1/auth/register}) is the request that
 * creates the first account on a default installation, and {@code GET /api/v1/auth/bootstrap-status}
 * is the request the UI issues on every load — it doubles as the retry entry.
 *
 * <h2>Why a servlet filter and not a controller</h2>
 * <p>J2 forbids a new side-channel controller: the trigger has to ride the real flow. The register
 * call site lives in {@code cp.auth} (and the seeded-admin analogue in {@code DataSeeder}), neither of
 * which is in this card's write scope, so the same product request is observed here instead. The
 * filter is the innermost servlet filter (Boot's default {@code LOWEST_PRECEDENCE}), so by the time
 * it looks at the status the controller has returned and the registration transaction has committed —
 * a seed failure can no longer roll the registration back.</p>
 *
 * <p>This class decides <b>nothing</b> about what to seed: it only says "a first-install product
 * request completed" and delegates to {@link FirstRunContentSeedTrigger}, which owns the idempotency,
 * the instance-level lock and the WARN-only failure contract.</p>
 */
@Component
public class FirstRunContentSeedRequestFilter extends OncePerRequestFilter {

    private static final Logger logger = LoggerFactory.getLogger(FirstRunContentSeedRequestFilter.class);

    static final String REGISTER_PATH = "/api/v1/auth/register";
    static final String BOOTSTRAP_STATUS_PATH = "/api/v1/auth/bootstrap-status";

    private final FirstRunContentSeedTrigger trigger;

    public FirstRunContentSeedRequestFilter(FirstRunContentSeedTrigger trigger) {
        this.trigger = trigger;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        chain.doFilter(request, response);
        // Everything below runs after the controller (and its transaction) finished. A listener that
        // throws here would surface as a spurious error after a committed response, so it must not.
        try {
            String path = request.getRequestURI();
            if (path == null || request.getMethod() == null) {
                return;
            }
            int status = response.getStatus();
            if ("POST".equalsIgnoreCase(request.getMethod())
                    && path.endsWith(REGISTER_PATH)
                    && status >= 200 && status < 300) {
                trigger.afterFirstAccountCreated();
            } else if ("GET".equalsIgnoreCase(request.getMethod())
                    && path.endsWith(BOOTSTRAP_STATUS_PATH)
                    && status == 200) {
                trigger.retryIfPending();
            }
        } catch (Exception unexpected) {
            logger.warn("seed-content: the first-run request hook swallowed an unexpected failure ({})",
                    unexpected.getClass().getSimpleName());
        }
    }
}
