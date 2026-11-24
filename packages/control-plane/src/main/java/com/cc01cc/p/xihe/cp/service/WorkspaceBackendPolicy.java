package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import jakarta.annotation.PostConstruct;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

/**
 * PLAN-0612 M4: static switch for the (frozen) workspace docker execution backend.
 *
 * <p>2026-10-31 用户裁定：工作区 Docker 执行后端**按冻结/不可用对待**；产品面必须在动作前
 * 显式提示不可用，不得让用户走到容器创建才收到原始错误。实现是一个**静态 env 开关**
 * （不做能力探测——探测会让行为随机器漂移，见 PLAN-0612 design 决策 #4）：
 * <ul>
 *   <li>{@code XIHE_WORKSPACE_DOCKER_BACKEND=enabled|disabled}，**默认 disabled**；</li>
 *   <li>创建 {@code managed_import}（docker）工作区 → 409 {@code BACKEND_DISABLED}；</li>
 *   <li>已存在的 docker 工作区的执行/文件/环境操作 → 503 {@code BACKEND_DISABLED}（fail-closed，
 *       不静默回退宿主）；</li>
 *   <li>{@code test:e2e:host} 显式注入 enabled（唯一豁免，DEV-020）。</li>
 * </ul>
 *
 * <p>非法值在启动时 fail-fast（先例：{@code RegistrationPolicy}）。
 */
@Service
public class WorkspaceBackendPolicy {

    private static final Logger logger = LoggerFactory.getLogger(WorkspaceBackendPolicy.class);

    public static final String KEY = "XIHE_WORKSPACE_DOCKER_BACKEND";

    /** 冻结说明与替代路径（wire detail 固定，便于 CLI/UI 与测试断言）。 */
    public static final String CREATION_DETAIL =
            "The docker workspace backend is disabled (frozen) on this instance. "
                    + "Create a direct_attach workspace (hostPath + windows-host/windows-mxc) instead; "
                    + "see docs/i18n/zh-Hans/DEV-031-sandbox-backend-contract.md";

    public static final String OPERATION_DETAIL =
            "This workspace runs on the docker execution backend, which is disabled (frozen) on this instance. "
                    + "File/execution/environment operations are refused; migrate to a direct_attach workspace "
                    + "(docs/i18n/zh-Hans/DEV-031-sandbox-backend-contract.md)";

    /**
     * task-958 (R50/R54/R55): the only execution mode whose Runtime file layer addresses
     * every declared root (each root resolves against its own host path). CP must refuse to
     * declare a second root on any other mode — "can be selected" implies "can be managed".
     */
    public static final String MULTI_ROOT_EXECUTION_MODE = "windows-host";

    /** task-958 (R55): managed MXC install switch; MVP ships the policy + switch, not the download. */
    public static final String MXC_MANAGED_INSTALL_KEY = "XIHE_WORKSPACE_MXC_MANAGED_INSTALL";

    /** Product-owned install directory. Never a system-wide location (that needs user approval). */
    public static final String MXC_INSTALL_DIR_KEY = "XIHE_WORKSPACE_MXC_INSTALL_DIR";

    public static final String MXC_INSTALL_MANAGED = "managed";
    public static final String MXC_INSTALL_SYSTEM = "system";
    public static final String MXC_INSTALL_MISSING = "missing";

    public static final String MXC_NOT_INSTALLED = "MXC_NOT_INSTALLED";
    public static final String MXC_HOST_RESOURCE_EXHAUSTED = "MXC_HOST_RESOURCE_EXHAUSTED";
    public static final String MXC_HOST_RESOURCE_DETAIL =
            "Host resources are insufficient for MXC (Windows error 0x800700E8). "
                    + "Free memory/disk or close background workloads, then retry; "
                    + "the selector shows this before any execution, not as a raw runtime error.";

    private final String rawValue;

    public WorkspaceBackendPolicy(@Value("${" + KEY + ":}") String rawValue) {
        this.rawValue = rawValue;
    }

    @PostConstruct
    public void validate() {
        String normalized = normalize(rawValue);
        if (normalized == null) {
            logger.error("Refusing to start: {}='{}' is not one of enabled|disabled. "
                    + "Unset it for the default (disabled) or set it to enabled.", KEY, rawValue);
            throw new IllegalStateException(KEY + " must be 'enabled' or 'disabled' (got: " + rawValue + ")");
        }
        logger.info("Workspace docker backend: {}{}",
                normalized, "disabled".equals(normalized) ? " (frozen)" : "");
        String mxcInstallSwitch = normalizeSwitch(System.getenv(MXC_MANAGED_INSTALL_KEY));
        if (mxcInstallSwitch == null) {
            throw new IllegalStateException(
                    MXC_MANAGED_INSTALL_KEY + " must be 'enabled' or 'disabled'");
        }
        logger.info("MXC managed install: {}", mxcInstallSwitch);
    }

    /** Default disabled: an absent value must behave like {@code XIHE_WORKSPACE_DOCKER_BACKEND=disabled}. */
    public boolean dockerEnabled() {
        return "enabled".equals(normalize(rawValue));
    }

    /** task-958: a mode can serve every declared root only when its file layer maps each root. */
    public static boolean supportsMultipleRoots(String executionMode) {
        return executionMode != null
                && MULTI_ROOT_EXECUTION_MODE.equalsIgnoreCase(executionMode.trim());
    }

