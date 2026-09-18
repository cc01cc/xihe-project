"""工具面契约（PLAN-0337 M2 起）：审批权威在 CP，Agent 侧不得持有本地判定。

历史：本文件原先冻结 Agent 侧 `REQUIRE_APPROVAL_TOOLS` 清单，并与 CP 的
`GatewayToolRegistryContractTest`（`GATEWAY_PUBLIC_TOOLS` +
`gatewayMutationTools_requireApproval`）做等值断言。M2 已删除该清单——
**工具分类与「是否需要人工确认」的唯一权威是 CP**（`ToolFaceRegistry` + 闸门），
因此等值断言不再有对端可比，改为守卫「本地判定不得重新回到 Agent 侧」。

Agent 侧的行为契约见 `test_gate_owned_approval_contract.py`（首调用直达闸门、
无本地清单、gate 信号等待 + 只重试一次）。
"""

import inspect

from xihe_agent.adapters import mcp_client as mcp_client_module

# M2 删除的符号：任何人重新引入即为回归（审批判定必须留在 CP）。
_FORBIDDEN_LOCAL_DECISION_SYMBOLS = (
    "REQUIRE_APPROVAL_TOOLS",
    "_request_approval",
)


def test_agent_holds_no_local_approval_decision_symbols():
    present = [name for name in _FORBIDDEN_LOCAL_DECISION_SYMBOLS if hasattr(mcp_client_module, name)]
    assert present == [], f"Agent dispatch 层不得持有本地审批判定符号 {present}；审批触发权只在 CP（PLAN-0337 M2）"


def test_agent_dispatch_source_has_no_local_pre_flight_call_site():
    source = inspect.getsource(mcp_client_module)
    assert "request_approval(" not in source, "dispatch 路径不得调用本地前置审批；工具调用必须直达 CP 闸门"
