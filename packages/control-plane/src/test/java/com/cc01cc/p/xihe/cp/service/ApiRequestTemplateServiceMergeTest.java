package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.policy.RequesterAuthority;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * BL-284: the admission snapshot freezes BOTH halves of the context — the API request template's
 * {@code bodySource} and the context template's {@code components}. The merge is the only place the
 * component manifest enters the snapshot, so these cases pin the contract:
 * inject when absent, keep one copy when identical, and <b>fail loudly</b> when the two domains
 * disagree (never guess which manifest wins).
 */
class ApiRequestTemplateServiceMergeTest {

    private static final UUID USER = UUID.randomUUID();
    private static final UUID WORKSPACE = UUID.randomUUID();
    private static final String BODY_SOURCE = "{\"model\":\"${xh.model}\"}";

    private final ObjectMapper json = new ObjectMapper();
    private final ContextTemplateService contextTemplates = mock(ContextTemplateService.class);
    @SuppressWarnings("unchecked")
    private final org.springframework.beans.factory.ObjectProvider<ContextTemplateService> contextProvider =
            mock(org.springframework.beans.factory.ObjectProvider.class);
    private final ApiRequestTemplateService service;

    ApiRequestTemplateServiceMergeTest() {
        when(contextProvider.getObject()).thenReturn(contextTemplates);
        service = new ApiRequestTemplateService(null, null, null, null, json, null, null, null, null,
                contextProvider, mock(RequesterAuthority.class),
                com.cc01cc.p.xihe.cp.support.TestInstanceIdentity.mock());
    }

    private void contextManifest(JsonNode components) {
        ObjectNode snapshot = json.createObjectNode();
        ObjectNode template = snapshot.putObject("template");
        template.set("components", components);
        when(contextTemplates.defaultBinding(USER, WORKSPACE))
                .thenReturn(new ContextTemplateService.TemplateBinding("instance",
                        UUID.randomUUID().toString(), 1, snapshot));
    }

    private ObjectNode apiTemplate() {
        ObjectNode template = json.createObjectNode();
        template.put("id", UUID.randomUUID().toString());
        template.put("bodySource", BODY_SOURCE);
        return template;
    }

    private ObjectNode component(String type, boolean enabled) {
        ObjectNode component = json.createObjectNode();
        component.put("instanceId", UUID.randomUUID().toString());
        component.put("type", type);
        component.put("enabled", enabled);
        component.set("config", json.createObjectNode());
        return component;
    }

    @Test
    void injectsContextComponents_andKeepsBodySource() {
        ArrayNode manifest = json.createArrayNode();
        manifest.add(component("system_prompt", true));
        manifest.add(component("agent_memory", true));
        contextManifest(manifest);

        ObjectNode template = apiTemplate();
        service.mergeContextComponents(template, USER, WORKSPACE);

        assertThat(template.path("bodySource").asText()).isEqualTo(BODY_SOURCE);
        assertThat(template.path("components").isArray()).isTrue();
        assertThat(template.path("components")).hasSize(2);
        assertThat(template.path("components").get(1).path("type").asText()).isEqualTo("agent_memory");
    }

    @Test
    void identicalManifestOnBothSides_isMergedOnce() {
        ArrayNode manifest = json.createArrayNode();
        manifest.add(component("agent_memory", true));
        contextManifest(manifest);
        ObjectNode template = apiTemplate();
        template.set("components", manifest.deepCopy());

        service.mergeContextComponents(template, USER, WORKSPACE);

        assertThat(template.path("components")).hasSize(1);
    }

    /** BL-284 follow-up (Lead ruling): a shared type is not a conflict — the API side wins. */
    @Test
    void sharedType_apiRequestComponentWins_andNoConflictIsRaised() {
        ArrayNode contextManifest = json.createArrayNode();
        ObjectNode contextMemory = component("agent_memory", true);
        contextMemory.put("instanceId", "context-memory");
        contextManifest.add(contextMemory);
        contextManifest.add(component("skill_catalog", true));
        contextManifest(contextManifest);
        ObjectNode template = apiTemplate();
        ArrayNode apiManifest = json.createArrayNode();
        ObjectNode apiMemory = component("agent_memory", true);
        apiMemory.put("instanceId", "api-memory");
        apiManifest.add(apiMemory);
        template.set("components", apiManifest);

        service.mergeContextComponents(template, USER, WORKSPACE);

        assertThat(template.path("components")).hasSize(2);
        assertThat(template.path("components").get(0).path("instanceId").asText())
                .as("context order is kept, the API component replaces the shared type")
                .isEqualTo("api-memory");
        assertThat(template.path("components").get(1).path("type").asText())
                .as("context-only types are appended")
                .isEqualTo("skill_catalog");
    }

    /** Only a duplicate type <i>inside one manifest</i> stays a hard error. */
    @Test
    void duplicateTypeWithinOneManifest_isStillAConflict() {
        ArrayNode contextManifest = json.createArrayNode();
        contextManifest.add(component("agent_memory", true));
        contextManifest( contextManifest);
        ObjectNode template = apiTemplate();
        ArrayNode apiManifest = json.createArrayNode();
        apiManifest.add(component("skill_catalog", true));
        apiManifest.add(component("skill_catalog", true));
        template.set("components", apiManifest);

        assertThatThrownBy(() -> service.mergeContextComponents(template, USER, WORKSPACE))
                .isInstanceOf(CpApiException.class)
                .satisfies(thrown -> {
                    CpApiException conflict = (CpApiException) thrown;
                    assertThat(conflict.getCode()).isEqualTo("CONTEXT_TEMPLATE_COMPONENTS_CONFLICT");
                    assertThat(conflict.getStatus().value()).isEqualTo(409);
                    assertThat(conflict.getMessage()).contains("Duplicate component type in apiRequestTemplate");
                });
    }

    @Test
    void emptyContextManifest_leavesTemplateUntouched() {
        contextManifest(json.createArrayNode());

        ObjectNode template = apiTemplate();
        service.mergeContextComponents(template, USER, WORKSPACE);

        assertThat(template.has("components")).isFalse();
        assertThat(template.path("bodySource").asText()).isEqualTo(BODY_SOURCE);
    }
}
