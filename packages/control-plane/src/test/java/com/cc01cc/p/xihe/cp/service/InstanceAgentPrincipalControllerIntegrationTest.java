package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuditLog;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.policy.AccessScope;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.policy.GrantPrincipalPathResolver;
import com.cc01cc.p.xihe.cp.policy.RequesterAuthority;
import com.cc01cc.p.xihe.cp.policy.RoleGrantMaterializer;
import com.cc01cc.p.xihe.cp.policy.SystemAccessRoleCatalog;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuditLogRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0771 M3 / task-179 (contract {@code d533613c}): the four instance platform-agent endpoints
 * over real HTTP.
 *
 * <p>Every endpoint carries at least one <b>negative</b> case whose assertion names the exact status
 * <b>and</b> the {@code problem.code} — "it failed somehow" does not prove the contract's rule fired.
 * The behaviours this class exists to pin down:</p>
 * <ul>
 *   <li><b>asymmetric gates</b>: the read face is open to every authenticated caller (unlike the
 *       credential surface, which is admin-only because it carries a secret face), while every write
 *       needs {@code cap:instance:admin} <b>and</b> {@code MANAGE_AGENT_PRINCIPALS};</li>
 *   <li><b>{@code DELETE} = retire</b>: 204, {@code disabledAt} set, row still there — never a hard
 *       delete, and repeating it is a 204 that adds no second audit row.</li>
 * </ul>
 *
 * <p>Transport note: {@code PATCH} cannot go through the JDK {@code HttpURLConnection} factory that
 * backs this base class's {@code RestTemplate} ({@code ProtocolException: Invalid HTTP method:
 * PATCH}), so every call here uses one small JDK {@code HttpClient} probe. It also returns 401
 * problem bodies that {@code HttpURLConnection} drops, which is why the 401 assertion can read a
 * status only — the contract's 401 is the generic {@code Problem} reference, produced by the
 * security entry point before any controller runs.</p>
 */
class InstanceAgentPrincipalControllerIntegrationTest extends AbstractReusableIntegrationTest {

    private static final String INSTANCE_PRINCIPALS = "/api/v1/instance/agent-principals";

    @Autowired private AuthzContext authzContext;
    @Autowired private RequesterAuthority requesterAuthority;
    @Autowired private AccessRoleRepository roleRepository;
    @Autowired private AccessRoleBindingRepository bindingRepository;
    @Autowired private AgentPrincipalRepository principalRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private UserRepository userRepository;
    @Autowired private AuditLogRepository auditLogRepository;
    @Autowired private RoleGrantMaterializer roleMaterializer;
    @Autowired private PlatformTransactionManager transactionManager;
    @Autowired private ObjectMapper objectMapper;

    private final List<UUID> principalIds = new ArrayList<>();
    private final List<UUID> userIds = new ArrayList<>();
    private final Map<UUID, String> tokens = new HashMap<>();

    @AfterEach
    void cleanFixtures() {
        // Explicit ids only: a blanket "delete every principal" would also remove seeded rows and
        // hide a real leak in the exact-id assertions. The deletes run inside one transaction because
        // a repository delete outside a transaction cannot process entity removal at all.
        new TransactionTemplate(transactionManager).executeWithoutResult(status -> {
            for (UUID principalId : principalIds) {
                bindingRepository.deleteBySubject(GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId);
                grantRepository.deleteBySubjectTypeAndSubjectId(
                        GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId);
                principalRepository.findById(principalId).ifPresent(principalRepository::delete);
            }
            for (UUID userId : userIds) {
                grantRepository.deleteBySubjectTypeAndSubjectId("user", userId);
                bindingRepository.deleteBySubject("user", userId);
                auditLogRepository.deleteAll(
                        auditLogRepository.findByUserIdOrderByCreatedAtDesc(userId.toString()));
                userRepository.deleteById(userId);
            }
        });
        principalIds.clear();
        userIds.clear();
        tokens.clear();
    }

