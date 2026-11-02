package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.entity.AgentMemory;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.policy.ContextPolicyValidator;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.fasterxml.jackson.databind.JsonNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.LinkedHashSet;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0629 M1-6 (D29-26/27): the passive (system-side) memory writer — one candidate at most per
 * session end, and never an {@code active} row.
 *
 * <p>Attached to the <b>existing</b> compaction path ({@code ContextService.compact}): that flow already
 * produces the summary this writer reuses, so {@code passive=summary} adds no LLM call at all, and
 * {@code passive=judge} only adds the {@link PassiveMemoryJudge} yes/no question on the existing judge
 * transport. Both land through {@link AgentMemoryService#rememberPassive}, the single passive write
 * entry — there is no repository write in this class.</p>
 *
 * <p>Five rules this class exists to enforce:</p>
 * <ol>
 *   <li><b>Candidate only</b>: the origin is {@code passive.summary|passive.judge} and the service pairs
 *       it with {@code status=candidate}; V99's two CHECKs make the pairing a database invariant.</li>
 *   <li><b>Opt-in and fail-closed</b>: {@code passive=off} (the default), {@code memory.enabled=false}, or
 *       a {@code types} list without {@code fact} all mean "write nothing" — a policy never writes by
 *       implication.</li>
 *   <li><b>Idempotent per session end</b>: the natural key is
 *       {@code source_ref = passive.<mode>:<sessionId>:<compaction cursor>}, probed before writing, so a
 *       retried/duplicated compaction cannot write twice even when the summary text differs.</li>
 *   <li><b>Non-blocking</b>: {@link #onCompaction} never throws — a passive write is a side effect of
 *       compaction and must not be able to fail the compaction, the summary or the run (same discipline
 *       as "missing ≠ failed" on the injection side).</li>
 *   <li><b>Observable</b>: exactly one structured line per attempt,
 *       {@code service=cp event=agent_memory_passive_write outcome=ok|skipped|failed reason=…}, and the
 *       summary text never appears in it (only lengths/ids).</li>
 * </ol>
 */
@Service
public class AgentMemoryPassiveWriter {

    private static final Logger logger = LoggerFactory.getLogger(AgentMemoryPassiveWriter.class);

    public static final String EVENT = "agent_memory_passive_write";
    public static final String OUTCOME_OK = "ok";
    public static final String OUTCOME_SKIPPED = "skipped";
    public static final String OUTCOME_FAILED = "failed";

    public static final String REASON_PASSIVE_OFF = "passive_off";
    public static final String REASON_MEMORY_DISABLED = "memory_disabled";
    public static final String REASON_TYPE_NOT_ALLOWED = "type_not_allowed";
    public static final String REASON_EMPTY_SUMMARY = "empty_summary";
    public static final String REASON_ALREADY_WRITTEN = "already_written";
    public static final String REASON_ALREADY_ACTIVE = "already_active";
    public static final String REASON_NO_PRINCIPAL = "no_agent_principal";
    public static final String REASON_NO_SESSION_OWNER = "no_session_owner";
    public static final String REASON_INVALID_SCOPE = "invalid_scope";
    public static final String REASON_JUDGE_DECLINED = "judge_declined";
    public static final String REASON_JUDGE_UNAVAILABLE = "judge_unavailable";
    public static final String REASON_UNEXPECTED = "unexpected_failure";
    /** The success reason: exactly what landed (a candidate row). */
    public static final String REASON_WRITTEN = "candidate_written";

    /** The one type a compaction summary may become: it is knowledge about the work, not "who you are". */
    public static final String PASSIVE_TYPE = AgentMemory.TYPE_FACT;

    /** How the candidate is marked when the summary is longer than the D29-33 content bound. */
    static final String TRUNCATION_MARKER = " …[truncated]";

    private final SessionRepository sessions;
    private final AgentPrincipalRepository principals;
    private final AgentMemoryService memoryService;
    private final PassiveMemoryJudge judge;

    public AgentMemoryPassiveWriter(SessionRepository sessions, AgentPrincipalRepository principals,
                                    AgentMemoryService memoryService, PassiveMemoryJudge judge) {
        this.sessions = sessions;
        this.principals = principals;
        this.memoryService = memoryService;
        this.judge = judge;
    }

    /**
     * One session end, as seen by the compaction flow.
     *
     * @param cursor the compaction cursor ({@code up_to_sequence}) — part of the idempotency key
     * @param summary the summary that was actually applied (already shrink-validated by the caller)
     */
    public record CompactionEnd(String sessionId, String workspaceId, String trigger, long cursor,
                                String summary) {}

    /** The passive path in one call. Never throws; see rule 4 of the class contract. */
    public void onCompaction(CompactionEnd end) {
        if (end == null) {
            return;
        }
        String origin = null;
        UUID principalId = null;
        try {
            UUID workspaceId = uuidOrNull(end.workspaceId());
            UUID sessionUuid = uuidOrNull(end.sessionId());
            if (workspaceId == null || sessionUuid == null) {
                skip(end, null, null, REASON_INVALID_SCOPE);
                return;
            }
            Session session = sessions.findById(sessionUuid).orElse(null);
            principalId = session == null ? null : uuidOrNull(session.getAgentPrincipalId());
            if (principalId == null) {
                // A session without a bound subject has no memory to write into; missing ≠ failure.
                skip(end, null, null, REASON_NO_PRINCIPAL);
                return;
            }
            // The durable audit row is keyed by a USER (fk_audit_logs_user), and the honest actor of a
            // passive write is the session owner whose session produced it — not the subject, whose id
            // is not a user.
            String auditActor = session.getUserId();
            if (auditActor == null || auditActor.isBlank()) {
                skip(end, principalId, null, REASON_NO_SESSION_OWNER);
                return;
            }
            AgentPrincipal principal = principals.findById(principalId).orElse(null);
            MemoryPolicy policy = MemoryPolicy.of(principal == null ? null : principal.getContextPolicy());
            if (ContextPolicyValidator.PASSIVE_OFF.equals(policy.passive())) {
                skip(end, principalId, null, REASON_PASSIVE_OFF);
                return;
            }
            if (!policy.enabled()) {
                skip(end, principalId, null, REASON_MEMORY_DISABLED);
                return;
            }
            if (!policy.types().contains(PASSIVE_TYPE)) {
                skip(end, principalId, null, REASON_TYPE_NOT_ALLOWED);
                return;
            }
            String content = passiveContent(end.summary());
            if (content.isEmpty()) {
                skip(end, principalId, null, REASON_EMPTY_SUMMARY);
                return;
            }
            origin = ContextPolicyValidator.PASSIVE_SUMMARY.equals(policy.passive())
                    ? AgentMemory.ORIGIN_PASSIVE_SUMMARY
                    : AgentMemory.ORIGIN_PASSIVE_JUDGE;
            String sourceRef = origin + ":" + end.sessionId() + ":" + end.cursor();
            if (memoryService.passiveAlreadyWritten(principalId, workspaceId, sourceRef)) {
                skip(end, principalId, origin, REASON_ALREADY_WRITTEN);
                return;
            }
            if (AgentMemory.ORIGIN_PASSIVE_JUDGE.equals(origin)) {
                PassiveMemoryJudge.Verdict verdict = judge.judge(principalId, end.sessionId(), content);
                if (!verdict.available()) {
                    skip(end, principalId, origin, REASON_JUDGE_UNAVAILABLE + ":" + verdict.reason());
                    return;
                }
                if (!verdict.worthRemembering()) {
                    skip(end, principalId, origin, REASON_JUDGE_DECLINED);
                    return;
                }
            }
            Optional<AgentMemory> written = memoryService.rememberPassive(
                    new AgentMemoryService.PassiveWrite(principalId, workspaceId, PASSIVE_TYPE, content,
                            origin, sourceRef, auditActor));
            if (written.isEmpty()) {
                // An active row already holds this assertion: the passive path must not touch it.
                skip(end, principalId, origin, REASON_ALREADY_ACTIVE);
                return;
            }
            log(OUTCOME_OK, REASON_WRITTEN, end, principalId, origin,
                    written.get().getId() == null ? null : written.get().getId().toString(),
                    content.length());
        } catch (Exception failure) {
            // Rule 4: swallow, but never silently — one structured line with the failure class only
            // (untrusted summary text must not reach the logs, and no content is included).
            logger.warn("[LIFECYCLE] service=cp event={} outcome={} reason={} sessionId={} principalId={} "
                            + "origin={} trigger={} cursor={} error={}", EVENT, OUTCOME_FAILED,
                    REASON_UNEXPECTED, end.sessionId(), principalId, origin, end.trigger(), end.cursor(),
                    failure.getClass().getSimpleName());
        }
    }

    /** The candidate text: normalised, bounded to the D29-33 limit with an explicit truncation marker. */
    static String passiveContent(String summary) {
        String normalized = AgentMemoryNormalizer.normalize(summary == null ? "" : summary);
        if (normalized.isEmpty()) {
            return "";
        }
        if (normalized.length() <= AgentMemory.MAX_CONTENT_LENGTH) {
            return normalized;
        }
        int keep = AgentMemory.MAX_CONTENT_LENGTH - TRUNCATION_MARKER.length();
        return normalized.substring(0, keep) + TRUNCATION_MARKER;
    }

    private void skip(CompactionEnd end, UUID principalId, String origin, String reason) {
        if (REASON_PASSIVE_OFF.equals(reason)) {
            // The documented default: one line per compaction at debug keeps the info lane quiet.
            if (logger.isDebugEnabled()) {
                logDebug(OUTCOME_SKIPPED, reason, end, principalId, origin, null, 0);
            }
            return;
        }
        log(OUTCOME_SKIPPED, reason, end, principalId, origin, null, 0);
    }

    private void log(String outcome, String reason, CompactionEnd end, UUID principalId, String origin,
                     String memoryId, int contentChars) {
        logger.info("[LIFECYCLE] service=cp event={} outcome={} reason={} sessionId={} principalId={} "
                        + "origin={} memoryId={} trigger={} cursor={} contentChars={}", EVENT, outcome, reason,
                end.sessionId(), principalId, origin, memoryId, end.trigger(), end.cursor(), contentChars);
    }

    private void logDebug(String outcome, String reason, CompactionEnd end, UUID principalId, String origin,
                          String memoryId, int contentChars) {
        logger.debug("[LIFECYCLE] service=cp event={} outcome={} reason={} sessionId={} principalId={} "
                        + "origin={} memoryId={} trigger={} cursor={} contentChars={}", EVENT, outcome, reason,
                end.sessionId(), principalId, origin, memoryId, end.trigger(), end.cursor(), contentChars);
    }

    private static UUID uuidOrNull(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(raw);
        } catch (IllegalArgumentException invalid) {
            return null;
        }
    }

    /**
     * The subset of {@code contextPolicy} this writer reads. Parsed defensively (a hand-edited or older
     * document must not throw); {@link ContextPolicyValidator} is still the single write-side gate, so a
     * value outside the frozen vocabulary cannot appear here.
     */
    record MemoryPolicy(boolean enabled, String passive, Set<String> types) {

        static MemoryPolicy of(JsonNode contextPolicy) {
            JsonNode memory = contextPolicy != null && contextPolicy.isObject()
                    ? contextPolicy.get("memory") : null;
            if (memory == null || !memory.isObject()) {
                return new MemoryPolicy(false, ContextPolicyValidator.PASSIVE_OFF, Set.of());
            }
            Set<String> types = new LinkedHashSet<>();
            JsonNode declared = memory.get("types");
            if (declared != null && declared.isArray()) {
                for (JsonNode type : declared) {
                    if (type.isTextual()) {
                        types.add(type.asText());
                    }
                }
            }
            return new MemoryPolicy(memory.path("enabled").asBoolean(false),
                    memory.path("passive").asText(ContextPolicyValidator.PASSIVE_OFF), types);
        }
    }
}
