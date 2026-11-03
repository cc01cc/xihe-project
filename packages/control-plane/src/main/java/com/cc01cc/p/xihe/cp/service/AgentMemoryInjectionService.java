package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.entity.AgentMemory;
import com.cc01cc.p.xihe.cp.repository.AgentMemoryRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0629 M1-4 (D29-20): the per-run memory injection snapshot handed to the Agent's system slot.
 *
 * <p>This is the CP half of the read path; the Agent half ({@code context/builder.py}) only renders
 * what arrives here and charges it against the run's single injection ledger. Splitting it this way
 * keeps the ordering/limit rule in one place (CP owns the data) and the budget in one place (Agent
 * owns {@code charge_assembly}).</p>
 *
 * <p>Frozen selection rule (D29-20 / task book): rows of exactly one {@code (principal, workspace)}
 * with {@code status='active' AND deleted_at IS NULL}, ordered
 * <b>pinned DESC, then updated_at DESC</b> (the {@code type='profile'} key is gone with V106), capped
 * by both {@code maxEntries} and {@code maxTokens}. Candidates (passive writes, D29-26/27) are never
 * injected in v1; a soft-deleted row is gone.</p>
 *
 * <p>Token estimate: {@code chars / 2}, deliberately the same conservative rule as the Agent's
 * {@code injection_budget.conservative_token_count} — the two sides must agree, or CP would hand over
 * more text than the ledger can charge and the Agent would have to drop it after the fact.</p>
 *
 * <p>Output is plain {@code Map}/{@code List}/scalars on purpose: 0633 C1 forbids a Jackson-2
 * {@code JsonNode} leaving a response/SSE/snapshot (Boot 4 serialises it as bean metadata).</p>
 */
@Service
public class AgentMemoryInjectionService {

    /** CP-side entry cap when a component omits it; a UX bound, not a D27-22 number. */
    public static final int DEFAULT_MAX_ENTRIES = 24;
    /**
     * D27-22 fallback: the memory cap is {@code 4% * window} and this is the value used when the
     * window is unknown ({@code MEMORY_FALLBACK_CAP_TOKENS} in {@code context/injection_budget.py}).
     * The floor is {@code 2% * window} and is enforced by the Agent ledger, not here.
     */
    public static final int DEFAULT_MAX_TOKENS = 4_000;
    public static final int MAX_ENTRIES_UPPER = 500;
    public static final int MAX_TOKENS_UPPER = 100_000;

    public static final String STATUS_READY = "ready";
    public static final String STATUS_EMPTY = "empty";
    public static final String STATUS_TRUNCATED = "truncated";
    public static final String STATUS_FAILED = "failed";

    /**
     * PLAN-0629 M1-5: the {@code source} discriminator of this component view, mirroring
     * {@code SkillCatalogSourceService.SOURCE} ({@code "skill_bindings"}). The Agent fills the
     * {@code ${xh.agent_memory}} slot by matching this tag, so a component source must be
     * self-describing instead of recognised by its shape (two views with the same keys would
     * otherwise be indistinguishable).
     */
    public static final String SOURCE = "agent_memory";

    public static final String DIAGNOSTIC_MISSING_PRINCIPAL = "missing_agent_principal";
    public static final String DIAGNOSTIC_ENTRY_CAP = "memory_entry_cap";
    public static final String DIAGNOSTIC_TOKEN_CAP = "memory_token_cap";

    private final AgentMemoryRepository memories;

    public AgentMemoryInjectionService(AgentMemoryRepository memories) {
        this.memories = memories;
    }

    /**
     * The injection order: pinned first, freshest second, then the id as a deterministic tiebreak.
     *
     * <p>PLAN-0629 M1-5 (V106) removed the {@code profile}/{@code fact} classification, so the old
     * "profile before fact inside a pinned group" key is gone; ordering no longer claims anything about
     * the assertion itself.</p>
     */
    private static final Comparator<AgentMemory> INJECTION_ORDER = Comparator
            .comparingInt((AgentMemory memory) -> memory.isPinned() ? 0 : 1)
            .thenComparing(AgentMemory::getUpdatedAt, Comparator.reverseOrder())
            .thenComparing(memory -> memory.getId().toString());

