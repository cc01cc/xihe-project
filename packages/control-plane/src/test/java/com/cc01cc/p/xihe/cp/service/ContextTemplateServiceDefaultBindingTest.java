package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.ConfigDomainSchema;
import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * BL-284: the built-in context template must carry the {@code agent_memory} component, otherwise a
 * brand-new stack resolves an empty component manifest and memory never reaches the prompt even
 * when the principal is correct (the second half of BL-281). Also pins the deterministic
 * workspace → user → instance → built-in resolution order and the fail-hard rule for broken refs.
 */
class ContextTemplateServiceDefaultBindingTest {

    private static final UUID USER = UUID.randomUUID();
    private static final UUID WORKSPACE = UUID.randomUUID();
    private static final String DOMAIN = ContextTemplateService.DOMAIN;

    private final ObjectMapper json = new ObjectMapper();
    private ConfigService configService;
    private ContextTemplateService service;

    @BeforeEach
    void setUp() {
        configService = mock(ConfigService.class);
        when(configService.layerEntries(any(), eq(DOMAIN), any(), any())).thenReturn(Map.of());
        service = new ContextTemplateService(configService, mock(ConfigDomainSchema.class), json);
    }

    private void stubLayer(String layer, Map<String, String> entries) {
        when(configService.layerEntries(eq(layer), eq(DOMAIN), any(), any())).thenReturn(entries);
    }

    private Map<String, String> templateEntries(ObjectNode template, ObjectNode defaultRef) {
        Map<String, String> entries = new LinkedHashMap<>();
        entries.put("templates", json.createArrayNode().add(template).toString());
        if (defaultRef != null) {
            entries.put("defaultTemplate", defaultRef.toString());
        }
        return entries;
    }

    @Test
    void builtinTemplate_carriesAgentMemoryComponent() {
        ContextTemplateService.TemplateBinding binding = service.defaultBinding(USER, WORKSPACE);

        assertThat(binding.layer()).isEqualTo("instance");
        assertThat(binding.templateId()).isEqualTo(ContextTemplateService.BUILTIN_TEMPLATE_ID.toString());
        JsonNode components = binding.snapshot().path("template").path("components");
        JsonNode memory = null;
        for (JsonNode component : components) {
            if ("agent_memory".equals(component.path("type").asText())) {
                memory = component;
            }
        }
        assertThat(memory).as("built-in manifest must contain agent_memory").isNotNull();
        assertThat(memory.path("enabled").asBoolean()).isTrue();
        assertThat(memory.path("config").path("maxEntries").asInt()).isEqualTo(24);
        assertThat(memory.path("config").path("maxTokens").asInt()).isEqualTo(4000);
        assertThat(binding.snapshot().path("template").path("document").asText())
                .contains(memory.path("instanceId").asText());
    }

    @Test
    void workspaceDefault_winsOverUserAndInstance() {
        UUID workspaceTemplateId = UUID.randomUUID();
        ObjectNode workspaceTemplate = json.createObjectNode();
        workspaceTemplate.put("id", workspaceTemplateId.toString());
        workspaceTemplate.put("version", 2);
        workspaceTemplate.put("name", "workspace template");
        workspaceTemplate.put("description", "ws");
        workspaceTemplate.put("document", "{{component:00000000-0000-4000-8000-000000000011}}");
        workspaceTemplate.set("components", json.createArrayNode());
        ObjectNode ref = json.createObjectNode();
        ref.put("layer", "workspace");
        ref.put("templateId", workspaceTemplateId.toString());
        ref.put("version", 2);
        stubLayer("workspace", templateEntries(workspaceTemplate, ref));

        ContextTemplateService.TemplateBinding binding = service.defaultBinding(USER, WORKSPACE);

        assertThat(binding.layer()).isEqualTo("workspace");
        assertThat(binding.templateId()).isEqualTo(workspaceTemplateId.toString());
        assertThat(binding.version()).isEqualTo(2);
    }

    @Test
    void brokenDefaultRef_failsAdmissionInsteadOfSilentlyFallingBack() {
        ObjectNode ref = json.createObjectNode();
        ref.put("layer", "instance");
        ref.put("templateId", UUID.randomUUID().toString());
        ref.put("version", 3);
        stubLayer("instance", Map.of("templates", "[]", "defaultTemplate", ref.toString()));

        assertThatThrownBy(() -> service.defaultBinding(USER, WORKSPACE))
                .isInstanceOf(CpApiException.class)
                .satisfies(thrown -> assertThat(((CpApiException) thrown).getCode())
                        .isEqualTo("CONTEXT_TEMPLATE_NOT_FOUND"));
    }
}
