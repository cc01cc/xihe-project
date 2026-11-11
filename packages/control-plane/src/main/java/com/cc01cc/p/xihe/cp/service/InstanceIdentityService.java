package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.entity.InstanceIdentity;
import com.cc01cc.p.xihe.cp.repository.InstanceIdentityRepository;
import com.cc01cc.p.xihe.cp.telemetry.DeploymentIdProvider;
import java.time.Instant;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * D-935 / PLAN-0767 M1: the deployment identity decision point.
 *
 * <p>The row is immutable after the first boot, so once {@link #ensureSeeded} has committed the
 * UUID is cached in memory; the eleven former sentinel consumer sites read
 * {@link #ownerId()} / {@link #isInstanceOwnerId(String)} instead of a literal sentinel. Seeding is
 * one transaction: env three-state check, idempotent insert, sentinel backfill, residual assertion
 * and the init/backfill audit row either all commit or all roll back.</p>
 */
@Service
public class InstanceIdentityService {

    private static final Logger logger = LoggerFactory.getLogger(InstanceIdentityService.class);
    private static final String RESOURCE_TYPE = "instance_identity";

    /** The wire-level schema version of this milestone: M1 never reports one (spec §5). */
    public static final String SCHEMA_VERSION = null;

    private final InstanceIdentityRepository repository;
    private final DeploymentIdProvider deploymentIdProvider;
    private final AuditLogger audit;

    /** Seeded values; never null after a successful {@link #ensureSeeded} (the row is immutable). */
    private volatile UUID cachedInstanceId;
    private volatile Instant cachedCreatedAt;

    public InstanceIdentityService(InstanceIdentityRepository repository,
                                   DeploymentIdProvider deploymentIdProvider,
                                   AuditLogger audit) {
        this.repository = repository;
        this.deploymentIdProvider = deploymentIdProvider;
        this.audit = audit;
    }

    /** The deployment identity anchor (UUID). */
    public UUID instanceId() {
        UUID value = cachedInstanceId;
        if (value == null) {
            throw new IllegalStateException("Instance identity is not seeded yet");
        }
        return value;
    }

    /** The same identity as the wire string used by {@code provider_connections.owner_id}. */
    public String ownerId() {
        return instanceId().toString();
    }

    /** First-boot instant of the identity row (the immutable {@code createdAt} of the read view). */
    public Instant createdAt() {
        instanceId();
        return cachedCreatedAt;
    }

    /**
     * True when {@code candidate} denotes this deployment: dashes and case are ignored so the
     * legacy 32-hex deployment-id form and a canonical UUID compare equal.
     */
    public boolean isInstanceOwnerId(String candidate) {
        UUID value = cachedInstanceId;
        return value != null && InstanceIdentityFormat.equalsIdentity(candidate, value.toString());
    }

    /**
     * First-boot seeding, idempotent and run on every start (also the repair path for sentinel rows
     * left by an older build). Fail-fast on an invalid or conflicting {@code XIHE_DEPLOYMENT_ID}:
     * the fixed log line carries no UUID value, and the thrown exception makes the process exit
     * non-zero before it can serve business traffic.
     */
    @Transactional
    public void ensureSeeded(String configuredDeploymentId) {
        Seed seed = resolveSeed(configuredDeploymentId);
        InstanceIdentity row = repository.findById(InstanceIdentity.SINGLETON_ID).orElse(null);
        boolean created = false;
        if (row != null) {
            requireEnvMatches(configuredDeploymentId, row.getInstanceId());
        } else {
            int inserted = repository.insertIfAbsent(seed.instanceId().toString());
            row = repository.findById(InstanceIdentity.SINGLETON_ID)
                    .orElseThrow(() -> new IllegalStateException(
                            "instance_identity row is missing after the seeding insert"));
            created = inserted == 1;
            requireEnvMatches(configuredDeploymentId, row.getInstanceId());
        }

        int backfilled = repository.backfillInstanceConnectionOwner(row.getInstanceId().toString());
        long residual = repository.countSentinelInstanceConnections();
        if (residual != 0) {
            throw new IllegalStateException(
                    "instance identity backfill left " + residual + " sentinel provider connections");
        }
        if (created) {
            audit.recordDurableChange(null, null, "instance_identity_init", RESOURCE_TYPE,
                    row.getInstanceId().toString(),
                    "source=" + seed.source() + " backfilled=" + backfilled);
            logger.info("[IDENTITY] event=instance_identity_init source={} backfilled={}",
                    seed.source(), backfilled);
        } else if (backfilled > 0) {
            audit.recordDurableChange(null, null, "instance_identity_backfill", RESOURCE_TYPE,
                    row.getInstanceId().toString(), "backfilled=" + backfilled);
            logger.info("[IDENTITY] event=instance_identity_backfill backfilled={}", backfilled);
        }
        cachedInstanceId = row.getInstanceId();
        cachedCreatedAt = row.getCreatedAt();
    }

    private Seed resolveSeed(String configuredDeploymentId) {
        if (configuredDeploymentId != null && !configuredDeploymentId.isBlank()) {
            UUID parsed = InstanceIdentityFormat.parse(configuredDeploymentId);
            if (parsed == null) {
                logger.error("[IDENTITY] event=instance_identity_mismatch result=fail-fast");
                throw new IllegalStateException(
                        "XIHE_DEPLOYMENT_ID is not a valid UUID or 32-hex deployment id");
            }
            return new Seed(parsed, "env");
        }
        UUID fromFile = InstanceIdentityFormat.parse(deploymentIdProvider.get());
        if (fromFile != null) {
            return new Seed(fromFile, "deployment-file");
        }
        return new Seed(UUID.randomUUID(), "generated");
    }

    private void requireEnvMatches(String configuredDeploymentId, UUID stored) {
        if (configuredDeploymentId == null || configuredDeploymentId.isBlank()) {
            return;
        }
        UUID configured = InstanceIdentityFormat.parse(configuredDeploymentId);
        if (configured == null || !configured.equals(stored)) {
            logger.error("[IDENTITY] event=instance_identity_mismatch result=fail-fast");
            throw new IllegalStateException(
                    "XIHE_DEPLOYMENT_ID does not match the stored instance identity");
        }
    }

    private record Seed(UUID instanceId, String source) {}
}
