# A03-xihe Agent Skills 索引

本项目特有的 Agent Skills 位于 `./<name>/SKILL.md`（开放标准位置，兼容工具在本项目根下自动发现；one 根会话按 one/AGENTS.md「Skills 体系」节导航协议使用）。

| Skill | 用途 | 路径 |
|-------|------|------|
| ai-chat-ui-design | AI 聊天界面设计原则（shadcn/ui MessageScroller 15 条流式聊天原则：自动滚动/锚定定位/长对话导航） | `ai-chat-ui-design/SKILL.md` |
| dev-host-verification | Windows native + Docker PostgreSQL/Sandbox 的 host readiness、M1、E2E profile 和清理证据 | `dev-host-verification/SKILL.md` |
| playwright-site-inspection | Playwright 站点 UI 排查与视觉复核流程（桌面+移动端截图、控制台错误、证据规范） | 根池 `.agents/skills/playwright/references/playwright-site-inspection/SKILL.md` |
| ui-verification-methodology | UI 验证方法论（a11y vs 像素可见性、destructive 按钮三层验证、截图复核流程） | 根池 `.agents/skills/ui-verification-methodology/SKILL.md` |

维护规则：新增/迁移/删除 skill 必须同步更新本清单；根池通用 skill 不在本清单。
