package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.cc01cc.p.xihe.cp.service.ContextTemplateSourceService;
import com.cc01cc.p.xihe.cp.skill.SkillBindingRepository;
import com.cc01cc.p.xihe.cp.skill.Skill;
import com.cc01cc.p.xihe.cp.skill.SkillBinding;
import com.cc01cc.p.xihe.cp.skill.SkillCatalogSnapshotService;
import com.cc01cc.p.xihe.cp.skill.SkillCatalogSourceService;
import com.cc01cc.p.xihe.cp.skill.SkillRepository;
import com.cc01cc.p.xihe.cp.skill.SkillTokenEstimator;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

/**
 * PLAN-0628 M2a (D28-39): the Run's listing is frozen at admission and read back from the snapshot.
 *
 * <p>Why this test drives <b>real admission</b> ({@link ChatSubmissionService#create}) instead of
 * hand-writing a {@code chat_runs} row: the thing under test is "what the model will see for this
 * Run", and the only honest way to pin that is to create the Run the way production does — then
 * mutate the bindings underneath it and observe that the rendered block does not move. A hand-built
 * fixture row would let a broken freeze path (or a broken read path) pass unnoticed.</p>
 *
 * <p>Acceptance mapping: #2 (binding add/delete after admission ⇒ identical listing), #3 (a later Run
 * in the same Session does see the new binding), #4 (a continuation inherits the parent's frozen
 * listing), plus the D28-39 assertion that the live resolver is never called for a frozen Run, and
 * #5's "oversized listing is recorded, the Run still exists".</p>
 */
class SkillSnapshotFreezeIntegrationTest extends AbstractIntegrationTest {

    /** The component instanceId the fixture template gives its listing block. */
    private static final String COMPONENT_ID = "5f0d1f5e-1111-4111-8111-000000000001";

    @Autowired
    private ChatSubmissionService submissionService;

    @Autowired
    private ChatRunReadService chatRunReadService;

    @Autowired
    private ChatRunRepository chatRuns;

    @Autowired
    private SessionRepository sessions;

    @Autowired
    private UserRepository users;

    @Autowired
    private AgentPrincipalRepository principals;

    @Autowired
    private WorkspaceAgentRepository members;

    @Autowired
    private ProviderConnectionRepository connections;

    @Autowired
    private SkillRepository skills;

    @Autowired
    private SkillBindingRepository bindings;

    @Autowired
    private ApiRequestTemplateService templates;

    @Autowired
    private BranchPathService branchPathService;

    @Autowired
    private ContextTemplateSourceService contextSources;

    @Autowired
    private WorkspaceFixture workspaceFixture;

    @Autowired
    private ObjectMapper objectMapper;

    /**
     * Spies the real service rather than replacing it: the freeze itself must keep working, and the
     * assertion is about the <b>dispatch</b> path not calling the live resolver (D28-39).
     */
    @MockitoSpyBean
    private SkillCatalogSourceService skillCatalog;

    /** Mints the Run owner's access token so the read face is exercised over real HTTP (see below). */
    @Autowired
    private com.cc01cc.p.xihe.cp.config.JwtTokenProvider jwtTokenProvider;

    /** The class shares one cloned database, so seeded libraries are cleared between tests. */
    @BeforeEach
    void clearSeededLibraries() {
        bindings.deleteAll();
        skills.deleteAll();
    }

