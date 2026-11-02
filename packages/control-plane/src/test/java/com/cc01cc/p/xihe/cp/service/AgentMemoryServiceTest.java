package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
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
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0629 M1 (V99): the memory service contract on a real PostgreSQL.
 *
 * <p>The rules exercised here are the ones that would silently rot if only reviewed: dedupe keeps one
 * row and the <b>original</b> provenance (Lead ruling: a hit refreshes {@code updated_at} only), soft
 * delete frees the dedupe key, isolation is by {@code (principal, workspace)}, the tool channel can
 * never pin, and the v1 write surface refuses passive origins / oversized or blank content. Audit
 * assertions double as the "no raw memory content in durable audit" check.</p>
 */
class AgentMemoryServiceTest extends AbstractIntegrationTest {

    @Autowired private AgentMemoryService memoryService;
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
        jdbcTemplate.update("DELETE FROM audit_logs WHERE resource_type = 'agent_memory'");
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
    void aDedupeHitRefreshesUpdatedAtButKeepsTheOriginalProvenance() {
        fixture();
        AgentMemory first = memoryService.remember(write("profile", "  Likes concise answers  ",
                AgentMemory.ORIGIN_TOOL, "run-1", false));

        AgentMemory second = memoryService.remember(write("profile", "Likes concise   answers",
                AgentMemory.ORIGIN_UI, "user-1", false));

        assertEquals(first.getId(), second.getId(), "the same assertion must not create a second row");
        assertEquals(1, memories.count());
        assertEquals("Likes concise answers", second.getContent(), "the stored form is normalized");
        assertEquals(AgentMemory.ORIGIN_TOOL, second.getOrigin(),
                "a hit keeps the original origin (the audit records the hitting channel)");
        assertEquals("run-1", second.getSourceRef(),
                "a hit keeps the original source_ref: the assertion did not change");
        assertTrue(second.getUpdatedAt().isAfter(first.getUpdatedAt().minusNanos(1)));
        assertEquals(1, auditCount(AgentMemoryService.AUDIT_CREATED));
        assertEquals(1, auditCount(AgentMemoryService.AUDIT_DEDUPE_HIT));
    }

    @Test
    void forgetIsASoftDeleteThatFreesTheDedupeKey() {
        fixture();
        AgentMemory stored = memoryService.remember(write("fact", "Deploys happen on Fridays",
                AgentMemory.ORIGIN_CLI, "cmd-1", false));

        memoryService.forget(principalId, workspaceId, stored.getId(), userId.toString());

        assertTrue(memories.findById(stored.getId()).orElseThrow().getDeletedAt() != null);
        assertTrue(memoryService.activeMemories(principalId, workspaceId).isEmpty(),
                "a forgotten assertion is no longer injected");
        assertEquals(1, auditCount(AgentMemoryService.AUDIT_DELETED));

        AgentMemory rewritten = memoryService.remember(write("fact", "Deploys happen on Fridays",
                AgentMemory.ORIGIN_CLI, "cmd-2", false));
        assertFalse(rewritten.getId().equals(stored.getId()),
                "after a soft delete the same content may be remembered again as a live row");
        assertEquals(2, memories.count());
    }

    @Test
    void isolationIsByPrincipalAndWorkspace() {
        fixture();
        memoryService.remember(write("fact", "Shared sentence", AgentMemory.ORIGIN_UI, "user-1", false));

        // Same content, different workspace: a different assertion scope, so a second row is correct.
        AgentMemory inOtherWorkspace = memoryService.remember(new AgentMemoryService.MemoryWrite(
                principalId, otherWorkspaceId, "fact", "Shared sentence",
                AgentMemory.ORIGIN_UI, "user-1", false, userId.toString()));

        assertEquals(2, memories.count());
        assertEquals(1, memoryService.activeMemories(principalId, workspaceId).size());
        assertEquals(List.of(inOtherWorkspace.getId()),
                memoryService.activeMemories(principalId, otherWorkspaceId).stream()
                        .map(AgentMemory::getId).toList());
    }

    @Test
    void onlyTheUiAndCliChannelsMayPinAndPinnedRowsComeFirst() {
        fixture();
        CpApiException toolPin = assertThrows(CpApiException.class, () -> memoryService.remember(
                write("fact", "Pinned by tool?", AgentMemory.ORIGIN_TOOL, "run-1", true)));
        assertEquals(HttpStatus.BAD_REQUEST, toolPin.getStatus());
        assertTrue(toolPin.getMessage().contains("ui or cli"));

        memoryService.remember(write("fact", "Older but pinned", AgentMemory.ORIGIN_UI, "user-1", true));
        memoryService.remember(write("fact", "Newer but not pinned", AgentMemory.ORIGIN_UI, "user-1", false));

        List<AgentMemory> injected = memoryService.activeMemories(principalId, workspaceId);
        assertEquals(2, injected.size());
        assertTrue(injected.getFirst().isPinned(), "injection order is pinned first");
        assertEquals(AgentMemory.ORIGIN_UI, injected.getFirst().getPinnedBy());
    }

