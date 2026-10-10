package com.cc01cc.p.xihe.cp.provider;

import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0470: bounded model-descriptor assembly for the models proxy adapter.
 * A separate service (not {@link ProviderCatalogService}) because both
 * {@link ProviderConnectionService} and {@link ProviderCredentialLeaseService}
 * already depend on the catalog — inverting that would create a bean cycle.
 * Returns descriptor maps only; never a {@code ProviderConnection} entity.
 */
@Service
public class ProviderModelDescriptorService {

    private final ProviderConnectionService connectionService;
    private final ProviderCredentialLeaseService leaseService;
    private final ProviderCatalogService catalogService;

    public ProviderModelDescriptorService(ProviderConnectionService connectionService,
                                          ProviderCredentialLeaseService leaseService,
                                          ProviderCatalogService catalogService) {
        this.connectionService = connectionService;
        this.leaseService = leaseService;
        this.catalogService = catalogService;
    }

    public List<Map<String, Object>> scopedModelDescriptors(String userId, String workspaceId) {
        if (userId == null || userId.isBlank()) {
            return List.of();
        }

        String catalogRunId = UUID.randomUUID().toString();
        List<Map<String, Object>> descriptors = new ArrayList<>();
        Set<String> seenProviders = new HashSet<>();
        for (ProviderConnection connection : connectionService.listVisibleEntities()) {
            if (!connection.isEnabled()
                    || !ProviderConnection.STATUS_READY.equals(connection.getStatus())
                    || !seenProviders.add(connection.getProviderId())) {
                continue;
            }
            // Catalog discovery has no chat run: the lease must not reference a
            // (non-existent) chat_runs row — `run_id` stays NULL and the synthetic
            // id is only a descriptor-level correlation id for the Agent.
            ProviderCredentialLeaseService.IssuedLease lease = leaseService.issue(
                    userId, workspaceId, null, null,
                    connection.getId().toString(), connection.getProviderId(), "*");
            Map<String, Object> descriptor = new LinkedHashMap<>();
            descriptor.put("lease", lease.token());
            descriptor.put("runId", catalogRunId);
            descriptor.put("connectionId", connection.getId());
            descriptor.put("providerId", connection.getProviderId());
            descriptor.put("scope", connection.getOwnerType());
            descriptor.put("connectionRevision", connection.getRevision());
            descriptor.put("displayName", catalogService.require(connection.getProviderId())
                    .path("displayName").asText(connection.getProviderId()));
            descriptors.add(descriptor);
        }
        return descriptors;
    }
}
