# A03-xihe Agent Skills 索引

本项目特有的 Agent Skills 位于 `./<name>/SKILL.md`（开放标准位置，兼容工具在本项目根下自动发现；one 根会话按 one/AGENTS.md「Skills 体系」节导航协议使用）。

| Skill | 用途 | 路径 |
|-------|------|------|
| ai-chat-ui-design | AI 聊天界面设计原则（shadcn/ui MessageScroller 15 条流式聊天原则：自动滚动/锚定定位/长对话导航） | `ai-chat-ui-design/SKILL.md` |
| dev-host-verification | Windows native + Docker PostgreSQL/Sandbox 的 host readiness、M1、E2E profile 和清理证据 | `dev-host-verification/SKILL.md` |
| team-roles | 常驻团队**工位制**（正式，**DSH 专用**）：模块工位 `ui-1`/`cp-1`/`agent-1`/`runtime-1`（各管一条常驻模块分支）+ 职能工位 `infra-N`/`verify`/`research-N`/`lead`；工位名持久、成员名会话内（D-815）；并行上限与编译位、测量窗值班（含 develop 零前进）、空岗须写「当前无在办」、idle/回收、临时席登记、交接契约 team_rebuild 联动 | `team-roles/SKILL.md` |
| xh-settings-ui-design | 设置区 UI 设计与实施判据：层×域两层模型、内容列 1152px 唯一口径、计数与徽标量纲、字段级编辑闭环（来源/锁/reset/Save）、vendor 组件优先；含 15 条 PR 验收清单 + mock P0 反例对照 | `xh-settings-ui-design/SKILL.md` |

维护规则：新增/迁移/删除 skill 必须同步更新本清单；根池通用 skill 不在本清单。