    @Test
    void listIsOpenToEveryAuthenticatedCallerAndReturnsTheSameRowsForBoth() {
        UUID adminId = registerInstanceAdmin();
        String adminToken = tokenOf(adminId);
        UUID createdId = createPrincipal(adminToken, "listagent");

        // 401: the read face still needs authentication (the JWT filter answers, not the controller).
        HttpProbe anonymous = probe(null, "GET", INSTANCE_PRINCIPALS, null);
        assertEquals(401, anonymous.status(),
                "the instance read face is authenticated-only: " + anonymous.body());

        String plainToken = registerPlainUser();
        HttpProbe plain = probe(plainToken, "GET", INSTANCE_PRINCIPALS, null);
        assertEquals(200, plain.status(),
                "a caller without any role must still read the instance list: " + plain.body());
        HttpProbe admin = probe(adminToken, "GET", INSTANCE_PRINCIPALS, null);
        assertEquals(200, admin.status(), admin.body());

        Set<String> plainIds = principalIds(parse(plain.body()).path("principals"));
        Set<String> adminIds = principalIds(parse(admin.body()).path("principals"));
        assertEquals(adminIds, plainIds,
                "the list must NOT be caller-scoped: a non-writer sees exactly what an admin sees");
        assertTrue(plainIds.contains(createdId.toString()),
                "the created instance agent must be listed: " + plain.body());
        assertEquals("no-store", plain.cacheControl());

        JsonNode row = find(parse(plain.body()).path("principals"), createdId.toString());
        assertNotNull(row, "the created row must be a list member");
        assertTrue(row.path("ownerUserId").isNull(),
                "an instance platform agent carries a null ownerUserId (present-but-null, D-1009)");
        assertTrue(row.path("disabledAt").isNull());
    }

    @Test
    void createNeedsInstanceAdminAndWritesAnUnownedRow() {
        UUID adminId = registerInstanceAdmin();
        String adminToken = tokenOf(adminId);
        String plainToken = registerPlainUser();

        // 403: an authenticated caller without cap:instance:admin + MANAGE_AGENT_PRINCIPALS.
        HttpProbe denied = probe(plainToken, "POST", INSTANCE_PRINCIPALS, Map.of("name", "noadminagent"));
        assertEquals(403, denied.status(), "the write face needs the instance atoms: " + denied.body());
        assertEquals("FORBIDDEN", problemCode(denied));

        // 400: additionalProperties:false — an ownership member is not accepted (there is no owner
        // column to address, and D-1009 forbids promote/import).
        HttpProbe owned = probe(adminToken, "POST", INSTANCE_PRINCIPALS,
                Map.of("name", "ownedagent", "ownerType", "INSTANCE"));
        assertEquals(400, owned.status(), owned.body());
        assertEquals("INVALID_REQUEST", problemCode(owned));

        // 400 with the dedicated code (never the generic one) — the name-shape ruling still applies.
        HttpProbe badName = probe(adminToken, "POST", INSTANCE_PRINCIPALS, Map.of("name", "1badname"));
        assertEquals(400, badName.status(), badName.body());
        assertEquals("INVALID_NAME_FORMAT", problemCode(badName));

        HttpProbe created = probe(adminToken, "POST", INSTANCE_PRINCIPALS,
                Map.of("name", "instancecreateagent"));
        assertEquals(201, created.status(), created.body());
        JsonNode view = parse(created.body());
        UUID principalId = UUID.fromString(view.path("principalId").asText());
        principalIds.add(principalId);
        assertTrue(view.path("ownerUserId").isNull(),
                "create never writes an owner (the instance owns the row, not a user)");
        assertTrue(view.path("roleIds").isArray(), "the written role bindings are echoed");
        assertFalse(created.body().contains("\"disabledAt\""),
                "a fresh principal is active, and the create view does not carry disabledAt");

        AgentPrincipal row = principalRepository.findById(principalId).orElseThrow();
        assertNull(row.getOwnerUserId(), "the row must be owner-less");
        assertEquals(adminId.toString(), row.getCreatedByUserId(),
                "the creator column records who did it (visibility, not authorization)");
        assertEquals(AgentPrincipal.ORIGIN_USER, row.getOrigin());
        assertNull(row.getDisabledAt());
    }

