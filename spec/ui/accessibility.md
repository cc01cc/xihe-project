# UI 无障碍与键盘契约

> 契约状态：`proposed`  
> 实现状态：`partial`  
> Profile：`ui`  
> Owner：UI owner + 可访问性审查者  
> 消费者：UI 组件、E2E、人工审查者  
> 来源：PLAN-0388、DEV-010/011、UI AGENTS、现有 mock/real E2E  
> 更新日期：2026-09-20

## 基线

1. 每个交互 control MUST 有可访问名称、可见 focus 或等价 focus indicator，并能通过键盘完成核心动作。
2. 装饰图标 MUST `aria-hidden`；有语义的图标按钮 MUST 有 `aria-label` 或可见 label。
3. `disabled`、`aria-disabled`、`inert` 和 `tabindex=-1` 只按当前组件语义使用；不可用元素不得制造可操作的假 affordance。
4. loading、reconnecting、approval pending 和错误 MUST 通过可读 DOM/status region 表达，不能只用颜色或动画。
5. 表单错误 MUST 与输入关联；提交失败后焦点不能丢失到不可见节点。

## Dialog/Sheet/菜单

- Dialog/Sheet 打开时 focus 进入标题、首个可操作元素或明确的错误元素；关闭时恢复触发 control focus。
- Escape 关闭只表示退出当前 UI，不自动执行 reject/delete/cancel 等 destructive decision。
- Confirm action 只有在 request/validation 成功或明确允许关闭时才关闭；服务端错误保持对话打开并呈现错误。
- ContextMenu/Tree 的键盘导航、展开状态和选中状态以 reka-ui primitive 语义为准；移动端长按必须有键盘/菜单替代路径。

## Chat 与流式状态

- Chat token/assistant update 不应抢夺用户当前 focus；自动滚动必须尊重用户 free-scrolling 状态。
- `role=status` 用于非阻塞 thinking/reconnecting 状态；错误和审批需要更强的 alert/dialog 语义。
- Tool call/result、diagnostic、artifact 必须有可读标题、状态和错误；原始大输出不直接作为无界 aria 内容注入。
- ApprovalModal 的 approve/reject/save actions 必须有明确的 decision label；关闭 modal 不得被解释为 reject。
- `dispatch_unknown` 必须以 `role=status` 或 `role=alert` 说明“状态未确认”，焦点可到达 refresh/status action；在服务端确认 pending 前，approve/reject controls 不得可操作。

## Reduced motion 与对比度

- `prefers-reduced-motion: reduce` 下保留状态变化和焦点逻辑，取消非必要动画和滚动过渡。
- light/dark/system 都必须检查文字、边框、focus ring、destructive/success/warning 的对比度；颜色不是唯一状态信号。
- 移动端 Sheet、桌面 Sidebar/Chat/Workspace 的可访问名称和 landmark 不得因响应式隐藏而消失。

## 测试证据

- 单元测试可覆盖 aria 属性、状态分支和 store projection，但不能替代封装组件的真实 focus/keyboard 行为。
- Playwright real/mock 分工：mock 验证确定性分支；real 验证真实 request/response/persistence/visible result；关键流程需要 action-after screenshot、DOM/computed style、console/network。
- 代表 viewport：桌面 1440px、移动 390px；异常路径至少覆盖 loading、error、reconnect、approval pending/terminal、empty 和 disabled。

## 验证映射

- 当前 UI 事实与 E2E：PLAN-0388 `evidence/current-state.md`、`action-matrix.md`。
- M3 手动步骤：PLAN-0388 `evidence/manual-verification-runbook.md`。
- V5/V6 尚未完成，本文保持 `proposed`。
