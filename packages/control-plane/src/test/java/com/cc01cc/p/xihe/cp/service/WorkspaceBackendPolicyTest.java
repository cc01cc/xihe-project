package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0612 M4: the workspace docker backend switch is static (env), default disabled.
 *
 * <p>Creation is refused with 409; operations on an existing docker workspace are refused
 * with 503 (fail-closed, never a host fallback). {@code enabled} is reserved for the host
 * E2E lane (DEV-020).
 */
class WorkspaceBackendPolicyTest {

    private static WorkspaceBackendPolicy policy(String raw) {
        WorkspaceBackendPolicy policy = new WorkspaceBackendPolicy(raw);
        policy.validate();
        return policy;
    }

    private static Workspace workspace(String executionMode) {
        Workspace workspace = new Workspace("ws");
        workspace.setExecutionMode(executionMode);
        return workspace;
    }

    @Test
    void absentValueIsDisabledAndStillStartsWithAnInformativeLog() {
        WorkspaceBackendPolicy disabled = policy(null);
        assertFalse(disabled.dockerEnabled());
        assertFalse(policy("").dockerEnabled());
        assertFalse(policy("disabled").dockerEnabled());
        assertFalse(policy("DISABLED ").dockerEnabled());
    }

    @Test
    void enabledIsTheOnlyValueThatOpensTheBackend() {
        assertTrue(policy("enabled").dockerEnabled());
        assertTrue(policy("ENABLED").dockerEnabled());
    }

    @Test
    void invalidValueFailsFastAtStartup() {
        IllegalStateException error = assertThrows(IllegalStateException.class, () -> policy("frozen"));
        assertTrue(error.getMessage().contains(WorkspaceBackendPolicy.KEY));
    }

    @Test
    void creationIs409WhileDisabled() {
        CpApiException error = assertThrows(CpApiException.class, () -> policy(null).requireCreationAllowed());
        assertEquals(HttpStatus.CONFLICT, error.getStatus());
        assertEquals("BACKEND_DISABLED", error.getCode());
        assertTrue(error.getMessage().contains("direct_attach"));
    }

    @Test
    void creationPassesWhenEnabled() {
        policy("enabled").requireCreationAllowed();
    }

    @Test
    void operationsOnDockerWorkspacesAre503WhileDisabled() {
        CpApiException error = assertThrows(CpApiException.class,
                () -> policy(null).requireOperationAllowed(workspace("docker")));
        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, error.getStatus());
        assertEquals("BACKEND_DISABLED", error.getCode());
    }

    @Test
    void aNullExecutionModeKeepsTheHistoricalDockerDefault() {
        // Workspace rows created before executionMode existed have no value; CP treats them
        // as docker (see WorkspaceEnvironmentController's "docker" default), so they fail closed too.
        CpApiException error = assertThrows(CpApiException.class,
                () -> policy(null).requireOperationAllowed(workspace(null)));
        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, error.getStatus());
    }

    @Test
    void directAttachWorkspacesAreNeverGated() {
        policy(null).requireOperationAllowed(workspace("windows-host"));
        policy(null).requireOperationAllowed(workspace("windows-mxc"));
    }

    @Test
    void enabledAllowsDockerOperations() {
        policy("enabled").requireOperationAllowed(workspace("docker"));
    }

    @Test
    void nullWorkspaceIsIgnored() {
        policy(null).requireOperationAllowed(null);
    }
}