    @Test
    void patchKeepsTheDocumentSemanticsAndNeverRaisesWorkspaceContextRequired() {
        UUID adminId = registerInstanceAdmin();
        String adminToken = tokenOf(adminId);
        UUID principalId = createPrincipal(adminToken, "patchagent");
        String plainToken = registerPlainUser();

        HttpProbe denied = probe(plainToken, "PATCH", INSTANCE_PRINCIPALS + "/" + principalId,
                Map.of("contextPolicy", Map.of("memory", Map.of("enabled", false))));
        assertEquals(403, denied.status(), denied.body());
        assertEquals("FORBIDDEN", problemCode(denied));

        // An explicit null clears the document, so the body is a real one-key map with a null value
        // (Map.of refuses nulls, hence the HashMap).
        Map<String, Object> clearHooks = new HashMap<>();
        clearHooks.put("hooks", null);
        HttpProbe missing = probe(adminToken, "PATCH", INSTANCE_PRINCIPALS + "/" + UUID.randomUUID(),
                clearHooks);
        assertEquals(404, missing.status(), missing.body());
        assertEquals("AGENT_PRINCIPAL_NOT_FOUND", problemCode(missing));

        HttpProbe unknownKey = probe(adminToken, "PATCH", INSTANCE_PRINCIPALS + "/" + principalId,
                Map.of("scope", "INSTANCE"));
        assertEquals(400, unknownKey.status(), unknownKey.body());
        assertEquals("INVALID_REQUEST", problemCode(unknownKey));

        // The load-bearing case: this row is "workspace-scoped" under the D-196 predicate
        // (owner_user_id null + origin USER), so the user surface would answer 409
        // WORKSPACE_CONTEXT_REQUIRED. The instance prefix carries no workspace context and the
        // contract says that code is never raised here ⇒ 200, and the persisted document is echoed.
        HttpProbe patched = probe(adminToken, "PATCH", INSTANCE_PRINCIPALS + "/" + principalId,
                Map.of("contextPolicy", Map.of("memory", Map.of("enabled", true))));
        assertEquals(200, patched.status(), patched.body());
        JsonNode body = parse(patched.body());
        assertEquals(principalId.toString(), body.path("principalId").asText());
        assertTrue(body.path("contextPolicy").path("memory").path("enabled").asBoolean(),
                "the response echoes the persisted document, not the raw input: " + patched.body());
        assertTrue(body.path("hooks").isNull(),
                "an untouched document reports its stored value (null), not a stale one");
        assertTrue(principalRepository.findById(principalId).orElseThrow()
                .getContextPolicy().path("memory").path("enabled").asBoolean(),
                "the column really changed");
    }

    @Test
    void deleteRetiresTheRowInsteadOfRemovingIt() {
        UUID adminId = registerInstanceAdmin();
        String adminToken = tokenOf(adminId);
        UUID principalId = createPrincipal(adminToken, "retireagent");
        String plainToken = registerPlainUser();

        HttpProbe denied = probe(plainToken, "DELETE", INSTANCE_PRINCIPALS + "/" + principalId, null);
        assertEquals(403, denied.status(), "retire is a write and needs the instance atoms: "
                + denied.body());
        assertEquals("FORBIDDEN", problemCode(denied));

        HttpProbe missing = probe(adminToken, "DELETE", INSTANCE_PRINCIPALS + "/" + UUID.randomUUID(),
                null);
        assertEquals(404, missing.status(), missing.body());
        assertEquals("AGENT_PRINCIPAL_NOT_FOUND", problemCode(missing));

        HttpProbe retired = probe(adminToken, "DELETE", INSTANCE_PRINCIPALS + "/" + principalId, null);
        assertEquals(204, retired.status(), retired.body());

        AgentPrincipal row = principalRepository.findById(principalId).orElseThrow(
                () -> new AssertionError("DELETE must retire, never hard-delete: the row is gone"));
        assertNotNull(row.getDisabledAt(), "retire sets disabledAt (the terminal lifecycle state)");
        assertEquals(adminId.toString(), row.getCreatedByUserId(), "the row identity is unchanged");

        // Idempotent by contract: the second call is still 204 and adds no second audit row.
        HttpProbe again = probe(adminToken, "DELETE", INSTANCE_PRINCIPALS + "/" + principalId, null);
        assertEquals(204, again.status(), again.body());
        assertEquals(1, disabledAuditRows(adminId, principalId),
                "exactly one agent_principal_disabled audit row (retire is idempotent)");

        // And the retired row is still visible (retirement is a state, not a removal).
        HttpProbe listed = probe(adminToken, "GET", INSTANCE_PRINCIPALS, null);
        JsonNode listedRow = find(parse(listed.body()).path("principals"), principalId.toString());
        assertNotNull(listedRow, "a retired principal is still an installed row");
        assertFalse(listedRow.path("disabledAt").isNull());
    }

