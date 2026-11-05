package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.http.HttpStatus;

import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0625 M2 (D25-14): hooks ride the principal create/update surface — validated in the one
 * write-side gate, mutable for ordinary principals, refused for preset guards with their own code.
 *
 * <p><b>Scope, stated because the old name overclaimed it</b> ("Wire" while every call went straight
 * to {@code env.service()}): this class pins the <i>service</i> contract — validation order, the
 * persistence call, and that refusals never write. It proves nothing about the route, the response
 * document or the list projection; those live at the HTTP boundary in
 * {@link AgentPrincipalHooksHttpTest} (real Spring context, {@code restTemplate}, JSON body + DB
 * assertions), which is where the walkthrough's Gaps I/J/K are pinned.</p>
 */
class AgentPrincipalHooksServiceTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final UUID ACTOR = UUID.randomUUID();

    @AfterEach
    void clearTenantContext() {
        TenantContext.clear();
    }

    /**
     * D-196 / BL-336: the workspace-context gate is <b>scope-aware</b>. Only a workspace-scoped row
     * (D-174: no owning user) needs an explicit context; a personal row must stay writable without one.
     */
    private static AgentPrincipal workspaceScopedPrincipal() {
        AgentPrincipal principal = new AgentPrincipal();
        principal.setId(UUID.randomUUID());
        principal.setOwnerUserId(null);
        principal.setOrigin(AgentPrincipal.ORIGIN_USER);
        return principal;
    }

    private static void legalWorkspaceContext() {
        TenantContext.setWorkspaceId(UUID.randomUUID().toString());
    }

    private static JsonNode hooksJson(String json) throws Exception {
        return MAPPER.readTree(json);
    }

    private static AgentPrincipal personalPrincipal(UUID ownerId) {
        AgentPrincipal principal = new AgentPrincipal();
        principal.setId(UUID.randomUUID());
        principal.setOwnerUserId(ownerId);
        principal.setOrigin(AgentPrincipal.ORIGIN_USER);
        return principal;
    }

    @Test
    void ownerResubscribesPersonalPrincipalHooks() throws Exception {
        // Deliberately NO TenantContext: a personal (instance-scope) principal must stay writable
        // without a workspace context — D22's unconditional gate made this unreachable (BL-336).
        AgentPrincipalTestSupport.Env env = AgentPrincipalTestSupport.workspaceManager();
        AgentPrincipal principal = personalPrincipal(ACTOR);
        when(env.principals().findById(principal.getId())).thenReturn(Optional.of(principal));

        env.service().updatePrincipalHooks(ACTOR.toString(), principal.getId(),
                hooksJson("{\"advisors\":[{\"kind\":\"guard\",\"on\":[\"approval.ask\"]}]}"));

        ArgumentCaptor<AgentPrincipal> saved = ArgumentCaptor.forClass(AgentPrincipal.class);
        verify(env.principals()).saveAndFlush(saved.capture());
        assertEquals("guard", saved.getValue().getHooks().path("advisors").get(0).path("kind").asText());
    }

    @Test
    void clearingHooksStoresNull() throws Exception {
        // Same as above: no context, personal row (clearing is a subject-level edit, not a
        // workspace operation).
        AgentPrincipalTestSupport.Env env = AgentPrincipalTestSupport.workspaceManager();
        AgentPrincipal principal = personalPrincipal(ACTOR);
        principal.setHooks(hooksJson("{\"advisors\":[{\"kind\":\"guard\",\"on\":[\"approval.ask\"]}]}"));
        when(env.principals().findById(principal.getId())).thenReturn(Optional.of(principal));

        env.service().updatePrincipalHooks(ACTOR.toString(), principal.getId(), null);

        ArgumentCaptor<AgentPrincipal> saved = ArgumentCaptor.forClass(AgentPrincipal.class);
        verify(env.principals()).saveAndFlush(saved.capture());
        assertNull(saved.getValue().getHooks());
    }

    @Test
    void strangerCannotResubscribeAnotherOwnersPersonalPrincipal() throws Exception {
        // D-196: a legal context is supplied so the 403 below is the *authority* refusal, not an
        // early 409 — the assertion is about who may write, and must not be satisfied by "no context".
        legalWorkspaceContext();
        AgentPrincipalTestSupport.Env env = AgentPrincipalTestSupport.workspaceManager();
        AgentPrincipal principal = personalPrincipal(UUID.randomUUID());
        when(env.principals().findById(principal.getId())).thenReturn(Optional.of(principal));

        CpApiException error = assertThrows(CpApiException.class, () -> env.service()
                .updatePrincipalHooks(ACTOR.toString(), principal.getId(),
                        hooksJson("{\"advisors\":[{\"kind\":\"guard\",\"on\":[\"approval.ask\"]}]}")));
        assertEquals(HttpStatus.FORBIDDEN, error.getStatus());
        verify(env.principals(), never()).saveAndFlush(any());
    }

    @Test
    void presetGuardHooksAreImmutable() throws Exception {
        // D-196: preset guards are instance-level assets, so no context is required — one is supplied
        // anyway to prove the GUARD_HOOKS_IMMUTABLE branch is reached with a legal context in place.
        legalWorkspaceContext();
        AgentPrincipalTestSupport.Env env = AgentPrincipalTestSupport.workspaceManager();
        AgentPrincipal preset = new AgentPrincipal();
        preset.setId(UUID.randomUUID());
        preset.setOrigin(AgentPrincipal.ORIGIN_SYSTEM_PRESET);
        preset.setPresetId("guard-v1");
        when(env.principals().findById(preset.getId())).thenReturn(Optional.of(preset));

        CpApiException error = assertThrows(CpApiException.class, () -> env.service()
                .updatePrincipalHooks(ACTOR.toString(), preset.getId(),
                        hooksJson("{\"advisors\":[{\"kind\":\"guard\",\"on\":[\"approval.ask\"]}]}")));
        assertEquals(HttpStatus.FORBIDDEN, error.getStatus());
        assertEquals("GUARD_HOOKS_IMMUTABLE", error.getCode(),
                "subscription refusals carry their own code, distinct from GUARD_CAP_IMMUTABLE");
        verify(env.principals(), never()).saveAndFlush(any());
    }

    @Test
    void malformedHooksAreRejectedBeforeAnyLookup() {
        // D-196 keeps body validation ahead of the scope-aware context gate: a malformed document is
        // a 400 with or without a context, never a 409 (that would lose "shape before authority").
        legalWorkspaceContext();
        AgentPrincipalTestSupport.Env env = AgentPrincipalTestSupport.workspaceManager();

        CpApiException error = assertThrows(CpApiException.class, () -> env.service()
                .updatePrincipalHooks(ACTOR.toString(), UUID.randomUUID(),
                        MAPPER.createObjectNode().put("advisors", "not-an-array")));
        assertEquals(HttpStatus.BAD_REQUEST, error.getStatus());
        assertEquals("INVALID_REQUEST", error.getCode());
        verify(env.principals(), never()).findById(any());
    }

    @Test
    void createPersistsValidatedHooksOnTheNewPrincipal() throws Exception {
        AgentPrincipalTestSupport.Env env = AgentPrincipalTestSupport.workspaceManager();
        ObjectNode snapshot = MAPPER.createObjectNode();
        snapshot.put("templateId", "tpl-1");
        snapshot.putArray("permissions");
        when(env.principals().saveAndFlush(any())).thenAnswer(invocation -> {
            AgentPrincipal principal = invocation.getArgument(0);
            principal.setId(UUID.randomUUID());
            return principal;
        });

        env.service().createPrincipal(ACTOR.toString(), "hooked", "tpl-1", snapshot,
                null, null, null,
                hooksJson("{\"advisors\":[{\"kind\":\"guard\",\"on\":[\"approval.ask\"]}]}"),
                AgentPrincipal.ORIGIN_USER, null, null);

        ArgumentCaptor<AgentPrincipal> saved = ArgumentCaptor.forClass(AgentPrincipal.class);
        verify(env.principals()).saveAndFlush(saved.capture());
        assertEquals("guard", saved.getValue().getHooks().path("advisors").get(0).path("kind").asText());
    }

    @Test
    void createRejectsInvalidHooksBeforePersisting() {
        AgentPrincipalTestSupport.Env env = AgentPrincipalTestSupport.workspaceManager();
        ObjectNode snapshot = MAPPER.createObjectNode();
        snapshot.put("templateId", "tpl-1");
        snapshot.putArray("permissions");

        assertThrows(CpApiException.class, () -> env.service().createPrincipal(ACTOR.toString(),
                "hooked", "tpl-1", snapshot, null, null, null,
                MAPPER.createObjectNode().put("advisors", "not-an-array"),
                AgentPrincipal.ORIGIN_USER, null, null));
        verify(env.principals(), never()).saveAndFlush(any());
    }

    /**
     * D-196 / BL-336: the 409 is reserved for <b>workspace-scoped</b> rows with no explicit context.
     * Pinning it explicitly means nobody can "helpfully" move the gate behind the authority check again
     * (that would reopen the oracle this whole discussion was about) or in front of it for everyone
     * (that is the regression D22 shipped).
     */
    @Test
    void workspaceScopedPrincipalNeedsAContextBeforeAnyAuthorityCheck() throws Exception {
        AgentPrincipalTestSupport.Env env = AgentPrincipalTestSupport.workspaceManager();
        AgentPrincipal principal = workspaceScopedPrincipal();
        when(env.principals().findById(principal.getId())).thenReturn(Optional.of(principal));

        CpApiException error = assertThrows(CpApiException.class, () -> env.service()
                .updatePrincipalHooks(ACTOR.toString(), principal.getId(),
                        hooksJson("{\"advisors\":[{\"kind\":\"guard\",\"on\":[\"approval.ask\"]}]}")));

        assertEquals(HttpStatus.CONFLICT, error.getStatus(),
                "D-196: a workspace-scoped row without a context is a 409");
        assertEquals("WORKSPACE_CONTEXT_REQUIRED", error.getCode());
        verify(env.principals(), never()).saveAndFlush(any());
    }

    /** With a context the same call reaches the authority gate — the 409 was only about the context. */
    @Test
    void workspaceScopedPrincipalReachesTheAuthorityGateOnceAContextExists() throws Exception {
        legalWorkspaceContext();
        AgentPrincipalTestSupport.Env env = AgentPrincipalTestSupport.workspaceManager();
        AgentPrincipal principal = workspaceScopedPrincipal();
        when(env.principals().findById(principal.getId())).thenReturn(Optional.of(principal));

        CpApiException error = assertThrows(CpApiException.class, () -> env.service()
                .updatePrincipalHooks(ACTOR.toString(), principal.getId(),
                        hooksJson("{\"advisors\":[{\"kind\":\"guard\",\"on\":[\"approval.ask\"]}]}")));

        assertEquals(HttpStatus.FORBIDDEN, error.getStatus(),
                "context present ⇒ no 409; authorisation decides (actor holds neither the owner column "
                        + "nor a workspace binding for this row)");
        assertEquals("AGENT_PRINCIPAL_OWNER_MISMATCH", error.getCode());
        verify(env.principals(), never()).saveAndFlush(any());
    }
}
