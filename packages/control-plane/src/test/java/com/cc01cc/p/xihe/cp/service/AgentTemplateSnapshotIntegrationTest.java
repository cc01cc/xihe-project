package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ConfigEntity;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.policy.GrantPrincipalPathResolver;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.ConfigJpaRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AgentTemplateSnapshotIntegrationTest extends AbstractIntegrationTest {

    private static final String INSTANCE_PROMPT = "decoy-instance-layer-prompt-0374";
    private static final String WORKSPACE_PROMPT = "decoy-workspace-layer-prompt-0374";
    private static final String USER_PROMPT = "user-layer-prompt-0374";
    private static final String OUTSIDER_PROMPT = "outsider-user-layer-prompt-0374";
    private static final String SNAPSHOT_PROMPT_V2 = "user-layer-prompt-0374-v2";
    private static final Pattern SECRET_KEY = Pattern.compile("(?i)(secret|token|api[-_]?key|password)");
    private static final List<String> SNAPSHOT_FIELDS = List.of(
            "templateId", "templateName", "roleId", "roleName", "systemPrompt",
            "toolMode", "provider", "model", "permissions");

    @Autowired private AgentTemplateService agentTemplateService;
    @Autowired private AgentPrincipalService agentPrincipalService;
    @Autowired private AgentPrincipalRepository agentPrincipalRepository;
    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceUserRepository workspaceUserRepository;
    @Autowired private ConfigJpaRepository configJpaRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private SessionRepository sessionRepository;
    @Autowired private ObjectMapper objectMapper;

    private UUID memberUserId;
    private UUID adminUserId;
    private UUID outsiderUserId;
    private UUID workspaceId;
    private UUID memberTemplateId;
    private UUID memberRoleId;
    private UUID outsiderTemplateId;
    private UUID instanceTemplateId;
    private UUID workspaceTemplateId;
    private UUID memberTemplateRowId;
    private UUID memberRoleRowId;
    private final List<UUID> configIds = new ArrayList<>();
    private final List<UUID> principalIds = new ArrayList<>();
    private final List<UUID> sessionIds = new ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        configJpaRepository.deleteAllById(configIds);
        sessionIds.forEach(sessionRepository::deleteById);
        principalIds.forEach(principalId -> {
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                    GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId));
            agentPrincipalRepository.deleteById(principalId);
        });
        if (memberUserId != null) {
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                    GrantPrincipalPathResolver.USER, memberUserId));
        }
        if (workspaceId != null) {
            workspaceUserRepository.deleteAll(workspaceUserRepository.findByIdWorkspaceId(workspaceId));
            workspaceRepository.deleteById(workspaceId);
        }
        if (adminUserId != null) {
            userRepository.deleteById(adminUserId);
        }
        if (outsiderUserId != null) {
            userRepository.deleteById(outsiderUserId);
        }
        if (memberUserId != null) {
            userRepository.deleteById(memberUserId);
        }
    }

    @Test
    void instanceUserWorkspaceLayerReadsEnforceFailClosedBoundaries() {
        fixture();
        String memberGlobal = TestDataFactory.createGlobalToken(
                memberUserId.toString(), memberEmail(), "USER");
        String memberWorkspace = TestDataFactory.createWorkspaceToken(
                memberUserId.toString(), memberEmail(), "USER", workspaceId.toString());
        String adminGlobal = TestDataFactory.createGlobalToken(
                adminUserId.toString(), adminEmail(), "ADMIN");
        String outsiderGlobal = TestDataFactory.createGlobalToken(
                outsiderUserId.toString(), outsiderEmail(), "USER");

        ResponseEntity<String> instanceDenied = get("?layer=instance", memberGlobal);
        assertEquals(HttpStatus.FORBIDDEN, instanceDenied.getStatusCode());
        assertEquals("FORBIDDEN", problemCode(instanceDenied.getBody()));
        assertNoTemplateContent(instanceDenied.getBody());
        assertNoSecretKeys(instanceDenied.getBody());

        ResponseEntity<String> instanceOk = get("?layer=instance", adminGlobal);
        assertEquals(HttpStatus.OK, instanceOk.getStatusCode());
        assertEquals("instance", readTree(instanceOk.getBody()).path("layer").asText());
        assertEquals(1, readTree(instanceOk.getBody()).path("templates").size());
        assertTrue(instanceOk.getBody().contains(INSTANCE_PROMPT));
        assertFalse(instanceOk.getBody().contains(USER_PROMPT));
        assertFalse(instanceOk.getBody().contains(WORKSPACE_PROMPT));
        assertNoSecretKeys(instanceOk.getBody());

        ResponseEntity<String> userOk = get("?layer=user", memberGlobal);
        assertEquals(HttpStatus.OK, userOk.getStatusCode());
        JsonNode userBody = readTree(userOk.getBody());
        assertEquals("user", userBody.path("layer").asText());
        assertTrue(userBody.path("workspaceId").isNull(), "user layer has no workspace scope");
        assertEquals(1, userBody.path("templates").size());
        assertEquals(memberTemplateId.toString(),
                userBody.path("templates").get(0).path("id").asText());
        for (String field : List.of("id", "name", "description", "systemPrompt", "toolMode",
                "provider", "model", "roleId")) {
            assertTrue(userBody.path("templates").get(0).has(field),
                    "raw template entry must keep field " + field);
        }
        assertTrue(userOk.getBody().contains(USER_PROMPT));
        assertFalse(userOk.getBody().contains(OUTSIDER_PROMPT),
                "user layer reads must not cross into another user's layer");
        assertFalse(userOk.getBody().contains(INSTANCE_PROMPT),
                "user layer reads must not fall back to the instance layer");
        assertFalse(userOk.getBody().contains(WORKSPACE_PROMPT),
                "user layer reads must not merge the workspace layer");
        assertNoSecretKeys(userOk.getBody());

        ResponseEntity<String> workspaceParam = get(
                "?layer=workspace&workspaceId=" + workspaceId, memberGlobal);
        assertEquals(HttpStatus.OK, workspaceParam.getStatusCode());
        JsonNode workspaceBody = readTree(workspaceParam.getBody());
        assertEquals("workspace", workspaceBody.path("layer").asText());
        assertEquals(workspaceId.toString(), workspaceBody.path("workspaceId").asText());
        assertEquals(1, workspaceBody.path("templates").size());
        assertEquals(workspaceTemplateId.toString(),
                workspaceBody.path("templates").get(0).path("id").asText());
        assertTrue(workspaceParam.getBody().contains(WORKSPACE_PROMPT));
        assertFalse(workspaceParam.getBody().contains(USER_PROMPT));
        assertFalse(workspaceParam.getBody().contains(INSTANCE_PROMPT));
        assertNoSecretKeys(workspaceParam.getBody());

        ResponseEntity<String> workspaceFallback = get("?layer=workspace", memberWorkspace);
        assertEquals(HttpStatus.OK, workspaceFallback.getStatusCode());
        assertEquals(workspaceId.toString(),
                readTree(workspaceFallback.getBody()).path("workspaceId").asText(),
                "missing workspaceId falls back to the tenant workspace context");
        assertNoSecretKeys(workspaceFallback.getBody());

        ResponseEntity<String> nonMember = get(
                "?layer=workspace&workspaceId=" + workspaceId, outsiderGlobal);
        assertEquals(HttpStatus.FORBIDDEN, nonMember.getStatusCode());
        assertEquals("WORKSPACE_ACCESS_DENIED", problemCode(nonMember.getBody()));
        assertNoTemplateContent(nonMember.getBody());
        assertNoSecretKeys(nonMember.getBody());

        ResponseEntity<String> missingWorkspace = get(
                "?layer=workspace&workspaceId=" + UUID.randomUUID(), memberGlobal);
        assertEquals(HttpStatus.NOT_FOUND, missingWorkspace.getStatusCode());
        assertEquals("WORKSPACE_NOT_FOUND", problemCode(missingWorkspace.getBody()));
        assertNoSecretKeys(missingWorkspace.getBody());

        ResponseEntity<String> missingLayer = get("", memberGlobal);
        assertEquals(HttpStatus.BAD_REQUEST, missingLayer.getStatusCode());
        assertEquals("INVALID_REQUEST", problemCode(missingLayer.getBody()));

        ResponseEntity<String> invalidLayer = get("?layer=merged", memberGlobal);
        assertEquals(HttpStatus.BAD_REQUEST, invalidLayer.getStatusCode());
        assertEquals("INVALID_REQUEST", problemCode(invalidLayer.getBody()));

        ResponseEntity<String> noWorkspaceContext = get("?layer=workspace", memberGlobal);
        assertEquals(HttpStatus.BAD_REQUEST, noWorkspaceContext.getStatusCode());
        assertEquals("INVALID_REQUEST", problemCode(noWorkspaceContext.getBody()));

        ResponseEntity<String> malformedWorkspaceId = get(
                "?layer=workspace&workspaceId=not-a-uuid", memberGlobal);
        assertEquals(HttpStatus.BAD_REQUEST, malformedWorkspaceId.getStatusCode());
        assertEquals("INVALID_REQUEST", problemCode(malformedWorkspaceId.getBody()));
    }

    @Test
    void crossLayerEnumerationIsDeniedWith403ProblemBodies() {
        fixture();
        String outsiderGlobal = TestDataFactory.createGlobalToken(
                outsiderUserId.toString(), outsiderEmail(), "USER");
        String memberGlobal = TestDataFactory.createGlobalToken(
                memberUserId.toString(), memberEmail(), "USER");

        ResponseEntity<String> instanceEnum = get("?layer=instance", outsiderGlobal);
        assertEquals(HttpStatus.FORBIDDEN, instanceEnum.getStatusCode());
        assertNoTemplateContent(instanceEnum.getBody());
        assertNoSecretKeys(instanceEnum.getBody());
        assertFalse(instanceEnum.getBody().contains(instanceTemplateId.toString()));

        ResponseEntity<String> workspaceEnum = get(
                "?layer=workspace&workspaceId=" + workspaceId, outsiderGlobal);
        assertEquals(HttpStatus.FORBIDDEN, workspaceEnum.getStatusCode());
        assertNoTemplateContent(workspaceEnum.getBody());
        assertNoSecretKeys(workspaceEnum.getBody());
        assertFalse(workspaceEnum.getBody().contains(workspaceTemplateId.toString()));

        ResponseEntity<String> memberUserLayer = get("?layer=user", memberGlobal);
        assertEquals(HttpStatus.OK, memberUserLayer.getStatusCode());
        assertFalse(memberUserLayer.getBody().contains(instanceTemplateId.toString()),
                "the user layer response must not carry instance template IDs");
        assertFalse(memberUserLayer.getBody().contains(workspaceTemplateId.toString()),
                "the user layer response must not carry workspace template IDs");
        assertFalse(memberUserLayer.getBody().contains(outsiderTemplateId.toString()),
                "the user layer response must not carry another user's template IDs");
    }

    @Test
    void templateSnapshotFreezesAtPrincipalCreationAndSurvivesConfigEdits() {
        fixture();
        AgentTemplateService.ResolvedTemplate resolved = agentTemplateService.resolveForCreation(
                memberUserId.toString(), workspaceId.toString(), memberTemplateId.toString());
        assertEquals("user", resolved.sourceLayer());

        AgentPrincipal first = agentPrincipalService.createPrincipal(
                memberUserId.toString(), "Snapshot principal A",
                memberTemplateId.toString(), resolved.snapshot());
        principalIds.add(first.getId());
        AgentPrincipal second = agentPrincipalService.createPrincipal(
                memberUserId.toString(), "Snapshot principal B",
                memberTemplateId.toString(), resolved.snapshot());
        principalIds.add(second.getId());

        JsonNode firstSnapshot = agentPrincipalRepository.findById(first.getId()).orElseThrow()
                .getTemplateSnapshot();
        JsonNode secondSnapshot = agentPrincipalRepository.findById(second.getId()).orElseThrow()
                .getTemplateSnapshot();
        for (String field : SNAPSHOT_FIELDS) {
            assertTrue(firstSnapshot.has(field), "snapshot must carry " + field);
            assertEquals(firstSnapshot.get(field), secondSnapshot.get(field),
                    "both principals must freeze the same " + field);
        }
        assertSnapshotFields(firstSnapshot, USER_PROMPT);
        assertSnapshotFields(secondSnapshot, USER_PROMPT);

        Session firstSession = saveAgentSession(first);
        Session secondSession = saveAgentSession(second);
        JsonNode firstSessionCap = objectMapper.valueToTree(
                firstSession.getAgentPermissionsSnapshot());
        JsonNode secondSessionCap = objectMapper.valueToTree(
                secondSession.getAgentPermissionsSnapshot());

        ConfigEntity templatesRow = configJpaRepository.findById(memberTemplateRowId).orElseThrow();
        templatesRow.setConfigValue(templateConfig(
                memberTemplateId, "Template read user", memberRoleId, SNAPSHOT_PROMPT_V2).toString());
        configJpaRepository.saveAndFlush(templatesRow);
        ConfigEntity rolesRow = configJpaRepository.findById(memberRoleRowId).orElseThrow();
        rolesRow.setConfigValue(roleConfig(memberRoleId, "Template read role", atoms("read")).toString());
        configJpaRepository.saveAndFlush(rolesRow);

        AgentTemplateService.ResolvedTemplate reloaded = agentTemplateService.resolveForCreation(
                memberUserId.toString(), workspaceId.toString(), memberTemplateId.toString());
        assertEquals(SNAPSHOT_PROMPT_V2, reloaded.snapshot().path("systemPrompt").asText(),
                "control assertion: the config edit is visible to new resolutions");
        assertEquals(atoms("read"), reloaded.snapshot().path("permissions"),
                "control assertion: the role edit is visible to new resolutions");

        JsonNode firstAfter = agentPrincipalRepository.findById(first.getId()).orElseThrow()
                .getTemplateSnapshot();
        JsonNode secondAfter = agentPrincipalRepository.findById(second.getId()).orElseThrow()
                .getTemplateSnapshot();
        for (String field : SNAPSHOT_FIELDS) {
            assertEquals(firstSnapshot.get(field), firstAfter.get(field),
                    "existing principal A snapshot must not follow the " + field + " config edit");
            assertEquals(firstSnapshot.get(field), secondAfter.get(field),
                    "existing principal B snapshot must not follow the " + field + " config edit");
        }
        assertSnapshotFields(firstAfter, USER_PROMPT);
        assertSnapshotFields(secondAfter, USER_PROMPT);

        assertEquals(firstSessionCap, objectMapper.valueToTree(
                        sessionRepository.findById(firstSession.getId()).orElseThrow()
                                .getAgentPermissionsSnapshot()),
                "Session permission caps are frozen at creation");
        assertEquals(secondSessionCap, objectMapper.valueToTree(
                        sessionRepository.findById(secondSession.getId()).orElseThrow()
                                .getAgentPermissionsSnapshot()),
                "Session permission caps are frozen at creation");
    }

    private void fixture() {
        User member = userRepository.saveAndFlush(new User(
                "tpl-snapshot-member-" + UUID.randomUUID() + "@test.com",
                "hash", UserRole.USER, "Template read member"));
        memberUserId = member.getId();
        User admin = userRepository.saveAndFlush(new User(
                "tpl-snapshot-admin-" + UUID.randomUUID() + "@test.com",
                "hash", UserRole.ADMIN, "Template read admin"));
        adminUserId = admin.getId();
        User outsider = userRepository.saveAndFlush(new User(
                "tpl-snapshot-outsider-" + UUID.randomUUID() + "@test.com",
                "hash", UserRole.USER, "Template read outsider"));
        outsiderUserId = outsider.getId();

        Workspace workspace = workspaceRepository.saveAndFlush(
                new Workspace("Template read workspace", memberUserId.toString()));
        workspaceId = workspace.getId();
        workspaceUserRepository.saveAndFlush(new WorkspaceUser(
                workspaceId.toString(), memberUserId.toString(), WorkspaceRole.OWNER));

        UUID instanceRoleId = UUID.randomUUID();
        instanceTemplateId = UUID.randomUUID();
        saveTemplateConfig("instance", null, null, "roles",
                roleConfig(instanceRoleId, "Instance role", atoms("read")).toString());
        saveTemplateConfig("instance", null, null, "templates",
                templateConfig(instanceTemplateId, "Instance template",
                        instanceRoleId, INSTANCE_PROMPT).toString());

        memberRoleId = UUID.randomUUID();
        memberTemplateId = UUID.randomUUID();
        memberRoleRowId = saveTemplateConfig("user", memberUserId, null, "roles",
                roleConfig(memberRoleId, "Template read role", atoms("read", "write")).toString());
        memberTemplateRowId = saveTemplateConfig("user", memberUserId, null, "templates",
                templateConfig(memberTemplateId, "Template read user",
                        memberRoleId, USER_PROMPT).toString());

        UUID outsiderRoleId = UUID.randomUUID();
        outsiderTemplateId = UUID.randomUUID();
        saveTemplateConfig("user", outsiderUserId, null, "roles",
                roleConfig(outsiderRoleId, "Outsider role", atoms("read")).toString());
        saveTemplateConfig("user", outsiderUserId, null, "templates",
                templateConfig(outsiderTemplateId, "Outsider template",
                        outsiderRoleId, OUTSIDER_PROMPT).toString());

        UUID workspaceRoleId = UUID.randomUUID();
        workspaceTemplateId = UUID.randomUUID();
        saveTemplateConfig("workspace", null, workspaceId, "roles",
                roleConfig(workspaceRoleId, "Workspace role", atoms("read")).toString());
        saveTemplateConfig("workspace", null, workspaceId, "templates",
                templateConfig(workspaceTemplateId, "Workspace template",
                        workspaceRoleId, WORKSPACE_PROMPT).toString());
    }

    private Session saveAgentSession(AgentPrincipal principal) {
        Session session = new Session(workspaceId.toString(), memberUserId.toString(),
                "Snapshot session " + principal.getName());
        session.setId(UUID.randomUUID());
        session.setAgentPrincipalId(principal.getId().toString());
        session.setAgentPermissionsSnapshot(atoms("read", "write"));
        Session saved = sessionRepository.save(session);
        sessionIds.add(saved.getId());
        return saved;
    }

    private void assertSnapshotFields(JsonNode snapshot, String systemPrompt) {
        assertEquals(memberTemplateId.toString(), snapshot.path("templateId").asText());
        assertEquals("Template read user", snapshot.path("templateName").asText());
        assertEquals(memberRoleId.toString(), snapshot.path("roleId").asText());
        assertEquals("Template read role", snapshot.path("roleName").asText());
        assertEquals(systemPrompt, snapshot.path("systemPrompt").asText());
        assertEquals("workspace", snapshot.path("toolMode").asText());
        assertEquals("openai", snapshot.path("provider").asText());
        assertEquals("test-model", snapshot.path("model").asText());
        assertEquals(atoms("read", "write"), snapshot.path("permissions"));
    }

    private void assertNoTemplateContent(String body) {
        assertNotNull(body);
        for (String prompt : List.of(INSTANCE_PROMPT, WORKSPACE_PROMPT, USER_PROMPT, OUTSIDER_PROMPT)) {
            assertFalse(body.contains(prompt), "response leaked a systemPrompt: " + prompt);
        }
        assertFalse(readTree(body).has("templates"),
                "denied response must not expose a templates array");
        assertFalse(body.contains("systemPrompt"), "denied response must not expose systemPrompt");
    }

    private void assertNoSecretKeys(String body) {
        assertNotNull(body);
        List<String> hits = new ArrayList<>();
        collectSecretKeys("", readTree(body), hits);
        assertTrue(hits.isEmpty(), "secret-like response keys: " + hits);
    }

    private void collectSecretKeys(String prefix, JsonNode node, List<String> hits) {
        if (node.isObject()) {
            Iterator<Map.Entry<String, JsonNode>> fields = node.fields();
            while (fields.hasNext()) {
                Map.Entry<String, JsonNode> field = fields.next();
                if (SECRET_KEY.matcher(field.getKey()).find()) {
                    hits.add(prefix + field.getKey());
                }
                collectSecretKeys(prefix + field.getKey() + ".", field.getValue(), hits);
            }
        } else if (node.isArray()) {
            for (int i = 0; i < node.size(); i++) {
                collectSecretKeys(prefix + i + ".", node.get(i), hits);
            }
        }
    }

    private JsonNode readTree(String body) {
        try {
            return objectMapper.readTree(body);
        } catch (Exception e) {
            throw new IllegalStateException("Response body is not valid JSON: " + body, e);
        }
    }

    private String problemCode(String body) {
        return readTree(body).path("code").asText();
    }

    private ResponseEntity<String> get(String query, String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return restTemplate.exchange(url("/api/v1/agent-templates" + query),
                HttpMethod.GET, new HttpEntity<Void>(headers), String.class);
    }

    private String memberEmail() {
        return userRepository.findById(memberUserId).orElseThrow().getEmail();
    }

    private String adminEmail() {
        return userRepository.findById(adminUserId).orElseThrow().getEmail();
    }

    private String outsiderEmail() {
        return userRepository.findById(outsiderUserId).orElseThrow().getEmail();
    }

    private UUID saveTemplateConfig(String layer, UUID ownerUserId, UUID ownerWorkspaceId,
                                    String key, String value) {
        ConfigEntity entity = new ConfigEntity();
        entity.setLayer(layer);
        entity.setUserId(ownerUserId);
        entity.setWorkspaceId(ownerWorkspaceId);
        entity.setDomain("agent-templates");
        entity.setConfigKey(key);
        entity.setConfigValue(value);
        entity.setUpdatedBy("test-fixture");
        ConfigEntity saved = configJpaRepository.saveAndFlush(entity);
        configIds.add(saved.getId());
        return saved.getId();
    }

    private ArrayNode roleConfig(UUID id, String name, ArrayNode permissions) {
        ObjectNode role = objectMapper.createObjectNode();
        role.put("id", id.toString());
        role.put("name", name);
        role.set("permissions", permissions);
        ArrayNode result = objectMapper.createArrayNode();
        result.add(role);
        return result;
    }

    private ArrayNode templateConfig(UUID id, String name, UUID roleId, String systemPrompt) {
        ObjectNode template = objectMapper.createObjectNode();
        template.put("id", id.toString());
        template.put("name", name);
        template.put("description", name + " description");
        template.put("systemPrompt", systemPrompt);
        template.put("toolMode", "workspace");
        template.put("provider", "openai");
        template.put("model", "test-model");
        template.put("roleId", roleId.toString());
        ArrayNode result = objectMapper.createArrayNode();
        result.add(template);
        return result;
    }

    private ArrayNode atoms(String... actionClasses) {
        ArrayNode permissions = objectMapper.createArrayNode();
        for (String actionClass : actionClasses) {
            ObjectNode atom = objectMapper.createObjectNode();
            atom.put("actionClass", actionClass);
            permissions.add(atom);
        }
        return permissions;
    }
}