    // --- task-413: the model-intent triple rides the same PATCH (G1 edit half) ----------------

    @Test
    void patchWritesTheModelIntentTripleAndAuditsIt() {
        UUID adminId = registerInstanceAdmin();
        String adminToken = tokenOf(adminId);
        UUID principalId = createPrincipal(adminToken, "modelagent");

        HttpProbe patched = probe(adminToken, "PATCH", INSTANCE_PRINCIPALS + "/" + principalId,
                Map.of("defaultModelProvider", "openai", "defaultModelName", "gpt-4o",
                        "allowedModels", List.of(Map.of("provider", "openai", "model", "gpt-4o"))));
        assertEquals(200, patched.status(), patched.body());
        JsonNode body = parse(patched.body());
        assertEquals("openai", body.path("defaultModelProvider").asText(), "the echo is the stored value");
        assertEquals("gpt-4o", body.path("defaultModelName").asText());
        assertEquals(1, body.path("allowedModels").size(), "the allow-list is echoed too");
        AgentPrincipal row = principalRepository.findById(principalId).orElseThrow();
        assertEquals("openai", row.getDefaultModelProvider(), "the column really changed");
        assertEquals("gpt-4o", row.getDefaultModelName(), "the column really changed");
        assertNotNull(row.getAllowedModels(), "the allow-list column really changed");
        assertEquals(1, modelIntentAuditRows(adminId, principalId),
                "the write lands one agent_principal_model_intent_updated audit row");
    }

    @Test
    void patchMergesOneModelHalfAndKeepsTheStoredOther() {
        UUID adminId = registerInstanceAdmin();
        String adminToken = tokenOf(adminId);
        UUID principalId = createPrincipal(adminToken, "mergeagent");
        assertEquals(200, probe(adminToken, "PATCH", INSTANCE_PRINCIPALS + "/" + principalId,
                Map.of("defaultModelProvider", "openai", "defaultModelName", "gpt-4o")).status());

        // Only the model half is named: the provider half must survive (merge-then-validate).
        HttpProbe merged = probe(adminToken, "PATCH", INSTANCE_PRINCIPALS + "/" + principalId,
                Map.of("defaultModelName", "gpt-4o-mini"));
        assertEquals(200, merged.status(), merged.body());
        JsonNode body = parse(merged.body());
        assertEquals("openai", body.path("defaultModelProvider").asText(),
                "an absent key keeps the stored half, it does not clear it");
        assertEquals("gpt-4o-mini", body.path("defaultModelName").asText());
        AgentPrincipal row = principalRepository.findById(principalId).orElseThrow();
        assertEquals("openai", row.getDefaultModelProvider());
        assertEquals("gpt-4o-mini", row.getDefaultModelName());
    }

