package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.policy.GrantDefaultService;
import com.cc01cc.p.xihe.cp.policy.GrantPrincipalPathResolver;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
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

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;

/**
 * task-207 / D-1587: a whole-list write of {@code roles}/{@code templates} replaces that key's list,
 * so ids the caller omitted disappear — silently, because the pre-change response was only
 * {@code {status, keys}}. This pins the additive report: {@code removedCount} + {@code removedIds}
 * for the {@code agent-templates} domain, ids only (never prompt text), and nothing else changed.
 *
 * <p>Red first ({@code D-1490}): on the pre-change code the second PUT answers 200 with no
 * {@code removedCount} at all, so {@link #wholeListWriteReportsExactlyTheIdsItDropped()} fails.
 * The report is a receipt, never a gate: nothing here asserts a write is refused.</p>
 */
class AgentTemplatesRemovalReportTest extends AbstractReusableIntegrationTest {

    @Autowired
    private UserRepository userRepository;
    @Autowired
    private AuthorizationGrantRepository grantRepository;
    @Autowired
    private GrantDefaultService grantDefaultService;
    @Autowired
    private ObjectMapper objectMapper;

    private UUID userId;

    @AfterEach
    void cleanFixtures() {
        if (userId == null) {
            return;
        }
        grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("user", userId));
        userRepository.deleteById(userId);
        userId = null;
    }

    @Test
    void wholeListWriteReportsExactlyTheIdsItDropped() throws Exception {
        String token = writerToken();
        UUID roleKeep = UUID.randomUUID();
        UUID roleSecond = UUID.randomUUID();
        UUID roleThird = UUID.randomUUID();
        UUID templateKeep = UUID.randomUUID();
        UUID templateSecond = UUID.randomUUID();
        UUID templateDropped = UUID.randomUUID();

        Map<String, Object> first = putTemplates(token, Map.of(
                "roles", roles(roleKeep, roleSecond, roleThird).toString(),
                "templates", templates(roleKeep, templateKeep, templateSecond, templateDropped).toString()));
        assertEquals("ok", first.get("status"));
        assertEquals(2, first.get("keys"), "the documented keys field must stay as it was");
        assertEquals(0, first.get("removedCount"),
                "removedCount must be present and 0 on a non-replacing write");
        assertEquals(List.of(), first.get("removedIds"));

        // 3 templates -> 2 templates: exactly templateDropped is gone.
        Map<String, Object> replaced = putTemplates(token, Map.of(
                "roles", roles(roleKeep, roleSecond, roleThird).toString(),
                "templates", templates(roleKeep, templateKeep, templateSecond).toString()));
        assertEquals("ok", replaced.get("status"));
        assertEquals(1, replaced.get("removedCount"),
                "the whole-list write dropped one template and the response must say so");
        assertEquals(List.of(templateDropped.toString()), replaced.get("removedIds"));

        // Merge semantics: keep both existing ids and append a new one.
        UUID templateAdded = UUID.randomUUID();
        Map<String, Object> merged = putTemplates(token, Map.of(
                "roles", roles(roleKeep, roleSecond, roleThird).toString(),
                "templates", templates(roleKeep, templateKeep, templateSecond, templateAdded).toString()));
        assertEquals("ok", merged.get("status"));
        assertEquals(0, merged.get("removedCount"), "a merge removes nothing");
        assertEquals(List.of(), merged.get("removedIds"));

        // A single-key write leaves the sibling key alone: no removal is reported for it.
        Map<String, Object> rolesOnly = putTemplates(token, Map.of(
                "roles", roles(roleKeep, roleSecond, roleThird).toString()));
        assertEquals("ok", rolesOnly.get("status"));
        assertEquals(0, rolesOnly.get("removedCount"),
                "templates were not part of this body, so nothing was removed from them");

        // The same receipt covers the other whole-list key, and only that key.
        Map<String, Object> rolesDropped = putTemplates(token, Map.of(
                "roles", roles(roleKeep, roleSecond).toString()));
        assertEquals(1, rolesDropped.get("removedCount"),
                "dropping a role is the same kind of loss and must be reported too");
        assertEquals(List.of(roleThird.toString()), rolesDropped.get("removedIds"));
    }

    @Test
    void removalReportIsOnlyAddedToTheAgentTemplatesDomain() {
        String token = writerToken();
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        ResponseEntity<Map> other = restTemplate.exchange(url("/api/v1/config/user/user-preference"),
                HttpMethod.PUT, new HttpEntity<>(Map.of(), headers), Map.class);
        assertEquals(HttpStatus.OK, other.getStatusCode());
        assertNotNull(other.getBody());
        assertFalse(other.getBody().containsKey("removedCount"),
                "non-template domains keep their exact previous response shape");
        assertFalse(other.getBody().containsKey("removedIds"));
        assertEquals(0, other.getBody().get("keys"));
    }

    private String writerToken() {
        User user = userRepository.saveAndFlush(new User(
                "task207-" + UUID.randomUUID() + "@test.com", "hash", "Template removal writer"));
        userId = user.getId();
        grantDefaultService.ensureUserDefault(user);
        addGrant(ToolFaceRegistry.ACTION_CREATE_TEMPLATE);
        return TestDataFactory.createGlobalToken(userId.toString(),
                "task207-" + userId + "@test.com", "USER", 0);
    }

    private void addGrant(String actionClass) {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setId(UUID.randomUUID());
        grant.setGranterType(GrantPrincipalPathResolver.USER);
        grant.setGranterId(userId);
        grant.setSubjectType(GrantPrincipalPathResolver.USER);
        grant.setSubjectId(userId);
        grant.setSource("role");
        grant.setReadState("read");
        ObjectNode atom = objectMapper.createObjectNode();
        atom.put("actionClass", actionClass);
        atom.put("resource", "*");
        ArrayNode permissions = objectMapper.createArrayNode();
        permissions.add(atom);
        grant.setPermissions(permissions);
        grantRepository.saveAndFlush(grant);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> putTemplates(String token, Map<String, String> body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        ResponseEntity<Map> response = restTemplate.exchange(
                url("/api/v1/config/user/agent-templates"), HttpMethod.PUT,
                new HttpEntity<>(body, headers), Map.class);
        assertEquals(HttpStatus.OK, response.getStatusCode(),
                "template write must succeed: " + response.getBody());
        return new LinkedHashMap<>(response.getBody());
    }

    private ArrayNode roles(UUID... ids) {
        ArrayNode roles = objectMapper.createArrayNode();
        for (UUID id : ids) {
            ObjectNode role = objectMapper.createObjectNode();
            role.put("id", id.toString());
            role.put("name", "Role " + id.toString().substring(0, 8));
            ArrayNode permissions = objectMapper.createArrayNode();
            ObjectNode atom = objectMapper.createObjectNode();
            atom.put("actionClass", "read");
            permissions.add(atom);
            role.set("permissions", permissions);
            roles.add(role);
        }
        return roles;
    }

    private ArrayNode templates(UUID roleId, UUID... ids) {
        ArrayNode templates = objectMapper.createArrayNode();
        for (UUID id : ids) {
            ObjectNode template = objectMapper.createObjectNode();
            template.put("id", id.toString());
            template.put("name", "Template " + id.toString().substring(0, 8));
            template.put("description", "task-207 fixture template");
            template.put("systemPrompt", "task-207 fixture prompt");
            template.put("toolMode", "workspace");
            template.put("provider", "openai");
            template.put("model", "test-model");
            template.put("roleId", roleId.toString());
            templates.add(template);
        }
        return templates;
    }
}