# BL-382 A′ POC：TanStack Virtual 挂进现有 MessageScroller

一句话：**四项风险全部通过**（真 Chromium 实测，2026-11-10），建议按 A′ 进入迁移；本目录只是探针，不参与产品路由、不构建产物、不合并。

## 怎么跑

```powershell
cd A03-xihe/packages/ui
node src/features/workspace/chat/__poc__/run-poc.mjs          # 约 6 s（含 vite 启动 + 浏览器启动 + 四场景）
node src/features/workspace/chat/__poc__/run-poc.mjs --headed  # 想看着它滚
```

脚本自带：起 vite（`127.0.0.1:12911`，`--strictPort`）→ 用 **Chrome Beta**（`executablePath` 显式给，本机没装与 `@playwright/test` 匹配的 bundled 浏览器）→ 跑四场景 → 打印 JSON → 关浏览器、杀 vite（含失败路径）。退出码 `0`=四项全通、`2`=有项不通、`1`=环境/脚本错误。

## 测的是什么

把 `@tanstack/vue-virtual@3.13.48`（依赖 `@tanstack/virtual-core@3.19.7`）挂到**现有** `MessageScrollerProvider/MessageScroller/MessageScrollerViewport/MessageScrollerContent/MessageScrollerItem` 上，**替换范围只到"行渲染"这一层**，滚动引擎一行没改。行高是确定性伪随机（44–164px）+ 代码块 220px + "图片行" 60→240px（模拟图片加载后长高）。

| 场景 | 量什么 | 判据 |
| --- | --- | --- |
| ① 接入 | `virtualizer.scrollElement` 是否就是 `[data-slot="message-scroller-viewport"]`；写 `scrollTop` 后渲染窗口是否跟着换 | 元素同一、文档里只有 1 个滚动容器、窗口跟着动 |
| ② 动态高度 | 预热后同一偏移来回滚 5 轮，`getTotalSize()` / 首行 index / 首行 `start` 逐轮是否一致；图片行长高后总高是否跟着涨 | 5/5 轮完全一致 + 长高后总高增加 |
| ③ prepend 保位 | 滚到中部，prepend 30 条，目标消息 `getBoundingClientRect().top` 变化；对照组 `anchorTo:'start'` | 目标行 |Δ| ≤ 2px，且不被动拽到底 |
| ④ 流式贴底 | 贴底后逐条追加 10 条，每条距底距离；再测"已上翻时追加不被拽"；再测 provider 自身 auto-scroll 并存 | 距底 ≤ 2px、上翻时 `scrollTop` 不跳、两者并存不打架 |

## 实测结果（2026-11-10，Chrome Beta，1280×900，500 行）

| 风险 | 结论 | 关键数字 |
| --- | --- | --- |
| ① `getScrollElement` 能挂进既有引擎 | **通过** | `scrollElement` = viewport 元素（`data-slot=message-scroller-viewport`）、文档内滚动容器数 = 1、滚动后渲染窗口 0–12 → 37–59 |
| ② 动态高度测量稳定 | **通过** | 5/5 轮 `getTotalSize()` 均 17340px、首行 index 均 11、首行 start 均 1255px；图片行 60→240 后总高 16980 → 17340（+360px） |
| ③ prepend 保位（`anchorTo:'end'`） | **通过** | 3 轮 prepend×30 条，目标行 `top` 均为 423px，**Δ = 0px**；`scrollTop` 每轮 +2400px = `scrollHeight` 每轮 +2400px；距底不变（19732px）⇒ 没被拽到底 |
| ③ 对照组（`anchorTo:'start'`，只有引擎自带保位） | 失败模式已量化 | `scrollHeight` +3198px 而 `scrollTop` 只 +319px ⇒ 内容相对视口下移 **2879px**，首行从 `m-240` 变成 `m-213` |
| ④ `followOnAppend` 贴底 | **通过** | 贴底判定 true（`distanceFromEnd` = 0，阈值 1px）后追加 10 条，库/DOM 两侧距底均 **0px**（10/10）；上翻 800px 后追加 3 条 `scrollTop` 位移 **0px**；provider 自身 `auto-scroll` 并存时距底也全 0 |

其它：整个 POC 期间 `longtask` 计数 **0**（只有 500 行、跑 4s，**不能**当作 5k 会话的性能结论）；页面无 JS 异常，只有一条 404（vite 下缺 favicon）。

## 踩到的两个坑（迁移时要写进任务）

1. **模板 ref 拿到的是组件实例，不是滚动 div**。`<MessageScrollerViewport ref="x">` 必须取 `x.$el` 并校验 `data-slot="message-scroller-viewport"` 再交给 `getScrollElement`，否则 `scrollElement.scrollTop/getAttribute` 直接炸 —— 与 BL-316 修的是同一个坑。
2. **估算高度会让"贴底"变假**。只写一次 `scrollTop = scrollHeight` 后，实测总高比估算大，`isAtEnd()` 又变假（本机实测差 558px），`followOnAppend` 就不触发。必须按库自己的 `isAtEnd()` 反复对齐（本 POC 最多 8 次）。**这条对迁移是真风险**：产品里贴底由 provider 的 auto-scroll 兜着，但两套机制并存时的写入顺序仍需在真 `MessageList` 上复测。

## 与 §8 回滚判据的对照

`lib-evaluation.md` §8 五条判据，本次实测**触发 0 条**：

1. 外部滚动容器不可用 —— 否（①通过）。
2. prepend 漂移 >1px / 中部回填被拽到底 —— 否（③ Δ=0px、距底不变）。
3. 流式追加抖动/双纠偏 —— 未出现（④ 库与 provider auto-scroll 并存距底全 0，无 longtask；但**范围仅此 POC**，真 `MessageList` 未验）。
4. 5k 真实会话 `longTasks/轮 > 1.2` 或堆不随轮次脱钩 —— **本 POC 未覆盖**（500 行、4 s），需在真会话上量。
5. 搜索态回退与现状不一致 —— **未覆盖**（POC 无搜索态）。

## 结论与建议

- 四项风险**全部通过**，A′ 的技术前提成立 ⇒ **建议进入迁移**（不建议按"关闭 A′、保留自研过渡方案"处理）。
- 迁移前必须补测：真 `MessageList`（697 行、含 run 分组头/折叠/搜索态/500 条上限）、5k 会话 longTask 与内存、`MessageListVirtual.spec.ts` 12 个用例在新实现下的等价性。
- 本目录文件保留为证据；迁移落地后可整体删除（`chat/__poc__/`）。