    /**
     * skill-wiring ruling 2026-11-04: the <b>production</b> shape is a template without a
     * {@code skill_catalog} component (the built-in api-request template carries only
     * {@code bodySource}), and the skill set always comes from {@code skill_bindings}. Before the fix
     * this Run froze {@code {}} — the binding was accepted by every layer and silently never reached
     * the model. The binding here is on the AGENT tier on purpose: it proves the snapshot is resolved
     * for the Session's main Agent principal ({@code session.getAgentPrincipalId()}), which is the
     * identity this milestone wires.
     */
    @Test
    void aBoundSkillIsFrozenEvenWhenTheTemplateCarriesNoListingComponent() {
        Fixture fixture = fixtureWithoutListingComponent("no-component");
        UUID alpha = insertSkill(fixture, "alpha", "desc of alpha");
        bindToPrincipal(fixture, alpha);
        String runId = submit(fixture, "no component message");

        JsonNode snapshot = chatRuns.findById(UUID.fromString(runId)).orElseThrow().getSkillsSnapshot();
        assertFalse(SkillCatalogSnapshotService.isAbsent(snapshot),
                "a bound skill must freeze a real listing, not the '{}' default: " + snapshot);
        assertEquals(SkillCatalogSnapshotService.VERSION, snapshot.path("version").asInt());
        assertEquals(SkillCatalogSourceService.STATUS_READY, snapshot.path("status").asText());
        assertEquals(SkillCatalogSnapshotService.SNAPSHOT_SOURCE_FROZEN,
                snapshot.path("snapshotSource").asText());
        assertEquals(SkillCatalogSourceService.DEFAULT_MAX_SKILLS, snapshot.path("maxSkills").asInt(),
                "no component means the frozen defaults, not 'no listing'");
        assertEquals(1, snapshot.path("items").size(), snapshot.toString());
        assertEquals("alpha", snapshot.path("items").get(0).path("name").asText());
        assertEquals(40, snapshot.path("maxSkills").asInt());
    }

    /**
     * The other half of the ruling: no binding must keep {@code {}} — the column must not start
     * claiming "a listing was captured" for every Run.
     */
    @Test
    void aRunWithoutBindingsStillCapturesNothing() {
        Fixture fixture = fixtureWithoutListingComponent("no-binding");
        String runId = submit(fixture, "nothing bound");

        JsonNode snapshot = chatRuns.findById(UUID.fromString(runId)).orElseThrow().getSkillsSnapshot();
        assertTrue(SkillCatalogSnapshotService.isAbsent(snapshot),
                "no binding means no capture: " + snapshot);
    }

    // ---------------------------------------------------------------------------------------------
    // D28-39: the snapshot is the read source
    // ---------------------------------------------------------------------------------------------

    @Test
    void admissionFreezesTheListingAndAResolveIsNeverConsultedAtRenderTime() {
        Fixture fixture = fixture("freeze");
        bind(fixture, insertSkill(fixture, "alpha", "desc of alpha"));
        String runId = submit(fixture, "freeze message");

        JsonNode snapshot = chatRuns.findById(UUID.fromString(runId)).orElseThrow().getSkillsSnapshot();
        assertEquals(SkillCatalogSnapshotService.VERSION, snapshot.path("version").asInt());
        assertEquals("ready", snapshot.path("status").asText());
        assertEquals(SkillCatalogSourceService.SOURCE, snapshot.path("source").asText());
        assertEquals(SkillCatalogSnapshotService.SNAPSHOT_SOURCE_FROZEN,
                snapshot.path("snapshotSource").asText());
        assertEquals(40, snapshot.path("maxSkills").asInt());
        assertTrue(snapshot.path("capturedAt").isTextual());
        assertEquals(1, snapshot.path("items").size());
        JsonNode item = snapshot.path("items").get(0);
        assertEquals("alpha", item.path("name").asText());
        assertTrue(item.path("qualifiedName").asText().startsWith("user:instance:instance:alpha"),
                item.path("qualifiedName").asText());
        assertEquals(64, item.path("contentHash").asText().length());
        assertFalse(item.has("body"), "D28-35: the snapshot records the listing, never the body");
        assertTrue(item.hasNonNull("skillId"));

        clearInvocations(skillCatalog);
        assertEquals(List.of("alpha — desc of alpha"), listingOf(runId, fixture));

        // D28-39: rendering a frozen Run must not touch the live resolver at all.
        verify(skillCatalog, never()).resolve(any());
        verify(skillCatalog, never()).resolveListing(any());
    }

