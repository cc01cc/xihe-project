package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.policy.RequesterAuthority;
import com.cc01cc.p.xihe.cp.provider.ApiInputTypeService;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.cc01cc.p.xihe.cp.support.TestInstanceIdentity;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowableOfType;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * task-965: the template domain covers every API Type operation, not just {@code chat}.
 *
 * <p>The invariant is deliberately derived from the registry rather than hard-coded to "5 types":
 * adding an API Type (e.g. the next embedding/rerank entry) must fail this test until it gets an
 * built-in seed too. The second half pins the boundary the card cares about: "may exist / may be
 * copied" does <b>not</b> mean "may be used by a Session" — {@code requireChat} still rejects non-chat
 * connections with {@code API_TYPE_OPERATION_MISMATCH}.</p>
 */
class ApiRequestTemplateDomainCoverageTest {

    private final ObjectMapper json = new ObjectMapper();
    private final ApiInputTypeService types = new ApiInputTypeService(json);
    private final ProviderConnectionRepository connections = mock(ProviderConnectionRepository.class);
    @SuppressWarnings("unchecked")
    private final org.springframework.beans.factory.ObjectProvider<ContextTemplateService> contextProvider =
            mock(org.springframework.beans.factory.ObjectProvider.class);
    private final ApiRequestTemplateService service = new ApiRequestTemplateService(null, null, connections,
            null, json, types, null, null, null, contextProvider, mock(RequesterAuthority.class),
            TestInstanceIdentity.mock());

    private static String typeKey(JsonNode node) {
        return node.path("apiTypeId").asText() + "@" + node.path("apiTypeVersion").asInt();
    }

    @Test
    void builtinsCoverEveryApiTypeEntryAndOperation() {
        Set<String> catalog = types.list().stream()
                .map(type -> type.get("apiTypeId") + "@" + type.get("version"))
                .collect(Collectors.toSet());
        Set<String> seeded = service.builtins().stream()
                .map(ApiRequestTemplateDomainCoverageTest::typeKey)
                .collect(Collectors.toSet());
        assertThat(seeded)
                .as("every API Type (chat and non-chat) must ship a built-in template")
                .isEqualTo(catalog);

        Set<String> catalogOperations = new HashSet<>();
        for (String key : catalog) {
            String[] parts = key.split("@");
            catalogOperations.add(types.operation(parts[0], Integer.parseInt(parts[1])));
        }
        Set<String> seededOperations = service.builtins().stream()
                .map(node -> types.operation(node.path("apiTypeId").asText(), node.path("apiTypeVersion").asInt()))
                .collect(Collectors.toSet());
        assertThat(seededOperations).isEqualTo(catalogOperations);
    }

    @Test
    void everyApiTypeShipsExactlyTwoReadableBuiltinRevisions() {
        for (String key : types.list().stream()
                .map(type -> type.get("apiTypeId") + "@" + type.get("version"))
                .collect(Collectors.toSet())) {
            List<JsonNode> revisions = service.builtins().stream()
                    .filter(node -> typeKey(node).equals(key))
                    .toList();
            assertThat(revisions).as("v1 + v2 for " + key).hasSize(2);
            assertThat(revisions.stream().map(node -> node.path("version").asInt()).collect(Collectors.toSet()))
                    .containsExactlyInAnyOrder(1, 2);
            assertThat(revisions).allSatisfy(node -> {
                assertThat(node.path("status").asText()).isEqualTo("published");
                assertThat(node.path("name").asText()).endsWith(" · Built-in");
            });
        }
    }

    @Test
    void embeddingSeedCarriesTheEmbeddingWireShapeAndNotChatMessages() {
        List<JsonNode> embeddingSeeds = service.builtins().stream()
                .filter(node -> node.path("apiTypeId").asText().equals("dashscope-multimodal-embedding"))
                .toList();
        assertThat(embeddingSeeds).as("task-965: the fifth built-in class is the embedding type").hasSize(2);
        assertThat(embeddingSeeds).allSatisfy(node -> {
            String body = node.path("bodySource").asText();
            assertThat(body).contains("\"input\":{\"contents\"", "\"parameters\":{\"dimension\"");
            assertThat(body).as("embedding requests have no chat message array").doesNotContain("\"messages\"");
            assertThat(node.path("name").asText()).startsWith("DashScope Multimodal Embedding");
        });
    }

    @Test
    void embeddingTemplateStillCannotEnterAChatSession() {
        ProviderConnection embedding = new ProviderConnection();
        embedding.setId(UUID.randomUUID());
        embedding.setOwnerType(ProviderConnection.OWNER_INSTANCE);
        embedding.setOwnerId(TestInstanceIdentity.OWNER_ID);
        embedding.setProviderId("dashscope-qwen");
        embedding.setConnectionKey("embedding");
        embedding.setApiTypeId("dashscope-multimodal-embedding");
        embedding.setApiTypeVersion(1);
        embedding.setEnabled(true);
        embedding.setStatus(ProviderConnection.STATUS_READY);
        embedding.setRevision(1L);
        when(connections.findById(embedding.getId())).thenReturn(Optional.of(embedding));

        JsonNode embeddingPin = service.builtins().stream()
                .filter(node -> node.path("apiTypeId").asText().equals("dashscope-multimodal-embedding"))
                .filter(node -> node.path("version").asInt() == 2)
                .findFirst().orElseThrow();

        Session session = new Session();
        session.setUserId(UUID.randomUUID().toString());
        session.setWorkspaceId(UUID.randomUUID().toString());
        session.setContextTemplateLayer("instance");
        session.setContextTemplateId(UUID.fromString(embeddingPin.path("id").asText()));
        session.setContextTemplateVersion(2);
        session.setModelProvider("dashscope-qwen");
        session.setModelName("tongyi-embedding-vision-flash-2026-03-06");
        session.setProviderConnectionId(embedding.getId().toString());
        session.setConnectionRevision(1L);

        CpApiException rejected = catchThrowableOfType(() -> service.admissionSnapshot(session),
                CpApiException.class);
        assertThat(rejected).isNotNull();
        assertThat(rejected.getCode()).isEqualTo("API_TYPE_OPERATION_MISMATCH");
        assertThat(rejected.getStatus().value()).isEqualTo(400);
    }
}
