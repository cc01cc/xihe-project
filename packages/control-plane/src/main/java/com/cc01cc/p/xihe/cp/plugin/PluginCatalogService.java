package com.cc01cc.p.xihe.cp.plugin;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import jakarta.persistence.EntityManager;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * PLAN-0691 T1.1 (D-65 / LC-1): the plugin catalog lifecycle.
 *
 * <p>Install reads the manifest <b>server-side</b> from the caller-provided {@code packagePath}
 * under the configured package root — the wire carries no url/digest/signature. The directory
 * decides the source ({@code plugins/official/} ⇒ builtin, {@code plugins/local/} ⇒ third-party)
 * and the validator rechecks the declared {@code source} and the {@code official.} prefix.</p>
 *
 * <p>Every state transition of one plugin id runs under a per-id transaction advisory lock
 * ({@code pg_advisory_xact_lock(hashtextextended('plugin:' || id, 0))}); the partial unique index
 * that backstops {@code is_current} is never relied on as the only guard. H2 has no advisory-lock
 * function, so the lock step is property-gated for the H2 L0 slice
 * ({@code cp.plugin.advisory-lock=false}) — the PG integration wave keeps it on.</p>
 *
 * <p>T1.1 freeze (review round-2 §45): install only registers a version row; it does not grant
 * atoms, does not create bindings, and does not auto-enable. The row starts {@code disabled}.</p>
 */
@Service
public class PluginCatalogService {

    private static final Logger log = LoggerFactory.getLogger(PluginCatalogService.class);

    private static final String ACTION_INSTALL = "plugin.install";
    private static final String ACTION_UPGRADE = "plugin.upgrade";
    private static final String ACTION_ENABLE = "plugin.enable";
    private static final String ACTION_DISABLE = "plugin.disable";
    private static final String ACTION_UNINSTALL = "plugin.uninstall";

    private final PluginRepository repository;
    private final AuditLogger auditLogger;
    private final EntityManager entityManager;
    private final String packageRoot;
    private final boolean advisoryLockEnabled;

    public PluginCatalogService(PluginRepository repository, AuditLogger auditLogger,
            EntityManager entityManager,
            @Value("${cp.plugin.package-root:plugins}") String packageRoot,
            @Value("${cp.plugin.advisory-lock:true}") boolean advisoryLockEnabled) {
        this.repository = repository;
        this.auditLogger = auditLogger;
        this.entityManager = entityManager;
        this.packageRoot = packageRoot;
        this.advisoryLockEnabled = advisoryLockEnabled;
    }

    @Transactional(readOnly = true)
    public List<Plugin> list(String source, String state) {
        List<Plugin> current = repository.findCurrent();
        return current.stream()
                .filter(plugin -> source == null || source.isBlank()
                        || source.equals(plugin.getSource()))
                .filter(plugin -> state == null || state.isBlank()
                        || state.equals(plugin.getState()))
                .toList();
    }

    @Transactional(readOnly = true)
    public Plugin getCurrent(String pluginId) {
        return repository.findCurrentById(pluginId).orElseThrow(() -> notFound(pluginId));
    }

    @Transactional
    public Plugin install(String packagePath, String actorUserId, String workspaceId) {
        Package pkg = resolvePackage(packagePath);
        PluginManifest manifest = PluginManifestValidator.validate(pkg.bytes(), pkg.source());
        lock(manifest.id());
        if (repository.findVersion(manifest.id(), manifest.digest()).isPresent()) {
            throw new CpApiException(HttpStatus.CONFLICT, "PLUGIN_DIGEST_EXISTS",
                    "plugin " + manifest.id() + " is already installed with digest "
                            + manifest.digest());
        }
        if (repository.countVersions(manifest.id()) > 0) {
            throw new CpApiException(HttpStatus.CONFLICT, "PLUGIN_CONFLICT",
                    "plugin " + manifest.id()
                            + " is installed with another version; install must not replace it");
        }
        Plugin plugin = new Plugin(manifest.id(), manifest.digest(), manifest.version(),
                manifest.source(), manifest.raw());
        // D-65: a freshly installed version is the current one (state stays disabled — T1.1 does
        // not auto-enable); without the flag the row would be invisible to every catalog finder.
        plugin.setCurrent(true);
        repository.save(plugin);
        audit(ACTION_INSTALL, actorUserId, workspaceId, manifest.id(),
                "version=" + manifest.version() + " digest=" + manifest.digest());
        log.info("plugin installed id={} version={} source={}", manifest.id(), manifest.version(),
                manifest.source());
        return plugin;
    }

