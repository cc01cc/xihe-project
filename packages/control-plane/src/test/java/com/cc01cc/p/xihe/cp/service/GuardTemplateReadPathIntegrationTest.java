package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.policy.AccessScope;
import com.cc01cc.p.xihe.cp.policy.RoleGrantMaterializer;
import com.cc01cc.p.xihe.cp.policy.SystemAccessRoleCatalog;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.policy.GrantPrincipalPathResolver;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0625 task-91 (Gap E): the builtin guard template must be READABLE through the real
 * HTTP path — {@code GET /api/v1/agent-templates?layer=instance} returns the guard template
 * (...a2) and its role (...a1) instead of 409 {@code AGENT_TEMPLATE_CONFIG_INVALID}.
 *
 * <p>The V95 seed mis-keyed the config row (domain name as key), which poisoned the assembled
 * document against the schema; V97 reseeds the two inner-keyed rows. This test pins the read
 * path so the blind spot (migration-internal shape assertions only) cannot regress.</p>
 */
class GuardTemplateReadPathIntegrationTest extends AbstractIntegrationTest {

    private static final String GUARD_ROLE_ID = "00000000-0000-4000-8000-0000000000a1";
    private static final String GUARD_TEMPLATE_ID = "00000000-0000-4000-8000-0000000000a2";

    @Autowired
    private UserRepository userRepository;
    @Autowired
    private AccessRoleRepository accessRoleRepository;
    @Autowired
    private AccessRoleBindingRepository bindingRepository;
    @Autowired
    private AuthorizationGrantRepository grantRepository;
    @Autowired
    private RoleGrantMaterializer materializer;

    private UUID adminUserId;

    @AfterEach
    void cleanFixtures() {
        if (adminUserId != null) {
            bindingRepository.deleteAll(bindingRepository.findBySubjectTypeAndSubjectIdAndScopeType(
                    "user", adminUserId, AccessScope.INSTANCE));
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                    GrantPrincipalPathResolver.USER, adminUserId));
            userRepository.deleteById(adminUserId);
        }
    }

    @Test
    void builtinGuardTemplateIsReadableThroughTheInstanceLayerEndpoint() {
        User admin = userRepository.saveAndFlush(new User(
                "guard-read-admin-" + UUID.randomUUID() + "@test.com", "hash", "Guard read admin"));
        adminUserId = admin.getId();
        AccessRole adminRole = accessRoleRepository.findByName(SystemAccessRoleCatalog.ADMIN)
                .orElseThrow();
        bindingRepository.deleteAll(bindingRepository.findBySubjectTypeAndSubjectIdAndScopeType(
                "user", adminUserId, AccessScope.INSTANCE));
        bindingRepository.save(new AccessRoleBinding(adminRole.getId(), "user", adminUserId,
                AccessScope.INSTANCE, null, adminUserId));
        materializer.materializeSubject("user", adminUserId, adminUserId, null);

        String adminGlobal = TestDataFactory.createGlobalToken(
                adminUserId.toString(), admin.getEmail(), "ADMIN", 0);
        ResponseEntity<String> response = restTemplate.exchange(
                url("/api/v1/agent-templates?layer=instance"), HttpMethod.GET,
                new HttpEntity<>(bearerHeaders(adminGlobal)), String.class);

        assertEquals(HttpStatus.OK, response.getStatusCode(),
                "Gap E regression guard: mis-keyed seed made every instance read 409 "
                        + "AGENT_TEMPLATE_CONFIG_INVALID");
        assertTrue(response.getBody() != null && response.getBody().contains(GUARD_TEMPLATE_ID),
                "the builtin guard template must be listed at the instance layer");
        assertTrue(response.getBody() != null && response.getBody().contains(GUARD_ROLE_ID),
                "the builtin guard role must be listed at the instance layer");
    }

    private HttpHeaders bearerHeaders(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return headers;
    }
}
