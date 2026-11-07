package com.cc01cc.p.xihe.cp.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.UUID;

/**
 * PLAN-0629 M1-6 (D29-26): {@link PassiveMemoryJudge} on the existing judge transport seam.
 *
 * <p>Why {@link JudgeModelClient} and not {@link JudgeDecisionService}: the latter owns the
 * "should this participant speak / may this action proceed" decisions and writes a durable
 * {@code judge_decisions} row keyed by {@code (participant, wakeRound)}. A memory-worthiness question has
 * neither a participant nor a wake round, so borrowing that service would either invent a fake
 * participant or pollute a table whose rows mean something else. The <b>transport</b> is the reusable
 * part, and it is the same one the two existing judge call sites use — the model identity below is
 * copied from them verbatim ({@code GuardHookAdvisor}, {@code WakeDispatchService}) so a future
 * config-driven judge identity changes in one place for all three.</p>
 *
 * <p>Metering: the returned token counts are the provider's own numbers (possibly {@code null} — never
 * synthesized, PLAN-0416 T2.3) and the caller writes them into the structured log. The transport used
 * to log {@code judge_client_unwired} while no real client was wired; that fail-closed stub has since
 * been removed (PLAN-0690 T1.2b), so the only client bean is {@link AgentJudgeModelClient} and this
 * judge reports unavailable when that client fails closed.</p>
 */
@Component
public class JudgeSeamPassiveMemoryJudge implements PassiveMemoryJudge {

    private static final Logger logger = LoggerFactory.getLogger(JudgeSeamPassiveMemoryJudge.class);

    /** Same identity as the two existing judge call sites (D24-04 decision-model-preview). */
    static final String MODEL_PROVIDER = "bailian";
    static final String MODEL_NAME = "decision-model-preview";

    /** The judge reads a bounded prefix: the question is "worth keeping?", not "summarise this". */
    static final int MAX_JUDGED_CHARS = 4_000;

    private static final String PROMPT_HEADER =
            "You are deciding whether a compacted conversation summary is worth keeping as durable"
                    + " memory for an agent. Answer with ONLY a short JSON object:"
                    + " {\"remember\": true|false, \"reason\": \"...\"}."
                    + " Say true only for stable, reusable facts; say false for small talk, one-off"
                    + " task state, or anything that will not help a future session.\n\nSummary:\n";

    private final JudgeModelClient judgeModelClient;
    private final ObjectMapper objectMapper;

    public JudgeSeamPassiveMemoryJudge(JudgeModelClient judgeModelClient, ObjectMapper objectMapper) {
        this.judgeModelClient = judgeModelClient;
        this.objectMapper = objectMapper;
    }

    @Override
    public Verdict judge(UUID principalId, String sessionId, String content) {
        try {
            JudgeModelClient.JudgeVerdict verdict = judgeModelClient.decide(
                    new JudgeModelClient.JudgeRequest(MODEL_PROVIDER, MODEL_NAME, prompt(content)));
            JsonNode parsed = objectMapper.readTree(verdict.verdictText());
            boolean remember = parsed.path("remember").asBoolean(false);
            return Verdict.answer(remember, parsed.path("reason").asText(""),
                    verdict.promptTokens(), verdict.completionTokens());
        } catch (JudgeModelClient.JudgeException notAnswered) {
            String reason = notAnswered.kind() == JudgeModelClient.JudgeException.Kind.TIMEOUT
                    ? "judge_timeout" : "judge_unavailable";
            logger.warn("[LIFECYCLE] service=cp event=agent_memory_passive_judge_unavailable "
                    + "reason={} sessionId={} principalId={}", reason, sessionId, principalId);
            return Verdict.unavailable(reason);
        } catch (Exception unparseable) {
            // An unreadable verdict is "no answer", never an implicit yes (fail-closed, Q2 phrasing).
            logger.warn("[LIFECYCLE] service=cp event=agent_memory_passive_judge_unparseable "
                    + "sessionId={} principalId={} error={}", sessionId, principalId,
                    unparseable.getClass().getSimpleName());
            return Verdict.unavailable("judge_verdict_unparseable");
        }
    }

    private static String prompt(String content) {
        String bounded = content == null ? "" : content;
        if (bounded.length() > MAX_JUDGED_CHARS) {
            bounded = bounded.substring(0, MAX_JUDGED_CHARS);
        }
        return PROMPT_HEADER + bounded;
    }
}
