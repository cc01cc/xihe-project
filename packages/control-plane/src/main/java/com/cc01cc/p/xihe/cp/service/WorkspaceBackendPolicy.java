package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import jakarta.annotation.PostConstruct;
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
    }

    /** Default disabled: an absent value must behave like {@code XIHE_WORKSPACE_DOCKER_BACKEND=disabled}. */
    public boolean dockerEnabled() {
        return "enabled".equals(normalize(rawValue));
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
