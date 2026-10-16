package com.cc01cc.p.xihe.cp.telemetry;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;

/**
 * Resolves the stable, per-deployment identifier used as the {@code deploymentId}
 * telemetry dimension (PLAN-0527). Resolution order: the {@code XIHE_DEPLOYMENT_ID}
 * environment/property override, else a random id persisted under the instance log
 * directory ({@code {XIHE_LOG_DIR}/deployment-id}) so it survives restarts and can be
 * reset by an administrator. It is never derived from hardware or user identity, and
 * is distinct from the boot-scoped {@code ChatController.INSTANCE_ID} lease marker.
 */
@Component
public class DeploymentIdProvider {

    private static final Logger log = LoggerFactory.getLogger(DeploymentIdProvider.class);
    private static final String FILE_NAME = "deployment-id";

    private final String deploymentId;

    public DeploymentIdProvider(@Value("${XIHE_DEPLOYMENT_ID:}") String configured,
                                @Value("${XIHE_LOG_DIR:logs}") String logDir) {
        this.deploymentId = resolve(configured, logDir);
    }

    public String get() {
        return deploymentId;
    }

    static String resolve(String configured, String logDir) {
        if (configured != null && !configured.isBlank()) {
            return configured.trim();
        }
        Path file = Path.of(logDir, FILE_NAME);
        try {
            if (Files.exists(file)) {
                String existing = Files.readString(file).trim();
                if (!existing.isBlank()) {
                    return existing;
                }
            }
            String created = UUID.randomUUID().toString().replace("-", "");
            if (file.getParent() != null) {
                Files.createDirectories(file.getParent());
            }
            Files.writeString(file, created);
            return created;
        } catch (IOException e) {
            log.warn("deployment id unavailable; central relay will omit deploymentId ({}): {}",
                    e.getClass().getSimpleName(), e.getMessage());
            return null;
        }
    }
}
