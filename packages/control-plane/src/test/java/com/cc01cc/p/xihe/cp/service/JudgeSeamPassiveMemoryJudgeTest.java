package com.cc01cc.p.xihe.cp.service;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0629 M1-6 (D29-26): the judge seam of the passive path, pinned without a model or a stack.
 *
 * <p>The rule under test is fail-closed in both directions: an unanswerable judge must yield
 * "unavailable" (so the writer skips instead of writing the summary anyway), and only an explicit
 * {@code "remember": true} counts as approval — a missing field, a string, or unparseable text is a no.
 */
class JudgeSeamPassiveMemoryJudgeTest {

    private static final UUID PRINCIPAL_ID = UUID.fromString("55555555-5555-4555-8555-555555555555");
    private static final String SESSION_ID = "66666666-6666-4666-8666-666666666666";

    private final JudgeModelClient client = mock(JudgeModelClient.class);
    private final JudgeSeamPassiveMemoryJudge judge =
            new JudgeSeamPassiveMemoryJudge(client, new com.fasterxml.jackson.databind.ObjectMapper());

    @Test
    void anExplicitRememberTrueIsTheOnlyApproval() throws Exception {
        when(client.decide(any())).thenReturn(verdict("{\"remember\":true,\"reason\":\"stable fact\"}"));
        PassiveMemoryJudge.Verdict approved = judge.judge(PRINCIPAL_ID, SESSION_ID, "summary");
        assertTrue(approved.available());
        assertTrue(approved.worthRemembering());
        assertEquals("stable fact", approved.reason());
        assertEquals(12L, approved.promptTokens());
        assertEquals(3L, approved.completionTokens());
    }

    @Test
    void aStringOrMissingRememberIsANo() throws Exception {
        when(client.decide(any())).thenReturn(verdict("{\"remember\":\"yes\"}"));
        PassiveMemoryJudge.Verdict stringy = judge.judge(PRINCIPAL_ID, SESSION_ID, "summary");
        assertTrue(stringy.available());
        assertFalse(stringy.worthRemembering(), "only an explicit JSON true may write");

        when(client.decide(any())).thenReturn(verdict("{\"reason\":\"nothing to say\"}"));
        PassiveMemoryJudge.Verdict missing = judge.judge(PRINCIPAL_ID, SESSION_ID, "summary");
        assertTrue(missing.available());
        assertFalse(missing.worthRemembering());
    }

    @Test
    void anUnwiredOrFailingJudgeIsReportedAsUnavailable() throws Exception {
        // doThrow, not when(...): re-stubbing a method that already throws would execute the stub.
        org.mockito.Mockito.doThrow(new JudgeModelClient.JudgeException(
                        JudgeModelClient.JudgeException.Kind.FAILED, "judge model client is not wired yet"))
                .when(client).decide(any());
        PassiveMemoryJudge.Verdict failed = judge.judge(PRINCIPAL_ID, SESSION_ID, "summary");
        assertFalse(failed.available(), "no answer ⇒ no write (never a silent yes)");
        assertEquals("judge_unavailable", failed.reason());

        org.mockito.Mockito.doThrow(new JudgeModelClient.JudgeException(
                        JudgeModelClient.JudgeException.Kind.TIMEOUT, "8s"))
                .when(client).decide(any());
        assertEquals("judge_timeout", judge.judge(PRINCIPAL_ID, SESSION_ID, "summary").reason(),
                "a timeout is reported separately so the audit shows which leg failed");
    }

    @Test
    void anUnparseableVerdictIsANoNotAnImplicitYes() throws Exception {
        when(client.decide(any())).thenReturn(verdict("this is not json"));
        PassiveMemoryJudge.Verdict unparseable = judge.judge(PRINCIPAL_ID, SESSION_ID, "summary");
        assertFalse(unparseable.available());
        assertFalse(unparseable.worthRemembering());
        assertEquals("judge_verdict_unparseable", unparseable.reason());
    }

    @Test
    void theJudgeReadsABoundedPrefixOnTheExistingTransportIdentity() throws Exception {
        when(client.decide(any())).thenReturn(verdict("{\"remember\":false}"));
        judge.judge(PRINCIPAL_ID, SESSION_ID, "s".repeat(JudgeSeamPassiveMemoryJudge.MAX_JUDGED_CHARS + 100));

        ArgumentCaptor<JudgeModelClient.JudgeRequest> request =
                ArgumentCaptor.forClass(JudgeModelClient.JudgeRequest.class);
        verify(client).decide(request.capture());
        assertEquals(JudgeSeamPassiveMemoryJudge.MODEL_PROVIDER, request.getValue().modelProvider());
        assertEquals(JudgeSeamPassiveMemoryJudge.MODEL_NAME, request.getValue().modelName());
        int promptChars = request.getValue().prompt().length();
        assertTrue(promptChars < JudgeSeamPassiveMemoryJudge.MAX_JUDGED_CHARS + 400,
                "the prompt must stay bounded: " + promptChars);
        assertTrue(request.getValue().prompt().contains("remember"),
                "the judge is asked for the documented verdict shape");
    }

    private static JudgeModelClient.JudgeVerdict verdict(String text) {
        return new JudgeModelClient.JudgeVerdict(text, 12L, 3L, 40L);
    }
}
