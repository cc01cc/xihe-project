package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.policy.CapResolver;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.stereotype.Component;

import java.util.UUID;

/** Policy-side dependency inversion adapter for agent workspace caps. */
@Component
public class AgentPrincipalCapResolver implements CapResolver {

    private final AgentPrincipalService principals;

    public AgentPrincipalCapResolver(AgentPrincipalService principals) {
        this.principals = principals;
    }

    @Override
    public JsonNode resolveCapFor(UUID principalId, UUID workspaceId) {
        return principals.resolveCapFor(principalId, workspaceId);
    }
}
