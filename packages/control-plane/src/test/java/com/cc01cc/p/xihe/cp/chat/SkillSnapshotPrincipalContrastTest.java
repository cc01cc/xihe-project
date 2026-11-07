package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
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
import com.cc01cc.p.xihe.cp.repository.McpInvocationRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService;
import com.cc01cc.p.xihe.cp.skill.Skill;
import com.cc01cc.p.xihe.cp.skill.SkillBinding;
import com.cc01cc.p.xihe.cp.skill.SkillBindingRepository;
import com.cc01cc.p.xihe.cp.skill.SkillCatalogSourceService;
import com.cc01cc.p.xihe.cp.skill.SkillRepository;
import com.cc01cc.p.xihe.cp.skill.SkillTokenEstimator;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0628 M2a-③ / D28-43: the frozen listing is scoped to the <b>Session's bound Agent
 * principal</b>, so the {@code spawn} and {@code wakeupAs} paths now see a different capability set
 * than they used to.
 *
 * <p><b>This is an intentional behaviour change from M2a, not a regression.</b> Before the snapshot,
 * the listing was resolved live at render time from {@code chat_runs.agent_principal_id} — the
 * <i>responder</i> attribution column, which is stamped <i>after</i> admission
 * ({@code ChatSubmissionService#create} for a user submission, {@code SessionWakeupService#wakeupAs}
 * for a wake). The snapshot is captured inside admission, where the only principal in scope is the
 * Session binding, so it is scoped the same way the run's {@code instructions} are resolved at
 * dispatch ({@code ChatController}: {@code agentPrincipalService.resolveSystemInstructionsForRun(
 * boundSession.getAgentPrincipalId())}) — i.e. to the identity that actually executes the Run.
 *
 * <p>What each path looked like before, and what these two tests pin:
 *
 * <ul>
 *   <li><b>spawn</b> — the child Run's responder is never stamped (spawn persists through
 *       {@code persist} directly), so the pre-M2a live resolve ran with a {@code null} principal and
 *       could only ever see the USER/workspace tiers. The child Session, however, is created with the
 *       parent Session's principal, so the new snapshot carries the AGENT tier. Wider, and correctly
 *       so: the listing now matches the principal that owns the child Session.</li>
 *   <li><b>wakeupAs</b> — the run is attributed to a participant that may be a <i>different</i>
 *       principal than the Session binding, so the listing's subject literally changed: the model
 *       used to be shown the responder's skills while the run executed as the Session's Agent.</li>
 * </ul>
 *
 * <p>Neither case is an escalation: the AGENT-tier entries are the bound principal's own bindings
 * (the same identity that owns the Session, its instructions and its permission snapshot), no
 * cross-principal binding becomes visible, and the dispatch-time render reads this same document.
 * The capability <i>does</i> change, and that is why each test also re-resolves the pre-M2a source
 * (live, with the run's responder) and asserts the difference — so the change is measured, not
 * assumed.
 *
 * <p><b>The contrast is three-state verified.</b> Passing {@code null} as the capture principal in
 * {@code ChatSubmissionService#freezeSkillsListing} (i.e. reproducing the pre-M2a live subject)
 * turns both tests red exactly where the change lives: the spawn child's frozen listing becomes
 * {@code [user-wide-skill]} (AGENT tier gone) and the wake-up Run's becomes empty (both its skills
 * were agent-scoped). Restoring the Session principal makes them green again.
 */
class SkillSnapshotPrincipalContrastTest extends AbstractIntegrationTest {

    private static final String COMPONENT_ID = "6a0d1f5e-3333-4333-8333-000000000003";

    @Autowired
    private ChatSubmissionService submissionService;

    @Autowired
    private SessionWakeupService wakeupService;

    @Autowired
    private ChatRunRepository chatRuns;

    @Autowired
    private SessionRepository sessions;

    @Autowired
    private SessionParticipantRepository participants;

    @Autowired
    private UserRepository users;

    @Autowired
    private AgentPrincipalRepository principals;

    @Autowired
    private WorkspaceAgentRepository members;

    @Autowired
    private ProviderConnectionRepository connections;

    @Autowired
    private ApiRequestTemplateService templates;

    @Autowired
    private SkillRepository skills;

    @Autowired
    private SkillBindingRepository bindings;

    @Autowired
    private McpInvocationRepository invocations;

    @Autowired
    private WorkspaceFixture workspaceFixture;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private SkillCatalogSourceService skillCatalog;

    @BeforeEach
    void clearSeededLibraries() {
        bindings.deleteAll();
        skills.deleteAll();
    }

    /**
     * spawn 子 run：快照按<b>子 Session 的 principal</b>（继承父 Session）冻结，而 run 的 responder
     * 仍为 {@code null}。对照：M2a 之前的 live 解析拿的是 responder（null）⇒ 看不到 AGENT 档。
     */
    @Test
    void aSpawnChildRunFreezesItsListingUnderTheSpawnedSessionsPrincipal() {
        Fixture fixture = fixture("spawn-principal");
        bind(fixture, insertSkill(fixture, "session-agent-skill", "agent scoped"),
                SkillBinding.SUBJECT_AGENT_PRINCIPAL, fixture.sessionPrincipal().getId(),
                SkillBinding.SCOPE_INSTANCE);
        bind(fixture, insertSkill(fixture, "user-wide-skill", "user scoped"),
                SkillBinding.SUBJECT_USER, fixture.user().getId(), SkillBinding.SCOPE_INSTANCE);

        ParentFixture parent = parentRun(fixture);
        ChatSubmissionService.SpawnResult child = spawnDirect(parent.runId(), parent.toolCallId());

        ChatRun childRun = chatRuns.findById(UUID.fromString(child.runId())).orElseThrow();
        // BL-280: spawn carriers are now stamped at admission with the Session-bound principal (the
        // agent that executes the child Run), so the dispatch-side context sources (memory /
        // skill_catalog) can resolve it. The **skill capture identity** is still the Session binding,
        // never a responder — that part of D28-39 is unchanged.
        assertEquals(fixture.sessionPrincipal().getId(), childRun.getAgentPrincipalId(),
                "spawn runs carry the Session-bound principal for dispatch context (BL-280)");
        assertEquals(fixture.sessionPrincipal().getId(),
                participants.primaryPrincipalId(UUID.fromString(childRun.getSessionId())).orElse(null),
                "the child Session runs as the parent Session's PRIMARY participant");

        List<String> frozen = snapshotNames(childRun);
        assertTrue(frozen.contains("session-agent-skill"), frozen.toString());
        assertTrue(frozen.contains("user-wide-skill"), frozen.toString());

        // The contrast, measured rather than assumed: the pre-M2a source (live resolution with the
        // Run's responder = null) could not see the AGENT tier at all.
        List<String> legacyLive = liveNames(
                SkillCatalogSourceService.Request.of(null, fixture.user().getId(),
                        fixture.workspace().getId()));
        assertFalse(legacyLive.contains("session-agent-skill"),
                "under the old semantics the spawned child's model saw no agent-scoped skill: "
                        + legacyLive);
        assertTrue(legacyLive.contains("user-wide-skill"),
                "the USER tier was visible before and still is: " + legacyLive);
    }

    /**
     * wakeupAs：run 的 responder 在准入之后被写成参与者 Q，而快照仍按 Session principal P 冻结。
     * 对照：live 解析若用 responder（Q），清单里是 Q 的 skill —— 主体真的变了。
     */
    @Test
    void aWakeupAsRunFreezesTheSessionPrincipalListingNotTheResponder() {
        Fixture fixture = fixture("wakeup-principal");
        bind(fixture, insertSkill(fixture, "session-agent-skill", "agent scoped"),
                SkillBinding.SUBJECT_AGENT_PRINCIPAL, fixture.sessionPrincipal().getId(),
                SkillBinding.SCOPE_INSTANCE);
        bind(fixture, insertSkill(fixture, "responder-skill", "responder scoped"),
                SkillBinding.SUBJECT_AGENT_PRINCIPAL, fixture.responderPrincipal().getId(),
                SkillBinding.SCOPE_INSTANCE);

        SessionWakeupService.WakeupResult result = wakeupService.wakeupAs(
                fixture.session().getId().toString(), fixture.user().getId().toString(),
                fixture.workspace().getId().toString(), "wake as the mentioned participant",
                "wakeup-principal-" + UUID.randomUUID(), fixture.responderPrincipal().getId(), "mention",
                null);
        assertTrue(result.started(), "the idle Session admits the wake-up Run");
        assertNotNull(result.runId());

        ChatRun run = chatRuns.findById(result.runId()).orElseThrow();
        assertEquals(fixture.responderPrincipal().getId(), run.getAgentPrincipalId(),
                "wakeupAs stamps the responder after admission (SessionWakeupService#wakeupAs)");

        List<String> frozen = snapshotNames(run);
        assertTrue(frozen.contains("session-agent-skill"), frozen.toString());
        assertFalse(frozen.contains("responder-skill"),
                "the frozen listing belongs to the Session principal, not to the responder: " + frozen);

        // The contrast: the pre-M2a descriptor (live resolution keyed by the Run's responder) would
        // have produced the opposite listing for this very Run.
        List<String> legacyLive = liveNames(
                SkillCatalogSourceService.Request.of(run.getAgentPrincipalId(),
                        fixture.user().getId(), fixture.workspace().getId()));
        assertTrue(legacyLive.contains("responder-skill"), legacyLive.toString());
        assertFalse(legacyLive.contains("session-agent-skill"), legacyLive.toString());
    }

    // ---------------------------------------------------------------------------------------------
    // fixture
    // ---------------------------------------------------------------------------------------------

    private record Fixture(User user, Workspace workspace, Session session,
                           AgentPrincipal sessionPrincipal, AgentPrincipal responderPrincipal) {
    }

    private record ParentFixture(String runId, String toolCallId) {
    }

    private Fixture fixture(String prefix) {
        User user = users.save(new User(prefix + "-" + UUID.randomUUID() + "@skill-principal.test",
                "hash", "Skill principal contrast"));
        Workspace workspace = workspaceFixture.createOwnedWorkspace(prefix + " Workspace",
                user.getId().toString());
        workspaceFixture.bindWorkspaceRole(workspace.getId().toString(), user.getId().toString(),
                WorkspaceRole.OWNER);
        AgentPrincipal sessionPrincipal = savePrincipal(user, prefix + " session principal");
        AgentPrincipal responderPrincipal = savePrincipal(user, prefix + " responder principal");
        members.saveAndFlush(new WorkspaceAgent(sessionPrincipal.getId().toString(),
                workspace.getId().toString(), objectMapper.createArrayNode()));

        Session session = new Session(workspace.getId().toString(), user.getId().toString(),
                prefix + " Session");
        session.setId(UUID.randomUUID());
        ProviderConnection connection = ChatBindingTestSupport.ensureChatConnection(connections, "USER",
                user.getId().toString(), "principal-contrast-" + session.getId());
        session.setModelProvider("custom-openai-compatible");
        session.setModelName("wire-model");
        session.setProviderConnectionId(connection.getId().toString());
        session.setConnectionRevision(connection.getRevision());
        session.setAgentPermissionsSnapshot(capNode());
        // A published user template carrying the listing component is what admission snapshots, so
        // the capture path has a component to freeze (same fixture shape as the M2a freeze suite).
        String templateId = UUID.randomUUID().toString();
        publishUserTemplate(user, templateId);
        session.setContextTemplateLayer("user");
        session.setContextTemplateId(UUID.fromString(templateId));
        session.setContextTemplateVersion(1);
        Session persisted = sessions.saveAndFlush(session);
        bindPrimaryParticipant(persisted.getId().toString(), sessionPrincipal.getId().toString());
        return new Fixture(user, workspace, persisted, sessionPrincipal, responderPrincipal);
    }

    private ParentFixture parentRun(Fixture fixture) {
        ChatRun parent = new ChatRun(UUID.randomUUID().toString(),
                fixture.session().getId().toString(), fixture.user().getId().toString(),
                fixture.workspace().getId().toString(), "spawn-principal-parent-" + UUID.randomUUID(),
                "spawn-principal-hash", "provider", "model", "workspace", "running");
        parent.setAgentPrincipalId(fixture.sessionPrincipal().getId());
        chatRuns.saveAndFlush(parent);
        String toolCallId = UUID.randomUUID().toString();
        SpawnTestSupport.seedAgentInvocation(invocations, fixture.session().getId().toString(),
                parent.getId().toString(), fixture.workspace().getId().toString(),
                fixture.user().getId().toString(), toolCallId,
                ChatSubmissionService.SPAWN_TOOL_NAME, "{\"prompt\":\"sub-task\"}");
        return new ParentFixture(parent.getId().toString(), toolCallId);
    }

    private ChatSubmissionService.SpawnResult spawnDirect(String parentRunId, String toolCallId) {
        ChatSubmissionService.SpawnInvocation invocation =
                submissionService.prepareSpawnInvocation(parentRunId, toolCallId);
        return submissionService.createSpawnFromParent(parentRunId, toolCallId,
                new ChatSubmissionService.SpawnAuthorization(invocation.authorizationBody(), null, null));
    }

    private void publishUserTemplate(User user, String templateId) {
        ObjectNode template = objectMapper.createObjectNode();
        template.put("id", templateId);
        template.put("version", 1);
        template.put("name", "skill principal contrast fixture");
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
        component.putObject("config").put("maxSkills", 40).put("includeDescriptions", true)
                .put("sort", "binding");
        try {
            String templatesJson = objectMapper.writeValueAsString(
                    objectMapper.createArrayNode().add(template));
            com.cc01cc.p.xihe.cp.config.TenantContext.setUserId(user.getId().toString());
            templates.putLayer("user", Map.of("templates", templatesJson),
                    user.getId().toString(), user.getId(), null);
        } catch (com.fasterxml.jackson.core.JsonProcessingException serializationFailure) {
            throw new IllegalStateException("Unable to serialize the fixture template", serializationFailure);
        } finally {
            com.cc01cc.p.xihe.cp.config.TenantContext.clear();
        }
    }

    private AgentPrincipal savePrincipal(User user, String name) {
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName(name + " " + UUID.randomUUID());
        principal.setCreatedByUserId(user.getId().toString());
        ObjectNode snapshot = objectMapper.createObjectNode();
        snapshot.set("permissions", objectMapper.createArrayNode());
        principal.setTemplateSnapshot(snapshot);
        return principals.saveAndFlush(principal);
    }

    private JsonNode capNode() {
        return objectMapper.createArrayNode()
                .add(objectMapper.createObjectNode().put("actionClass", "read"));
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
        skill.setContentHash("f".repeat(64));
        skill.setCreatedByUserId(fixture.user().getId());
        return skills.saveAndFlush(skill).getId();
    }

    private void bind(Fixture fixture, UUID skillId, String subjectType, UUID subjectId,
                      String scopeType) {
        SkillBinding binding = new SkillBinding();
        binding.setSkillId(skillId);
        binding.setSubjectType(subjectType);
        binding.setSubjectId(subjectId);
        binding.setScopeType(scopeType);
        binding.setCreatedByUserId(fixture.user().getId());
        bindings.saveAndFlush(binding);
    }

    /** The listing names a Run was admitted with, read from its frozen snapshot (D28-35/D28-39). */
    private static List<String> snapshotNames(ChatRun run) {
        JsonNode items = run.getSkillsSnapshot().path("items");
        assertTrue(items.isArray() && !items.isEmpty(),
                "the Run must have captured a listing: " + run.getSkillsSnapshot());
        List<String> names = new ArrayList<>();
        items.forEach(item -> names.add(item.path("name").asText()));
        return names;
    }

    /** The pre-M2a read source: live resolution for one principal (D28-40's fallback shape). */
    private List<String> liveNames(SkillCatalogSourceService.Request request) {
        List<String> names = new ArrayList<>();
        for (String line : skillCatalog.resolve(request).items()) {
            names.add(line.split(" — ", 2)[0]);
        }
        return names;
    }
}
