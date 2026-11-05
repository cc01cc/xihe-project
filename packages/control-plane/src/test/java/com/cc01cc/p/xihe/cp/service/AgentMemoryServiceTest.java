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
import static org.junit.jupiter.api.Assertions.assertNotNull;
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
        AgentMemory first = memoryService.remember(write("  Likes concise answers  ",
                AgentMemory.ORIGIN_TOOL, "run-1", false));

        AgentMemory second = memoryService.remember(write("Likes concise   answers",
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
        AgentMemory stored = memoryService.remember(write("Deploys happen on Fridays",
                AgentMemory.ORIGIN_CLI, "cmd-1", false));

        memoryService.forget(principalId, workspaceId, stored.getId(), userId.toString());

        assertTrue(memories.findById(stored.getId()).orElseThrow().getDeletedAt() != null);
        assertTrue(memoryService.activeMemories(principalId).isEmpty(),
                "a forgotten assertion is no longer injected");
        assertEquals(1, auditCount(AgentMemoryService.AUDIT_DELETED));

        AgentMemory rewritten = memoryService.remember(write("Deploys happen on Fridays",
                AgentMemory.ORIGIN_CLI, "cmd-2", false));
        assertFalse(rewritten.getId().equals(stored.getId()),
                "after a soft delete the same content may be remembered again as a live row");
        assertEquals(2, memories.count());
    }

    @Test
    void oneMemorySetIsSharedAcrossWorkspacesOfTheSamePrincipal() {
        fixture();
        AgentMemory first = memoryService.remember(
                write("Deploys happen on Fridays", AgentMemory.ORIGIN_UI, "user-1", false));

        // V107 (user ruling 2026-11-04): the workspace authorizes a write, it does not partition one.
        // The very same sentence written from another workspace is a dedupe hit, not a second row.
        AgentMemory fromOtherWorkspace = memoryService.remember(new AgentMemoryService.MemoryWrite(
                principalId, otherWorkspaceId, "Deploys happen on Fridays",
                AgentMemory.ORIGIN_UI, "user-1", false, userId.toString()));

        assertEquals(1, memories.count(), "one assertion, one row, regardless of workspace");
        assertEquals(first.getId(), fromOtherWorkspace.getId());
        assertEquals(1, memoryService.activeMemories(principalId).size());

        // And a different sentence written from the other workspace is visible from this one.
        memoryService.remember(new AgentMemoryService.MemoryWrite(
                principalId, otherWorkspaceId, "Never bake on release day",
                AgentMemory.ORIGIN_UI, "user-1", false, userId.toString()));
        assertEquals(List.of("Deploys happen on Fridays", "Never bake on release day").size(),
                memoryService.activeMemories(principalId).size());
    }

    @Test
    void onlyTheUiAndCliChannelsMayPinAndPinnedRowsComeFirst() {
        fixture();
        CpApiException toolPin = assertThrows(CpApiException.class, () -> memoryService.remember(
                write("Pinned by tool?", AgentMemory.ORIGIN_TOOL, "run-1", true)));
        assertEquals(HttpStatus.BAD_REQUEST, toolPin.getStatus());
        assertTrue(toolPin.getMessage().contains("ui or cli"));

        memoryService.remember(write("Older but pinned", AgentMemory.ORIGIN_UI, "user-1", true));
        memoryService.remember(write("Newer but not pinned", AgentMemory.ORIGIN_UI, "user-1", false));

        List<AgentMemory> injected = memoryService.activeMemories(principalId);
        assertEquals(2, injected.size());
        assertTrue(injected.getFirst().isPinned(), "injection order is pinned first");
        assertEquals(AgentMemory.ORIGIN_UI, injected.getFirst().getPinnedBy());
    }

    @Test
    void v1RefusesPassiveOriginsAndKeepsTheContentBound() {
        fixture();
        CpApiException passive = assertThrows(CpApiException.class, () -> memoryService.remember(
                write("Candidate text", AgentMemory.ORIGIN_PASSIVE_SUMMARY, "run-1", false)));
        assertEquals(HttpStatus.BAD_REQUEST, passive.getStatus());
        assertTrue(passive.getMessage().contains("passive memory writes are not available in v1"));

        CpApiException blank = assertThrows(CpApiException.class, () -> memoryService.remember(
                write("   \u200B  ", AgentMemory.ORIGIN_UI, "user-1", false)));
        assertEquals("INVALID_REQUEST", blank.getCode());

        CpApiException tooLong = assertThrows(CpApiException.class, () -> memoryService.remember(
                write("x".repeat(AgentMemory.MAX_CONTENT_LENGTH + 1),
                        AgentMemory.ORIGIN_UI, "user-1", false)));
        assertEquals("MEMORY_CONTENT_TOO_LONG", tooLong.getCode());


        assertEquals(0, memories.count(), "no rejected write may reach the table");
    }

    @Test
    void aForeignPrincipalMemoryIdIsIndistinguishableFromAMissingOne() {
        fixture();
        AgentMemory stored = memoryService.remember(write("Scoped row",
                AgentMemory.ORIGIN_UI, "user-1", false));

        // V107: the subject is the boundary, so "foreign" now means another principal — a
        // cross-workspace call of the same principal is legal (see the sharing test above) and must
        // not be turned into a 404, otherwise the ruling would be invisible on the wire.
        UUID foreignPrincipal = savePrincipal("Foreign principal", userId);
        CpApiException error = assertThrows(CpApiException.class, () -> memoryService.forget(
                foreignPrincipal, workspaceId, stored.getId(), userId.toString()));
        assertEquals(HttpStatus.NOT_FOUND, error.getStatus());
        assertEquals("MEMORY_NOT_FOUND", error.getCode());
        assertNull(memories.findById(stored.getId()).orElseThrow().getDeletedAt(),
                "a foreign principal's id must not delete anything");

        memoryService.forget(principalId, otherWorkspaceId, stored.getId(), userId.toString());
        assertNotNull(memories.findById(stored.getId()).orElseThrow().getDeletedAt(),
                "the same principal may archive from any authorizing workspace");

        // The second principal exists only for this test; the shared fixture cleanup deletes users and
        // would trip fk_agent_principals_created_by_user if the row were left behind.
        principalRepository.deleteById(foreignPrincipal);
        principalRepository.flush();
    }

    @Test
    void auditKeepsTheHashAndProvenanceButNeverTheRawContent() {
        fixture();
        String secret = "the user's private sentence";
        AgentMemory stored = memoryService.remember(write(secret,
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

        Optional<AgentMemory> written = memoryService.rememberPassive(passive("Deploys happen on Fridays", AgentMemory.ORIGIN_PASSIVE_SUMMARY,
                "passive.summary:sess-1:7"));

        assertTrue(written.isPresent(), "a clean passive write must land");
        AgentMemory candidate = written.get();
        assertEquals(AgentMemory.STATUS_CANDIDATE, candidate.getStatus(),
                "the passive path writes candidates only");
        assertEquals(AgentMemory.ORIGIN_PASSIVE_SUMMARY, candidate.getOrigin(),
                "the origin records WHICH passive producer wrote it (audit/UI distinction)");
        assertFalse(candidate.isPinned(), "a passive write can never pin (V99: pinned ⇒ active)");
        assertTrue(memoryService.activeMemories(principalId).isEmpty(),
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
                "INSERT INTO agent_memories (principal_id, workspace_id, content, content_sha256,"
                        + " origin, source_ref, status) VALUES (CAST(? AS UUID), CAST(? AS UUID),"
                        + " 'active by hand', ?, 'passive.summary', 'hand-written', 'active')",
                principalId.toString(), workspaceId.toString(),
                "0".repeat(64)));
        assertEquals(0, memories.count(), "the rejected row must not be there");
    }

    @Test
    void anExplicitWritePromotesTheCandidateAndOnlyThenDoesItCount() {
        fixture();
        memoryService.rememberPassive(passive("Prefers concise answers",
                AgentMemory.ORIGIN_PASSIVE_SUMMARY, "passive.summary:sess-2:9"));
        assertTrue(memoryService.activeMemories(principalId).isEmpty(),
                "before promotion the assertion is invisible");

        AgentMemory promoted = memoryService.remember(
                write("Prefers concise answers", AgentMemory.ORIGIN_UI, "user-9", false));

        assertEquals(AgentMemory.STATUS_ACTIVE, promoted.getStatus(),
                "only an explicit channel write promotes a candidate");
        assertEquals(AgentMemory.ORIGIN_UI, promoted.getOrigin(),
                "the explicit channel takes over the provenance (a passive origin may not be active)");
        assertEquals("user-9", promoted.getSourceRef());
        assertEquals(1, memories.count(), "promotion updates the row instead of adding a second one");
        assertEquals(List.of(promoted.getId()), memoryService.activeMemories(principalId)
                .stream().map(AgentMemory::getId).toList());
        assertEquals(1, auditCount(AgentMemoryService.AUDIT_PROMOTED));
    }

    @Test
    void aPassiveWriteNeverTouchesAnActiveRow() {
        fixture();
        AgentMemory active = memoryService.remember(
                write("Already in effect", AgentMemory.ORIGIN_UI, "user-1", false));
        var updatedAtBefore = memories.findById(active.getId()).orElseThrow().getUpdatedAt();

        Optional<AgentMemory> passiveHit = memoryService.rememberPassive(passive("Already in effect", AgentMemory.ORIGIN_PASSIVE_JUDGE, "passive.judge:sess-3:1"));

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
                passive("Not a passive channel", AgentMemory.ORIGIN_UI, "src-1")));
        assertEquals(HttpStatus.BAD_REQUEST, explicit.getStatus());
        assertTrue(explicit.getMessage().contains("passive memory origin must be one of"),
                "the two entry points may not be mixed: " + explicit.getMessage());
        assertEquals(0, memories.count());
    }

    // ---------------------------------------------------------------------------------------
    // PLAN-0629 M1-5: the in-place edit (PATCH) and the archive read face
    // ---------------------------------------------------------------------------------------

    @Test
    void anEditRehashesInPlaceAndKeepsTheIdentity() {
        fixture();
        AgentMemory stored = memoryService.remember(write("Prefers short answers",
                AgentMemory.ORIGIN_UI, "user-1", false));
        String originalHash = stored.getContentSha256();

        AgentMemory edited = memoryService.update(new AgentMemoryService.MemoryUpdate(
                principalId, workspaceId, stored.getId(), "Prefers  very short   answers", true,
                userId.toString()));

        assertEquals(stored.getId(), edited.getId(), "an edit is not a second row");
        assertEquals(1, memories.count());
        assertEquals("Prefers very short answers", edited.getContent(), "the stored form is normalized");
        assertFalse(originalHash.equals(edited.getContentSha256()),
                "a changed assertion must get a new hash, or dedupe would lie");
        assertEquals(AgentMemoryNormalizer.sha256Hex(edited.getContent()), edited.getContentSha256());
        assertTrue(edited.isPinned());
        assertEquals(AgentMemory.ORIGIN_UI, edited.getPinnedBy(), "V99: only ui|cli may pin");
        assertEquals(AgentMemory.ORIGIN_UI, edited.getOrigin(),
                "an edit keeps the original channel: provenance records where it came from");
        assertEquals(1, auditCount(AgentMemoryService.AUDIT_UPDATED));
    }

    @Test
    void anEditCannotSilentlyBecomeADuplicateAndCannotTouchACandidate() {
        fixture();
        memoryService.remember(write("first assertion", AgentMemory.ORIGIN_UI, "user-1", false));
        AgentMemory second = memoryService.remember(
                write("second assertion", AgentMemory.ORIGIN_UI, "user-1", false));

        CpApiException duplicate = assertThrows(CpApiException.class, () -> memoryService.update(
                new AgentMemoryService.MemoryUpdate(principalId, workspaceId, second.getId(),
                        "first assertion", null, userId.toString())));
        assertEquals(HttpStatus.CONFLICT, duplicate.getStatus());
        assertEquals("MEMORY_DUPLICATE", duplicate.getCode());
        assertEquals("second assertion", memories.findById(second.getId()).orElseThrow().getContent(),
                "a refused edit must not change the row");

        AgentMemory candidate = memoryService.rememberPassive(passive("candidate assertion",
                AgentMemory.ORIGIN_PASSIVE_SUMMARY, "passive.summary:sess-1:1")).orElseThrow();
        CpApiException invisible = assertThrows(CpApiException.class, () -> memoryService.update(
                new AgentMemoryService.MemoryUpdate(principalId, workspaceId, candidate.getId(),
                        "edited candidate", null, userId.toString())));
        assertEquals(HttpStatus.NOT_FOUND, invisible.getStatus(),
                "a candidate is invisible: by id it looks exactly like a missing row");
        assertEquals("MEMORY_NOT_FOUND", invisible.getCode());

        CpApiException nothingToDo = assertThrows(CpApiException.class, () -> memoryService.update(
                new AgentMemoryService.MemoryUpdate(principalId, workspaceId, second.getId(), null, null,
                        userId.toString())));
        assertEquals("INVALID_REQUEST", nothingToDo.getCode());
    }

    @Test
    void theStatusFilterSeparatesInEffectFromArchived() {
        fixture();
        AgentMemory live = memoryService.remember(write("still in effect", AgentMemory.ORIGIN_UI, "user-1", false));
        AgentMemory archived = memoryService.remember(
                write("archived one", AgentMemory.ORIGIN_UI, "user-1", false));
        memoryService.forget(principalId, workspaceId, archived.getId(), userId.toString());

        assertEquals(List.of(live.getId()), memoryService
                .listMemories(principalId, AgentMemoryService.MemoryStatus.ACTIVE)
                .stream().map(AgentMemory::getId).toList());
        assertEquals(List.of(archived.getId()), memoryService
                .listMemories(principalId, AgentMemoryService.MemoryStatus.RETIRED)
                .stream().map(AgentMemory::getId).toList(),
                "the archive must stay readable, or a soft delete looks like data loss");
        assertEquals(2, memoryService
                .listMemories(principalId, AgentMemoryService.MemoryStatus.ALL).size());
        assertTrue(memoryService.activeMemories(principalId).stream()
                        .noneMatch(row -> row.getId().equals(archived.getId())),
                "injection keeps using the live-only finder");
    }

    // ---------------------------------------------------------------------------------------
    // fixtures / helpers
    // ---------------------------------------------------------------------------------------

    private AgentMemoryService.PassiveWrite passive(String content, String origin,
                                                    String sourceRef) {
        return new AgentMemoryService.PassiveWrite(principalId, workspaceId, content, origin,
                sourceRef, userId.toString());
    }

    private AgentMemoryService.MemoryWrite write(String content, String origin,
                                                 String sourceRef, boolean pinned) {
        return new AgentMemoryService.MemoryWrite(principalId, workspaceId, content, origin,
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
        principal.setTemplateSnapshot(objectMapper.createObjectNode());
        return principalRepository.saveAndFlush(principal).getId();
    }

    private int auditCount(String action) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE action = ?", Integer.class, action);
    }
}
