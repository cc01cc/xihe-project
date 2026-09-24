package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/** Loads uncached grant state for one bounded tool-call decision. */
@Service
public class GrantAuthorizationService {

    private static final Logger logger = LoggerFactory.getLogger(GrantAuthorizationService.class);

    private final AuthorizationGrantRepository grantRepository;
    private final AgentPrincipalRepository agentPrincipalRepository;
    private final WorkspaceAgentRepository workspaceAgentRepository;
    private final GrantPrincipalPathResolver principalPathResolver;
    private final GrantIntersectionEvaluator evaluator;
    private final WorkspaceRepository workspaceRepository;
    private final WorkspaceUserRepository workspaceUserRepository;

    public GrantAuthorizationService(AuthorizationGrantRepository grantRepository,
                                     AgentPrincipalRepository agentPrincipalRepository,
                                     WorkspaceAgentRepository workspaceAgentRepository,
                                     GrantPrincipalPathResolver principalPathResolver,
                                     GrantIntersectionEvaluator evaluator,
                                     WorkspaceRepository workspaceRepository,
                                     WorkspaceUserRepository workspaceUserRepository) {
        this.grantRepository = grantRepository;
        this.agentPrincipalRepository = agentPrincipalRepository;
        this.workspaceAgentRepository = workspaceAgentRepository;
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
            UUID workspaceId = UUID.fromString(request.workspaceId());
            if (workspaceRepository.findByIdAndDeletedAtIsNull(workspaceId).isEmpty()) {
                return false;
            }
            GrantPrincipalPathResolver.AgentPath path = principalPathResolver.resolveAgent(
                    request.userId(), request.workspaceId(), request.sessionId());
            AgentPrincipal principal = agentPrincipalRepository.findById(path.principalId())
                    .filter(candidate -> candidate.getDisabledAt() == null)
                    .orElseThrow(() -> new IllegalArgumentException("Agent principal is unavailable"));
            WorkspaceAgent binding = workspaceAgentRepository.findById(
                    new WorkspaceAgentId(principal.getId(), workspaceId)).orElse(null);
            if (binding == null) return false;

            List<AuthorizationGrant> principalGrants = grantRepository.findBySubjectTypeAndSubjectId(
                    GrantPrincipalPathResolver.AGENT_PRINCIPAL, principal.getId());
            List<Set<GrantIntersectionEvaluator.PermissionAtom>> permissionPath = new ArrayList<>();
            permissionPath.add(evaluator.union(principalGrants));
            permissionPath.add(evaluator.parse(binding.getPermissionsSnapshot()));
            for (Session session : path.sessionPath()) {
                permissionPath.add(evaluator.parse(session.getAgentPermissionsSnapshot()));
            }
            return evaluator.allows(request, permissionPath);
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
            return evaluateUserPath(request);
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

    private boolean evaluateUserPath(PolicyRequest request) {
        UUID userId = UUID.fromString(request.userId());
        Set<GrantIntersectionEvaluator.PermissionAtom> userGrants = evaluator.union(
                grantRepository.findBySubjectTypeAndSubjectId(GrantPrincipalPathResolver.USER, userId));
        return evaluator.allows(request, List.of(userGrants));
    }
}