    /**
     * @param maxEntries positive entry cap (already bounded by the caller)
     * @param maxTokens positive token cap (already bounded by the caller)
     * @return the component source document for this instance (plain JSON)
     */
    @Transactional(readOnly = true)
    public Map<String, Object> snapshot(UUID principalId, UUID workspaceId, int maxEntries, int maxTokens) {
        Map<String, Object> view = new LinkedHashMap<>();
        List<String> diagnostics = new ArrayList<>();
        if (principalId == null || workspaceId == null) {
            diagnostics.add(DIAGNOSTIC_MISSING_PRINCIPAL);
            return view(STATUS_FAILED, List.of(), false, diagnostics, maxEntries, maxTokens, 0);
        }
        List<AgentMemory> rows = memories
                .findByPrincipalIdAndWorkspaceIdAndStatusAndDeletedAtIsNullOrderByPinnedDescUpdatedAtDesc(
                        principalId, workspaceId, AgentMemory.STATUS_ACTIVE);
        if (rows.isEmpty()) {
            return view(STATUS_EMPTY, List.of(), false, diagnostics, maxEntries, maxTokens, 0);
        }
        // The repository orders by (pinned, updated_at); the final order is decided here, once, so
        // the tiebreak is identical for every caller.
        List<AgentMemory> ordered = new ArrayList<>(rows);
        ordered.sort(INJECTION_ORDER);
        boolean truncated = false;
        List<Map<String, Object>> entries = new ArrayList<>();
        int used = 0;
        for (AgentMemory memory : ordered) {
            if (entries.size() >= maxEntries) {
                truncated = true;
                diagnostics.add(DIAGNOSTIC_ENTRY_CAP);
                break;
            }
            int tokens = estimateTokens(memory.getContent());
            if (used + tokens > maxTokens) {
                truncated = true;
                diagnostics.add(DIAGNOSTIC_TOKEN_CAP);
                break;
            }
            used += tokens;
            entries.add(entry(memory, tokens));
        }
        return view(truncated ? STATUS_TRUNCATED : STATUS_READY, entries, truncated, diagnostics,
                maxEntries, maxTokens, used);
    }

    /**
     * A source document that injects nothing but says why (the Agent renders the component as empty and
     * keeps the diagnostic). Used for a run without a resolvable principal/workspace and for an invalid
     * session↔workspace binding — never as a silent fallback to a wider scope.
     */
    public static Map<String, Object> unavailable(int maxEntries, int maxTokens, String diagnostic) {
        return view(STATUS_FAILED, List.of(), false, List.of(diagnostic), maxEntries, maxTokens, 0);
    }

    /**
     * Same rule as {@code injection_budget.conservative_token_count}: pessimistic (char/2) so the
     * Agent ledger never has to drop text CP already promised.
     */
    public static int estimateTokens(String content) {
        if (content == null || content.isEmpty()) {
            return 0;
        }
        return Math.max(1, content.length() / 2);
    }

    private static Map<String, Object> entry(AgentMemory memory, int tokens) {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("pinned", memory.isPinned());
        entry.put("updatedAt", memory.getUpdatedAt() == null ? null : memory.getUpdatedAt().toString());
        entry.put("content", memory.getContent());
        entry.put("tokens", tokens);
        return entry;
    }

    private static Map<String, Object> view(String status, List<Map<String, Object>> entries,
                                            boolean truncated, List<String> diagnostics,
                                            int maxEntries, int maxTokens, int usedTokens) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("source", SOURCE);
        view.put("status", status);
        view.put("entries", entries);
        view.put("truncated", truncated);
        view.put("diagnostics", List.copyOf(diagnostics));
        view.put("maxEntries", maxEntries);
        view.put("maxTokens", maxTokens);
        view.put("usedTokens", usedTokens);
        return view;
    }
}
