"""BL-159 回归守卫：`api/chat.py` 必须在**运行时**取 `generate_image_tool`。

缺陷形态（2026-11-06 核实仍成立）：`chat.py` 曾用 `from xihe_agent.app_state import
generate_image_tool` 做**值导入** —— 模块加载时就把当时的实例绑死；而
`main.py:224`（`import xihe_agent.app_state as state`）在配置 reload 时
`state.generate_image_tool = GenerateImageAgentTool(...)` **重建**该对象。
结果：reload 之后 chat run 仍用旧实例 ⇒ 改图像 provider 配置不生效且无报错。

本测试守两件事：
1. `chat` 模块上**没有**同名属性（有 ⇒ 说明有人又写回了值导入）；
2. `chat` 通过 `app_state` 模块属性访问，替换 `app_state.generate_image_tool`
   后 `chat` 侧读到的是**新对象**（不是加载时的旧对象）。
"""

from __future__ import annotations

import xihe_agent.api.chat as chat
import xihe_agent.app_state as app_state


def test_chat_module_does_not_bind_generate_image_tool_at_import_time() -> None:
    assert not hasattr(chat, "generate_image_tool"), (
        "api/chat.py 不得值导入 generate_image_tool：那会把 reload 前的实例绑死在模块上"
        "（BL-159）。请改为运行时访问 app_state.generate_image_tool。"
    )


def test_chat_reads_the_runtime_generate_image_tool(monkeypatch) -> None:
    sentinel = object()
    monkeypatch.setattr(app_state, "generate_image_tool", sentinel, raising=True)

    assert chat.app_state.generate_image_tool is sentinel
    # 同一个模块对象：chat 侧看到的必须就是 app_state 上当前的那个实例。
    assert chat.app_state is app_state
