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
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
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

    /** The class shares one cloned database, so seeded libraries are cleared between tests. */
    @BeforeEach
    void clearSeededLibraries() {
        bindings.deleteAll();
        skills.deleteAll();
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
    // fixture
    // ---------------------------------------------------------------------------------------------

    private record Fixture(User user, Workspace workspace, Session session, AgentPrincipal principal) {
    }

    private Fixture fixture(String prefix) {
        return fixture(prefix, 40);
    }

    private Fixture fixture(String prefix, int maxSkills) {
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
        publishUserTemplate(user, templateId, maxSkills);
        session.setContextTemplateLayer("user");
        session.setContextTemplateId(UUID.fromString(templateId));
        session.setContextTemplateVersion(1);
        Session persisted = sessions.saveAndFlush(session);
        return new Fixture(user, workspace, persisted, principal);
    }

    private void publishUserTemplate(User user, String templateId, int maxSkills) {
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
        ObjectNode component = template.putArray("components").addObject();
        component.put("instanceId", COMPONENT_ID);
        component.put("type", "skill_catalog");
        component.put("enabled", true);
        component.putObject("config").put("maxSkills", maxSkills).put("includeDescriptions", true)
                .put("sort", "binding");

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
