package com.cc01cc.p.xihe.cp.provider;

import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.HashSet;
import java.util.UUID;

/**
 * PLAN-0470/0438: bounded model-descriptor assembly for the models proxy adapter.
 * Model identity is concrete connectionId + modelId; providerId is display grouping only.
 */
@Service
public class ProviderModelDescriptorService {

    private final ProviderConnectionService connectionService;
    private final ProviderCredentialLeaseService leaseService;
    private final ProviderCatalogService catalogService;
    private final ApiInputTypeService apiTypes;

    public ProviderModelDescriptorService(ProviderConnectionService connectionService,
                                          ProviderCredentialLeaseService leaseService,
                                          ProviderCatalogService catalogService,
                                          ApiInputTypeService apiTypes) {
        this.connectionService = connectionService;
        this.leaseService = leaseService;
        this.catalogService = catalogService;
        this.apiTypes = apiTypes;
    }

    public List<Map<String, Object>> scopedModelDescriptors(String userId, String workspaceId) {
        if (userId == null || userId.isBlank()) {
            return List.of();
        }

        String catalogRunId = UUID.randomUUID().toString();
        List<Map<String, Object>> descriptors = new ArrayList<>();
        Set<String> seenConnections = new HashSet<>();
        for (ProviderConnection connection : connectionService.listVisibleEntities()) {
            if (!connection.isEnabled()
                    || !ProviderConnection.STATUS_READY.equals(connection.getStatus())
                    || !seenConnections.add(connection.getId().toString())) {
                continue;
            }
            ProviderCredentialLeaseService.IssuedLease lease = leaseService.issue(
                    userId, workspaceId, null, null,
                    connection.getId().toString(), connection.getProviderId(), "*");
            Map<String, Object> descriptor = new LinkedHashMap<>();
            descriptor.put("lease", lease.token());
            descriptor.put("runId", catalogRunId);
            descriptor.put("connectionId", connection.getId());
            descriptor.put("connectionKey", connection.getConnectionKey());
            descriptor.put("providerId", connection.getProviderId());
            descriptor.put("scope", connection.getOwnerType());
            descriptor.put("connectionRevision", connection.getRevision());
            descriptor.put("apiTypeId", connection.getApiTypeId());
            descriptor.put("apiTypeVersion", connection.getApiTypeVersion());
            descriptor.put("operation", apiTypes.operation(
                    connection.getApiTypeId(), connection.getApiTypeVersion()));
            descriptor.put("displayName", catalogService.require(connection.getProviderId())
                    .path("displayName").asText(connection.getProviderId()));
            descriptors.add(descriptor);
        }
        return descriptors;
    }
}
