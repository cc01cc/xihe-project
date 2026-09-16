"""工具面契约测试：冻结 Agent 侧审批门工具清单（PLAN-292 T4）。

Java 对端：packages/control-plane/src/test/java/com/cc01cc/p/xihe/cp/policy/
GatewayToolRegistryContractTest.java（GATEWAY_PUBLIC_TOOLS +
gatewayMutationTools_requireApproval）。两侧必须同步修改，禁止单边漂移。
"""
from xihe_agent.adapters.mcp_client import REQUIRE_APPROVAL_TOOLS

# 与 GatewayToolRegistryContractTest#gatewayMutationTools_requireApproval
# 冻结的 11 个 Gateway 公开 mutation 工具完全一致。
_GATEWAY_MUTATION_TOOLS = frozenset({
    "write_file",
    "edit_file",
    "delete_file",
    "delete_directory",
    "move_file",
    "copy_file",
    "mkdir",
    "execute_command",
    "start_background_process",
    "cancel_background_process",
    "apply_patch",
})

# CP internal-only 工具（决策 #12 / PLAN-292 M2）：不经 #[tool_router] 暴露，
# Agent 审批门不得收录（收录即虚假完整性）。
_INTERNAL_ONLY_TOOLS = frozenset({
    "create_snapshot",
    "revert_snapshot",
})


def test_require_approval_tools_match_gateway_mutation_contract():
    assert REQUIRE_APPROVAL_TOOLS == _GATEWAY_MUTATION_TOOLS, (
        "REQUIRE_APPROVAL_TOOLS 与 GatewayToolRegistryContractTest 冻结集合漂移；"
        "新增/删除 Gateway mutation 工具必须两侧同步修改"
    )


def test_internal_only_tools_are_not_require_approval_tools():
    leaked = REQUIRE_APPROVAL_TOOLS & _INTERNAL_ONLY_TOOLS
    assert not leaked, f"internal-only 工具不得进入 Agent 审批门清单: {sorted(leaked)}"