    @Test
    void patchClearsTheModelIntentWithExplicitNulls() {
        UUID adminId = registerInstanceAdmin();
        String adminToken = tokenOf(adminId);
        UUID principalId = createPrincipal(adminToken, "clearagent");
        assertEquals(200, probe(adminToken, "PATCH", INSTANCE_PRINCIPALS + "/" + principalId,
                Map.of("defaultModelProvider", "openai", "defaultModelName", "gpt-4o",
                        "allowedModels", List.of(Map.of("provider", "openai", "model", "gpt-4o")))).status());

        Map<String, Object> clear = new HashMap<>();
        clear.put("defaultModelProvider", null);
        clear.put("defaultModelName", null);
        clear.put("allowedModels", null);
        HttpProbe cleared = probe(adminToken, "PATCH", INSTANCE_PRINCIPALS + "/" + principalId, clear);
        assertEquals(200, cleared.status(), cleared.body());
        JsonNode body = parse(cleared.body());
        assertTrue(body.path("defaultModelProvider").isNull(), "null clears the provider column");
        assertTrue(body.path("defaultModelName").isNull(), "null clears the model column");
        assertTrue(body.path("allowedModels").isNull(), "null clears the allow-list");
        AgentPrincipal row = principalRepository.findById(principalId).orElseThrow();
        assertNull(row.getDefaultModelProvider());
        assertNull(row.getDefaultModelName());
        assertNull(row.getAllowedModels());
    }

    @Test
    void patchRejectsAHalfFilledMergedModelIntent() {
        UUID adminId = registerInstanceAdmin();
        String adminToken = tokenOf(adminId);
        UUID principalId = createPrincipal(adminToken, "halfagent");
        assertEquals(200, probe(adminToken, "PATCH", INSTANCE_PRINCIPALS + "/" + principalId,
                Map.of("defaultModelProvider", "openai", "defaultModelName", "gpt-4o")).status());

        // Clearing one half alone leaves a half-filled intent — the same rule create enforces.
        Map<String, Object> half = new HashMap<>();
        half.put("defaultModelProvider", null);
        HttpProbe refused = probe(adminToken, "PATCH", INSTANCE_PRINCIPALS + "/" + principalId, half);
        assertEquals(400, refused.status(), refused.body());
        assertEquals("INVALID_AGENT_PRINCIPAL", problemCode(refused));
        AgentPrincipal row = principalRepository.findById(principalId).orElseThrow();
        assertEquals("openai", row.getDefaultModelProvider(), "a refused write changes nothing");
        assertEquals("gpt-4o", row.getDefaultModelName());
    }

    @Test
    void patchRejectsMalformedAllowedModels() {
        UUID adminId = registerInstanceAdmin();
        String adminToken = tokenOf(adminId);
        UUID principalId = createPrincipal(adminToken, "listagent");

        HttpProbe missingHalf = probe(adminToken, "PATCH", INSTANCE_PRINCIPALS + "/" + principalId,
                Map.of("allowedModels", List.of(Map.of("provider", "openai"))));
        assertEquals(400, missingHalf.status(), missingHalf.body());
        assertEquals("INVALID_AGENT_PRINCIPAL", problemCode(missingHalf));

        HttpProbe notAnArray = probe(adminToken, "PATCH", INSTANCE_PRINCIPALS + "/" + principalId,
                Map.of("allowedModels", "openai/gpt-4o"));
        assertEquals(400, notAnArray.status(), notAnArray.body());
        assertEquals("INVALID_AGENT_PRINCIPAL", problemCode(notAnArray));
        assertNull(principalRepository.findById(principalId).orElseThrow().getAllowedModels());
    }

    @Test
    void patchStillRefusesUnknownKeysAndAnEmptyBody() {
        UUID adminId = registerInstanceAdmin();
        String adminToken = tokenOf(adminId);
        UUID principalId = createPrincipal(adminToken, "shapeagent");

        HttpProbe unknown = probe(adminToken, "PATCH", INSTANCE_PRINCIPALS + "/" + principalId,
                Map.of("defaultModel", "gpt-4o"));
        assertEquals(400, unknown.status(), unknown.body());
        assertEquals("INVALID_REQUEST", problemCode(unknown));

        HttpProbe wrongType = probe(adminToken, "PATCH", INSTANCE_PRINCIPALS + "/" + principalId,
                Map.of("defaultModelName", 42));
        assertEquals(400, wrongType.status(), wrongType.body());
        assertEquals("INVALID_REQUEST", problemCode(wrongType));

        HttpProbe empty = probe(adminToken, "PATCH", INSTANCE_PRINCIPALS + "/" + principalId, Map.of());
        assertEquals(400, empty.status(), empty.body());
        assertEquals("INVALID_REQUEST", problemCode(empty));
    }

