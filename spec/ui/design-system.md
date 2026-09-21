# UI 设计系统与状态表现

> 契约状态：`proposed`  
> 实现状态：`partial`  
> Profile：`ui`  
> Owner：UI owner  
> 消费者：UI 组件、页面、视觉/交互审查者  
> 来源：PLAN-0388、DEV-010/011/012、reka-ui/shadcn-vue 约定  
> 更新日期：2026-09-20

## 范围

本文定义跨页面可复用的视觉/交互状态表达，不创建新的 CSS token 表，不复制组件库实现，也不以某一张 screenshot 作为唯一规范。

## 状态表达

| 状态 | 视觉表达 | 行为约束 | 不能替代 |
|---|---|---|---|
| loading | spinner/skeleton/status text | 相关 control disabled，保留取消/返回语义 | 服务端成功 |
| error | inline error + Toast 或 alert region | 文案包含稳定 code/可理解 detail；焦点可到达 | console log |
| warning | non-blocking notice | 不伪装成 success/error | 审批或授权 decision |
| success | visible result/status | 以 response/projection 为依据 | optimistic mutation |
| reconnecting | subtle status region，不使用漂移 spinner 作为唯一提示 | 不重复创建 ChatRun | durable recovery |
| dispatch_unknown | warning/status region + request/run context | 禁止直接二次提交 decision；提供 refresh/status action | approved/rejected |
| disabled | contrast + `disabled`/`inert`/`aria-disabled` 语义 | 必须解释原因或由 label 提供上下文 | 仅降低 opacity |
| empty | 说明 + 唯一主动作 | 空集合与加载中区分 | missing/error |

## 组件基线

- Button、Input、Dialog/Sheet、Tree、ContextMenu 使用现有 reka-ui/shadcn-vue 封装；新交互不得绕开其 focus/ARIA contract。
- Modal/Sheet 打开时保存先前焦点，关闭后恢复；不可用 action 不应仍进入 tab order。
- Toast 负责短反馈；持久错误、表单错误和审批状态必须有 DOM 可读的 inline/status region。
- Chat message/tool/diagnostic/artifact 使用已有 `MessagePart`/`ToolCall` 类型；设计系统不重命名 wire 字段。
- dark/light/system 主题下，层级、边框、focus ring 和 destructive/success/warning 对比必须可见；颜色不能作为唯一状态编码。

## 响应式

- 桌面 Chat/Workspace 可并列呈现；移动端为独立 IA：文件树 Sheet、Chat bottom Sheet、全屏编辑器。
- 代表 viewport 至少包括桌面 1440px 和移动 390px；布局变化必须保持同一 Session/Workspace 语义。
- 触摸/长按操作不能删除键盘/屏幕阅读器路径；复杂 ContextMenu 操作应有可访问的 Sheet/菜单入口。

## reduced-motion

- `prefers-reduced-motion: reduce` 时取消或缩短装饰动画、自动滚动和重连视觉动效；不取消状态变化、焦点移动或错误反馈。
- 任何关键状态不得只通过动画表达；必须有文本、ARIA 或结构变化。

## 外部参考

DEV-012 的参考项目只提供布局/交互启发，不引入其组件代码、React 组件或完整设计系统。XH 现有 token、reka-ui 和 Tailwind 事实以 DEV-010/011 和代码为准。

## 验证映射

- 视觉清单：DEV-011。
- 当前状态/并发边界：PLAN-0388 `evidence/current-state.md`。
- action-after screenshot、computed style 和 viewport 验证：PLAN-0388 V5/V6，当前未完成。