    /**
     * Acceptance #2: the listing must be exactly what it was, after a binding was added and after a
     * different one was deleted. Asserting "the row did not change" would be far too weak.
     */
    @Test
    void bindingChangesAfterAdmissionCannotChangeTheRunsListing() {
        Fixture fixture = fixture("frozen-bytes");
        UUID alpha = insertSkill(fixture, "alpha", "desc of alpha");
        bind(fixture, alpha);
        String runId = submit(fixture, "frozen message");
        List<String> frozen = listingOf(runId, fixture);
        assertEquals(List.of("alpha — desc of alpha"), frozen);

        bind(fixture, insertSkill(fixture, "beta", "desc of beta"));

        assertEquals(frozen, listingOf(runId, fixture), "adding a binding must not change this Run");

        bindings.deleteAll(bindings.findAll().stream()
                .filter(binding -> binding.getSkillId().equals(alpha)).toList());
        // The live resolver really has lost that skill: the frozen Run is unaffected only because it
        // reads its own record rather than the bindings table.
        List<String> live = skillCatalog.resolve(SkillCatalogSourceService.Request.of(null,
                fixture.user().getId(), fixture.workspace().getId())).items();
        assertTrue(live.stream().noneMatch(line -> line.startsWith("alpha")), live.toString());
        assertEquals(frozen, listingOf(runId, fixture),
                "deleting the binding must not change this Run either — the snapshot is the read source");
    }

    /**
     * Acceptance #3: freezing is not a global freeze — a Run admitted <i>after</i> the new binding sees
     * it. This is the pair that shows "not effective for this Run" is a semantics, not a bug.
     */
    @Test
    void aBindingAddedAfterRunAIsAbsentFromAAndPresentInB() {
        Fixture fixture = fixture("two-runs");
        bind(fixture, insertSkill(fixture, "alpha", "desc of alpha"));
        String runA = submit(fixture, "run A");
        bind(fixture, insertSkill(fixture, "beta", "desc of beta"));

        assertEquals(List.of("alpha — desc of alpha"), listingOf(runA, fixture));

        terminalize(runA);
        String runB = submit(fixture, "run B");

        List<String> listingB = listingOf(runB, fixture);
        assertTrue(listingB.contains("beta — desc of beta"), listingB.toString());
        assertTrue(listingB.contains("alpha — desc of alpha"), listingB.toString());
    }

    /**
     * Acceptance #4: the continuation inherits the parent's snapshot, so a binding added while the
     * parent ran does not reach the child either. The child row is built through the same
     * {@code inherited(...)} transform the continuation service applies (that call itself is pinned in
     * {@code ChatRunContinuationServiceTest}).
     */
    @Test
    void aContinuationChildInheritsTheFrozenListingNotTheNewBindings() {
        Fixture fixture = fixture("continuation");
        bind(fixture, insertSkill(fixture, "alpha", "desc of alpha"));
        String runA = submit(fixture, "parent run");
        List<String> parentListing = listingOf(runA, fixture);

        bind(fixture, insertSkill(fixture, "beta", "desc of beta"));

        ChatRun parent = chatRuns.findById(UUID.fromString(runA)).orElseThrow();
        ChatRun child = new ChatRun(UUID.randomUUID().toString(), parent.getSessionId(),
                parent.getUserId(), parent.getWorkspaceId(), "child-key", "child-hash",
                parent.getProvider(), parent.getModel(), parent.getToolMode(), "accepted");
        child.setBranchId(parent.getBranchId());
        child.setContextTemplateSnapshot(parent.getContextTemplateSnapshot());
        child.setSkillsSnapshot(SkillCatalogSnapshotService.inherited(parent.getSkillsSnapshot()));
        chatRuns.saveAndFlush(child);

        assertEquals(SkillCatalogSnapshotService.SNAPSHOT_SOURCE_INHERITED,
                child.getSkillsSnapshot().path("snapshotSource").asText());
        assertEquals(parentListing, listingOf(child.getId().toString(), fixture),
                "the child must see exactly what its parent saw");
        assertFalse(listingOf(child.getId().toString(), fixture).contains("beta — desc of beta"));
    }

    /** Acceptance #5/#6: an oversized record is reported, and the Run is still created (D27-22). */
    @Test
    void anOversizedListingIsRecordedAsFailedAndTheRunStillExists() {
        // A template may set maxSkills up to 200 (schema bound), so a legal library of ~1 KiB
        // descriptions is the one realistic way to cross 64 KB — exactly the "description bloat"
        // signal D28-35 wants to be seen rather than silently truncated.
        Fixture fixture = fixture("oversize", 200);
        for (int index = 0; index < 70; index++) {
            bind(fixture, insertSkill(fixture, "bulk-" + index, "d".repeat(1024)));
        }
        String runId = submit(fixture, "oversize message");

        ChatRun run = chatRuns.findById(UUID.fromString(runId)).orElseThrow();
        assertEquals(SkillCatalogSourceService.STATUS_FAILED,
                run.getSkillsSnapshot().path("status").asText());
        assertEquals(SkillCatalogSnapshotService.DIAG_TOO_LARGE,
                run.getSkillsSnapshot().path("diagnostics").get(0).asText());
        assertEquals(0, run.getSkillsSnapshot().path("items").size());
        assertEquals("accepted", run.getStatus(),
                "the snapshot is a record: it must never block the Run it describes");
    }

