package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.ChatRunProviderRequest;
import com.cc01cc.p.xihe.cp.repository.ChatRunProviderRequestRepository;
import org.springframework.stereotype.Service;

/**
 * PLAN-0679 T2.3: the one impure step of the provider-request read path, kept out of the controller.
 *
 * <p>{@code CpArchitectureTest#controllersDoNotDependOnRepositories} forbids a controller from
 * holding a JPA repository, so "does this run have a stored row, and what metadata did it carry"
 * lives here. The projection itself stays pure in {@link ProviderRequestFingerprintReadService}
 * (no repository, no clock, no HTTP) — this service only resolves the row and hands it over.</p>
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
     */
    public ProviderRequestFingerprintReadService.View viewFor(ChatRun run) {
        return providerRequestRepository.findById(run.getId())
                .map(row -> ProviderRequestFingerprintReadService.captured(
                        run.getId().toString(),
                        run.getSessionId(),
                        row.getFingerprint(),
                        metadataOf(row)))
                .orElseGet(() -> ProviderRequestFingerprintReadService.absent(
                        run.getId().toString(), run.getSessionId()));
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
