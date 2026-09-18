package com.cc01cc.p.xihe.cp.config;

import jakarta.persistence.EntityManager;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * PLAN-0346 (T1.8): bounds PostgreSQL lock waits inside ledger/context write
 * transactions. {@code SET LOCAL} is transaction-scoped, so the bound applies
 * only to the current transaction and never leaks to other users of the pooled
 * connection. Non-PostgreSQL datasources (H2 test contexts) skip the statement —
 * the invariant only exists on PostgreSQL.
 *
 * <p>Call {@link #apply()} as the first statement of every public ledger or
 * context write method whose first blocking statement is a row lock
 * ({@code FOR UPDATE}), a conditional {@code UPDATE}, or a unique-index
 * {@code INSERT}. Duplicate calls inside one transaction are harmless.
 * The timeout value comes from {@code cp.lock-timeout-ms}
 * (env {@code XIHE_CP_LOCK_TIMEOUT_MS}, default 5000ms).
 */
@Component
public class DbLockTimeout {

    private final EntityManager entityManager;
    private final boolean postgres;
    private final long timeoutMs;

    public DbLockTimeout(EntityManager entityManager,
                         @Value("${spring.datasource.url:}") String datasourceUrl,
                         @Value("${cp.lock-timeout-ms:5000}") long timeoutMs) {
        this.entityManager = entityManager;
        this.postgres = datasourceUrl != null && datasourceUrl.startsWith("jdbc:postgresql");
        this.timeoutMs = timeoutMs;
    }

    /**
     * Applies the transaction-scoped lock timeout. Must be called inside an
     * active transaction, before the first potentially blocking statement.
     * SQLSTATE 55P03 raised on timeout is translated by Spring into
     * {@code CannotAcquireLockException} and mapped to a 503
     * {@code OPERATION_LOCK_TIMEOUT} problem response at the API edge.
     */
    public void apply() {
        if (!postgres || timeoutMs <= 0) {
            return;
        }
        entityManager.createNativeQuery("SET LOCAL lock_timeout = " + timeoutMs).executeUpdate();
    }
}
