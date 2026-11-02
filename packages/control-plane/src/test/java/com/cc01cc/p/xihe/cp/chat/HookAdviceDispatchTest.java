package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.policy.HookAdvisor;
import com.cc01cc.p.xihe.cp.policy.HookAdvisorRegistry;
import com.cc01cc.p.xihe.cp.policy.HookInvocation;
import com.cc01cc.p.xihe.cp.policy.HookVerdict;
import com.cc01cc.p.xihe.cp.policy.HookVerdictCache;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.service.GuardHookAdvisor;
import com.cc01cc.p.xihe.cp.service.JudgeDecisionService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.ObjectProvider;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0625 M2 (D25-08/13/16): the hook dispatch beyond the single guard — multi-advisor merge,
 * verdict cache (no second model call), timeout downgrade to ask, deny presented-not-applied,
 * and any-principal subscriptions (D25-09).
 */
class HookAdviceDispatchTest {

    private static final String SESSION_ID = UUID.randomUUID().toString();
    private static final String REQUEST_ID = "33333333-3333-4333-8333-333333333333";

    private ChatApprovalRepository approvals;
    private SessionParticipantRepository participants;
    private AgentPrincipalRepository agents;
    private JudgeDecisionService judge;
    private HookVerdictCache cache;
    private ObjectMapper mapper;

    private ChatApproval approval;
    private SessionParticipant companion;

    @BeforeEach
    void setUp() {
        approvals = mock(ChatApprovalRepository.class);
        participants = mock(SessionParticipantRepository.class);
        agents = mock(AgentPrincipalRepository.class);
        judge = mock(JudgeDecisionService.class);
        cache = new HookVerdictCache();
        mapper = new ObjectMapper();
        approval = new ChatApproval(REQUEST_ID, "run-1", SESSION_ID,
                UUID.randomUUID().toString(), UUID.randomUUID().toString(),
                "write_file", "write", "{}", "pending",
                java.time.Instant.now().plusSeconds(300));
        approval.setPolicySummary("{\"actionClass\":\"write\",\"effect\":\"ask\"}");
        companion = new SessionParticipant(UUID.fromString(SESSION_ID), "AGENT", UUID.randomUUID(),
                "COMPANION", 10, "MENTION", "WHEN_MENTIONED");
    }

    private record FixedAdvisor(String kind, HookVerdict verdict) implements HookAdvisor {
        @Override
        public String kind() {
            return kind;
        }

        @Override
        public HookVerdict advise(HookInvocation invocation) {
            return verdict;
        }
    }

    private GuardAdviceService serviceWith(HookAdvisor... advisors) {
        HookAdvisorRegistry registry = new HookAdvisorRegistry(List.of(advisors));
        @SuppressWarnings("unchecked")
        ObjectProvider<HookAdvisorRegistry> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(registry);
        return new GuardAdviceService(approvals, participants, agents, provider, mapper);
    }

    private AgentPrincipal principalWithHooks(String hooksJson) throws Exception {
        AgentPrincipal principal = new AgentPrincipal();
        principal.setId(companion.getPrincipalId());
        principal.setOrigin(AgentPrincipal.ORIGIN_USER);
        if (hooksJson != null) {
            principal.setHooks(mapper.readTree(hooksJson));
        }
        when(agents.findById(companion.getPrincipalId())).thenReturn(Optional.of(principal));
        when(participants.findBySessionIdOrderByOrderIndexAsc(UUID.fromString(SESSION_ID)))
                .thenReturn(List.of(companion));
        return principal;
    }

    private JsonNode savedSummary() throws Exception {
        ArgumentCaptor<ChatApproval> saved = ArgumentCaptor.forClass(ChatApproval.class);
        verify(approvals, org.mockito.Mockito.atLeastOnce()).save(saved.capture());
        return mapper.readTree(saved.getAllValues().get(saved.getAllValues().size() - 1).getPolicySummary());
    }