    @Transactional
    public Plugin upgrade(String pluginId, String packagePath, String actorUserId,
            String workspaceId) {
        Package pkg = resolvePackage(packagePath);
        PluginManifest manifest = PluginManifestValidator.validate(pkg.bytes(), pkg.source());
        if (!pluginId.equals(manifest.id())) {
            throw invalid("packagePath contains plugin " + manifest.id()
                    + " but the route names " + pluginId);
        }
        lock(pluginId);
        Plugin current = repository.findCurrentForUpdate(pluginId)
                .orElseThrow(() -> notFound(pluginId));
        if (!current.getSource().equals(manifest.source())) {
            throw invalid("upgrade must keep the installed source " + current.getSource());
        }
        if (!PluginManifestValidator.isNewerVersion(manifest.version(), current.getVersion())) {
            throw invalid("upgrade version " + manifest.version()
                    + " must be greater than current " + current.getVersion());
        }
        if (repository.findVersion(pluginId, manifest.digest()).isPresent()) {
            throw new CpApiException(HttpStatus.CONFLICT, "PLUGIN_DIGEST_EXISTS",
                    "plugin " + pluginId + " already has digest " + manifest.digest());
        }
        String previousVersion = current.getVersion();
        current.setCurrent(false);
        repository.saveAndFlush(current);
        Plugin next = new Plugin(manifest.id(), manifest.digest(), manifest.version(),
                manifest.source(), manifest.raw());
        next.setState(current.getState());
        next.setCurrent(true);
        repository.save(next);
        audit(ACTION_UPGRADE, actorUserId, workspaceId, pluginId,
                "from=" + previousVersion + " to=" + manifest.version());
        log.info("plugin upgraded id={} from={} to={}", pluginId, previousVersion,
                manifest.version());
        return next;
    }

    @Transactional
    public Plugin setEnabled(String pluginId, boolean enabled, String actorUserId,
            String workspaceId) {
        lock(pluginId);
        Plugin current = repository.findCurrentForUpdate(pluginId)
                .orElseThrow(() -> notFound(pluginId));
        String target = enabled ? Plugin.STATE_ENABLED : Plugin.STATE_DISABLED;
        current.setState(target);
        repository.save(current);
        audit(enabled ? ACTION_ENABLE : ACTION_DISABLE, actorUserId, workspaceId, pluginId,
                "state=" + target);
        return current;
    }

    @Transactional
    public void uninstall(String pluginId, String actorUserId, String workspaceId) {
        lock(pluginId);
        if (repository.countVersions(pluginId) == 0) {
            throw notFound(pluginId);
        }
        int removed = repository.deleteAllVersions(pluginId);
        audit(ACTION_UNINSTALL, actorUserId, workspaceId, pluginId, "versions=" + removed);
        log.info("plugin uninstalled id={} versions={}", pluginId, removed);
    }

    private Package resolvePackage(String packagePath) {
        if (packagePath == null || packagePath.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "packagePath is required");
        }
        Path root = Path.of(packageRoot).toAbsolutePath().normalize();
        String raw = packagePath.trim().replace('\\', '/');
        Path relative = Path.of(raw.startsWith("plugins/") ? raw.substring("plugins/".length())
                : raw);
        Path directory = root.resolve(relative).normalize();
        if (!directory.startsWith(root) || directory.equals(root)) {
            throw invalid("packagePath must resolve under the plugin package root");
        }
        if (!Files.isDirectory(directory)) {
            throw invalid("packagePath does not exist: " + packagePath);
        }
        Path manifestFile = directory.resolve("manifest.json");
        if (!Files.isRegularFile(manifestFile)) {
            throw invalid("packagePath has no manifest.json: " + packagePath);
        }
        String source = sourceOf(root.relativize(directory));
        byte[] bytes;
        try {
            bytes = Files.readAllBytes(manifestFile);
        } catch (IOException e) {
            throw new CpApiException(HttpStatus.UNPROCESSABLE_ENTITY,
                    PluginManifestValidator.ERROR_CODE, "manifest.json is not readable", e);
        }
        return new Package(source, bytes);
    }

    private static String sourceOf(Path relative) {
        Path first = relative.getName(0);
        if ("official".equals(first.toString())) {
            return Plugin.SOURCE_BUILTIN;
        }
        if ("local".equals(first.toString())) {
            return Plugin.SOURCE_THIRD_PARTY;
        }
        throw invalid("packagePath must live under plugins/official or plugins/local");
    }

    private void lock(String pluginId) {
        if (!advisoryLockEnabled) {
            return;
        }
        entityManager.createNativeQuery(
                        "select pg_advisory_xact_lock(hashtextextended(:key, 0))")
                .setParameter("key", "plugin:" + pluginId)
                .getResultList();
    }

    private void audit(String action, String actorUserId, String workspaceId, String pluginId,
            String detail) {
        auditLogger.recordDurableChange(actorUserId, workspaceId, action, "plugin", pluginId,
                detail);
    }

    private static CpApiException notFound(String pluginId) {
        return new CpApiException(HttpStatus.NOT_FOUND, "PLUGIN_NOT_FOUND",
                "plugin " + pluginId + " is not installed");
    }

    private static CpApiException invalid(String detail) {
        return new CpApiException(HttpStatus.UNPROCESSABLE_ENTITY,
                PluginManifestValidator.ERROR_CODE, detail);
    }

    private record Package(String source, byte[] bytes) {}
}
