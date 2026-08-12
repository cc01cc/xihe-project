---
name: ai-chat-ui-design
description: AI 聊天界面设计原则与实践指南。基于 shadcn/ui MessageScroller 的 15 条流式聊天设计原则，覆盖自动滚动、锚定定位、上下文保持、长对话导航、布局防抖等核心交互模式。适用于 AI 聊天、Agent 对话、流式输出等场景的设计与实现参考。引用官方 shadcn/ui 文档。 [Scope: XH]
license: MIT
metadata:
  category: design
  references:
    - https://ui.shadcn.com/docs/components/message-scroller
    - https://ui.shadcn.com/docs/changelog/2026-06-chat-components
---

# AI Chat UI 设计原则

基于 shadcn/ui MessageScroller 官方提炼的 15 条设计原则，适用于 AI 聊天、Agent 对话等流式场景。这些原则独立于具体框架，可直接指导 Xihe 的 chat UI 设计。

---

## 15 条核心原则

### 1. Move only when the reader asked to move
仅在用户要求移动时才移动。用户正在阅读时绝不将其拉到别处。**自动滚动绝不能是默认行为**。

**实现要点**：只有当用户主动将滚动条拉到底部边缘时，页面才跟随 AI 吐字速度自动往下滚。用户向上滚动、选中文本、搜索时系统必须定格在原地。

### 2. Follow only while they're following
只在用户跟随最新内容时才跟随。用户在 live edge 则保持流式内容可见；用户向上滚动离开则立即解除跟随。

### 3. Every interaction is a signal
所有交互都是信号。滚动不是唯一的信号——选中文本、键盘操作、打开链接、搜索内容，都应当通知界面停止自动移动。

### 4. Start a new turn near the top of the viewport
新回合（用户发送消息后）的起点应自动初始化在视口靠上的位置。给接下来的回答留出充足的向下生长空间，让用户不动也能看到新回答的初始内容。

### 5. Then stream in the answer
回答应**向屏幕内生长**，而非立即将所有内容推走。内容从上到下渐进填充，用户视线自然跟随。

### 6. Keep part of the previous conversation in context
上一轮对话的结尾应保持可见（peek），使用户知道当前上下文在哪儿。新回合与上下文保持视觉连接。

### 7. Let new content arrive offscreen
只要用户没有主动追踪最新行，AI 未完成的输出在不可见区域继续加载即可，不需要强行走阅读视线。视口中仅需微小状态提示（如 Spinner、按钮状态变化）。

### 8. Show what's happening out of view
当视口外仍在流式输出或新消息到达时，应给出明确指示。常见模式：底部悬浮"向下"按钮、shimmer 动画状态指示。

### 9. Make it easy to return to the latest reply
提供"跳至最新"（jump-to-latest）操作。用户点击后回到最新回复并恢复跟随。类似 ChatGPT 网页端的悬浮"向下"按钮。

### 10. Let people jump anywhere in the conversation
长对话需要消息级导航链接、搜索、未读标记和直接跳转。类似 Office Word 的导航窗格。

### 11. Reopen where the reader left off
重新打开已保存的对话时，应定位到**最近一次有意义的回合**（通常是最后一次用户消息），而非绝对最底部。这让读者立即知道上下文。

### 12. Keep the reader's place when layout changes
图片加载、Markdown 展开、代码块高亮、异步内容渲染时，**必须锚定用户正在看的行**，不能发生意外位移。

### 13. Handle interruptions without stealing position
停止生成、重试、重新生成、分支、报错等操作不应意外移动对话位置。

### 14. Stay responsive in long threads
流式文本、Markdown、代码块、图片和长历史记录中仍保持响应。通过 `content-visibility: auto`、imperative scroll state 等技术避免 React rerender 瓶颈。

### 15. Be accessible without the noise
保持对话记录可键盘导航、可被屏幕阅读器感知。使用 `role="log"` + `aria-relevant="additions"` 作为 live region，通过 `aria-busy` 控制流式输出期间的播报节奏。

> **核心红线: Never move the reader against their intent.**

---

## 实现模式

### 锚定 (Anchoring)

用 `scrollAnchor` 标记哪条消息是"新回合的起点"。触发方式：
- 用户消息发送时标记 anchor → 视口自动将该消息定位到靠近顶部的位置
- 上一轮回复的结尾保留 `scrollPreviousItemPeek`，保持上下文可见

```
新回合锚定效果：
┌────────────────────────────┐
│ 上一轮回复结尾 (peek 64px) │ ← 保持上下文
│ ─── 新回合 ─────────────── │
│ 用户问题                   │ ← scrollAnchor = true
│ AI 回复开始...             │
│ 继续流式...                │
│                           │ ← 向下生长
└────────────────────────────┘
```

