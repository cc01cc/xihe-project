# xihe Agent Interfaces

本目录定义 `xihe-agent` 模块的抽象接口层（PLAN-033 M1），将 LangChain/LangGraph 特定实现隔离在接口之后。

## 接口清单

| 文件 | 接口 | 职责 |
|------|------|------|
| `agent_runner.py` | `AgentRunner` | Agent 编排抽象：`stream()` / `create_agent()` / `reset()` |
| `tool.py` | `BaseAgentTool` / `ToolSpec` | 工具抽象：`execute()` + JSON Schema 声明 |
| `event_adapter.py` | `EventAdapter` | 将框架原始事件翻译为 SSE `AgentEvent` |
| `llm.py` | `LLMProvider` | LLM 后端抽象：`complete()` / `stream_complete()` / `with_model()` |
| `message.py` | `Message` / `TextMessage` | 最小消息协议：`role` + `content` |
| `event.py` | `Event` / `EventEnvelope` | PLAN-035 持久化域事件 |
| `event_store.py` | `EventStore` | 事件存储抽象：append / read / fork |
| `context.py` | `AgentContext` / `ContextEpoch` / `ContextProvider` | 事件投影后的上下文快照 |

## 设计原则

1. **零 LangChain 依赖**：`interfaces/` 下不直接 import `langchain*`。
2. **Protocol + dataclass**：接口使用 `typing.Protocol` 或 ABC；具体实现使用 `dataclass`。
3. **SSE 事件与域事件分离**：`AgentEvent` 供 UI 消费的 SSE 流；`Event` 供 CP Event Store 持久化。
4. **LangGraph 实现隔离**：所有 LangChain 调用收敛到 `agent_runner/langgraph_runner.py` 和 `adapters/`。

## 生命周期

- `AgentRunner.stream(messages, config)` 接收 `Message` 列表和 `RunnerConfig`。
- `RunnerConfig.context` 由 `ContextProvider.load()` 提供（PLAN-035 EventSourcedContextProvider）。
- `BaseAgentTool.execute(input, context)` 可读取 `context.runtime_state` 并写入事件（通过 `EventStore`）。
- `AgentRunner.reset()` 清除运行时状态并追加 `runtime.state_cleared` 事件。

## 线程/并发

当前实现为单请求单线程异步；`EventStore` 同步写入到 CP，暂不考虑并发 append 的乐观锁控制。
