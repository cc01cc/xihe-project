package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.ChatRunProviderRequest;
import com.cc01cc.p.xihe.cp.repository.ChatRunProviderRequestRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * task-103 (D-1869①) read side: every captured step reaches the envelope in provider order, so
 * attempts = steps count and retries = steps count - 1 without a second round trip.
 */
class RunProviderRequestReadServiceTest {

    private static final UUID RUN = UUID.fromString("00000000-0000-4000-8000-000000000001");

    private final ChatRunProviderRequestRepository repository =
            mock(ChatRunProviderRequestRepository.class);
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final RunProviderRequestReadService service = new RunProviderRequestReadService(repository);

    private ChatRunProviderRequest row(int step, String tier) {
        ChatRunProviderRequest row = new ChatRunProviderRequest();
        row.setRunId(RUN);
        row.setProviderStep(step);
        row.setDispatchAttempt(1);
        row.setApiTypeId("openai-chat-completions");
        row.setApiTypeVersion(1);
        row.setModel("openai/gpt-5");
        row.setMessageCount(5);
        row.setToolCount(3);
        row.setBytesTotal(652L);
        row.setRoleHistogram(objectMapper.createObjectNode().put("user", 2));
        row.setSystemSources(objectMapper.createObjectNode());
        row.setFingerprint(objectMapper.createObjectNode().put("algo", "sha256").put("providerStep", step));
        row.setTier(tier);
        row.setCacheReadInputTokens(step == 1 ? 7L : null);
        row.setRequestSha256("a".repeat(64));
        row.setRequestBytes(652L);
        return row;
    }

    @Test
    void everyStepIsExposedInProviderOrder() {
        ChatRun run = mock(ChatRun.class);
        when(run.getId()).thenReturn(RUN);
        when(run.getSessionId()).thenReturn("session-1");
        when(repository.findByRunIdOrderByProviderStepAsc(RUN))
                .thenReturn(List.of(row(1, "full"), row(2, "metadata")));

        ProviderRequestFingerprintReadService.View view = service.viewFor(run);

        assertThat(view.available()).isTrue();
        assertThat(view.steps()).hasSize(2);
        assertThat(view.steps().get(1).providerStep()).isEqualTo(2);
        // The top-level request/document stays the first step's shape (v1 compatibility).
        assertThat(view.metadata().providerStep()).isEqualTo(1);
        assertThat(view.steps().get(1).audit().cacheReadInputTokens()).isNull();
    }

    @Test
    void noRowStaysNotCapturedAndCarriesNoSteps() {
        ChatRun run = mock(ChatRun.class);
        when(run.getId()).thenReturn(RUN);
        when(run.getSessionId()).thenReturn("session-1");
        when(repository.findByRunIdOrderByProviderStepAsc(RUN)).thenReturn(List.of());

        ProviderRequestFingerprintReadService.View view = service.viewFor(run);

        assertThat(view.available()).isFalse();
        assertThat(view.reason()).isEqualTo("not_captured");
        assertThat(view.steps()).isEmpty();
    }
}