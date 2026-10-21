package com.cc01cc.p.xihe.cp.status;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.env.Environment;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.lang.management.ManagementFactory;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * PLAN-0534: deployment identity surface.
 *
 * <p>This is the only module surface allowed to read {@code XIHE_STACK_ID}
 * (PLAN-0533 invariant I6). It reports identity, not health: an unreachable
 * Agent or Runtime yields {@code 200} with that module's version as
 * {@code null}. {@code modules.ui} is intentionally absent.
 */
@RestController
public class VersionController {

    private static final Set<String> RELEASE_CHANNELS = Set.of("stable", "beta", "dev");
    private static final Pattern COMMIT = Pattern.compile("^[0-9a-fA-F]{7,40}$");
    private static final String DEFAULT_STACK_ID = "stack-1";

    private final BuildVersion buildVersion;
    private final HealthMonitor healthMonitor;
    private final Environment environment;
    private final String startedAt;

    @Autowired
    public VersionController(
            BuildVersion buildVersion,
            HealthMonitor healthMonitor,
            Environment environment) {
        this.buildVersion = buildVersion;
        this.healthMonitor = healthMonitor;
        this.environment = environment;
        this.startedAt = Instant.ofEpochMilli(
            ManagementFactory.getRuntimeMXBean().getStartTime()).toString();
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/api/v1/version")
    public Map<String, Object> getVersion() {
        String cpCommit = commit();
        HealthMonitor.ServiceHealth agent = healthMonitor.getAgentHealth();
        HealthMonitor.ServiceHealth runtime = healthMonitor.getRuntimeHealth();

        Map<String, Object> modules = new LinkedHashMap<>();
        modules.put("cp", module(buildVersion.version(), cpCommit));
        modules.put("agent", agentModule(agent));
        modules.put("runtime", module(runtime.version(), runtime.commit()));

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("stackId", stackId());
        result.put("releaseChannel", releaseChannel());
        result.put("startedAt", startedAt);
        result.put("commit", cpCommit);
        result.put("modules", modules);
        return result;
    }

    private Map<String, Object> module(String version, String commit) {
        Map<String, Object> module = new LinkedHashMap<>();
        module.put("version", version);
        module.put("commit", commit);
        return module;
    }

    private Map<String, Object> agentModule(HealthMonitor.ServiceHealth agent) {
        Map<String, Object> module = module(agent.version(), agent.commit());
        module.put("framework", agent.framework());
        return module;
    }

    private String stackId() {
        String raw = environment.getProperty("XIHE_STACK_ID");
        if (raw == null || raw.isBlank()) {
            return DEFAULT_STACK_ID;
        }
        return raw.trim();
    }

    private String releaseChannel() {
        String raw = environment.getProperty("XIHE_RELEASE_CHANNEL");
        if (raw == null) {
            return "dev";
        }
        String normalized = raw.trim().toLowerCase(Locale.ROOT);
        return RELEASE_CHANNELS.contains(normalized) ? normalized : "dev";
    }

    private String commit() {
        String raw = environment.getProperty("XIHE_BUILD_COMMIT");
        if (raw == null) {
            return null;
        }
        String normalized = raw.trim();
        return COMMIT.matcher(normalized).matches() ? normalized : null;
    }
}
