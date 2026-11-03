package com.cc01cc.p.xihe.cp.policy;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 2026-11-04 P0 设计缺口（task-25）：<b>红测先行</b>。
 *
 * <p>现状：{@code SPAWN_AGENT} 被归入 {@link PermissionAtomCatalog#instanceOnlyAtoms()}
 * （决定 #27 原文把 "agent spawning" 当成实例级动作），而
 * {@link PermissionAtomCatalog#agentPrincipalForbiddenAtoms()} 无条件包含 instance-only 集合，
 * 于是<b>任何</b> agent 主体都拿不到 {@code SPAWN_AGENT}——与绑什么角色无关，委派能力在权限面断路。</p>
 *
 * <p>本测试在改造前应当红：1/2/4 红，3/5 是必须保持绿的回归护栏（agent 仍不得持有管理类原子）。</p>
 *
 * <p>判据来自真实求值链：{@code spawn_agent} 走
 * {@code AgentSpawnAuthorizationService → PolicyEngine.allowsByGrant(userPrincipalOnly=false)
 * → GrantAuthorizationService.allows(request)}，后者解析的是<b>会话的 agent 主体</b>作用域授权
 * （{@code findScopedGrants(AGENT_PRINCIPAL, …)} ∪ {@code WorkspaceAgent.permissionsSnapshot}
 * ∪ 会话路径快照，且这些路径是<b>交集</b>）。所以 agent 侧没有该原子 ⇒ spawn 恒 403。</p>
 */
class AgentDelegatorAtomTierTest {

    private static final String SPAWN_AGENT = ToolFaceRegistry.ACTION_SPAWN_AGENT;
    /** 角色名用字面量：实现前 {@code SystemAccessRoleCatalog} 还没有这个常量，红测必须先能编译。 */
    private static final String AGENT_DELEGATOR = "AGENT_DELEGATOR";

    @Test
    void spawnAgentIsAWorkspaceScopedActionAtomNotAnInstanceOnlyOne() {
        PermissionAtomCatalog.Atom atom = PermissionAtomCatalog.atom(SPAWN_AGENT);
        assertTrue(PermissionAtomCatalog.isActionAtom(SPAWN_AGENT),
                "SPAWN_AGENT 是可物化的动作原子，不是 capability");
        assertEquals(PermissionAtomCatalog.SCOPE_CLASS_BOTH, atom.scopeClass(),
                "委派的作用域是「同一工作区里建子会话」，不是整实例：应可 workspace 绑定");
        assertFalse(PermissionAtomCatalog.instanceOnlyAtoms().contains(SPAWN_AGENT),
                "instance-only 应保留给真正影响整实例的动作（建账号/管角色/配置锁）");
        assertDoesNotThrow(() -> PermissionAtomCatalog.requireScopeCompatible(SPAWN_AGENT, "workspace"),
                "否则 workspace 作用域的角色/绑定会以 400 ROLE_SCOPE_MISMATCH 被拒");
    }

    @Test
    void agentPrincipalsMayBeGrantedSpawnAgent() {
        assertTrue(PermissionAtomCatalog.canBindToAgentPrincipal(List.of(SPAWN_AGENT)),
                "agent 主体的委派角色必须可绑：这是 AGENT_DELEGATOR 能存在的前提");
        assertNull(PermissionAtomCatalog.firstForbiddenAgentPrincipalAtom(List.of(SPAWN_AGENT)));
    }

    @Test
    void agentsStillMayNotHoldAdministrationAtoms() {
        // 回归护栏：拆分 tier 不等于放开"agent 不得是管理员"。
        for (String forbidden : List.of(
                PermissionAtomCatalog.CAP_WORKSPACE_ADMIN,
                PermissionAtomCatalog.CAP_INSTANCE_ADMIN,
                PermissionAtomCatalog.CAP_INSTANCE_SUPER,
                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS,
                ToolFaceRegistry.ACTION_MANAGE_ROLES,
                ToolFaceRegistry.ACTION_CREATE_ACCOUNT)) {
            assertFalse(PermissionAtomCatalog.canBindToAgentPrincipal(List.of(forbidden)),
                    forbidden + " 仍必须对 agent 主体禁绑（agent 是受权方，不是管理员）");
        }
    }

    @Test
    void builtInDelegatorRoleExistsWithMinimalAtomSet() {
        Optional<SystemAccessRoleCatalog.RoleSeed> seed = SystemAccessRoleCatalog.roleSeeds().stream()
                .filter(candidate -> AGENT_DELEGATOR.equals(candidate.name()))
                .findFirst();
        assertTrue(seed.isPresent(), "内置角色目录里必须有 AGENT_DELEGATOR（随迁移下发，不靠人工建）");
        Set<String> atoms = seed.get().atoms().stream()
                .map(SystemAccessRoleCatalog.AtomRef::actionClass)
                .collect(Collectors.toSet());
        assertEquals(Set.of(SPAWN_AGENT), atoms,
                "最小原子集：只含委派本身；不得含 MANAGE_WORKSPACE_AGENTS / MANAGE_ROLES / instance:*");
    }

    @Test
    void superAdminRoleRemainsUnbindableToAgentPrincipals() {
        Set<String> superAdminAtoms = SystemAccessRoleCatalog.roleSeeds().stream()
                .filter(seed -> SystemAccessRoleCatalog.SUPER_ADMIN.equals(seed.name()))
                .findFirst()
                .orElseThrow()
                .atoms().stream()
                .map(SystemAccessRoleCatalog.AtomRef::actionClass)
                .collect(Collectors.toSet());
        assertFalse(PermissionAtomCatalog.canBindToAgentPrincipal(superAdminAtoms),
                "实例管理角色对 agent 主体仍然禁绑（2026-11-04 裁定）");
    }
}
