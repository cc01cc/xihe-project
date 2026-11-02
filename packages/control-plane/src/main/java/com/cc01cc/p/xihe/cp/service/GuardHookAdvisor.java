package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.policy.HookAdvisor;
import com.cc01cc.p.xihe.cp.policy.HookInvocation;
import com.cc01cc.p.xihe.cp.policy.HookVerdict;
import com.cc01cc.p.xihe.cp.policy.HookVerdictCache;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;

/**
 * PLAN-0625 M2 (D25-15): the guard as the first {@link HookAdvisor} — the M2 generalization of
 * the G advice. The judge call, prompt, provider/model and the {@code requestId}-as-wakeRoundId
 * dedup key are byte-identical to G's {@code GuardAdviceService}, so one pending action can never
 * trigger two model calls (that was the point of unifying the key).
 *
 * <p>Fail-closed per D25-08: an unanswered judge or an unparseable verdict is reported as
 * {@code ask} — the pending approval simply stays an ask; nothing is auto-allowed.
 */
@Service
public class GuardHookAdvisor implements HookAdvisor {

    public static final String KIND = "guard";

    private static final Logger logger = LoggerFactory.getLogger(GuardHookAdvisor.class);

    private final JudgeDecisionService judgeDecisionService;
    private final HookVerdictCache verdictCache;
    private final ObjectMapper objectMapper;

    public GuardHookAdvisor(JudgeDecisionService judgeDecisionService,
                            HookVerdictCache verdictCache, ObjectMapper objectMapper) {
        this.judgeDecisionService = judgeDecisionService;
        this.verdictCache = verdictCache;
        this.objectMapper = objectMapper;
    }

    @Override
    public String kind() {
        return KIND;
    }

    @Override
    public HookVerdict advise(HookInvocation invocation) {
        JsonNode payload = invocation.payload() == null || invocation.payload().isNull()
                ? objectMapper.createObjectNode()
                : invocation.payload();
        String requestId = payload.path("requestId").asText("");
        String fingerprint = HookVerdictCache.fingerprint(KIND, invocation.actionClass(),
                resourceList(payload), payload.path("whitelistKey").asText(""));
        HookVerdict cached = verdictCache.get(fingerprint);
        if (cached != null) {
            return cached;
        }

        JudgeDecisionService.JudgeOutcome outcome = judgeDecisionService.decide(
                new JudgeDecisionService.JudgeInput(
                        invocation.sessionId(), invocation.runId(), invocation.participantId(),
                        requestId,
                        KIND,
                        "approval requestId=" + requestId
                                + " tool=" + payload.path("tool").asText("")
                                + " action=" + payload.path("action").asText(""),
                        "guard participant " + invocation.participantId(),
                        "bailian", "decision-model-preview",
                        "A pending action needs an advisory verdict. Answer with a short JSON object"
                                + " { \"approve\": true|false, \"reason\": \"...\" }."));
        HookVerdict verdict = toVerdict(outcome);
        verdictCache.put(fingerprint, verdict);
        return verdict;
    }

    private HookVerdict toVerdict(JudgeDecisionService.JudgeOutcome outcome) {
        if (!outcome.answered() || outcome.verdictJson() == null) {
            return HookVerdict.ask(outcome.error() == null ? "judge did not answer" : outcome.error());
        }
        try {
            JsonNode verdict = objectMapper.readTree(outcome.verdictJson());
            return verdict.path("approve").asBoolean(false)
                    ? HookVerdict.allow(verdict.path("reason").asText(""))
                    : HookVerdict.deny(verdict.path("reason").asText(""));
        } catch (Exception unparseable) {
            logger.warn("[LIFECYCLE] service=cp event=guard_hook_verdict_unparseable");
            return HookVerdict.ask("unparseable judge verdict");
        }
    }

    private static List<String> resourceList(JsonNode payload) {
        JsonNode resources = payload.path("resources");
        if (!resources.isArray()) {
            return List.of();
        }
        List<String> values = new ArrayList<>();
        for (JsonNode resource : resources) {
            values.add(resource.asText(""));
        }
        return values;
    }
}