    // ---------------------------------------------------------------------------------------------
    // D28-42 (M2a-③): the read face replays the snapshot, over real HTTP
    // ---------------------------------------------------------------------------------------------

    /**
     * The replay is asserted on the wire rather than on the projection object, because the failure this
     * guards against is a serialisation one: a Jackson-2 {@code JsonNode} handed to Jackson 3 arrives as
     * {@code {"nodeType":"OBJECT",…}} instead of the document (PLAN-0633 C1). Going through
     * {@code restTemplate} also puts the response through {@code Jackson2NodeWireInterceptor}, the
     * runtime gate, so this test is the read face's C1 evidence and not just a shape check.
     */
    @Test
    @SuppressWarnings("unchecked")
    void theRunReadFaceReplaysTheFrozenListing() {
        Fixture fixture = fixture("read-face");
        bind(fixture, insertSkill(fixture, "alpha", "desc of alpha"));
        String runId = submit(fixture, "read face message");

        ResponseEntity<Map<String, Object>> response = restTemplate.exchange(
                baseUrl + "/api/v1/chat/runs/" + runId, HttpMethod.GET,
                new HttpEntity<>(authorization(fixture)), new org.springframework.core.ParameterizedTypeReference<>() { });
        assertEquals(HttpStatus.OK, response.getStatusCode());

        Map<String, Object> snapshot = (Map<String, Object>) response.getBody().get("skillsSnapshot");
        assertNotNull(snapshot, "a Run admitted with a captured listing must replay it");
        assertEquals(SkillCatalogSnapshotService.VERSION, snapshot.get("version"));
        assertEquals("ready", snapshot.get("status"));
        assertEquals(SkillCatalogSourceService.SOURCE, snapshot.get("source"));
        assertEquals(SkillCatalogSnapshotService.SNAPSHOT_SOURCE_FROZEN, snapshot.get("snapshotSource"));
        assertEquals(40, snapshot.get("maxSkills"));
        assertEquals(Boolean.FALSE, snapshot.get("truncated"));
        assertNotNull(snapshot.get("capturedAt"));
        assertTrue(((List<?>) snapshot.get("items")).size() == 1);

        Map<String, Object> item = (Map<String, Object>) ((List<?>) snapshot.get("items")).getFirst();
        assertEquals("alpha", item.get("name"));
        assertEquals("desc of alpha", item.get("description"));
        assertEquals("e".repeat(64), item.get("contentHash"));
        assertFalse(item.containsKey("body"), "D28-35: the replay never carries the skill body");
        assertEquals(Map.of("subjectType", "user", "scopeType", "instance",
                "definitionScopeType", "instance"), item.get("tier"));
    }

    /**
     * D28-40's contract decision: a Run that captured nothing ({@code {}}) reads back as {@code null},
     * never as an empty listing — "not captured" and "had no skills" are different statements, and the
     * legacy Run's listing is resolved live at dispatch, which no replay can represent.
     */
    @Test
    void aPreM2aRunReadsBackWithANullSnapshot() {
        Fixture fixture = fixture("read-face-absent");
        ChatRun legacy = new ChatRun(UUID.randomUUID().toString(),
                fixture.session().getId().toString(), fixture.user().getId().toString(),
                fixture.workspace().getId().toString(), "legacy-key", "legacy-hash",
                "provider", "model", "none", "succeeded");
        legacy.setBranchId(branchPathService.ensureRootBranchId(fixture.session().getId().toString()));
        chatRuns.saveAndFlush(legacy);
        assertTrue(SkillCatalogSnapshotService.isAbsent(legacy.getSkillsSnapshot()),
                "the column default {} is the pre-M2a state this test describes");

        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/chat/runs/" + legacy.getId(), HttpMethod.GET,
                new HttpEntity<>(authorization(fixture)), Map.class);

