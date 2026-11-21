package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.repository.InstanceOwnerRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * task-18 J1/J2: the first-run content seed reaches the <b>real first-install path</b> — the
 * onboarding {@code POST /api/v1/auth/register} that creates the first account when
 * {@code cp.bootstrap.seed-admin=false} (the shipped default) — and not only the seeded-admin branch
 * of {@link DataSeeder}.
 *
 * <h2>Why a narrow entry and not a call inside {@link DataSeeder}</h2>
 * <p>{@code DataSeeder} returns before its content-seed line whenever the admin seed is off, and the
 * account it would hand over does not exist yet at boot time. The onboarding request is the earliest
 * moment the instance has a first account, so the trigger lives here and the product path calls it
 * ({@link FirstRunContentSeedRequestFilter}). {@code DataSeeder} is untouched on purpose: it belongs
 * to another card's write scope.</p>
 *
 * <h2>Contract</h2>
 * <ul>
 *   <li><b>Idempotent.</b> The seed's own keys (workspace idempotency key, connection natural key,
 *       subject name lookup) plus the {@code cp.bootstrap.seed-content=auto} emptiness gate make a
 *       second run insert nothing.</li>
 *   <li><b>Serialised.</b> Concurrent first requests take the existing instance-level write mutex
 *       ({@code instance_owner} singleton row, {@code SELECT … FOR UPDATE}); the loser then reads the
 *       <em>earliest</em> account and finds the content already seeded (or seeds it itself if the
 *       winner crashed). Two simultaneous registrations therefore cannot leave the instance empty.</li>
 *   <li><b>Never rolls back the registration.</b> It runs in its own transaction <i>after</i> the
 *       register request has committed, and it swallows every failure into a WARN plus
 *       {@link #retryPending()} — the retry entry is the next first-run product request
 *       ({@code GET /api/v1/auth/bootstrap-status}) or the documented
 *       {@code cp.bootstrap.seed-content=true} backfill.</li>
 * </ul>
 *
 * <p><b>Known boundary (reported, not hidden):</b> the instance-scoped provider connection needs an
 * instance owner + {@code cap:instance:admin}. A fresh onboarding account is bound to the USER tier
 * (the launcher's D-1818 note calls this the claim chicken-and-egg gap), so the seeder warns and skips
 * the connection there; the workspace and the three subjects still land.</p>
 */
@Component
public class FirstRunContentSeedTrigger {

    private static final Logger logger = LoggerFactory.getLogger(FirstRunContentSeedTrigger.class);

    private final UserRepository users;
    private final InstanceOwnerRepository instanceOwner;
    private final FirstRunContentSeeder seeder;
    private final DbLockTimeout dbLockTimeout;
    private final TransactionTemplate transaction;
    private final boolean disabled;

    /** Set when an attempt failed; the next first-run request retries instead of waiting for a restart. */
    private final AtomicBoolean pendingRetry = new AtomicBoolean();

    public FirstRunContentSeedTrigger(UserRepository users,
                                      InstanceOwnerRepository instanceOwner,
                                      FirstRunContentSeeder seeder,
                                      DbLockTimeout dbLockTimeout,
                                      PlatformTransactionManager transactionManager,
                                      @Value("${cp.bootstrap.seed-content:auto}") String seedContent) {
        this.users = users;
        this.instanceOwner = instanceOwner;
        this.seeder = seeder;
        this.dbLockTimeout = dbLockTimeout;
        this.transaction = new TransactionTemplate(transactionManager);
        this.disabled = seedContent != null
                && FirstRunContentSeeder.MODE_FALSE.equals(seedContent.trim().toLowerCase(Locale.ROOT));
    }

    /**
     * Called right after the product path created an account. Idempotent and never throws; it seeds for
     * the earliest account and the seeder's emptiness gate makes every later call a no-op.
     */
    public void afterFirstAccountCreated() {
        attempt("register");
    }

    /** J2 retry entry: a later first-run product request retries a failed attempt. */
    public void retryIfPending() {
        if (pendingRetry.get()) {
            attempt("retry");
        }
    }

    /** Whether the last attempt failed and a retry is owed. */
    public boolean retryPending() {
        return pendingRetry.get();
    }

    private void attempt(String reason) {
        if (disabled) {
            return;
        }
        try {
            Boolean seeded = transaction.execute(status -> {
                // Bound the wait first, then take the frozen instance-level write mutex
                // (instance_owner -> users): concurrent registrations serialise here.
                dbLockTimeout.apply();
                instanceOwner.lockSingleton();
                User first = firstAccount();
                if (first == null) {
                    return Boolean.FALSE;
                }
                seeder.seed(first);
                return Boolean.TRUE;
            });
            pendingRetry.set(false);
            if (Boolean.TRUE.equals(seeded)) {
                logger.info("[LIFECYCLE] service=cp event=first_run_content_seeded reason={} pendingModelIntent={}",
                        reason, seeder.lastModelIntentPending());
            }
        } catch (Exception failure) {
            pendingRetry.set(true);
            logger.warn("seed-content: onboarding trigger failed reason={} ({}) -- the registration is"
                            + " unaffected; retry on the next first-run request or set"
                            + " cp.bootstrap.seed-content=true",
                    reason, failure.getClass().getSimpleName());
        }
    }

    /**
     * The first-install account: the earliest row. Deliberately not "the only row" — two concurrent
     * registrations both commit before either hook runs, and requiring exactly one would then skip the
     * seed forever. The seed is keyed and gated, so "earliest" is the stable owner either way.
     */
    private User firstAccount() {
        // Bounded read: this runs on every registration, and a large instance must not pay a
        // full-table load just to answer "who registered first".
        return users.findAll(PageRequest.of(0, 1, Sort.by(Sort.Direction.ASC, "createdAt").and(Sort.by("id"))))
                .stream()
                .findFirst()
                .orElse(null);
    }
}
