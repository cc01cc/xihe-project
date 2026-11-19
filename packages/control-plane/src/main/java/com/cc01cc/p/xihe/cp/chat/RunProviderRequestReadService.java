package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.ChatRunProviderRequest;
import com.cc01cc.p.xihe.cp.repository.ChatRunProviderRequestRepository;
import org.springframework.stereotype.Service;

import java.util.List;

/**
 * PLAN-0679 T2.3 + task-103: the one impure step of the provider-request read path, kept out of the
 * controller.
 *
 * <p>{@code CpArchitectureTest#controllersDoNotDependOnRepositories} forbids a controller from
 * holding a JPA repository, so "does this run have stored steps, and what did each carry" lives
 * here. The projection itself stays pure in {@link ProviderRequestFingerprintReadService} (no
 * repository, no clock, no HTTP) - this service only resolves the rows and hands them over.</p>
 */
@Service
public class RunProviderRequestReadService {

    private final ChatRunProviderRequestRepository providerRequestRepository;

    public RunProviderRequestReadService(ChatRunProviderRequestRepository providerRequestRepository) {
        this.providerRequestRepository = providerRequestRepository;
    }

    /**
     * Row presence is the only truth. There is no "submitted but not yet captured" state to name:
     * the diagnostics event travels with the dispatch, so between capture and absence the run is
     * simply not captured yet (envelope reason {@code not_captured}, two-level model).
     *
     * <p>task-103: every step is returned, in provider order. {@code fingerprint} / {@code request} at
     * the top of the envelope stay the first step's (the v1 shape every existing reader expects);
     * {@code steps} carries all of them plus the attempt facts, so retries are countable.</p>
     */
    public ProviderRequestFingerprintReadService.View viewFor(ChatRun run) {
        List<ChatRunProviderRequest> rows =
                providerRequestRepository.findByRunIdOrderByProviderStepAsc(run.getId());
        if (rows.isEmpty()) {
            return ProviderRequestFingerprintReadService.absent(
                    run.getId().toString(), run.getSessionId());
        }
        ChatRunProviderRequest first = rows.stream()
                .filter(row -> row.getProviderStep() != null
                        && row.getProviderStep() == ChatRunProviderRequest.V1_PROVIDER_STEP)
                .findFirst()
                .orElse(rows.get(0));
        List<ProviderRequestFingerprintReadService.Step> steps = rows.stream()
                .map(RunProviderRequestReadService::stepOf)
                .toList();
        return ProviderRequestFingerprintReadService.captured(
                run.getId().toString(),
                run.getSessionId(),
                first.getFingerprint(),
                metadataOf(first),
                steps);
    }

    private static ProviderRequestFingerprintReadService.Step stepOf(ChatRunProviderRequest row) {
        return new ProviderRequestFingerprintReadService.Step(
                row.getProviderStep(),
                metadataOf(row),
                new ProviderRequestFingerprintReadService.Audit(
                        row.getTier(),
                        row.getHttpStatus(),
                        row.getStreamed(),
                        row.getFinishReason(),
                        row.getTtftMs(),
                        row.getTotalMs(),
                        row.getRequestSha256(),
                        row.getRequestBytes(),
                        row.getResponseSha256(),
                        row.getResponseBytes(),
                        row.getErrorSha256(),
                        row.getErrorBytes(),
                        row.getCacheReadInputTokens(),
                        row.getCacheWriteInputTokens(),
                        row.getRequestParams(),
                        row.getToolSurface()));
    }

    private static ProviderRequestFingerprintReadService.Metadata metadataOf(ChatRunProviderRequest row) {
        return new ProviderRequestFingerprintReadService.Metadata(
                row.getApiTypeId(),
                row.getApiTypeVersion(),
                row.getModel(),
                row.getMessageCount(),
                row.getToolCount(),
                row.getBytesTotal(),
                row.getRoleHistogram(),
                row.getSystemSources(),
                row.getDispatchAttempt(),
                row.getProviderStep());
    }
}