package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.entity.JudgeDecision;
import com.cc01cc.p.xihe.cp.repository.JudgeDecisionRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0624 M1 commit 1 — the four paths of the judge core (Q2 fail-closed / D24-02 throttle),
 * provider-agnostic: the {@link JudgeModelClient} is mocked; the concrete Agent-side transport
 * lands in commit 2 after the Q6 probe fixes the model wire shape.
 */
class JudgeDecisionServiceTest {

    private static final UUID SESSION_ID = UUID.randomUUID();
    private static final UUID PARTICIPANT_ID = UUID.randomUUID();
    private static final UUID RUN_ID = UUID.randomUUID();

    private JudgeModelClient client;
    private JudgeDecisionRepository repository;
    private JudgeDecisionService service;

    @BeforeEach
    void setUp() {
        client = mock(JudgeModelClient.class);
        repository = mock(JudgeDecisionRepository.class);
        when(repository.save(any(JudgeDecision.class))).thenAnswer(call -> call.getArgument(0));
        service = new JudgeDecisionService(client, repository, new ObjectMapper());
    }

    private static JudgeDecisionService.JudgeInput input(String wakeRound) {
        return new JudgeDecisionService.JudgeInput(SESSION_ID, RUN_ID, PARTICIPANT_ID, wakeRound,
                "mention", "lastN=20 seq=100..119 summary=plan0624 duty-template=v1",
                "duty description", "bailian", "decision-model-preview",
                "should this participant respond?");
    }

    @Test
    void verdictPathStoresTheRawVerdictAndMeteredFacts() throws Exception {
        when(client.decide(any())).thenReturn(
                new JudgeModelClient.JudgeVerdict("{\"speak\":true,\"reason\":\"direct question\"}",
                        3180, 12, 412));

        JudgeDecisionService.JudgeOutcome outcome = service.decide(input("round-1"));

        assertTrue(outcome.answered());
        assertEquals("succeeded", outcome.outcome());
        assertNull(outcome.error());
        assertTrue(outcome.verdictJson().contains("\"speak\":true"), "verdict stored untouched");
        org.mockito.ArgumentCaptor<JudgeDecision> saved = org.mockito.ArgumentCaptor.forClass(JudgeDecision.class);
        verify(repository).save(saved.capture());
        assertEquals("succeeded", saved.getValue().getOutcome());
        assertEquals(3180L, saved.getValue().getPromptTokens());
        assertEquals(12L, saved.getValue().getCompletionTokens());
        assertEquals(412, saved.getValue().getLatencyMs());
        assertEquals("bailian", saved.getValue().getModelProvider());
        assertEquals("decision-model-preview", saved.getValue().getModelName());
        assertEquals("mention", saved.getValue().getTriggerSource());
        assertNotNull(saved.getValue().getVerdict());
    }

    @Test
    void emptyVerdictIsFailedNotGuessed() throws Exception {
        when(client.decide(any())).thenReturn(new JudgeModelClient.JudgeVerdict("  ", 12, 0, 3));

        JudgeDecisionService.JudgeOutcome outcome = service.decide(input("round-empty"));

        assertFalse(outcome.answered(), "spec §1: an empty answer is not a silent no-speak");
        assertEquals("failed", outcome.outcome());
        assertEquals(JudgeDecisionService.ERROR_VERDICT_EMPTY, outcome.error());
        assertNull(outcome.verdictJson());
        org.mockito.ArgumentCaptor<JudgeDecision> saved = org.mockito.ArgumentCaptor.forClass(JudgeDecision.class);
        verify(repository).save(saved.capture());
        assertEquals("failed", saved.getValue().getOutcome());
        assertFalse(saved.getValue().getVerdict().path("speak").asBoolean(),
                "failed rows carry the no-speak placeholder");
    }

    @Test
    void nonJsonVerdictIsFailedNotWrapped() throws Exception {
        when(client.decide(any())).thenReturn(
                new JudgeModelClient.JudgeVerdict("yes, answer it", 20, 2, 5));

        JudgeDecisionService.JudgeOutcome outcome = service.decide(input("round-not-json"));

        assertFalse(outcome.answered());
        assertEquals("failed", outcome.outcome());
        assertEquals(JudgeDecisionService.ERROR_VERDICT_NOT_JSON, outcome.error());
        assertNull(outcome.verdictJson(), "strict path never wraps free text as a verdict");
        org.mockito.ArgumentCaptor<JudgeDecision> saved = org.mockito.ArgumentCaptor.forClass(JudgeDecision.class);
        verify(repository).save(saved.capture());
        assertEquals("failed", saved.getValue().getOutcome());
        assertFalse(saved.getValue().getVerdict().path("speak").asBoolean());
    }

