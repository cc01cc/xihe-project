package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Loads uncached grant state for one bounded tool-call decision. */
@Service
public class GrantAuthorizationService {

    private static final Logger logger = LoggerFactory.getLogger(GrantAuthorizationService.class);

    private final AuthorizationGrantRepository grantRepository;
    private final GrantPrincipalPathResolver principalPathResolver;
    private final GrantIntersectionEvaluator evaluator;

    public GrantAuthorizationService(AuthorizationGrantRepository grantRepository,
                                     GrantPrincipalPathResolver principalPathResolver,
                                     GrantIntersectionEvaluator evaluator) {
        this.grantRepository = grantRepository;
        this.principalPathResolver = principalPathResolver;
        this.evaluator = evaluator;
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ, propagation = Propagation.REQUIRES_NEW)
    public boolean allows(PolicyRequest request) {
        if (request == null) {
            return false;
        }
        try {
            List<GrantPrincipalPathResolver.PrincipalRef> path = principalPathResolver.resolve(
                    request.userId(), request.workspaceId(), request.sessionId());
            UUID userId = UUID.fromString(request.userId());
            List<UUID> agentSessionIds = path.stream()
                    .filter(principal -> GrantPrincipalPathResolver.AGENT.equals(principal.type()))
                    .map(GrantPrincipalPathResolver.PrincipalRef::id)
                    .toList();
            List<AuthorizationGrant> grants = grantRepository.findForAuthorizationPath(userId, agentSessionIds);
            Map<GrantPrincipalPathResolver.PrincipalRef, List<AuthorizationGrant>> grantsByPrincipal = new HashMap<>();
            for (AuthorizationGrant grant : grants) {
                var ref = new GrantPrincipalPathResolver.PrincipalRef(grant.getSubjectType(), grant.getSubjectId());
                grantsByPrincipal.computeIfAbsent(ref, ignored -> new ArrayList<>()).add(grant);
            }
            List<Set<GrantIntersectionEvaluator.PermissionAtom>> permissionPath = path.stream()
                    .map(principal -> evaluator.union(grantsByPrincipal.getOrDefault(principal, List.of())))
                    .toList();
            return evaluator.allows(request, permissionPath);
        } catch (IllegalArgumentException e) {
            logger.warn("[POLICY] event=grant_evaluation_fail_closed exceptionType={}",
                    e.getClass().getSimpleName());
            return false;
        }
    }
}
