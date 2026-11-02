package com.cc01cc.p.xihe.cp.skill;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0628 M1 (taskbook T5): <b>service-level isolation</b> of the skills listing.
 *
 * <p>Why service level and not endpoint level: isolation is not "what the HTTP layer filters", it is
 * which rows the resolution query may see — the endpoint will only project that. So this test drives
 * the real {@link SkillCatalogSourceService} against a real migrated PostgreSQL (each test class gets
 * a freshly cloned, fully migrated database from {@link AbstractIntegrationTest}), which means the
 * SQL {@code WHERE} clauses actually execute. A mocked repository would just re-assert the mock.</p>
 *
 * <p><b>Seeding goes through the JPA repositories, not hand-written INSERTs</b>: a hand-written
 * column list is exactly the thing that drifts the next time a migration adds a NOT NULL column,
 * whereas the entities follow the DDL by construction.</p>
 *
 * <p>The four reachable tiers are expressed as a <b>matrix</b> ({@link #VISIBILITY_MATRIX}), so a
 * future tier is one more row instead of a fifth block of assertions.</p>
 */
class SkillCatalogIsolationTest extends AbstractIntegrationTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /**
     * One tier of the 2×2 table plus what it must make visible.
     *
     * @param principalSubject true when the binding's subject is an {@code agent_principal}
     * @param visibleInOwnWorkspace the subject sees it in the workspace it was bound for
     * @param visibleInOtherWorkspace the subject also sees it in a second workspace
     */
    private record TierCase(String name, String subjectType, String scopeType,
                            boolean principalSubject, boolean visibleInOwnWorkspace,
                            boolean visibleInOtherWorkspace, boolean visibleToOtherUser,
                            boolean visibleToOtherPrincipal) {}

    /**
     * The 2×2, as data.
     *
     * <p><b>The two subject axes are a union (OR), not a filter.</b> The resolution query matches
     * {@code (subject_type='user' AND subject_id=:userId) OR (subject_type='agent_principal' AND
     * subject_id=:principalId)} — so a USER binding is unaffected by which principal is answering,
     * and an AGENT binding is unaffected by which user is. That makes the last two columns
     * <b>cross-axis independence</b> checks (they catch a regression that accidentally ANDs the two
     * axes and makes bindings silently disappear); the real isolation check is the fifth probe
     * ("other subject"), which changes <i>both</i> and must see nothing.</p>
     */
    private static final List<TierCase> VISIBILITY_MATRIX = List.of(
            // name              subject_type        scope_type    principal  own  otherWs  otherUser  otherPrin
            new TierCase("user-instance", SkillBinding.SUBJECT_USER, SkillBinding.SCOPE_INSTANCE,
                    false, true, true, false, true),
            new TierCase("user-workspace", SkillBinding.SUBJECT_USER, SkillBinding.SCOPE_WORKSPACE,
                    false, true, false, false, true),
            new TierCase("agent-instance", SkillBinding.SUBJECT_AGENT_PRINCIPAL,
                    SkillBinding.SCOPE_INSTANCE, true, true, true, true, false),
            new TierCase("agent-workspace", SkillBinding.SUBJECT_AGENT_PRINCIPAL,
                    SkillBinding.SCOPE_WORKSPACE, true, true, false, true, false));

    @Autowired
    private SkillCatalogSourceService catalog;

    @Autowired
    private SkillRepository skills;

    @Autowired
    private SkillBindingRepository bindings;

    @Autowired
    private UserRepository users;

    @Autowired
    private WorkspaceRepository workspaces;

    @Autowired
    private AgentPrincipalRepository principals;

    @Autowired
    private WorkspaceAgentRepository members;

    private UUID userA;
    private UUID userB;
    private UUID workspaceOne;
    private UUID workspaceTwo;
    private UUID principalOne;
    private UUID principalTwo;
    /** Per-test unique suffix: keeps {@code uq_users_email} and workspace names from colliding. */
    private String runSuffix;

    @BeforeEach
    void seedSubjects() {
        runSuffix = UUID.randomUUID().toString().substring(0, 8);
        bindings.deleteAll();
        skills.deleteAll();
        members.deleteAll();
        userA = insertUser("iso-a");
        userB = insertUser("iso-b");
        workspaceOne = insertWorkspace("iso-w1");
        workspaceTwo = insertWorkspace("iso-w2");
        principalOne = insertPrincipal("iso-principal-1", userA);
        principalTwo = insertPrincipal("iso-principal-2", userA);
        members.save(new WorkspaceAgent(principalOne.toString(), workspaceOne.toString(),
                MAPPER.createObjectNode()));
        members.save(new WorkspaceAgent(principalTwo.toString(), workspaceOne.toString(),
                MAPPER.createObjectNode()));
    }

    private UUID insertUser(String handle) {
        // Unique suffix per test: the database is per class, so a fixed email collides with
        // `uq_users_email` on the second test method.
        String unique = handle + "-" + runSuffix;
        User user = new User();
        user.setEmail(unique + "@iso.test");
        user.setUsername(unique);
        user.setPasswordHash("x");
        user.setName(unique);
        return users.save(user).getId();
    }

    private UUID insertWorkspace(String name) {
        Workspace workspace = new Workspace();
        workspace.setName(name + "-" + runSuffix);
        // V-migration CHECK ck_workspaces_direct_attach_path:
        //   storage_mode = 'managed_import' OR host_path IS NOT NULL
        // The entity defaults to direct_attach, so a host path is mandatory. Read the DDL rather
        // than guessing — guessing is exactly how this test failed the first time.
        workspace.setStorageMode("direct_attach");
        workspace.setHostPath("/tmp/xihe-iso/" + runSuffix);
        return workspaces.save(workspace).getId();
    }

    private UUID insertPrincipal(String name, UUID creator) {
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName(name + "-" + runSuffix);
        principal.setCreatedByUserId(creator.toString());
        return principals.save(principal).getId();
    }

    private UUID insertSkill(String name, String definitionScopeType, UUID definitionScopeId) {
        Skill skill = new Skill();
        skill.setName(name);
        skill.setDefinitionScopeType(definitionScopeType);
        skill.setDefinitionScopeId(definitionScopeId);
        skill.setDescription("desc of " + name);
        skill.setBody("body text");
        skill.setBodyTokensEst(SkillTokenEstimator.estimate("body text"));
        skill.setOversize(false);
        skill.setAttachments(MAPPER.createArrayNode());
        skill.setTrusted(false);
        skill.setSourcePath(".agents/skills/" + name + "/SKILL.md");
        skill.setContentHash("e".repeat(64));
        skill.setCreatedByUserId(userA);
        return skills.save(skill).getId();
    }

    private void bind(UUID skillId, String subjectType, UUID subjectId, String scopeType,
                      UUID scopeId) {
        SkillBinding binding = new SkillBinding();
        binding.setSkillId(skillId);
        binding.setSubjectType(subjectType);
        binding.setSubjectId(subjectId);
        binding.setScopeType(scopeType);
        binding.setScopeId(scopeId);
        binding.setCreatedByUserId(userA);
        bindings.save(binding);
    }

    private List<String> itemsFor(UUID principalId, UUID userId, UUID workspaceId) {
        return catalog.resolve(new SkillCatalogSourceService.Request(principalId, userId, workspaceId,
                SkillCatalogSourceService.DEFAULT_MAX_SKILLS, true,
                SkillCatalogSourceService.SORT_BINDING)).items();
    }

    /**
     * JPA seeding follows the DDL, but it does <b>not</b> tell you a field was forgotten — the CHECK
     * only fires when the row is written. This asserts the two values this fixture depends on are set
     * <b>explicitly</b>, so "it happened to pass" cannot masquerade as "it was specified".
     */
    @Test
    void theSeededWorkspaceCarriesAnExplicitDirectAttachPath() {
        Workspace workspace = workspaces.findById(workspaceOne).orElseThrow();

        assertEquals("direct_attach", workspace.getStorageMode());
        assertTrue(workspace.getHostPath() != null && !workspace.getHostPath().isBlank(),
                "host_path must be explicit: ck_workspaces_direct_attach_path requires it");
    }

    /** The matrix, executed: every tier × every probe; a new tier only adds a row. */
    @Test
    void everyTierIsVisibleExactlyWhereTheMatrixSays() {
        List<String> failures = new ArrayList<>();
        for (TierCase tier : VISIBILITY_MATRIX) {
            boolean workspaceTier = SkillBinding.SCOPE_WORKSPACE.equals(tier.scopeType());
            String skillName = "s-" + tier.name();
            UUID skillId = insertSkill(skillName,
                    workspaceTier ? Skill.DEFINITION_SCOPE_WORKSPACE : Skill.DEFINITION_SCOPE_INSTANCE,
                    workspaceTier ? workspaceOne : null);
            bind(skillId, tier.subjectType(), tier.principalSubject() ? principalOne : userA,
                    tier.scopeType(), workspaceTier ? workspaceOne : null);

            UUID ownerPrincipal = tier.principalSubject() ? principalOne : null;
            UUID otherPrincipal = tier.principalSubject() ? principalTwo : null;

            recordProbe(tier, skillName, failures, "own workspace",
                    itemsFor(ownerPrincipal, userA, workspaceOne), tier.visibleInOwnWorkspace());
            recordProbe(tier, skillName, failures, "other workspace",
                    itemsFor(ownerPrincipal, userA, workspaceTwo), tier.visibleInOtherWorkspace());
            // Cross-axis independence: changing only the *other* axis must not remove the binding.
            recordProbe(tier, skillName, failures, "other user (principal unchanged)",
                    itemsFor(ownerPrincipal, userB, workspaceOne), tier.visibleToOtherUser());
            recordProbe(tier, skillName, failures, "other principal (user unchanged)",
                    itemsFor(otherPrincipal, userA, workspaceOne), tier.visibleToOtherPrincipal());
            // Real isolation: a different subject on BOTH axes must see nothing.
            recordProbe(tier, skillName, failures, "other subject (both axes)",
                    itemsFor(otherPrincipal, userB, workspaceOne), false);
        }
        assertEquals(List.of(), failures);
    }

    private static void recordProbe(TierCase tier, String skillName, List<String> failures,
                                    String probe, List<String> items, boolean expected) {
        boolean actual = items.stream().anyMatch(item -> item.startsWith(skillName));
        if (actual != expected) {
            failures.add(tier.name() + " / " + probe + ": expected " + expected + " but got " + actual);
        }
    }

    @Test
    void aWorkspaceTierIsInvisibleToAnotherWorkspaceForTheSameUser() {
        UUID skill = insertSkill("w1-only", Skill.DEFINITION_SCOPE_WORKSPACE, workspaceOne);
        bind(skill, SkillBinding.SUBJECT_USER, userA, SkillBinding.SCOPE_WORKSPACE, workspaceOne);

        assertTrue(itemsFor(null, userA, workspaceOne).stream().anyMatch(i -> i.startsWith("w1-only")));
        assertTrue(itemsFor(null, userA, workspaceTwo).isEmpty());
    }

    @Test
    void anInstanceTierFollowsTheSubjectIntoEveryWorkspace() {
        UUID skill = insertSkill("shared", Skill.DEFINITION_SCOPE_INSTANCE, null);
        bind(skill, SkillBinding.SUBJECT_USER, userA, SkillBinding.SCOPE_INSTANCE, null);

        assertTrue(itemsFor(null, userA, workspaceOne).stream().anyMatch(i -> i.startsWith("shared")));
        assertTrue(itemsFor(null, userA, workspaceTwo).stream().anyMatch(i -> i.startsWith("shared")));
    }
}