    @Test
    void patchModelIntentNeedsTheSameInstanceAtoms() {
        UUID adminId = registerInstanceAdmin();
        UUID principalId = createPrincipal(tokenOf(adminId), "gateagent");
        String plainToken = registerPlainUser();

        HttpProbe denied = probe(plainToken, "PATCH", INSTANCE_PRINCIPALS + "/" + principalId,
                Map.of("defaultModelProvider", "openai", "defaultModelName", "gpt-4o"));
        assertEquals(403, denied.status(), "model intent is a write, not a new privilege: " + denied.body());
        assertEquals("FORBIDDEN", problemCode(denied));
        AgentPrincipal row = principalRepository.findById(principalId).orElseThrow();
        assertNull(row.getDefaultModelProvider(), "the refused write left the row alone");
    }

    @Test
    void presetGuardRefusesModelIntentEdits() {
        UUID adminId = registerInstanceAdmin();
        String adminToken = tokenOf(adminId);
        UUID principalId = createPrincipal(adminToken, "guardagent");
        // Fixture: mark the row a preset guard (the builtin-preset create path sets the same origin).
        // V95:32-34 requires preset_id NOT NULL whenever origin=SYSTEM_PRESET, so both columns move
        // together — setting the origin alone is a DataIntegrityViolation, not a guard.
        AgentPrincipal row = principalRepository.findById(principalId).orElseThrow();
        row.setOrigin(AgentPrincipal.ORIGIN_SYSTEM_PRESET);
        row.setPresetId("fixture-guard-preset");
        principalRepository.saveAndFlush(row);

        HttpProbe refused = probe(adminToken, "PATCH", INSTANCE_PRINCIPALS + "/" + principalId,
                Map.of("defaultModelProvider", "openai", "defaultModelName", "gpt-4o"));
        assertEquals(403, refused.status(), refused.body());
        assertEquals("GUARD_MODEL_INTENT_IMMUTABLE", problemCode(refused),
                "its own code, not a sibling's (D25-14: the refusals say different things)");
        assertNull(principalRepository.findById(principalId).orElseThrow().getDefaultModelProvider());
    }

    @Test
    void theUserSurfaceAcceptsTheSameModelIntentKeys() {
        UUID adminId = registerInstanceAdmin();
        String adminToken = tokenOf(adminId);
        UUID principalId = createPrincipal(adminToken, "widthagent");

        // Width pin (task-413): the wire-body gate is SHARED, so the user surface accepts the keys too.
        // This row is workspace-scoped under the D-196 predicate (owner null + origin USER), so that
        // surface answers 409 for the missing context — the point is that it is NOT a 400 shape refusal.
        HttpProbe shared = probe(adminToken, "PATCH", "/api/v1/agent-principals/" + principalId,
                Map.of("defaultModelProvider", "openai", "defaultModelName", "gpt-4o"));
        assertEquals(409, shared.status(), shared.body());
        assertEquals("WORKSPACE_CONTEXT_REQUIRED", problemCode(shared));
    }

    // --- fixtures ---------------------------------------------------------------------------

    private String tokenOf(UUID userId) {
        return tokens.get(userId);
    }

    /** Registers a user over HTTP (real token) and binds ADMIN at instance scope. */
    private UUID registerInstanceAdmin() {
        UUID userId = registerUserViaHttp();
        AccessRole adminRole = roleRepository.findByName(SystemAccessRoleCatalog.ADMIN).orElseThrow();
        AccessRoleBinding binding = new AccessRoleBinding(adminRole.getId(),
                AuthzContext.SUBJECT_USER, userId, AccessScope.INSTANCE, null, userId);
        bindingRepository.saveAndFlush(binding);
        // A role binding is not an atom until it is materialized into grants (the app does this in
        // BindingAdminService; the fixture does it directly) — without it the assertions below would
        // fail and every negative case would be green for the wrong reason.
        roleMaterializer.materializeSubject(AuthzContext.SUBJECT_USER, userId, userId, null);
        authzContext.invalidate(userId);
        assertTrue(authzContext.isInstanceAdmin(userId),
                "fixture must really hold cap:instance:admin, otherwise the positive cases prove nothing");
        assertTrue(requesterAuthority.holdsActionAtom(userId,
                ToolFaceRegistry.ACTION_MANAGE_AGENT_PRINCIPALS, null),
                "fixture must really hold the instance-tier atom the write gate names");
        return userId;
    }