        assertEquals(HttpStatus.OK, response.getStatusCode(),
                "a Run without a snapshot must stay readable, not become a 500");
        assertTrue(response.getBody().containsKey("skillsSnapshot"),
                "the key is present with a null value: 'not captured' is an answer, not a missing field");
        assertNull(response.getBody().get("skillsSnapshot"));
    }

    private org.springframework.http.HttpHeaders authorization(Fixture fixture) {
        org.springframework.http.HttpHeaders headers = new org.springframework.http.HttpHeaders();
        headers.setBearerAuth(jwtTokenProvider.createAccessToken(
                fixture.user().getId().toString(), fixture.user().getEmail(), "USER",
                fixture.workspace().getId().toString(), 0));
        return headers;
    }

    // ---------------------------------------------------------------------------------------------
    // fixture
    // ---------------------------------------------------------------------------------------------

    private record Fixture(User user, Workspace workspace, Session session, AgentPrincipal principal) {
    }

    private Fixture fixture(String prefix) {
        return fixture(prefix, 40);
    }

    /** A Session whose context template carries no {@code components} array (production shape). */
    private Fixture fixtureWithoutListingComponent(String prefix) {
        return fixture(prefix, 40, false);
    }

    private Fixture fixture(String prefix, int maxSkills) {
        return fixture(prefix, maxSkills, true);
    }

    private Fixture fixture(String prefix, int maxSkills, boolean withListingComponent) {
        User user = users.save(new User(prefix + "-" + UUID.randomUUID() + "@skill-snapshot.test",
                "hash", "Skill snapshot"));
        Workspace workspace = workspaceFixture.createOwnedWorkspace(prefix + " Workspace",
                user.getId().toString());
        workspaceFixture.bindWorkspaceRole(workspace.getId().toString(), user.getId().toString(),
                WorkspaceRole.OWNER);
        AgentPrincipal principal = savePrincipal(user);
        members.saveAndFlush(new WorkspaceAgent(principal.getId().toString(),
                workspace.getId().toString(), objectMapper.createArrayNode()));

        Session session = new Session(workspace.getId().toString(), user.getId().toString(),
                prefix + " Session");
        session.setId(UUID.randomUUID());
        ProviderConnection connection = ChatBindingTestSupport.ensureChatConnection(connections, "USER",
                user.getId().toString(), "chat-" + session.getId());
        ChatBindingTestSupport.bind(session, connection, templates);

        // A published api-request-template revision that carries the listing component: the admission
        // snapshot copies `template.components` verbatim, which is what the listing component reads.
        String templateId = UUID.randomUUID().toString();
        publishUserTemplate(user, templateId, maxSkills, withListingComponent);
        session.setContextTemplateLayer("user");
        session.setContextTemplateId(UUID.fromString(templateId));
        session.setContextTemplateVersion(1);
        Session persisted = sessions.saveAndFlush(session);
        return new Fixture(user, workspace, persisted, principal);
    }

    private void publishUserTemplate(User user, String templateId, int maxSkills,
                                     boolean withListingComponent) {
        ObjectNode template = objectMapper.createObjectNode();
        template.put("id", templateId);
        template.put("version", 1);
        template.put("name", "skill snapshot fixture");
        template.put("description", "fixture");
        template.put("apiTypeId", "openai-chat-completions");
        template.put("apiTypeVersion", 1);
        template.put("status", "published");
        template.put("bodySource", "{\"model\":\"${xh.model}\","
                + "\"messages\":[{\"role\":\"system\",\"content\":\"${xh.agent_instructions}\"},"
                + "\"${xh.conversation_history}\",{\"role\":\"user\",\"content\":\"${xh.user_input}\"}],"
                + "\"tools\":[\"${xh.tools}\"],\"stream\":true}");
        if (withListingComponent) {
            ObjectNode component = template.putArray("components").addObject();
            component.put("instanceId", COMPONENT_ID);
            component.put("type", "skill_catalog");
            component.put("enabled", true);
            component.putObject("config").put("maxSkills", maxSkills).put("includeDescriptions", true)
                    .put("sort", "binding");
        }

        try {
            String templatesJson = objectMapper.writeValueAsString(
                    objectMapper.createArrayNode().add(template));
            TenantContext.setUserId(user.getId().toString());
            templates.putLayer("user", Map.of("templates", templatesJson),
                    user.getId().toString(), user.getId(), null);
        } catch (com.fasterxml.jackson.core.JsonProcessingException serializationFailure) {
            throw new IllegalStateException("Unable to serialize the fixture template", serializationFailure);
        } finally {
            TenantContext.clear();
        }
    }

    private AgentPrincipal savePrincipal(User user) {
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("skill snapshot principal " + UUID.randomUUID());
        principal.setCreatedByUserId(user.getId().toString());
        ObjectNode snapshot = objectMapper.createObjectNode();
        snapshot.set("permissions", objectMapper.createArrayNode());
        principal.setTemplateSnapshot(snapshot);
        return principals.saveAndFlush(principal);
    }

    private UUID insertSkill(Fixture fixture, String name, String description) {
        Skill skill = new Skill();
        skill.setName(name);
        skill.setDefinitionScopeType(Skill.DEFINITION_SCOPE_INSTANCE);
        skill.setDescription(description);
        skill.setBody("body text");
        skill.setBodyTokensEst(SkillTokenEstimator.estimate("body text"));
        skill.setOversize(false);
        skill.setAttachments(objectMapper.createArrayNode());
        skill.setTrusted(false);
        skill.setSourcePath(".agents/skills/" + name + "/SKILL.md");
        skill.setContentHash("e".repeat(64));
        skill.setCreatedByUserId(fixture.user().getId());
        return skills.saveAndFlush(skill).getId();
    }

    private void bind(Fixture fixture, UUID skillId) {
        SkillBinding binding = new SkillBinding();
        binding.setSkillId(skillId);
        binding.setSubjectType(SkillBinding.SUBJECT_USER);
        binding.setSubjectId(fixture.user().getId());
        binding.setScopeType(SkillBinding.SCOPE_INSTANCE);
        binding.setCreatedByUserId(fixture.user().getId());
        bindings.saveAndFlush(binding);
    }

    /** AGENT-tier binding: the tier the Session's main Agent principal resolves (skill-wiring). */
    private void bindToPrincipal(Fixture fixture, UUID skillId) {
        SkillBinding binding = new SkillBinding();
        binding.setSkillId(skillId);
        binding.setSubjectType(SkillBinding.SUBJECT_AGENT_PRINCIPAL);
        binding.setSubjectId(fixture.principal().getId());
        binding.setScopeType(SkillBinding.SCOPE_INSTANCE);
        binding.setCreatedByUserId(fixture.user().getId());
        bindings.saveAndFlush(binding);
    }

    private String submit(Fixture fixture, String content) {
        String sessionId = fixture.session().getId().toString();
        String runId = UUID.randomUUID().toString();
        submissionService.create(runId, sessionId, fixture.user().getId().toString(),
                fixture.workspace().getId().toString(),
                branchPathService.ensureRootBranchId(sessionId), fixture.principal().getId().toString(),
                "idem-" + runId, "request-hash", "provider", "model", "none", null, null,
                "lease-owner", UUID.randomUUID().toString(), content, "[]", List.of());
        return runId;
    }

    private void terminalize(String runId) {
        ChatRun run = chatRuns.findById(UUID.fromString(runId)).orElseThrow();
        run.setStatus("succeeded");
        chatRuns.saveAndFlush(run);
    }

    /**
     * Renders the listing the way dispatch does: the stored Run row → {@link ChatRunReadService}'s
     * {@code RunContext} (which now carries the snapshot) → the component-source resolver.
     */
    @SuppressWarnings("unchecked")
    private List<String> listingOf(String runId, Fixture fixture) {
        ChatRunReadService.ExecutionRun execution = chatRunReadService.findExecutionRun(runId).orElseThrow();
        Session session = sessions.findById(fixture.session().getId()).orElseThrow();
        Map<String, Object> sources = contextSources.resolve(execution.context(), session);
        assertNotNull(sources.get(COMPONENT_ID), sources.keySet().toString());
        return (List<String>) ((Map<String, Object>) sources.get(COMPONENT_ID)).get("items");
    }
}
