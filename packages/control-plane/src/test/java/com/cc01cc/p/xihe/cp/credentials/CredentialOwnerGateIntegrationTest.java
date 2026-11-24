package com.cc01cc.p.xihe.cp.credentials;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.GrantPreset;
import com.cc01cc.p.xihe.cp.entity.GrantPresetBinding;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.Credential;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.policy.AccessScope;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.policy.GrantPrincipalPathResolver;
import com.cc01cc.p.xihe.cp.policy.SystemGrantPresetCatalog;
import com.cc01cc.p.xihe.cp.repository.GrantPresetBindingRepository;
import com.cc01cc.p.xihe.cp.repository.GrantPresetRepository;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuditLogRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.CredentialRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * DSD-1519 (task-142): every credential face answers "may I?" with the management atom AND the
 * ownership gate. These cases pin the four read faces against a row that exists and belongs to
 * somebody else, which is the shape the detail page hit (one face 200, the next 403), plus the
 * positive branch, the missing row and the no-admin-bypass rule.
 */
class CredentialOwnerGateIntegrationTest extends AbstractReusableIntegrationTest {

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private CredentialRepository credentialRepository;
    @Autowired private AuditLogRepository auditLogRepository;
    @Autowired private AgentPrincipalRepository agentPrincipalRepository;
    @Autowired private WorkspaceAgentRepository workspaceAgentRepository;
    @Autowired private AgentPrincipalService agentPrincipalService;
    @Autowired private CredentialService credentialService;
    @Autowired private AuthzContext authzContext;
    @Autowired private GrantPresetRepository roleRepository;
    @Autowired private GrantPresetBindingRepository bindingRepository;
    @Autowired private ObjectMapper objectMapper;

