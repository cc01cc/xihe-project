package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.service.JudgeDecisionService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0625 G (D25-04/06): guard advice lands in the approval's versioned hooks section;
 * fail-closed when there is no guard, an unwired judge, or an unparseable verdict.
 */
class GuardAdviceServiceTest {

    private static final String SESSION_ID = UUID.randomUUID().toString();
    private static final String REQUEST_ID = "22222222-2222-4222-8222-222222222222";

    private ChatApprovalRepository approvals;
    private SessionParticipantRepository participants;
    private AgentPrincipalRepository agents;
    private JudgeDecisionService judge;
    private GuardAdviceService service;

    private ChatApproval approval;
    private SessionParticipant guard;

    @BeforeEach
    void setUp() {
        approvals = mock(ChatApprovalRepository.class);
        participants = mock(SessionParticipantRepository.class);
        agents = mock(AgentPrincipalRepository.class);
        judge = mock(JudgeDecisionService.class);
        service = new GuardAdviceService(approvals, participants, agents, judge,
                new ObjectMapper());

        approval = new ChatApproval(REQUEST_ID, "run-1", SESSION_ID,
                UUID.randomUUID().toString(), UUID.randomUUID().toString(),
                "write_file", "write", "{}", "pending",
                java.time.Instant.now().plusSeconds(300));
        approval.setPolicySummary("{\"actionClass\":\"write\",\"effect\":\"ask\",\"sourceLayer\":\"workspace\","
                + "\"reason\":\"workspace approval mode\"}");

        guard = new SessionParticipant(UUID.fromString(SESSION_ID), "AGENT", UUID.randomUUID(),
                "GUARD", 20, "MENTION", "WHEN_MENTIONED");
    }

    private void stubGuardPresent() {
        when(participants.findBySessionIdOrderByOrderIndexAsc(UUID.fromString(SESSION_ID)))
                .thenReturn(List.of(guard));
        when(agents.findById(guard.getPrincipalId())).thenAnswer(invocation -> {
            AgentPrincipal principal = new AgentPrincipal();
            principal.setId(guard.getPrincipalId());
            principal.setOrigin(AgentPrincipal.ORIGIN_SYSTEM_PRESET);
            return Optional.of(principal);
        });
    }

    @Test
    void approveVerdictPatchesTheVersionedHooksSection() throws Exception {
        stubGuardPresent();
        when(judge.decide(any())).thenReturn(new JudgeDecisionService.JudgeOutcome(true,
                "{\"approve\":true,\"reason\":\"safe path\"}", "succeeded", null));

        service.advise(approval);

        ArgumentCaptor<ChatApproval> saved = ArgumentCaptor.forClass(ChatApproval.class);
        verify(approvals).save(saved.capture());
        com.fasterxml.jackson.databind.JsonNode root =
                new ObjectMapper().readTree(saved.getValue().getPolicySummary());
        assertEquals(GuardAdviceService.HOOKS_SECTION_VERSION, root.path("hooks").path("version").asInt(),
                "the hooks section is versioned — M2 advisors extend it, they do not fork it");
        com.fasterxml.jackson.databind.JsonNode advice = root.path("hooks").path("advisors").get(0);
        assertEquals("guard", advice.path("kind").asText());
        assertEquals("approve", advice.path("verdict").asText());
        assertEquals("safe path", advice.path("reason").asText());
        assertEquals("ask", root.path("effect").asText(), "the original policy fields are untouched");
    }

    @Test
    void denyVerdictIsRecordedAndNeverOverwrittenByALaterAllow() throws Exception {
        stubGuardPresent();
        when(judge.decide(any())).thenReturn(new JudgeDecisionService.JudgeOutcome(true,
                "{\"approve\":false,\"reason\":\"touches prod config\"}", "succeeded", null));
        service.advise(approval);
        when(judge.decide(any())).thenReturn(new JudgeDecisionService.JudgeOutcome(true,
                "{\"approve\":true,\"reason\":\"changed my mind\"}", "succeeded", null));
        service.advise(approval);

        ArgumentCaptor<ChatApproval> saved = ArgumentCaptor.forClass(ChatApproval.class);
        verify(approvals).save(saved.capture());
        com.fasterxml.jackson.databind.JsonNode root =
                new ObjectMapper().readTree(saved.getValue().getPolicySummary());
        assertEquals(1, root.path("hooks").path("advisors").size(),
                "deny-priority: one deny, never overwritten by a later allow");
        assertEquals("deny", root.path("hooks").path("advisors").get(0).path("verdict").asText());
    }

    @Test
    void noGuardLeavesTheSummaryUntouched() {
        when(participants.findBySessionIdOrderByOrderIndexAsc(UUID.fromString(SESSION_ID)))
                .thenReturn(List.of());

        service.advise(approval);

        verify(approvals, never()).save(any());
        assertTrue(approval.getPolicySummary().contains("\"effect\":\"ask\""));
    }

    @Test
    void judgeFailureIsFailClosed() throws Exception {
        stubGuardPresent();
        when(judge.decide(any())).thenReturn(new JudgeDecisionService.JudgeOutcome(false,
                null, "timeout", "judge did not answer within 8s"));

        service.advise(approval);

        verify(approvals, never()).save(any());
        assertNull(new ObjectMapper().readTree(approval.getPolicySummary()).path("hooks").path("advisors").get(0),
                "no advice field appears — the human decider sees exactly the baseline");
    }
}