    /**
     * task-958 (R50/R54/R55): declaration-time gate. Extra roots on a mode that cannot
     * address them would produce "can select but cannot use", so they are refused here.
     */
    public static void requireRootCountSupported(String executionMode, int rootCount) {
        if (rootCount <= 1 || supportsMultipleRoots(executionMode)) {
            return;
        }
        String mode = executionMode == null || executionMode.isBlank() ? "docker (default)" : executionMode;
        throw new CpApiException(
                HttpStatus.BAD_REQUEST,
                "INVALID_REQUEST",
                "executionMode " + mode + " supports only the primary root; declaring multiple roots "
                        + "requires " + MULTI_ROOT_EXECUTION_MODE);
    }

    /**
     * task-958 (R51/R52) MVP: MXC install state as seen by the execution-mode selector.
     *
     * <ul>
     *   <li>{@code managed} — a wxc-exec exists under the Xihe-owned install dir;</li>
     *   <li>{@code system} — only a system/PATH installation is visible (version not ours);</li>
     *   <li>{@code missing} — nothing found; {@code reason=MXC_NOT_INSTALLED} plus
     *       {@code installSupported} tells the UI whether the managed installer is enabled.</li>
     * </ul>
     *
     * <p>The MVP deliberately performs no download: the switch gates a future one-click
     * installer, and installing outside the product directory stays a user-approved action.
     */
    public Map<String, Object> mxcInstallSnapshot() {
        return mxcInstallSnapshot(System.getenv());
    }

    static Map<String, Object> mxcInstallSnapshot(Map<String, String> env) {
        String installDir = mxcInstallDir(env);
        boolean managedEnabled = managedInstallEnabled(env);
        String state = detectMxcInstallState(env, installDir);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("state", state);
        body.put("installDir", installDir);
        body.put("installSupported", managedEnabled);
        body.put("systemInstallIsNotVersionControlled", MXC_INSTALL_SYSTEM.equals(state));
        if (MXC_INSTALL_MISSING.equals(state)) {
            body.put("reason", MXC_NOT_INSTALLED);
            body.put("detail", "MXC is not installed. Install it from the execution-mode selector; "
                    + "the managed installer writes only under the Xihe-owned directory (no manual download).");
        }
        body.put("hostResourceErrorCode", MXC_HOST_RESOURCE_EXHAUSTED);
        body.put("hostResourceDetail", MXC_HOST_RESOURCE_DETAIL);
        return body;
    }

    static boolean managedInstallEnabled(Map<String, String> env) {
        String raw = env == null ? null : env.get(MXC_MANAGED_INSTALL_KEY);
        return "enabled".equals(normalizeSwitch(raw));
    }

    static String mxcInstallDir(Map<String, String> env) {
        String raw = env == null ? null : env.get(MXC_INSTALL_DIR_KEY);
        if (raw != null && !raw.isBlank()) {
            return raw.trim();
        }
        String localAppData = env == null ? null : env.get("LOCALAPPDATA");
        String base = localAppData == null || localAppData.isBlank() ? "." : localAppData;
        return base + java.io.File.separator + "Xihe" + java.io.File.separator + "mxc";
    }

    static String detectMxcInstallState(Map<String, String> env, String installDir) {
        if (hasExecutable(Path.of(installDir))) {
            return MXC_INSTALL_MANAGED;
        }
        String pathValue = env == null ? null : env.get("PATH");
        if (pathValue != null) {
            for (String entry : pathValue.split(java.io.File.pathSeparator)) {
                if (!entry.isBlank() && hasExecutable(Path.of(entry))) {
                    return MXC_INSTALL_SYSTEM;
                }
            }
        }
        return MXC_INSTALL_MISSING;
    }

    private static boolean hasExecutable(Path dir) {
        return Files.isRegularFile(dir.resolve("wxc-exec.exe"))
                || Files.isRegularFile(dir.resolve("wxc-exec"));
    }

    private static String normalizeSwitch(String value) {
        if (value == null || value.isBlank()) {
            return "disabled";
        }
        String trimmed = value.trim().toLowerCase(java.util.Locale.ROOT);
        return switch (trimmed) {
            case "enabled", "disabled" -> trimmed;
            default -> null;
        };
    }

    /** 409 for {@code POST /api/v1/workspaces} when the request would create a docker workspace. */
    public void requireCreationAllowed() {
        if (!dockerEnabled()) {
            throw new CpApiException(HttpStatus.CONFLICT, "BACKEND_DISABLED", CREATION_DETAIL);
        }
    }

    /**
     * 503 for execution/file/environment operations on an **existing** docker workspace.
     * {@code null} executionMode means the historical default ({@code docker}).
     */
    public void requireOperationAllowed(Workspace workspace) {
        if (workspace == null || dockerEnabled()) {
            return;
        }
        String executionMode = workspace.getExecutionMode();
        boolean docker = executionMode == null || executionMode.isBlank()
                || "docker".equalsIgnoreCase(executionMode);
        if (docker) {
            throw new CpApiException(HttpStatus.SERVICE_UNAVAILABLE, "BACKEND_DISABLED", OPERATION_DETAIL);
        }
    }

    private static String normalize(String value) {
        if (value == null || value.isBlank()) {
            return "disabled";
        }
        String trimmed = value.trim().toLowerCase(java.util.Locale.ROOT);
        return switch (trimmed) {
            case "enabled", "disabled" -> trimmed;
            default -> null;
        };
    }
}
