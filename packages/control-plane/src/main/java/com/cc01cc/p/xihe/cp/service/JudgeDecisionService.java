package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.entity.JudgeDecision;
import com.cc01cc.p.xihe.cp.repository.JudgeDecisionRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * PLAN-0624 M1: judge decision execution — assemble-free core of path A.
 *
 * <p>Per D24-03 this service has <b>no trigger</b>: M4's wake executor calls it when
 * {@code respond_policy=JUDGE}. The governor (MODEL admission + separate metering, G-04/Q1) wraps
 * the call site, not this class — admission happens before a run exists.</p>
 *
 * <p>Rules baked in here:</p>
 * <ul>
 *   <li><b>Throttle (D24-02)</b>: one judge per {@code (participant, wakeRound)}. Failures are not
 *       retried inside the round — fail-closed means retrying cannot change "do not speak", it only
 *       doubles latency and cost. The dedupe set is in-memory and bounded; M4's trigger lifecycle
 *       owns the durable round scoping if a second CP node ever needs it.</li>
 *   <li><b>Fail-closed (Q2)</b>: every path — success, failure, timeout, throttle — writes exactly
 *       one {@code judge_decisions} row, and a non-success outcome always reports
 *       {@code speak=false} with the reason in {@code error}.</li>
 *   <li><b>Verdict raw (Q6)</b>: the success row stores the judge output untouched; only the
 *       metered facts (tokens, latency) are lifted into columns.</li>
 *   <li><b>Strict verdict (PLAN-0690 T1.2b / spec §1/§8)</b>: empty text, non-JSON text, a JSON
 *       value that is not an object, or a missing/non-boolean {@code speak} is a
 *       {@code failed} row ("did not answer") — never guessed and never silently read as
 *       {@code speak=false}. {@link #parseVerdict} keeps its text fallback for lenient callers.</li>
 * </ul>
 */
@Service
public class JudgeDecisionService {

    /** Fail-closed verdict placeholder for rows where no judge output exists (keeps verdict NOT NULL). */
    private static final JsonNode NO_SPEAK = new ObjectMapper().createObjectNode().put("speak", false);

    /** Strict-verdict reason codes (spec §5: {@code error} carries a short code, never the body). */
    static final String ERROR_VERDICT_EMPTY = "verdict_empty";
    static final String ERROR_VERDICT_NOT_JSON = "verdict_not_json";
    static final String ERROR_VERDICT_NOT_OBJECT = "verdict_not_object";
    static final String ERROR_VERDICT_MISSING_SPEAK = "verdict_missing_speak";
    static final String ERROR_VERDICT_SPEAK_NOT_BOOLEAN = "verdict_speak_not_boolean";

    /** D24-02 dedupe: (participant, wakeRound) once. Bounded; M4 owns durable round scoping. */
    private static final int DEDUPE_CAPACITY = 100_000;
    private final Set<String> judgedRounds = ConcurrentHashMap.newKeySet();

    private final JudgeModelClient judgeModelClient;
    private final JudgeDecisionRepository judgeDecisionRepository;
    private final ObjectMapper objectMapper;

    public JudgeDecisionService(JudgeModelClient judgeModelClient,
                                JudgeDecisionRepository judgeDecisionRepository,
                                ObjectMapper objectMapper) {
        this.judgeModelClient = judgeModelClient;
        this.judgeDecisionRepository = judgeDecisionRepository;
        this.objectMapper = objectMapper;
    }

    /**
     * Runs one judge decision and always audits it.
     *
     * <p>PLAN-0660 T2.1: the audit row lives in its own transaction. Joining the caller's wake
     * transaction let a failed insert mark that shared transaction rollback-only while
     * {@code fire()} still returned {@code judged_no}; the outer commit then threw
     * {@link org.springframework.transaction.UnexpectedRollbackException} and dropped the whole
     * round. A separate transaction makes the durable judge result and the wake outcome agree:
     * a failed judge row rolls back only here, and the caller records the refusal it actually
     * observed.</p>
     *
     * @return the outcome; {@code speak()} is true only when the judge returned a verdict — the
     *     verdict body itself ({@code verdictJson}) is what M4 inspects; this service never
     *     interprets it.
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public JudgeOutcome decide(JudgeInput input) {
        String dedupeKey = input.participantId() + ":" + input.wakeRoundId();
        if (!judgedRounds.add(dedupeKey)) {
            return audit(input, JudgeDecision.OUTCOME_THROTTLED,
                    "judge already invoked for this participant in wake round " + input.wakeRoundId(),
                    null, null, null, null);
        }
        if (judgedRounds.size() > DEDUPE_CAPACITY) {
            // Bounded memory: rounds are short-lived identifiers; a crude reset beats an OOM.
            // M4 replaces this with durable round scoping if multi-node CP ever needs it.
            judgedRounds.clear();
        }
        try {
            JudgeModelClient.JudgeVerdict verdict = judgeModelClient.decide(
                    new JudgeModelClient.JudgeRequest(input.modelProvider(), input.modelName(),
                            input.prompt(), input.sessionId(), input.runId()));
            String invalidReason = invalidVerdictReason(verdict.verdictText());
            if (invalidReason != null) {
                // spec §1/§2: an unusable verdict is a failed decision, not "the judge said no".
                return audit(input, JudgeDecision.OUTCOME_FAILED, invalidReason, null,
                        verdict.promptTokens(), verdict.completionTokens(), verdict.latencyMs());
            }
            return audit(input, JudgeDecision.OUTCOME_SUCCEEDED, null, parseVerdict(verdict.verdictText()),
                    verdict.promptTokens(), verdict.completionTokens(), verdict.latencyMs());
        } catch (JudgeModelClient.JudgeException e) {
            String outcome = e.kind() == JudgeModelClient.JudgeException.Kind.TIMEOUT
                    ? JudgeDecision.OUTCOME_TIMEOUT : JudgeDecision.OUTCOME_FAILED;
            return audit(input, outcome, e.getMessage(), null, null, null, null);
        }
    }

    private JudgeOutcome audit(JudgeInput input, String outcome, String error, JsonNode verdict,
                               Long promptTokens, Long completionTokens, Long latencyMs) {
        JudgeDecision row = new JudgeDecision(input.sessionId(), input.runId(), input.participantId(),
                input.triggerSource(), input.inputWindow(),
                verdict == null ? NO_SPEAK : verdict,
                input.modelProvider(), input.modelName(),
                latencyMs == null ? 0 : latencyMs.intValue(), promptTokens, completionTokens,
                outcome, error);
        judgeDecisionRepository.save(row);
        return new JudgeOutcome(outcome.equals(JudgeDecision.OUTCOME_SUCCEEDED),
                Optional.ofNullable(verdict).map(JsonNode::toString).orElse(null),
                outcome, error);
    }

    /**
     * Strict verdict contract (PLAN-0690 T1.2b / spec §1/§8): the judge must answer with a JSON
     * object carrying a boolean {@code speak}. Anything else is a failed decision, so the row says
     * "the judge did not answer" instead of silently turning into {@code speak=false}.
     *
     * @return the short reason code to store in {@code error}, or {@code null} when the verdict is
     *     usable
     */
    private String invalidVerdictReason(String verdictText) {
        if (verdictText == null || verdictText.isBlank()) {
            return ERROR_VERDICT_EMPTY;
        }
        JsonNode parsed;
        try {
            parsed = objectMapper.readTree(verdictText);
        } catch (Exception notJson) {
            return ERROR_VERDICT_NOT_JSON;
        }
        if (parsed == null || !parsed.isObject()) {
            return ERROR_VERDICT_NOT_OBJECT;
        }
        JsonNode speak = parsed.get("speak");
        if (speak == null) {
            return ERROR_VERDICT_MISSING_SPEAK;
        }
        if (!speak.isBoolean()) {
            return ERROR_VERDICT_SPEAK_NOT_BOOLEAN;
        }
        return null;
    }

    /** The judge's raw text when it is JSON, otherwise wrapped as a JSON string (never dropped). */
    private JsonNode parseVerdict(String verdictText) {
        try {
            return objectMapper.readTree(verdictText);
        } catch (Exception notJson) {
            return objectMapper.getNodeFactory().textNode(verdictText);
        }
    }

    /** Assembled by the CP wiring (commit 2): Q1 window facts + model identity + prompt. */
    public record JudgeInput(UUID sessionId, UUID runId, UUID participantId, String wakeRoundId,
                             String triggerSource, String inputWindow, String dutyDescription,
                             String modelProvider, String modelName, String prompt) {}

    /** What M4 consumes: did the judge answer, and with what. */
    public record JudgeOutcome(boolean answered, String verdictJson, String outcome, String error) {}
}
