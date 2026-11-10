# A03-xihe Agent Skills 索引

本项目特有的 Agent Skills 位于 `./<name>/SKILL.md`（开放标准位置，兼容工具在本项目根下自动发现；one 根会话按 one/AGENTS.md「Skills 体系」节导航协议使用）。

| Skill | 用途 | 路径 |
|-------|------|------|
| ai-chat-ui-design | AI 聊天界面设计原则（shadcn/ui MessageScroller 15 条流式聊天原则：自动滚动/锚定定位/长对话导航） | `ai-chat-ui-design/SKILL.md` |
| dev-host-verification | Windows native + Docker PostgreSQL/Sandbox 的 host readiness、M1、E2E profile 和清理证据 | `dev-host-verification/SKILL.md` |
| team-roles | 常驻团队角色化（正式，**DSH 专用**）：verify/dev-1/dev-2/ops/research-1/research-2 分层、成员命名=角色名+数字序号、并行上限与编译位、测量窗值班（含 develop 零前进）、idle/回收、临时席登记、交接契约 team_rebuild 联动 | `team-roles/SKILL.md` |
| xh-settings-ui-design | 设置区 UI 设计与实施判据：层×域两层模型、内容列 1152px 唯一口径、计数与徽标量纲、字段级编辑闭环（来源/锁/reset/Save）、vendor 组件优先；含 15 条 PR 验收清单 + mock P0 反例对照 | `xh-settings-ui-design/SKILL.md` |

维护规则：新增/迁移/删除 skill 必须同步更新本清单；根池通用 skill 不在本清单。
