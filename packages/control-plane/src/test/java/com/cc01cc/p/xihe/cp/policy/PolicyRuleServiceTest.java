package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.PolicyRuleEntity;
import com.cc01cc.p.xihe.cp.repository.PolicyRuleRepository;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** PLAN-0328 M1 batch 4: rule administration guardrails, effective-layer marking, conflicts. */
class PolicyRuleServiceTest {

    private final PolicyRuleRepository repository = mock(PolicyRuleRepository.class);
    private final PolicyRuleService service = new PolicyRuleService(repository);

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
        when(repository.save(any(PolicyRuleEntity.class))).thenAnswer(inv -> inv.getArgument(0));
        when(repository.findByLayerAndOwnerIdOrderByCreatedAtAscIdAsc(anyString(), anyString()))
                .thenReturn(List.of());

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
    void marksRulesIneffectiveWhenHigherLayerConfiguresTheDomain() {
        PolicyRuleEntity userRule = rule("user", "u1", "exec", "*", "allow", false);
        when(repository.findByLayerAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance")).thenReturn(List.of());
        when(repository.findByLayerAndOwnerIdOrderByCreatedAtAscIdAsc("user", "u1")).thenReturn(List.of(userRule));
        when(repository.findByLayerAndOwnerIdOrderByCreatedAtAscIdAsc("workspace", "ws1"))
                .thenReturn(List.of(rule("workspace", "ws1", "exec", "pnpm test *", "ask", false)));

        List<PolicyRuleService.RuleView> views = service.list("user", "u1", "ws1", false);

        assertEquals(1, views.size());
        assertFalse(views.get(0).effective(), "workspace configures exec → the user rule is not effective");
    }

    @Test
    void reportsAllowShadowedBySpecificDenyAtSameLayer() {
        PolicyRuleEntity allow = rule("workspace", "ws1", "exec", "pnpm *", "allow", false);
        PolicyRuleEntity deny = rule("workspace", "ws1", "exec", "pnpm test *", "deny", false);
        when(repository.findByLayerAndOwnerIdOrderByCreatedAtAscIdAsc("workspace", "ws1"))
                .thenReturn(List.of(allow, deny));

        List<PolicyRuleService.RuleView> conflicts = service.conflicts("workspace", "u1", "ws1", false);

        assertEquals(1, conflicts.size());
        assertTrue(conflicts.get(0).conflict().contains("不会生效"));
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
    void deleteRejectsCrossScopeAccess() {
        PolicyRuleEntity workspaceRule = rule("workspace", "ws2", "exec", "*", "deny", false);
        when(repository.findById(workspaceRule.getId())).thenReturn(Optional.of(workspaceRule));

        assertThrows(CpApiException.class,
                () -> service.delete(workspaceRule.getId(), "workspace", "u1", "ws1", false));
    }
}
