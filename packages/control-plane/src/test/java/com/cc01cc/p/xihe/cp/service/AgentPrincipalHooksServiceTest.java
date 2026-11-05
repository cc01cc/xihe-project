package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
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
}