    private final List<Actor> actors = new ArrayList<>();
    private final List<UUID> principalIds = new ArrayList<>();
    private final List<UUID> credentialIds = new ArrayList<>();
    private final List<UUID> accessBindingIds = new ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        principalIds.forEach(principalId -> {
            workspaceAgentRepository.deleteAll(workspaceAgentRepository.findByIdPrincipalId(principalId));
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                    GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId));
            agentPrincipalRepository.deleteById(principalId);
        });
        principalIds.clear();
        credentialIds.forEach(id -> credentialRepository.findById(id)
                .ifPresent(row -> credentialRepository.deleteById(row.getId())));
        credentialIds.clear();
        accessBindingIds.forEach(bindingRepository::deleteById);
        accessBindingIds.clear();
        actors.forEach(actor -> {
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("user", actor.id()));
            auditLogRepository.deleteAll(
                    auditLogRepository.findByUserIdOrderByCreatedAtDesc(actor.id().toString()));
            UUID workspaceUuid = UUID.fromString(actor.workspaceId());
            workspaceFixture.unbindWorkspace(workspaceUuid);
            workspaceRepository.deleteById(workspaceUuid);
            userRepository.deleteById(actor.id());
        });
        actors.clear();
    }

    /** T1: references — the atom alone used to answer 200 for a foreign row. */
    @Test
    void referencesRefusesAForeignUserRowEvenWhenTheManageAtomIsHeld() {
        Actor owner = registerActor("owner");
        Actor attacker = registerActor("attacker");
        String credentialId = createUserCredential(owner, "references");
        grantAtom(attacker.id(), manageAtom(credentialId));

        ResponseEntity<String> foreign = exchange(attacker.token(), HttpMethod.GET,
                "/api/v1/credentials/" + credentialId + "/references", null);

        assertEquals(HttpStatus.FORBIDDEN, foreign.getStatusCode(),
                "a row that belongs to another USER must be refused by the ownership gate");
        assertEquals("FORBIDDEN", problemCode(foreign));
        assertFalse(foreign.getBody().contains(owner.id().toString()),
                "the refusal must not carry the owner id");
    }

    /** T2: events — ownership-only before, now the same AND as references. */
    @Test
    void eventsRefusesAForeignUserRow() {
        Actor owner = registerActor("owner");
        Actor attacker = registerActor("attacker");
        String credentialId = createUserCredential(owner, "events");
        grantAtom(attacker.id(), manageAtom(credentialId));

        ResponseEntity<String> foreign = exchange(attacker.token(), HttpMethod.GET,
                "/api/v1/credentials/" + credentialId + "/events", null);

        assertEquals(HttpStatus.FORBIDDEN, foreign.getStatusCode());
        assertEquals("FORBIDDEN", problemCode(foreign));
    }

    /** T3: reveal — before the change the atom alone released a foreign plaintext. */
    @Test
    void revealRefusesAForeignUserRowAndNeverLeaksTheSecret() {
        Actor owner = registerActor("owner");
        Actor attacker = registerActor("attacker");
        String secret = "foreign-reveal-secret-0123456789";
        String credentialId = createUserCredential(owner, "reveal", Credential.TIER_REVEAL, secret);
        grantAtom(attacker.id(), "{\"actionClass\":\"credential_reveal\",\"resource\":\"credential:"
                + credentialId + "\"}");

        ResponseEntity<String> foreign = exchange(attacker.token(), HttpMethod.POST,
                "/api/v1/credentials/" + credentialId + "/reveal",
                Map.of("password", TestDataFactory.PASSWORD));

        assertEquals(HttpStatus.FORBIDDEN, foreign.getStatusCode(),
                "the ownership gate must answer before the step-up path ever decrypts");
        assertEquals("FORBIDDEN", problemCode(foreign));
        assertFalse(foreign.getBody().contains(secret), "a refused reveal must not carry the plaintext");
    }

    /** T4: bindings — 422 before (existence fence), 403 now (ownership gate). */
    @Test
    void bindingsRefusesAForeignUserRow() {
        Actor owner = registerActor("owner");
        Actor attacker = registerActor("attacker");
        String credentialId = createUserCredential(owner, "bindings");
        grantAtom(attacker.id(), manageAtom(credentialId));
        String principalId = createBoundPrincipal(attacker, "gateAgent");

        ResponseEntity<String> foreign = exchange(attacker.token(), HttpMethod.POST,
                "/api/v1/credentials/" + credentialId + "/bindings",
                Map.of("workspaceId", attacker.workspaceId(),
                        "agentPrincipalIds", List.of(principalId)));

        assertEquals(HttpStatus.FORBIDDEN, foreign.getStatusCode(),
                "existence and ownership must not be distinguishable through the status code");
        assertEquals("FORBIDDEN", problemCode(foreign));
    }

    /** T5: the owner without the atom is still refused — the gate is an AND. */
    @Test
    void theOwnerWithoutTheManageAtomIsRefusedOnReferences() {
        Actor owner = registerActor("owner");
        // Seeded straight through the service on purpose: the owner must hold NO atom, and the
        // HTTP create path grants credential_manage@credential:* as a precondition.
        String credentialId = seedUserCredential(owner, "no-atom");

        ResponseEntity<String> refused = exchange(owner.token(), HttpMethod.GET,
                "/api/v1/credentials/" + credentialId + "/references", null);

        assertEquals(HttpStatus.FORBIDDEN, refused.getStatusCode());
        assertTrue(refused.getBody().contains("credential_manage"),
                "the refusal must name the atom the caller lacks: " + refused.getBody());
    }

    /** T6: the positive branch — owner plus atom reads both blocks. */
    @Test
    void theOwnerHoldingTheManageAtomReadsReferencesAndEvents() {
        Actor owner = registerActor("owner");
        String credentialId = createUserCredential(owner, "positive");
        grantAtom(owner.id(), manageAtom(credentialId));

        ResponseEntity<String> references = exchange(owner.token(), HttpMethod.GET,
                "/api/v1/credentials/" + credentialId + "/references", null);
        ResponseEntity<String> events = exchange(owner.token(), HttpMethod.GET,
                "/api/v1/credentials/" + credentialId + "/events", null);

        assertEquals(HttpStatus.OK, references.getStatusCode(), references.getBody());
        assertEquals(HttpStatus.OK, events.getStatusCode(), events.getBody());
        assertEquals("no-store", references.getHeaders().getFirst("Cache-Control"));
    }

    /** T7: the ownership gate keeps no admin bypass (DSD-1519). */
    @Test
    void theInstanceAdminHoldingTheManageAtomStillCannotReadAForeignUserRow() {
        Actor owner = registerActor("owner");
        Actor admin = registerActor("admin");
        String credentialId = createUserCredential(owner, "admin-bypass");
        grantAtom(admin.id(), manageAtom(credentialId));
        grantInstanceAdmin(admin);

        ResponseEntity<String> foreign = exchange(admin.token(), HttpMethod.GET,
                "/api/v1/credentials/" + credentialId + "/references", null);

        assertEquals(HttpStatus.FORBIDDEN, foreign.getStatusCode(),
                "cap:instance:admin opens the INSTANCE branch only, never another USER row");
        assertEquals("FORBIDDEN", problemCode(foreign));
    }

    /** T8: a row that is gone answers 404 with the credential code, not a 200 empty list. */
    @Test
    void aMissingRowKeepsTheNotFoundAnswer() {
        Actor owner = registerActor("owner");
        grantAtom(owner.id(), "{\"actionClass\":\"credential_manage\",\"resource\":\"credential:*\"}");
        String missing = UUID.randomUUID().toString();

        ResponseEntity<String> response = exchange(owner.token(), HttpMethod.GET,
                "/api/v1/credentials/" + missing + "/references", null);

        assertEquals(HttpStatus.NOT_FOUND, response.getStatusCode());
        assertEquals("CREDENTIAL_NOT_FOUND", problemCode(response));
    }

    // ---- write faces (A, task-142 / DSD-1519 1) ------------------------------------------

    /**
     * W1: replace is destructive, so it carries both gates as well. The attacker holds the
     * concrete atom credential_manage@credential:&lt;id&gt; (not instance administration) — the refusal
     * below is therefore about ownership, never about a missing management right.
     */
    @Test
    void aForeignUserRowCannotBeReplacedEvenWhenTheManageAtomIsHeld() {
        Actor owner = registerActor("owner");
        Actor attacker = registerActor("attacker");
        String credentialId = createUserCredential(owner, "replace-target");
        grantAtom(attacker.id(), manageAtom(credentialId));

        ResponseEntity<String> response = exchange(attacker.token(), HttpMethod.POST,
                "/api/v1/credentials/" + credentialId + "/replace", Map.of("token", "attacker-secret"));

        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode(), String.valueOf(response.getBody()));
    }

    /**
     * W2: delete is destructive too — the same foreign row must stay undeleted. Again the attacker
     * holds credential_manage@credential:&lt;id&gt;, so the 403 is the ownership gate answering.
     */
    @Test
    void aForeignUserRowCannotBeDeletedEvenWhenTheManageAtomIsHeld() {
        Actor owner = registerActor("owner");
        Actor attacker = registerActor("attacker");
        String credentialId = createUserCredential(owner, "delete-target");
        grantAtom(attacker.id(), manageAtom(credentialId));

        ResponseEntity<String> refused = exchange(attacker.token(), HttpMethod.DELETE,
                "/api/v1/credentials/" + credentialId, null);
        ResponseEntity<String> stillThere = exchange(owner.token(), HttpMethod.GET,
                "/api/v1/credentials/" + credentialId + "/references", null);

        assertEquals(HttpStatus.FORBIDDEN, refused.getStatusCode());
        assertEquals(HttpStatus.OK, stillThere.getStatusCode(),
                "the refused delete must leave the row readable by its owner");
    }

    /** W3: the owner holding the atom still replaces and deletes its own row (no over-blocking). */
    @Test
    void theOwnerReplacesAndDeletesItsOwnRowWhenHoldingTheManageAtom() {
        Actor owner = registerActor("owner");
        String credentialId = createUserCredential(owner, "own-write");
        grantAtom(owner.id(), manageAtom(credentialId));

        ResponseEntity<String> replaced = exchange(owner.token(), HttpMethod.POST,
                "/api/v1/credentials/" + credentialId + "/replace", Map.of("token", "rotated-secret"));
        ResponseEntity<String> deleted = exchange(owner.token(), HttpMethod.DELETE,
                "/api/v1/credentials/" + credentialId, null);

        assertEquals(HttpStatus.OK, replaced.getStatusCode(), String.valueOf(replaced.getBody()));
        assertEquals(HttpStatus.OK, deleted.getStatusCode(), String.valueOf(deleted.getBody()));
    }

    /** W4: the INSTANCE branch stays open to the instance administrator. */
    @Test
    void theInstanceAdminReplacesAnInstanceRow() {
        Actor admin = registerActor("admin");
        grantInstanceAdmin(admin);
        Credential seeded = credentialService.create(new CredentialService.CreateRequest(
                Credential.OWNER_INSTANCE, null, "instance-write", Credential.KIND_TOKEN,
                Credential.TIER_LEASE, new CredentialService.SecretPayload("instance-secret", null, null)),
                admin.id().toString());
        credentialIds.add(seeded.getId());
        grantAtom(admin.id(), manageAtom(seeded.getId().toString()));

        ResponseEntity<String> replaced = exchange(admin.token(), HttpMethod.POST,
                "/api/v1/credentials/" + seeded.getId() + "/replace", Map.of("token", "rotated-instance"));

        assertEquals(HttpStatus.OK, replaced.getStatusCode(), String.valueOf(replaced.getBody()));
    }

    /**
     * W5 (anti-existence-oracle): on the write faces the atom gate answers before the row is even
     * looked up, so a caller holding NO atom gets one and the same answer whether the id names a
     * foreign row or nothing at all. If a later refactor moves the ownership gate first, this case
     * turns 403-vs-404 and the ordering regression becomes visible.
     */
    @Test
    void aCallerWithoutTheAtomGetsTheSameAnswerForAForeignRowAndAMissingRowOnWriteFaces() {
        Actor owner = registerActor("owner");
        Actor stranger = registerActor("stranger");
        String foreignRow = createUserCredential(owner, "probe-target");
        String missingRow = UUID.randomUUID().toString();

        ResponseEntity<String> foreignReplace = exchange(stranger.token(), HttpMethod.POST,
                "/api/v1/credentials/" + foreignRow + "/replace", Map.of("token", "probe-secret"));
        ResponseEntity<String> missingReplace = exchange(stranger.token(), HttpMethod.POST,
                "/api/v1/credentials/" + missingRow + "/replace", Map.of("token", "probe-secret"));
        ResponseEntity<String> foreignDelete = exchange(stranger.token(), HttpMethod.DELETE,
                "/api/v1/credentials/" + foreignRow, null);
        ResponseEntity<String> missingDelete = exchange(stranger.token(), HttpMethod.DELETE,
                "/api/v1/credentials/" + missingRow, null);

        assertEquals(foreignReplace.getStatusCode(), missingReplace.getStatusCode());
        assertEquals(foreignDelete.getStatusCode(), missingDelete.getStatusCode());
        assertEquals(HttpStatus.FORBIDDEN, foreignReplace.getStatusCode());
        assertEquals(HttpStatus.FORBIDDEN, foreignDelete.getStatusCode());
    }

    // ---- fixtures -------------------------------------------------------------------------

    private record Actor(UUID id, String token, String workspaceId) {}

    private Actor registerActor(String prefix) {
        String email = "cred-gate-" + prefix + "-" + UUID.randomUUID() + "@test.com";
        ResponseEntity<AuthResponse> response = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register",
                new RegisterRequest(email, TestDataFactory.PASSWORD, "Credential Gate"),
                AuthResponse.class);
        assertEquals(HttpStatus.CREATED, response.getStatusCode());
        assertNotNull(response.getBody());
        User user = userRepository.findByEmail(email).orElseThrow();
        String workspaceId = workspaceFixture
                .ensureOwnedWorkspace(user.getId(), "gate workspace " + prefix).getId().toString();
        Actor actor = new Actor(user.getId(), response.getBody().getAccessToken(), workspaceId);
        actors.add(actor);
        return actor;
    }

    private void grantInstanceAdmin(Actor actor) {
        GrantPreset adminRole = roleRepository.findByName(SystemGrantPresetCatalog.ADMIN).orElseThrow();
        GrantPresetBinding binding = new GrantPresetBinding(adminRole.getId(),
                AuthzContext.SUBJECT_USER, actor.id(), AccessScope.INSTANCE, null, actor.id());
        bindingRepository.saveAndFlush(binding);
        accessBindingIds.add(binding.getId());
        authzContext.invalidate(actor.id());
        assertTrue(authzContext.isInstanceAdmin(actor.id()),
                "fixture must really hold instance:admin, otherwise the negative case proves nothing");
    }

    private String createUserCredential(Actor owner, String label) {
        return createUserCredential(owner, label, Credential.TIER_LEASE, "gate-secret-" + label);
    }

    private String createUserCredential(Actor owner, String label, String tier, String secret) {
        grantAtom(owner.id(), "{\"actionClass\":\"credential_manage\",\"resource\":\"credential:*\"}");
        ResponseEntity<String> created = exchange(owner.token(), HttpMethod.POST, "/api/v1/credentials",
                Map.of("label", label, "kind", "token", "deliveryTier", tier, "token", secret));
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), created.getBody());
        UUID credentialId = UUID.fromString(parse(created.getBody()).path("id").asText());
        credentialIds.add(credentialId);
        return credentialId.toString();
    }

    private String createBoundPrincipal(Actor actor, String name) {
        grantAtom(actor.id(), "{\"actionClass\":\"MANAGE_WORKSPACE_AGENTS\"}");
        AgentPrincipal principal = agentPrincipalService.createPrincipal(actor.id().toString(), name, null,
                snapshot("[{\"actionClass\":\"read\"}]"));
        principalIds.add(principal.getId());
        agentPrincipalService.setWorkspaceCap(actor.id().toString(), UUID.fromString(actor.workspaceId()),
                principal.getId(), objectMapper.createArrayNode());
        return principal.getId().toString();
    }

    private String seedUserCredential(Actor owner, String label) {
        Credential created = credentialService.create(new CredentialService.CreateRequest(
                Credential.OWNER_USER, owner.id().toString(), label, Credential.KIND_TOKEN,
                Credential.TIER_LEASE, new CredentialService.SecretPayload("seed-secret-" + label, null, null)),
                owner.id().toString());
        credentialIds.add(created.getId());
        return created.getId().toString();
    }

    private String manageAtom(String credentialId) {
        return "{\"actionClass\":\"credential_manage\",\"resource\":\"credential:" + credentialId + "\"}";
    }

    private void grantAtom(UUID userId, String atomJson) {
        AuthorizationGrant direct = grantRepository.findBySubjectTypeAndSubjectId("user", userId).stream()
                .filter(grant -> "direct".equals(grant.getSource()))
                .findFirst()
                .orElse(null);
        JsonNode newAtoms = parse("[" + atomJson + "]");
        if (direct == null) {
            direct = new AuthorizationGrant();
            direct.setId(UUID.randomUUID());
            direct.setSubjectType("user");
            direct.setSubjectId(userId);
            direct.setGranterType("user");
            direct.setGranterId(userId);
            direct.setSource("assigned");
            direct.setPermissions(newAtoms);
            grantRepository.save(direct);
            return;
        }
        ArrayNode merged = objectMapper.createArrayNode();
        direct.getPermissions().forEach(merged::add);
        newAtoms.forEach(merged::add);
        direct.setPermissions(merged);
        grantRepository.save(direct);
    }

    private ResponseEntity<String> exchange(String token, HttpMethod method, String path,
            Map<String, Object> body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<?> entity = body == null ? new HttpEntity<>(headers) : new HttpEntity<>(body, headers);
        return restTemplate.exchange(baseUrl + path, method, entity, String.class);
    }

    private JsonNode snapshot(String permissionsJson) {
        var snapshot = objectMapper.createObjectNode();
        snapshot.put("systemPrompt", "cred-gateAgent");
        snapshot.set("permissions", parse(permissionsJson));
        return snapshot;
    }

    private JsonNode parse(String json) {
        try {
            return objectMapper.readTree(json);
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new AssertionError(e);
        }
    }

    private static String problemCode(ResponseEntity<String> response) {
        String body = response.getBody();
        if (body == null) {
            return "";
        }
        int at = body.indexOf("\"code\"");
        if (at < 0) {
            return "";
        }
        int start = body.indexOf(0x22, at + 6);
        int end = start < 0 ? -1 : body.indexOf(0x22, start + 1);
        return start < 0 || end < 0 ? "" : body.substring(start + 1, end);
    }
}
