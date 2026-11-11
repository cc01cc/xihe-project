# XH 设置区截图审阅：六维落地换算与实测反例

> 本文件只做**项目落地换算**：把六维换成设置区里可判的具体项（testid / 数字 / 文件锚点），并登记 XH 产品实测反例。
> 六维定义、分档、WCAG 条款与通用审阅流程以 `DEV-011` §11（D-926 / D-927）与 `DEV-012`「标准与规范」为事实源，此处不重复。
> 维护纪律不变：判据没写清 ⇒ 回写 DEV-011 §11；实现偏离 ⇒ 转卡。每批只留「新判据 + 新反例」，截图存 `.tmp/xh/<批次>/` 不堆进文档。

## 0. 拍图落地（前置三条在 XH 的具体化）

1. **钉 commit**：拍前与拍完后各取一次 lane `git rev-parse HEAD`，不一致 ⇒ 整批作废重拍（mock/预览 lane 随合入热更新，2026-11-11 task-155 实证整批作废）。
2. **视口**：1920×1080（最小）主用 + 390×844 移动端一轮；深色模式单独一轮。
3. **数据真实**：mock lane = `XIHE_UI_MOCK_API=1` 起 `pnpm dev -- --port <自有端口> --strictPort`；**5199/5200 是他人 lane，不碰**；页面出现 `MOCK_ENDPOINT_MISSING` 或错误横幅 ⇒ 先补**最小** mock 端点（响应按真实 shape，不虚构状态）再拍，不带红条出图。
4. **交付图唯一拍法** = `packages/ui/scripts/ui-mock-shot.mjs`（manifest 钉 commit sha / 浏览器 channel）；报告只给路径与结论。

## 1. 六维 → 设置区换算

| 维 | 设置区怎么判（锚点） | XH 实测反例 |
| --- | --- | --- |
| A 反馈与可用性 | 缺口项（后端缺口 G1–G4）必须真不可点：`settings-nav-resource-gap-*` 是 `div` + `aria-disabled` + `cursor-not-allowed`，悬停 `title` 给说明，组级解释 `settings-nav-gap-hint`；真入口仍是 router-link。保存等真实 PUT 200 才清脏态。 | 缺口项与真链接外观相同、只靠小徽标区分（task-156 前实测，已修为不可点 + 组级说明）。 |
| B 一致性 | 同一动作只留一个入口：桌面 ≥lg 隐藏 `BackToChatButton`（rail 工作台同动作），移动端 `lg:hidden` 容器保留。同语义同图标（@lucide/vue）。 | rail 有入口 + 页内又有返回链接（task-156 前实测，已按断点拆分）。 |
| C 层级与排版 | 字阶 24 > 18 > 14 三级肉眼可分；辅助文字 ≥12px token（`text-xs`），不新造 10/11px 字面量。内容列只有一个宽度口径：`max-w-6xl`（1152px）+ `px-6`，禁止 `max-w-[920px]` 类局部字面量。 | 历史 mock `max-w-[920px]` + 注记线 `left-[1010px]` 偏右 50px（H3 反例）；M 标签 10px 偏小（task-157 补件升 12px）。 |
| D 无障碍 | 缺口项 `aria-disabled` + `title`；图标按钮有 `aria-label`；focus 环与 hover 可区分（DEV-011 §10 注意力预算：L3 强调每屏 ≤2、L4 危险每屏 ≤1）。 | 灰显缺口条目标题不可读/像可点（与 A 维反例同源，task-156 一并修）。 |
| E 内容与真实性 | 计数两量纲（task-157 定稿）：主文案「本域 N 个配置键」= 本层 entries **键数**，N=0 不显示（C-01）；右侧「当前页可编辑 M 项」= schema 派生**可编辑字段数**（扣 env 锁 / 管理员锁 / 下层不可写的实例专属键），M>0 才显示；**连接条目不算字段**（连接管理页 M=0）；纯引导页与 tool-faces 页签不显示计数。`effectiveLayer` 必须来自 API（`GET /config/{domain}/meta`），UI 不本地推导。resolver 文案 = task-152 定稿语义（profile 整组 工作区 > 用户 > 实例；连接归属供给层，owner 规则非优先序；唯一末位兜底 = 共享实例连接，不跨层搜索）。 | 「本域 9 项配置」同页只有 3 个可填字段（键数被说成配置项，task-155/157 修）；「本域 0 项配置」与说明卡并存（C-01，已改为不显示）；「实例 profile 落到消费用户的个人连接」无兜底陈述（D-922 旧口径，task-167 修）；mock 点号键 fixture 导致截图 N=9 ≠ 真 CP 聚合键 N=3（已知 fixture 偏差，读图时先问键形）。 |
| F 布局与自适应 | 1920×1080 与 390×844 均无横向溢出；390 下页头两量纲同行不挤压、移动端保留「返回聊天」入口；左栏折叠后有可回入口。 | 移动端缺失返回聊天入口 / 桌面 rail 与页内双入口（task-156 修）；长 id / 长模型名撑破卡片（C 维同源，截断或换行）。 |

## 2. 设置区硬判据锚点（审到相关页必查）

- **层×域矩阵**：instance 12 域 / user 9 域，唯一事实源 `src/lib/settingsIa.ts`；层只由路由 `meta.settingsLayer` 决定，组件内禁止另写层判定；UI 没有第三层（task-253），工作区设置只有 `general|config|mcp|members|credentials|knowledge` 六个 tab。
- **字段集唯一事实源** = CP `config-schemas/<domain>.json` 的 `properties` 键集；屏上多画的键写进去也会被 CP 拒（`additionalProperties:false`）。
- **字段级编辑闭环六件套**（缺任一条即比现状退步）：有效层徽标 `config-key-layer-badge-*` / 来源 + 跳层 `config-source-*` / env 锁与管理员锁两枚不同徽标 `config-env-lock-*`、`config-admin-lock-*` / 数值校验错误位 `config-number-error-*` / 逐项重置 `settings.resetToDefault` / 域级 Save + 脏态等真实 PUT 200。
- **权限两面不混用**：`SettingsPermissionGate` 的 `no-atom`（信息条 `settings-no-atom-notice`，页面照常取数）vs `atom-denied`（403 卡 `settings-atom-denied`，主体不挂载），审到权限页先分清是哪一种。
- **壳层唯一**：左栏与工作区共用同一个 `SidebarProvider`（两层 Provider 有快捷键/cookie/宽度/布局四处硬冲突）。
- **凭证口径**：连接与密钥由 CP 加密存储，不出现锁定开关；「API key 不写入浏览器存储或日志」类声明不得改写成别的承诺。

## 3. 反例登记纪律

- 只收 **XH 产品实测**反例（带任务卡 / commit 锚点），不收跨项目通例。
- 每条反例必须能落回「维 + 元素 + 现象 + 判据」四要素；写不出判据 ⇒ 判据缺失，先回写 DEV-011 §11。
- 已修反例保留一行（标注修复卡号），作为「这类问题在本项目长什么样」的对照，不整段删除。