    @Test
    void twoSubscribedAdvisorsBothLandInTheVersionedSection() throws Exception {
        principalWithHooks("{\"advisors\":[{\"kind\":\"guard\",\"on\":[\"approval.ask\"]},"
                + "{\"kind\":\"lint\",\"on\":[\"approval.ask\"]}]}");
        GuardAdviceService service = serviceWith(
                new FixedAdvisor("guard", HookVerdict.deny("unsafe")),
                new FixedAdvisor("lint", HookVerdict.allow("fine")));

        service.advise(approval);

        JsonNode advisors = savedSummary().path("hooks").path("advisors");
        assertEquals(2, advisors.size());
        assertEquals("deny", advisors.get(0).path("verdict").asText());
        assertEquals("approve", advisors.get(1).path("verdict").asText());
    }

    @Test
    void subscribedKindWithNoRegisteredAdvisorDoesNotFire() throws Exception {
        // The principal subscribes a kind nobody implements — the registry filter selects nothing,
        // which is the D25-10 plugin seam: a subscription ahead of its advisor is inert, not an error.
        principalWithHooks("{\"advisors\":[{\"kind\":\"ghost\",\"on\":[\"approval.ask\"]}]}");
        GuardAdviceService service = serviceWith(new FixedAdvisor("lint", HookVerdict.deny("x")));

        service.advise(approval);

        verify(approvals, times(0)).save(any());
    }

    @Test
    void verdictCachePreventsASecondModelCallForTheSameFingerprint() throws Exception {
        AgentPrincipal principal = new AgentPrincipal();
        principal.setId(companion.getPrincipalId());
        principal.setOrigin(AgentPrincipal.ORIGIN_USER);
        principal.setHooks(mapper.readTree("{\"advisors\":[{\"kind\":\"guard\",\"on\":[\"approval.ask\"]}]}"));
        when(agents.findById(companion.getPrincipalId())).thenReturn(Optional.of(principal));
        when(participants.findBySessionIdOrderByOrderIndexAsc(UUID.fromString(SESSION_ID)))
                .thenReturn(List.of(companion));
        when(judge.decide(any())).thenReturn(new JudgeDecisionService.JudgeOutcome(true,
                "{\"approve\":true,\"reason\":\"safe\"}", "succeeded", null));
        GuardAdviceService service = serviceWith(new GuardHookAdvisor(judge, cache, mapper));

        service.advise(approval);
        service.advise(approval);

        verify(judge, times(1)).decide(any());
        JsonNode advisors = savedSummary().path("hooks").path("advisors");
        assertEquals(2, advisors.size(), "both rounds record their allow advice");
    }

    @Test
    void unansweredJudgeDowngradesToAskAndRecordsNothing() throws Exception {
        principalWithHooks("{\"advisors\":[{\"kind\":\"guard\",\"on\":[\"approval.ask\"]}]}");
        when(judge.decide(any())).thenReturn(new JudgeDecisionService.JudgeOutcome(false,
                null, "timeout", "judge did not answer within 8s"));
        GuardAdviceService service = serviceWith(new GuardHookAdvisor(judge, cache, mapper));

        service.advise(approval);

        verify(approvals, times(0)).save(any());
        assertEquals("pending", approval.getState(), "D25-08: uncertainty stays an ask — the pending row is untouched");
        assertTrue(mapper.readTree(approval.getPolicySummary()).path("hooks").isMissingNode(),
                "no hooks section appears on the baseline");
    }

    @Test
    void denyIsPresentedAndNeverAutoRejects() throws Exception {
        principalWithHooks("{\"advisors\":[{\"kind\":\"guard\",\"on\":[\"approval.ask\"]}]}");
        GuardAdviceService service = serviceWith(new FixedAdvisor("guard", HookVerdict.deny("touches prod")));

        service.advise(approval);

        assertEquals("pending", approval.getState(),
                "D25-16: deny is only presented — ApprovalService.decide remains the sole executor");
        JsonNode advisors = savedSummary().path("hooks").path("advisors");
        assertEquals("deny", advisors.get(0).path("verdict").asText());
    }
}
