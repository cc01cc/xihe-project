package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.EmbeddingProfileService;
import com.cc01cc.p.xihe.cp.provider.ApiInputTypeService;
import com.cc01cc.p.xihe.cp.provider.ApiRequestValidator;
import com.cc01cc.p.xihe.cp.provider.ProviderCredentialLeaseService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class ChatRunRagCredentialsTest {
    private final ObjectMapper json = new ObjectMapper();
    private final EmbeddingProfileService profiles = mock(EmbeddingProfileService.class);
    private final ChatController controller = mock(ChatController.class, org.mockito.Mockito.CALLS_REAL_METHODS);
    private final String user = UUID.randomUUID().toString();
    private final String workspace = UUID.randomUUID().toString();

    @BeforeEach
    void setUp() {
        ReflectionTestUtils.setField(controller, "embeddingProfiles", profiles);
        ReflectionTestUtils.setField(controller, "requestValidator",
                new ApiRequestValidator(new ApiInputTypeService(json)));
    }

    @Test
    void unusedAndEscapedSlotsDoNotResolveOrLease() {
        for (String body : new String[]{"{}", "{\"data\":\"$${xh.rag_context}\"}"}) {
            Map<String, Object> request = new LinkedHashMap<>();
            controller.addRagCredentials(request, snapshot(body), user, workspace, "session", "run");
            assertEquals(Map.of(), request);
        }
        verifyNoInteractions(profiles);
    }

    @Test
    void authenticatedScopeIssuesIndependentRunBoundLease() {
        var profile = mock(EmbeddingProfileService.ResolvedProfile.class);
        when(profiles.resolve(UUID.fromString(user), UUID.fromString(workspace))).thenReturn(profile);
        when(profiles.issueLease(profile, user, workspace, "session", "run"))
                .thenReturn(new ProviderCredentialLeaseService.IssuedLease("embedding-lease", Instant.EPOCH));
        when(profiles.describe(profile)).thenReturn(Map.of("dimension", 768, "workspaceId", workspace));
        Map<String, Object> request = new LinkedHashMap<>(Map.of("credentialLease", "chat-lease"));
        controller.addRagCredentials(request, snapshot("{\"data\":\"${xh.rag_context}\"}"),
                user, workspace, "session", "run");
        assertEquals("chat-lease", request.get("credentialLease"));
        assertEquals("embedding-lease", request.get("embeddingCredentialLease"));
        assertEquals(Map.of("dimension", 768, "workspaceId", workspace), request.get("embeddingProfile"));
        verify(profiles).issueLease(profile, user, workspace, "session", "run");
    }

    @Test
    void missingProfileStopsPayloadAssemblyWithStableCode() {
        when(profiles.resolve(UUID.fromString(user), UUID.fromString(workspace)))
                .thenThrow(new IllegalArgumentException("missing"));
        Map<String, Object> request = new LinkedHashMap<>();
        var error = assertThrows(CpApiException.class, () -> controller.addRagCredentials(request,
                snapshot("{\"data\":\"${xh.rag_context}\"}"), user, workspace, "session", "run"));
        assertEquals("RAG_PROFILE_UNAVAILABLE", error.getCode());
        assertEquals(Map.of(), request);
    }

    @Test
    void leaseFailureStopsPayloadAssemblyWithStableCode() {
        var profile = mock(EmbeddingProfileService.ResolvedProfile.class);
        when(profiles.resolve(UUID.fromString(user), UUID.fromString(workspace))).thenReturn(profile);
        when(profiles.issueLease(profile, user, workspace, "session", "run"))
                .thenThrow(new IllegalArgumentException("revoked"));
        Map<String, Object> request = new LinkedHashMap<>();
        var error = assertThrows(CpApiException.class, () -> controller.addRagCredentials(request,
                snapshot("{\"data\":\"${xh.rag_context}\"}"), user, workspace, "session", "run"));
        assertEquals("RAG_LEASE_UNAVAILABLE", error.getCode());
        assertEquals(Map.of(), request);
    }

    private com.fasterxml.jackson.databind.JsonNode snapshot(String body) {
        return json.createObjectNode().set("template", json.createObjectNode().put("bodySource", body));
    }
}