    @Test
    void v1RefusesPassiveOriginsAndKeepsTheContentBound() {
        fixture();
        CpApiException passive = assertThrows(CpApiException.class, () -> memoryService.remember(
                write("fact", "Candidate text", AgentMemory.ORIGIN_PASSIVE_SUMMARY, "run-1", false)));
        assertEquals(HttpStatus.BAD_REQUEST, passive.getStatus());
        assertTrue(passive.getMessage().contains("passive memory writes are not available in v1"));

        CpApiException blank = assertThrows(CpApiException.class, () -> memoryService.remember(
                write("fact", "   \u200B  ", AgentMemory.ORIGIN_UI, "user-1", false)));
        assertEquals("INVALID_REQUEST", blank.getCode());

        CpApiException tooLong = assertThrows(CpApiException.class, () -> memoryService.remember(
                write("fact", "x".repeat(AgentMemory.MAX_CONTENT_LENGTH + 1),
                        AgentMemory.ORIGIN_UI, "user-1", false)));
        assertEquals("MEMORY_CONTENT_TOO_LONG", tooLong.getCode());

        CpApiException badType = assertThrows(CpApiException.class, () -> memoryService.remember(
                write("opinion", "not a v1 type", AgentMemory.ORIGIN_UI, "user-1", false)));
        assertEquals("INVALID_REQUEST", badType.getCode());

        assertEquals(0, memories.count(), "no rejected write may reach the table");
    }

    @Test
    void aForeignMemoryIdIsIndistinguishableFromAMissingOne() {
        fixture();
        AgentMemory stored = memoryService.remember(write("fact", "Scoped row",
                AgentMemory.ORIGIN_UI, "user-1", false));

        CpApiException error = assertThrows(CpApiException.class, () -> memoryService.forget(
                principalId, otherWorkspaceId, stored.getId(), userId.toString()));
        assertEquals(HttpStatus.NOT_FOUND, error.getStatus());
        assertEquals("MEMORY_NOT_FOUND", error.getCode());
        assertNull(memories.findById(stored.getId()).orElseThrow().getDeletedAt(),
                "a cross-workspace id must not delete anything");
    }

    @Test
    void auditKeepsTheHashAndProvenanceButNeverTheRawContent() {
        fixture();
        String secret = "the user's private sentence";
        AgentMemory stored = memoryService.remember(write("fact", secret,
                AgentMemory.ORIGIN_TOOL, "run-42", false));

        List<String> details = jdbcTemplate.queryForList(
                "SELECT details FROM audit_logs WHERE action = ? AND CAST(resource_id AS VARCHAR) = ?",
                String.class, AgentMemoryService.AUDIT_CREATED, stored.getId().toString());
        assertEquals(1, details.size());
        String detail = details.getFirst();
        assertTrue(detail.contains(stored.getContentSha256()), "the hash identifies the assertion");
        assertTrue(detail.contains("run-42"), "the provenance reference is recorded");
        assertFalse(detail.contains(secret), "raw memory content must never enter durable audit");
    }

    // ---------------------------------------------------------------------------------------
    // PLAN-0629 M1-6: the passive path can only produce candidates (D29-26/27)
    // ---------------------------------------------------------------------------------------

    @Test
    void aPassiveWriteLandsAsACandidateThatIsNeverInjected() {
        fixture();

        Optional<AgentMemory> written = memoryService.rememberPassive(passive("fact",
                "Deploys happen on Fridays", AgentMemory.ORIGIN_PASSIVE_SUMMARY,
                "passive.summary:sess-1:7"));

        assertTrue(written.isPresent(), "a clean passive write must land");
        AgentMemory candidate = written.get();
        assertEquals(AgentMemory.STATUS_CANDIDATE, candidate.getStatus(),
                "the passive path writes candidates only");
        assertEquals(AgentMemory.ORIGIN_PASSIVE_SUMMARY, candidate.getOrigin(),
                "the origin records WHICH passive producer wrote it (audit/UI distinction)");
        assertFalse(candidate.isPinned(), "a passive write can never pin (V99: pinned ⇒ active)");
        assertTrue(memoryService.activeMemories(principalId, workspaceId).isEmpty(),
                "a candidate is invisible to the injection read");
        assertEquals(1, memories.count());
        assertEquals(1, auditCount(AgentMemoryService.AUDIT_CREATED));
        assertEquals(0, auditCount(AgentMemoryService.AUDIT_DEDUPE_HIT));
    }