    @Test
    void verdictWithoutSpeakIsFailedNotSilentFalse() throws Exception {
        when(client.decide(any())).thenReturn(
                new JudgeModelClient.JudgeVerdict("{\"reason\":\"no explicit flag\"}", 30, 3, 7));

        JudgeDecisionService.JudgeOutcome outcome = service.decide(input("round-missing-speak"));

        assertFalse(outcome.answered(), "missing speak must not become speak=false");
        assertEquals("failed", outcome.outcome());
        assertEquals(JudgeDecisionService.ERROR_VERDICT_MISSING_SPEAK, outcome.error());
        assertNull(outcome.verdictJson());
        org.mockito.ArgumentCaptor<JudgeDecision> saved = org.mockito.ArgumentCaptor.forClass(JudgeDecision.class);
        verify(repository).save(saved.capture());
        assertEquals("failed", saved.getValue().getOutcome());
        assertFalse(saved.getValue().getVerdict().path("speak").asBoolean());
    }

    @Test
    void failurePathIsFailClosedAndAudited() throws Exception {
        when(client.decide(any())).thenThrow(
                new JudgeModelClient.JudgeException(JudgeModelClient.JudgeException.Kind.FAILED,
                        "agent endpoint answered 502"));

        JudgeDecisionService.JudgeOutcome outcome = service.decide(input("round-fail"));

        assertFalse(outcome.answered(), "Q2: a failed judge never speaks");
        assertEquals("failed", outcome.outcome());
        assertNotNull(outcome.error());
        assertNull(outcome.verdictJson());
        org.mockito.ArgumentCaptor<JudgeDecision> saved = org.mockito.ArgumentCaptor.forClass(JudgeDecision.class);
        verify(repository).save(saved.capture());
        assertEquals("failed", saved.getValue().getOutcome());
        assertFalse(saved.getValue().getVerdict().path("speak").asBoolean(),
                "failure rows carry the explicit no-speak placeholder");
    }

    @Test
    void timeoutPathIsAuditedSeparately() throws Exception {
        when(client.decide(any())).thenThrow(
                new JudgeModelClient.JudgeException(JudgeModelClient.JudgeException.Kind.TIMEOUT,
                        "judge did not answer within 8s"));

        JudgeDecisionService.JudgeOutcome outcome = service.decide(input("round-timeout"));

        assertFalse(outcome.answered());
        assertEquals("timeout", outcome.outcome(), "timeout is its own audit outcome, not a generic failure");
        assertNotNull(outcome.error());
    }

    @Test
    void throttleAllowsOneJudgePerParticipantAndRound() throws Exception {
        when(client.decide(any())).thenReturn(
                new JudgeModelClient.JudgeVerdict("{\"speak\":false}", 100, 1, 50));
        JudgeDecisionService.JudgeInput first = input("round-throttle");
        JudgeDecisionService.JudgeInput duplicate = input("round-throttle");

        JudgeDecisionService.JudgeOutcome firstOutcome = service.decide(first);
        JudgeDecisionService.JudgeOutcome secondOutcome = service.decide(duplicate);

        assertTrue(firstOutcome.answered());
        assertFalse(secondOutcome.answered());
        assertEquals("throttled", secondOutcome.outcome());
        assertNotNull(secondOutcome.error());
        verify(client, times(1)).decide(any());
        // exactly one transport call — the duplicate never reached the model (D24-02)
        org.mockito.ArgumentCaptor<JudgeDecision> saved = org.mockito.ArgumentCaptor.forClass(JudgeDecision.class);
        verify(repository, times(2)).save(saved.capture());
        assertEquals("succeeded", saved.getAllValues().get(0).getOutcome());
        assertEquals("throttled", saved.getAllValues().get(1).getOutcome());

        // A new round is a new decision — the dedupe key is (participant, wakeRound), not participant alone.
        assertTrue(service.decide(input("round-throttle-next")).answered());
    }
}