### 自动跟随 (Auto-follow)

`autoScroll` 控制流式输出时的滚动行为：
- **用户位于 live edge（最底部）** → 跟随 AI 吐字，新内容自动进入视口
- **用户滚动离开** → 自动跟随解除，新内容在屏幕外加载
- **用户点击"跳至最新"或手动滚回底部** → 重新进入跟随
- 所有交互（wheel / touch / keyboard / scrollbar 拖拽/ 消息跳转）均释放跟随

### 打开位置 (Opening Position)

保存的对话重新打开时有三种策略：

| 策略 | 适用场景 |
|------|---------|
| `"last-anchor"`（推荐） | 回到最近一次用户消息位置，适合继续对话 |
| `"end"` | 跳到绝对最底部，适合查看最新状态 |
| `"start"` | 从开头开始，适合回顾长对话 |

### 预加载历史 (Prepend History)

加载更早的消息不应移动用户当前查看的位置。`preserveScrollOnPrepend` 保持用户正在看的行不动，旧消息在上方追加。使用稳定的 `messageId` 让 scroller 精确识别行。

### 滚动状态追踪

对外暴露的 scroll state 属性：

| 状态 | 含义 |
|------|------|
| `data-autoscrolling` | 当前正在自动跟随 |
| `data-scrollable` → `start` / `end` | 哪个方向还有可滚动内容 |
| `currentAnchorId` | 当前锚定的 turn id |
| `visibleMessageIds` | 视口中可见的消息 id 列表 |

---

## 组件映射 (shadcn/ui)

| 组件 | 职责 |
|------|------|
| `MessageScrollerProvider` | 无头根组件，拥有 scroll state 和行为 props |
| `MessageScroller` | 带样式的容器框架 |
| `MessageScrollerViewport` | 可滚动的视口元素 |
| `MessageScrollerContent` | 对话记录容器，live region |
| `MessageScrollerItem` | 每条对话行的边界（消息/标记/分隔符） |
| `MessageScrollerButton` | "跳至最新"按钮 |
| `Message` | 消息行布局（头像、对齐、header、内容、footer） |
| `Bubble` | 消息内容面（变体、对齐、交互、可折叠） |
| `Attachment` | 文件/图片附件 |
| `Marker` | 状态更新、系统通知、日期分隔 |
| `scroll-fade` | 滚动边缘淡出效果（CSS utility） |
| `shimmer` | 流式生成中的文字闪烁效果（CSS utility） |

安装命令：
```bash
pnpm dlx shadcn@latest add message-scroller message bubble attachment marker
```

---

## 本地项目参考

| 项目 | 对应模块 | 可借鉴点 |
|------|---------|---------|
| **A03-xihe / packages/ui** | `components/chat/`、`views/` | chat 窗口的流式输出、消息列表、Agent 对话 |
| **A07-yizhan** | 文件互传 + 聊天式 UI | P2P 聊天界面、消息列表、同步状态指示 |
| **A02-shouzha** | SyncDetailPanel | 同步状态卡片、进度条反馈（跨领域参考） |

---

## 优先级建议

实现时按以下优先级推进：

| 优先级 | 原则 | 理由 |
|--------|------|------|
| P0 | 1, 2, 3, 12 | 最基础的用户体验，避免阅读被打断 |
| P0 | 4, 5, 6 | 新回合定位和上下文保持，直接影响对话连贯性 |
| P1 | 7, 8, 9 | offscreen 内容 + 状态指示 + 跳转回最新 |
| P1 | 11 | 重新打开的位置恢复 |
| P2 | 10 | 长对话导航 |
| P2 | 13, 14 | 异常处理和长对话性能 |
| P3 | 15 | 无障碍增强 |

---

## 常见陷阱

1. **强制自动滚动**：用户阅读时被突然拉到最新——这是最常见的差体验。用 auto-scroll only when at live edge 解决。
2. **新回合上下文丢失**：用户发送消息后，问题被压到屏幕底部，回答只能从下面"挤"出来。用 anchored turns 解决。
3. **布局抖动**：Markdown/代码块/图片异步加载导致视口位移。用 per-row anchoring 解决。
4. **保存对话打开位置错误**：总是从最底部打开，用户丢失上下文。用 `"last-anchor"` 策略解决。
5. **滚轮与自动滚动冲突**：用户不小心滚了一下就失去跟随，之后新内容不可见。需要明确的"跳至最新"按钮。

---

## References

- [shadcn/ui MessageScroller Documentation](https://ui.shadcn.com/docs/components/message-scroller)
- [shadcn/ui Changelog - June 2026 Chat Components](https://ui.shadcn.com/docs/changelog/2026-06-chat-components)
