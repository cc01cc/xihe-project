package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.when;

/**
 * PLAN-0625 F (D25-02/D25-08): a preset guard's cap is fixed at the input side — the WRITE
 * side refuses. resolveCapFor stays the single entry, untouched (no parse-side special case).
 *
 * <p>Dependency graphs come from {@link AgentPrincipalTestSupport} (task-86) — the four-layer
 * mock stack this test originally hand-built one gate at a time now lives in one place.</p>
 */
class AgentPrincipalPresetGuardTest {

    @Test
    void presetGuardCapCannotBeRewrittenThroughABinding() {
        AgentPrincipalTestSupport.Env env = AgentPrincipalTestSupport.workspaceManager();
        AgentPrincipal guard = AgentPrincipalTestSupport.presetGuard();
        when(env.principals().findById(guard.getId())).thenReturn(java.util.Optional.of(guard));

        CpApiException refused = assertThrows(CpApiException.class, () -> env.service().setWorkspaceCap(
                UUID.randomUUID().toString(), UUID.randomUUID(), guard.getId(),
                new com.fasterxml.jackson.databind.ObjectMapper().createArrayNode()));
        assertEquals("GUARD_CAP_IMMUTABLE", refused.getCode());
        assertEquals(HttpStatus.FORBIDDEN, refused.getStatus(),
                "the refusal is a write-side gate, not a parse-side special case");
    }

    @Test
    void userPrincipalCapStaysWritable() {
        AgentPrincipalTestSupport.Env env = AgentPrincipalTestSupport.workspaceManager();
        AgentPrincipal userPrincipal = AgentPrincipalTestSupport.activeUserPrincipal();
        when(env.principals().findById(userPrincipal.getId()))
                .thenReturn(java.util.Optional.of(userPrincipal));

        // The guard check must not fire for user principals; the path proceeds past requireMutableCap
        // and fails later on binding validation — proving the refusal is preset-only.
        RuntimeException laterFailure = assertThrows(RuntimeException.class, () -> env.service()
                .setWorkspaceCap(UUID.randomUUID().toString(), UUID.randomUUID(),
                        userPrincipal.getId(),
                        new com.fasterxml.jackson.databind.ObjectMapper().createArrayNode()));
        if (laterFailure instanceof CpApiException api) {
            org.junit.jupiter.api.Assertions.assertNotEquals("GUARD_CAP_IMMUTABLE", api.getCode(),
                    "user principals never see the preset gate");
        }
    }
}
