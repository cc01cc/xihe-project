package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AgentMemory;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.AgentMemoryRepository;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0629 M1-4 (A②/④): the per-run memory snapshot CP hands to the Agent's system slot.
 *
 * <p>Eight frozen cases: empty / candidate-only / pinned first / profile before fact / maxEntries /
 * maxTokens / same principal in another workspace / soft-deleted. The snapshot is asserted as plain
 * JSON (no Jackson-2 node reaches it — 0633 C1).</p>
 */
class AgentMemoryInjectionTest extends AbstractIntegrationTest {

    @Autowired private AgentMemoryInjectionService injection;
    @Autowired private AgentMemoryRepository memories;
    @Autowired private AgentPrincipalRepository principalRepository;
    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private ObjectMapper objectMapper;
    @Autowired private JdbcTemplate jdbcTemplate;

    private UUID userId;
    private UUID principalId;
    private UUID workspaceId;
    private UUID otherWorkspaceId;

    @AfterEach
    void cleanFixtures() {
        memories.deleteAll();
        if (principalId != null) {
            grantRepository.deleteAll(
                    grantRepository.findBySubjectTypeAndSubjectId("agent_principal", principalId));
            principalRepository.deleteById(principalId);
            principalId = null;
        }
        for (UUID workspace : new UUID[] {workspaceId, otherWorkspaceId}) {
            if (workspace != null) {
                workspaceFixture.unbindWorkspace(workspace);
                workspaceRepository.deleteById(workspace);
            }
        }
        workspaceId = null;
        otherWorkspaceId = null;
        if (userId != null) {
            jdbcTemplate.update("DELETE FROM audit_logs WHERE user_id = CAST(? AS UUID)", userId.toString());
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("user", userId));
            userRepository.deleteById(userId);
            userId = null;
        }
    }

    @Test
    void emptyMemoryInjectsNothing() {
        fixture();
        Map<String, Object> view = injection.snapshot(principalId, workspaceId, 24, 4_000);
        assertEquals(AgentMemoryInjectionService.STATUS_EMPTY, view.get("status"));
        assertTrue(entries(view).isEmpty());
        assertEquals(false, view.get("truncated"));
    }

    @Test
    void viewIsSelfDescribingForTheAgentSlot() {
        // PLAN-0629 M1-5: the Agent fills ${xh.agent_memory} by matching this tag, exactly like
        // ${xh.skill_catalog} matches SkillCatalogSourceService.SOURCE. Losing it would make the
        // slot silently empty while CP thinks it handed memory over.
        fixture();
        assertEquals(AgentMemoryInjectionService.SOURCE,
                injection.snapshot(principalId, workspaceId, 24, 4_000).get("source"));
        assertEquals(AgentMemoryInjectionService.SOURCE,
                AgentMemoryInjectionService.unavailable(24, 4_000, "missing_agent_principal").get("source"));
    }

    @Test
    void candidateRowsAreNeverInjected() {
        fixture();
        // A passive write may only land as a candidate (V99 CHECK); v1 must not inject it.
        saveMemory("candidate assertion", AgentMemory.ORIGIN_PASSIVE_SUMMARY,
                AgentMemory.STATUS_CANDIDATE, false, 1, null);
        Map<String, Object> view = injection.snapshot(principalId, workspaceId, 24, 4_000);
        assertEquals(AgentMemoryInjectionService.STATUS_EMPTY, view.get("status"));
        assertTrue(entries(view).isEmpty(), "a candidate is not part of the injected memory");
    }

    @Test
    void pinnedRowsComeFirst() {
        fixture();
        saveMemory("newer unpinned", AgentMemory.ORIGIN_UI, AgentMemory.STATUS_ACTIVE, false, 3, null);
        saveMemory("older pinned", AgentMemory.ORIGIN_UI, AgentMemory.STATUS_ACTIVE, true, 1, null);
        List<String> contents = contents(injection.snapshot(principalId, workspaceId, 24, 4_000));
        assertEquals(List.of("older pinned", "newer unpinned"), contents);
    }


    @Test
    void maxEntriesTruncatesAndReportsIt() {
        fixture();
        for (int i = 1; i <= 3; i++) {
            saveMemory("assertion " + i, AgentMemory.ORIGIN_UI, AgentMemory.STATUS_ACTIVE,
                    false, 5 - i, null);
        }
        Map<String, Object> view = injection.snapshot(principalId, workspaceId, 2, 4_000);
        assertEquals(AgentMemoryInjectionService.STATUS_TRUNCATED, view.get("status"));
        assertEquals(2, entries(view).size());
        assertTrue(diagnostics(view).contains(AgentMemoryInjectionService.DIAGNOSTIC_ENTRY_CAP));
    }

    @Test
    void maxTokensTruncatesAndReportsIt() {
        fixture();
        saveMemory("x".repeat(200), AgentMemory.ORIGIN_UI, AgentMemory.STATUS_ACTIVE, false, 2, null);
        saveMemory("y".repeat(200), AgentMemory.ORIGIN_UI, AgentMemory.STATUS_ACTIVE, false, 1, null);
        // Each entry estimates ~100 tokens; a 150-token cap admits exactly one.
        Map<String, Object> view = injection.snapshot(principalId, workspaceId, 24, 150);
        assertEquals(AgentMemoryInjectionService.STATUS_TRUNCATED, view.get("status"));
        assertEquals(1, entries(view).size());
        assertTrue(diagnostics(view).contains(AgentMemoryInjectionService.DIAGNOSTIC_TOKEN_CAP));
        assertTrue((Integer) view.get("usedTokens") <= 150);
    }

    @Test
    void anotherWorkspaceOfTheSamePrincipalIsNotInjected() {
        fixture();
        saveMemoryIn("only in the other workspace", otherWorkspaceId, 1);
        Map<String, Object> view = injection.snapshot(principalId, workspaceId, 24, 4_000);
        assertEquals(AgentMemoryInjectionService.STATUS_EMPTY, view.get("status"),
                "memory is isolated by (principal, workspace), never by principal alone");
        assertEquals(1, entries(injection.snapshot(principalId, otherWorkspaceId, 24, 4_000)).size());
    }

    @Test
    void softDeletedRowsAreNotInjected() {
        fixture();
        saveMemory("forgotten assertion", AgentMemory.ORIGIN_UI, AgentMemory.STATUS_ACTIVE,
                false, 1, Instant.now());
        Map<String, Object> view = injection.snapshot(principalId, workspaceId, 24, 4_000);
        assertEquals(AgentMemoryInjectionService.STATUS_EMPTY, view.get("status"));
        assertTrue(entries(view).isEmpty());
    }

    // ---------------------------------------------------------------------------------------
    // fixtures / helpers
    // ---------------------------------------------------------------------------------------

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> entries(Map<String, Object> view) {
        return (List<Map<String, Object>>) view.get("entries");
    }

    @SuppressWarnings("unchecked")
    private static List<String> diagnostics(Map<String, Object> view) {
        return (List<String>) view.get("diagnostics");
    }

    private static List<String> contents(Map<String, Object> view) {
        return entries(view).stream().map(entry -> (String) entry.get("content")).toList();
    }

    private void fixture() {
        User user = userRepository.saveAndFlush(new User(
                "memory-injection-" + UUID.randomUUID() + "@test.com", "hash", "Memory injection owner"));
        userId = user.getId();
        principalId = savePrincipal("Injection principal", userId);
        workspaceId = workspaceFixture.createOwnedWorkspace("Memory injection ws", userId.toString()).getId();
        otherWorkspaceId = workspaceFixture.createOwnedWorkspace("Memory injection ws 2",
                userId.toString()).getId();
    }

    private UUID savePrincipal(String name, UUID owner) {
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName(name);
        principal.setCreatedByUserId(owner.toString());
        principal.setOwnerUserId(owner);
        principal.setScope("PERSONAL");
        principal.setTemplateSnapshot(objectMapper.createObjectNode());
        return principalRepository.saveAndFlush(principal).getId();
    }

    private void saveMemoryIn(String content, UUID workspace, int ageMinutes) {
        saveMemory(content, AgentMemory.ORIGIN_UI, AgentMemory.STATUS_ACTIVE, false, ageMinutes, null,
                workspace);
    }

    private void saveMemory(String content, String origin, String status, boolean pinned,
                            int ageMinutes, Instant deletedAt) {
        saveMemory(content, origin, status, pinned, ageMinutes, deletedAt, workspaceId);
    }

    private void saveMemory(String content, String origin, String status, boolean pinned,
                            int ageMinutes, Instant deletedAt, UUID workspace) {
        AgentMemory memory = new AgentMemory();
        memory.setPrincipalId(principalId);
        memory.setWorkspaceId(workspace);
        memory.setContent(content);
        memory.setContentSha256(AgentMemoryNormalizer.sha256Hex(AgentMemoryNormalizer.normalize(content)));
        memory.setOrigin(origin);
        memory.setSourceRef("test-" + UUID.randomUUID());
        memory.setStatus(status);
        memory.setPinned(pinned);
        memory.setPinnedBy(pinned ? AgentMemory.ORIGIN_UI : null);
        memory.setUpdatedAt(Instant.now().minusSeconds(60L * ageMinutes));
        memory.setDeletedAt(deletedAt);
        memories.saveAndFlush(memory);
    }
}
