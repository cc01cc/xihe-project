package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.PolicyRuleEntity;
import com.cc01cc.p.xihe.cp.repository.PolicyRuleRepository;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

/**
 * PLAN-0328 M1 batch 4 guardrails, trimmed by PLAN-0407 T2.8: the list/conflicts/delete
 * administration surface retired with the rule CRUD; what remains is the approval storage
 * write path ({@code create}) and the domain dictionary ({@code domains}).
 */
class PolicyRuleServiceTest {

    private final PolicyRuleRepository repository = mock(PolicyRuleRepository.class);
    private final PolicyRevision policyRevision = mock(PolicyRevision.class);
    private final PolicyRuleService service = new PolicyRuleService(repository, policyRevision);

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    private static PolicyRuleEntity rule(String layer, String owner, String actionClass, String resource,
                                         String effect, boolean locked) {
        return new PolicyRuleEntity(UUID.randomUUID(), layer, owner, actionClass, resource, effect, 0, locked, "tester");
    }

    private static PolicyRuleService.RuleInput input(String actionClass, String resource, String effect,
                                                    Boolean locked) {
        return new PolicyRuleService.RuleInput(actionClass, resource, effect, 0, locked);
    }

    @Test
    void instanceLayerRequiresAdmin() {
        assertThrows(CpApiException.class, () -> service.create("instance", "u1", "ws1", false,
                input("exec", "*", "deny", false)));
        assertNotNull(service.create("instance", "u1", "ws1", true, input("exec", "*", "deny", true)));
    }

    @Test
    void userAndWorkspaceLayersBindToCallerIdentity() {
        TenantContext.setWorkspaceRole("OWNER");
        when(repository.save(any(PolicyRuleEntity.class))).thenAnswer(inv -> inv.getArgument(0));

        assertEquals("u1", service.create("user", "u1", "ws1", false, input("read", "*", "allow", false)).ownerId());
        assertEquals("ws1", service.create("workspace", "u1", "ws1", false, input("read", "*", "allow", false)).ownerId());
        assertThrows(CpApiException.class, () -> service.create("workspace", "u1", null, false,
                input("read", "*", "allow", false)));
    }

    @Test
    void lockedRulesMustBeTightening() {
        assertThrows(CpApiException.class, () -> service.create("instance", "u1", "ws1", true,
                input("exec", "*", "allow", true)));
        assertThrows(CpApiException.class, () -> service.create("instance", "u1", null, false,
                input("exec", "*", "deny", true)));
    }

    @Test
    void rejectsInvalidEffectAndBlankFields() {
        assertThrows(CpApiException.class, () -> service.create("user", "u1", "ws1", false,
                input("exec", "*", "yolo", false)));
        assertThrows(CpApiException.class, () -> service.create("user", "u1", "ws1", false,
                input("  ", "*", "allow", false)));
    }

    @Test
    void domainViewPicksHighestConfiguredLayer() {
        when(repository.findByLayerAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance"))
                .thenReturn(List.of(rule("instance", null, "exec", "git push *", "deny", true)));
        when(repository.findByLayerAndOwnerIdOrderByCreatedAtAscIdAsc("user", "u1"))
                .thenReturn(List.of(rule("user", "u1", "read", "*", "allow", false)));
        when(repository.findByLayerAndOwnerIdOrderByCreatedAtAscIdAsc("workspace", "ws1"))
                .thenReturn(List.of(rule("workspace", "ws1", "exec", "pnpm test *", "allow", false)));

        List<PolicyRuleService.DomainView> domains = service.domains("u1", "ws1");

        PolicyRuleService.DomainView exec = domains.stream()
                .filter(view -> "exec".equals(view.actionClass())).findFirst().orElseThrow();
        assertEquals("workspace", exec.effectiveLayer());
        PolicyRuleService.DomainView read = domains.stream()
                .filter(view -> "read".equals(view.actionClass())).findFirst().orElseThrow();
        assertEquals("user", read.effectiveLayer());
    }

    @Test
    void workspaceLayerCreateRequiresWorkspaceOwnerOrAdmin() {
        when(repository.save(any(PolicyRuleEntity.class))).thenAnswer(inv -> inv.getArgument(0));

        TenantContext.setWorkspaceRole("MEMBER");
        CpApiException error = assertThrows(CpApiException.class,
                () -> service.create("workspace", "u1", "ws1", false, input("read", "*", "allow", false)));
        assertEquals(HttpStatus.FORBIDDEN, error.getStatus());

        TenantContext.setUserRole("ADMIN");
        assertNotNull(service.create("workspace", "u1", "ws1", false, input("read", "*", "allow", false)));

        TenantContext.setUserRole(null);
        TenantContext.setWorkspaceRole("ADMIN");
        assertNotNull(service.create("workspace", "u1", "ws1", false, input("read", "*", "allow", false)));
    }
}