    private String registerPlainUser() {
        return tokens.get(registerUserViaHttp());
    }

    private UUID registerUserViaHttp() {
        String suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 10);
        // Short local part (the @Email validator enforces the RFC local-part cap) and an explicit
        // username in the shared NameFormat shape, so registration cannot fail for fixture reasons.
        String email = "instprin-" + suffix + "@test.com";
        HttpProbe response = probe(null, "POST", "/api/v1/auth/register", Map.of(
                "email", email,
                "password", TestDataFactory.PASSWORD,
                "name", "Instance Principal API",
                "username", "instprin" + suffix));
        assertEquals(201, response.status(), response.body());
        User user = userRepository.findByEmail(email).orElseThrow();
        userIds.add(user.getId());
        tokens.put(user.getId(), parse(response.body()).path("accessToken").asText());
        return user.getId();
    }

    private UUID createPrincipal(String adminToken, String name) {
        // The name format is letters/digits/CJK only, so the uniqueness suffix must not be a
        // hyphenated uuid.
        HttpProbe created = probe(adminToken, "POST", INSTANCE_PRINCIPALS,
                Map.of("name", name + UUID.randomUUID().toString().replace("-", "").substring(0, 6)));
        assertEquals(201, created.status(), created.body());
        UUID principalId = UUID.fromString(parse(created.body()).path("principalId").asText());
        principalIds.add(principalId);
        return principalId;
    }

    private HttpProbe probe(String token, String method, String path, Map<String, Object> body) {
        HttpRequest.Builder builder = HttpRequest
                .newBuilder(URI.create(baseUrl + path))
                .header("Content-Type", "application/json");
        if (token != null) {
            builder.header("Authorization", "Bearer " + token);
        }
        try {
            String payload = body == null ? "" : objectMapper.writeValueAsString(body);
            HttpRequest request = builder.method(method, body == null
                    ? HttpRequest.BodyPublishers.noBody()
                    : HttpRequest.BodyPublishers.ofString(payload)).build();
            HttpResponse<String> response = HttpClient.newHttpClient()
                    .send(request, HttpResponse.BodyHandlers.ofString());
            return new HttpProbe(response.statusCode(), response.body(),
                    response.headers().firstValue("cache-control").orElse(null));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AssertionError(e);
        } catch (java.io.IOException e) {
            throw new AssertionError(e);
        }
    }

    private record HttpProbe(int status, String body, String cacheControl) {}

    private JsonNode parse(String json) {
        try {
            return objectMapper.readTree(json);
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new AssertionError(e);
        }
    }

    private String problemCode(HttpProbe response) {
        return parse(response.body()).path("code").asText("");
    }

    private static Set<String> principalIds(JsonNode array) {
        Set<String> values = new HashSet<>();
        array.forEach(item -> values.add(item.path("principalId").asText()));
        return values;
    }

    private static JsonNode find(JsonNode array, String principalId) {
        for (JsonNode item : array) {
            if (principalId.equals(item.path("principalId").asText())) {
                return item;
            }
        }
        return null;
    }

    /** task-413: the model-intent write's durable audit action. */
    private int modelIntentAuditRows(UUID actorId, UUID principalId) {
        int count = 0;
        for (AuditLog log : auditLogRepository.findByUserIdOrderByCreatedAtDesc(actorId.toString())) {
            if ("agent_principal_model_intent_updated".equals(log.getAction())
                    && principalId.toString().equals(log.getResourceId())) {
                count++;
            }
        }
        return count;
    }

    private int disabledAuditRows(UUID actorId, UUID principalId) {
        int count = 0;
        for (AuditLog log : auditLogRepository.findByUserIdOrderByCreatedAtDesc(actorId.toString())) {
            if ("agent_principal_disabled".equals(log.getAction())
                    && principalId.toString().equals(log.getResourceId())) {
                count++;
            }
        }
        return count;
    }
}
