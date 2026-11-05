package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import org.junit.jupiter.api.Test;
import org.slf4j.Logger;

import java.util.UUID;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

/**
 * BL-354: the diagnostic is log-only and scoped to <b>derived</b> origins. A main submission answered
 * by a HUMAN is deliberately NULL and must stay quiet (otherwise every human reply logs a warning).
 */
class RunPrincipalStampDiagnosticsTest {

    private ChatRun run(String origin) {
        ChatRun run = new ChatRun(UUID.randomUUID().toString(), UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), UUID.randomUUID().toString(), "key", "hash",
                "provider", "model", "workspace", "accepted");
        run.setOrigin(origin);
        return run;
    }

    @Test
    void spawnAndScheduledAndContinuationAreDerived() {
        for (String origin : new String[]{ChatRun.ORIGIN_SPAWN, ChatRun.ORIGIN_SCHEDULED}) {
            ChatRun derived = run(origin);
            Logger logger = mock(Logger.class);
            RunPrincipalStampDiagnostics.logIfDerivedNull(logger, derived);
            verify(logger).warn(anyString(), any(Object[].class));
        }
        ChatRun continuation = run(ChatRun.ORIGIN_USER_SUBMISSION);
        continuation.setContinuationSourceRunId(UUID.randomUUID().toString());
        Logger logger = mock(Logger.class);
        RunPrincipalStampDiagnostics.logIfDerivedNull(logger, continuation);
        verify(logger).warn(anyString(), any(Object[].class));
    }

    @Test
    void userSubmissionAndStampedDerivedRunsStayQuiet() {
        Logger userLogger = mock(Logger.class);
        RunPrincipalStampDiagnostics.logIfDerivedNull(userLogger, run(ChatRun.ORIGIN_USER_SUBMISSION));
        verify(userLogger, never()).warn(anyString(), any(Object[].class));

        ChatRun stampedSpawn = run(ChatRun.ORIGIN_SPAWN);
        stampedSpawn.setAgentPrincipalId(UUID.randomUUID());
        Logger stampedLogger = mock(Logger.class);
        RunPrincipalStampDiagnostics.logIfDerivedNull(stampedLogger, stampedSpawn);
        verify(stampedLogger, never()).warn(anyString(), any(Object[].class));
    }
}
