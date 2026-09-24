package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
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
    private final WorkspaceRepository workspaceRepository;
    private final WorkspaceUserRepository workspaceUserRepository;

    public GrantAuthorizationService(AuthorizationGrantRepository grantRepository,
                                     GrantPrincipalPathResolver principalPathResolver,
                                     GrantIntersectionEvaluator evaluator,
                                     WorkspaceRepository workspaceRepository,
                                     WorkspaceUserRepository workspaceUserRepository) {
        this.grantRepository = grantRepository;
        this.principalPathResolver = principalPathResolver;
        this.evaluator = evaluator;
        this.workspaceRepository = workspaceRepository;
        this.workspaceUserRepository = workspaceUserRepository;
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ, propagation = Propagation.REQUIRES_NEW)
    public boolean allows(PolicyRequest request) {
        if (request == null) {
            return false;
        }
        try {
            if (!isWorkspaceMember(request)) {
                return false;
            }
            List<GrantPrincipalPathResolver.PrincipalRef> path = principalPathResolver.resolve(
                    request.userId(), request.workspaceId(), request.sessionId());
            return evaluatePath(request, path);
        } catch (IllegalArgumentException e) {
            logger.warn("[POLICY] event=grant_evaluation_fail_closed exceptionType={}",
                    e.getClass().getSimpleName());
            return false;
        }
    }

    /** User-driven UI mutations use only the user principal; Session is an audit container, not an Agent. */
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ, propagation = Propagation.REQUIRES_NEW)
    public boolean allowsUserOnly(PolicyRequest request) {
        if (request == null) {
            return false;
        }
        try {
            if (!isWorkspaceMember(request)) {
                return false;
            }
            return evaluatePath(request, principalPathResolver.resolveUser(request.userId()));
        } catch (IllegalArgumentException e) {
            logger.warn("[POLICY] event=grant_user_evaluation_fail_closed exceptionType={}",
                    e.getClass().getSimpleName());
            return false;
        }
    }

    private boolean isWorkspaceMember(PolicyRequest request) {
        UUID userId = UUID.fromString(request.userId());
        UUID workspaceId = UUID.fromString(request.workspaceId());
        return workspaceRepository.findByIdAndDeletedAtIsNull(workspaceId).isPresent()
                && workspaceUserRepository.findByIdWorkspaceIdAndIdUserId(workspaceId, userId).isPresent();
    }

    private boolean evaluatePath(PolicyRequest request, List<GrantPrincipalPathResolver.PrincipalRef> path) {
        GrantPrincipalPathResolver.PrincipalRef user = path.stream()
                .filter(principal -> GrantPrincipalPathResolver.USER.equals(principal.type()))
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException("User principal missing from grant path"));
        List<AuthorizationGrant> grants = new ArrayList<>(grantRepository.findBySubjectTypeAndSubjectId(
                GrantPrincipalPathResolver.USER, user.id()));
        List<UUID> agentSessionIds = path.stream()
                .filter(principal -> GrantPrincipalPathResolver.AGENT.equals(principal.type()))
                .map(GrantPrincipalPathResolver.PrincipalRef::id)
                .toList();
        if (!agentSessionIds.isEmpty()) {
            grants.addAll(grantRepository.findBySubjectTypeAndSubjectIdIn(
                    GrantPrincipalPathResolver.AGENT, agentSessionIds));
        }
        Map<GrantPrincipalPathResolver.PrincipalRef, List<AuthorizationGrant>> grantsByPrincipal = new HashMap<>();
        for (AuthorizationGrant grant : grants) {
            var ref = new GrantPrincipalPathResolver.PrincipalRef(grant.getSubjectType(), grant.getSubjectId());
            grantsByPrincipal.computeIfAbsent(ref, ignored -> new ArrayList<>()).add(grant);
        }
        List<Set<GrantIntersectionEvaluator.PermissionAtom>> permissionPath = path.stream()
                .map(principal -> evaluator.union(grantsByPrincipal.getOrDefault(principal, List.of())))
                .toList();
        return evaluator.allows(request, permissionPath);
    }
}