    @Test
    void theDatabaseItselfRefusesAPassiveRowThatIsNotACandidate() {
        fixture();
        // Proof that "passive ⇒ candidate" is a database invariant, not service discipline: this insert
        // bypasses the service entirely and must be rejected by V99's CHECK pair.
        assertThrows(org.springframework.dao.DataAccessException.class, () -> jdbcTemplate.update(
                "INSERT INTO agent_memories (principal_id, workspace_id, type, content, content_sha256,"
                        + " origin, source_ref, status) VALUES (CAST(? AS UUID), CAST(? AS UUID), 'fact',"
                        + " 'active by hand', ?, 'passive.summary', 'hand-written', 'active')",
                principalId.toString(), workspaceId.toString(),
                "0".repeat(64)));
        assertEquals(0, memories.count(), "the rejected row must not be there");
    }

    @Test
    void anExplicitWritePromotesTheCandidateAndOnlyThenDoesItCount() {
        fixture();
        memoryService.rememberPassive(passive("fact", "Prefers concise answers",
                AgentMemory.ORIGIN_PASSIVE_SUMMARY, "passive.summary:sess-2:9"));
        assertTrue(memoryService.activeMemories(principalId, workspaceId).isEmpty(),
                "before promotion the assertion is invisible");

        AgentMemory promoted = memoryService.remember(
                write("fact", "Prefers concise answers", AgentMemory.ORIGIN_UI, "user-9", false));

        assertEquals(AgentMemory.STATUS_ACTIVE, promoted.getStatus(),
                "only an explicit channel write promotes a candidate");
        assertEquals(AgentMemory.ORIGIN_UI, promoted.getOrigin(),
                "the explicit channel takes over the provenance (a passive origin may not be active)");
        assertEquals("user-9", promoted.getSourceRef());
        assertEquals(1, memories.count(), "promotion updates the row instead of adding a second one");
        assertEquals(List.of(promoted.getId()), memoryService.activeMemories(principalId, workspaceId)
                .stream().map(AgentMemory::getId).toList());
        assertEquals(1, auditCount(AgentMemoryService.AUDIT_PROMOTED));
    }

    @Test
    void aPassiveWriteNeverTouchesAnActiveRow() {
        fixture();
        AgentMemory active = memoryService.remember(
                write("fact", "Already in effect", AgentMemory.ORIGIN_UI, "user-1", false));
        var updatedAtBefore = memories.findById(active.getId()).orElseThrow().getUpdatedAt();

        Optional<AgentMemory> passiveHit = memoryService.rememberPassive(passive("fact",
                "Already in effect", AgentMemory.ORIGIN_PASSIVE_JUDGE, "passive.judge:sess-3:1"));

        assertTrue(passiveHit.isEmpty(),
                "a passive write of an already-active assertion is a no-op, not an update");
        assertEquals(1, memories.count());
        assertEquals(updatedAtBefore, memories.findById(active.getId()).orElseThrow().getUpdatedAt(),
                "a passive path must not reorder injection by refreshing an active row's updated_at");
    }

    @Test
    void thePassiveEntryRefusesExplicitOrigins() {
        fixture();
        CpApiException explicit = assertThrows(CpApiException.class, () -> memoryService.rememberPassive(
                passive("fact", "Not a passive channel", AgentMemory.ORIGIN_UI, "src-1")));
        assertEquals(HttpStatus.BAD_REQUEST, explicit.getStatus());
        assertTrue(explicit.getMessage().contains("passive memory origin must be one of"),
                "the two entry points may not be mixed: " + explicit.getMessage());
        assertEquals(0, memories.count());
    }

    // ---------------------------------------------------------------------------------------
    // fixtures / helpers
    // ---------------------------------------------------------------------------------------

    private AgentMemoryService.PassiveWrite passive(String type, String content, String origin,
                                                    String sourceRef) {
        return new AgentMemoryService.PassiveWrite(principalId, workspaceId, type, content, origin,
                sourceRef, userId.toString());
    }

    private AgentMemoryService.MemoryWrite write(String type, String content, String origin,
                                                 String sourceRef, boolean pinned) {
        return new AgentMemoryService.MemoryWrite(principalId, workspaceId, type, content, origin,
                sourceRef, pinned, userId.toString());
    }

    private void fixture() {
        User user = userRepository.saveAndFlush(new User(
                "memory-service-" + UUID.randomUUID() + "@test.com", "hash", "Memory service owner"));
        userId = user.getId();
        principalId = savePrincipal("Memory owner principal", userId);
        workspaceId = workspaceFixture.createOwnedWorkspace("Memory service ws", userId.toString()).getId();
        otherWorkspaceId = workspaceFixture.createOwnedWorkspace("Memory other ws", userId.toString()).getId();
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

    private int auditCount(String action) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE action = ?", Integer.class, action);
    }
}