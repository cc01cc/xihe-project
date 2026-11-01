---
title: DEV-033 - 新手首跑（gold path）
category: dev-guide
sidebar_order: 33
lang: zh-Hans
sidebar_group: "开发指南"
status: active
created: 2026-11-01
updated: 2026-11-01
---

# DEV-033: 新手首跑（gold path）

> **定位**：从**空白实例**到**第一条助手回复**的最短可验证路径。面向第一次接触 XH 的人：每条命令都指向 `mise.toml` 的具体任务，每条「看到什么算成功」都能指到 `packages/ui/e2e/real/goldpath-first-run.spec.ts` 的具体断言（映射见 §5.2）。
>
> **本文的证据范围**：`plans/PLAN-0611-XH-first-run-goldpath/evidence/m1-m2.md` §8.8 的 **6 轮矩阵**（`goldpath` ×3 = 8 passed / 4 skipped；`goldpath-closed` ×3 = 4 passed / 8 skipped；0 failed / 0 flaky）。**未覆盖**的部分集中写在 §5.3，本文不据此宣称"已完成"。

## 1. 前置

| 项 | 要求 | 依据 |
|---|---|---|
| 工具链 | Node 24 / pnpm 10 / Python 3.14 / uv / Java 25 / Maven 3.9 / Rust 1.97.1，由 `mise install` 固定 | `mise.toml:23-30`（`[tools]`） |
| Docker | **仅 PostgreSQL** 用容器；服务容器化与 `xihe/workspace` 镜像构建已冻结，不要试图 `docker compose up` 全栈 | `mise.toml:1-16`（冻结说明） |
| 目录 | **任意目录**即可（单 clone）；不再是"必须在 `one/` 工作区内" | `mise run check:standalone`（`mise.toml:395`）自检「不依赖 one 根」 |
| 端口 | stack-1：UI 12630 / CP 12631 / Agent 12632 / Runtime 12633 / PG 12634 | `scripts/lib/stack-ports.mjs:20`（端口事实源） |

两种运行前提，按用途选：

1. **本地模式（新手默认）**：一套 `dev:host` 栈 + `XIHE_LOCAL_MODE=true`，空库起步，浏览器手动走 §3/§4。
2. **隔离 E2E 栈（复跑 §5 矩阵）**：`scripts/e2e-host.mjs` 每轮自建 PG 容器与随机端口（27xxx 段），见 §5.4。

## 2. 启动

```powershell
mise install
mise run setup            # mise.toml:32（UI/Agent/CP/Runtime 依赖）
mise run dev:host         # mise.toml:275（先起 PG 容器，再并行起 CP/Agent/Runtime/UI）
mise run dev:host:check   # mise.toml:307（可选：只读预检 工具/Docker/端口/host root）
```

- `dev:host` **不导入配置、不创建 Provider Connection**（`mise.toml:280`）；需要时显式 `mise run dev:host:import-config`（`mise.toml:290`）或 `mise run dev:host:provider-init`（`mise.toml:296`）。
- 停栈：`mise run dev:host:stop`（`mise.toml:317`）。
- 换个端口段（多栈并行）：`mise run dev:stack -- --stack 2`（`mise.toml:285`），槽位表见 DEV-002「模式 D」。

## 3. 首跑（本地模式 onboarding）

**三个条件缺一不可**，否则 CP 启动即拒绝（`LocalModeService.java:49-64`）：

1. `XIHE_LOCAL_MODE=true`
2. CP 绑定回环：`SERVER_ADDRESS=127.0.0.1`
3. `XIHE_ENV` 不是 `prod`

步骤：

1. 打开 `http://localhost:12630/workspace` → 空实例被推送到 `/onboarding?redirect=…`。
2. 表单只有「邮箱」「名称」，**没有密码字段**（本地模式免密）；空提交时按钮为禁用态。
3. 提交 → `POST /api/v1/auth/register` **201**，落到 `/workspace/<uuid>`；此时 `GET /api/v1/bootstrap-status` 的 `initialized` 由 `false` 变 `true`。
4. 该账号在 localMode 下获得实例级 `SUPER_ADMIN`（0610 访问角色模型），**无需自授权**即可管理 Agent 与设置。

> **localMode 豁免注册策略**：`AuthController.register` 只在**非** localMode 时执行 `registrationPolicy.requireOpen()`。所以「`closed` 策略下首账号仍可注册」是设计内行为，不是缺陷；同一豁免也允许在同一实例继续注册第二个账号（判据与边界见 §5.3）。

## 4. 第一条回复

1. **建工作区时选 `direct_attach`**（指定宿主目录，执行选 `windows-host` 或 `windows-mxc`）。不要用默认的 `managed_import`：它固定 docker 执行后端，而该后端已按冻结/不可用对待（`AGENTS.md` 2026-10-31 裁定；边界见 §5.3 BL-171）。
2. **建 Agent 并绑定**：工作区 →「Agent 管理」→ 新建（`201`）→ 绑定到本工作区（`200`）。
3. **建会话**：「新建对话」→ 选已绑定 Agent → `201` → 进入 `/workspace/<ws>/chat/<session>`，输入框可见。
4. **发一条消息**：`POST /api/v1/chat` 返回 `200/202` + `runId`；随后出现助手气泡。
5. **刷新页面**：消息仍在（persistence）。

模型与连接：

- 本地模式手动首跑时，模型要么用 fake/本地 provider，要么先在设置页建一条 chat 连接（`POST /api/v1/provider-connections` → `201`，再 verify 到 `READY`）。
- 会话需要钉住「连接 + 请求模板三元组（`contextTemplateLayer/Id/Version`）」。**UI 建会话会带上**；**直接用 API 建会话时需自行带**，否则 `409 API_TYPE_REBIND_REQUIRED`。

## 5. 看到什么算成功

### 5.1 七条可见判据

| # | 你会看到什么 | 怎么确认 |
|---|---|---|
| C1 | 首访落在 `/onboarding`，且表单**没有密码框** | 地址栏 `…/onboarding?redirect=…`；标题「开始使用」；只有邮箱/名称两个输入 |
| C2 | 提交后进入**具体工作区**，`initialized` 变 true | 地址变成 `/workspace/<uuid>`；空工作区显示「工作区暂无文件」 |
| C3 | 换一个全新浏览器上下文再打开，**不再要求登录** | 地址栏无 `/login`，页面无账号/密码输入框，但本地持有服务端签发的 token |
| C4 | 点登出后再打开 `/workspace`，**自动免密回到工作区** | 不出现登录表单；落在「选择工作区」列表或工作区视图；`GET /auth/me` 200 |
| C5 | 空实例首账号即最高权限：**无需任何授权步骤**就能进「Agent 管理」 | 导航出现管理入口；权限接口含 `instance:super`；Agent 管理弹窗可打开 |
| C6 | 建 Agent → 绑定 → 建会话，**输入框出现** | Agent 创建 201、绑定 200；会话 201 且地址为 `…/chat/<session>`；composer 可见 |
| C7 | 发一条消息后**助手气泡出现且刷新仍在** | 出现左侧助手消息且文本非空、无内联错误块；刷新后消息条数 ≥2 |

### 5.2 判据 → spec 断言映射

| 判据 | spec 用例（行号） | 关键断言（行号） |
|---|---|---|
| C1 | `G1-a`（`goldpath-first-run.spec.ts:432`） | `bootstrap.localMode===true`（:437）、URL 匹配 `/onboarding?redirect=`（:442）、标题「开始使用」（:443）、`#email`/`#name` 可见（:446-447）、`#password` 数量为 0（:448）、提交按钮禁用（:449） |
| C2 | `G1-b`（:452） | 注册 **201**（:472）、`initialized===true`（:473）、`workspace-empty-state` 可见（:479）、本地有 token（:480）、`isInstanceSuper===true`（:484）、`nav-rail-settings` 可见（:487） |
| C3 | `G1-c`（:490） | `#identifier` 数量为 0（:503）、token 非空（:504） |
| C4 | `G1-d`（:510） | `#identifier` 为 0（:522）、token 非空（:563）、`/auth/me` 200（:565）；落点写进 annotation `goldpath-g1d-landing`（picker 条目**或** 工作区视图，二选一） |
| C5 | `G2-b`（:630） | `isInstanceSuper`（:626/:638）、权限含 `instance:super`（:646）、`nav-rail-admin` 可见（:648）、Agent 管理弹窗与授权面板链接可见（:655-658） |
| C6 | `G2-c`（:651）+ `G2-d`（:689） | Agent 201（:673）、未绑定列表含该 id（:676）、绑定 200（:685）；会话 201（:710）、URL 为 `…/chat/<session>`（:711）、`chat-input` 可见（:714） |
| C7 | `G2-e`（:717） | chat 200/202（:774）+ `runId` 非空（:775）、助手气泡可见（:780）、文本非空（:781-786）、`message-error` 计数 0（:787）、reload 后消息 ≥2（:789-795）、会话条目可见（:796） |

补充（不在 C1–C7，但同批覆盖）：C8 连接「验证并保存」到 `READY` 且 fake 模型可选 —— `G3-a`（:811，201@:859、verify@:867、名称可见@:873）与 `G3-b`（:876，`model-item-*` 可见@:890-893）。

### 5.3 已知边界（必读，避免把"没绿"误读成回归）

1. **G4 两条是 `test.fixme`，且在 host 车道不被收集**：`G4-a`（:902-915，BL-152 错误文案可读性）与 `G4-b`（:918-925，F-09 连接→Agent 就绪）位于 `@gap` describe（:901），而 host 车道的 Playwright 配置是 `grep: /@host/`（`packages/ui/e2e/playwright.config.ts:42`）⇒ 这两条**既不通过也不 skip，而是不进入 run 列表**；用 `--grep "@gap"` 单独跑也会被 config 的 grep 覆盖。要看它们需改配置或另开车道（本波不做）。来源：`m1-m2.md` §8.8 拆分说明。
2. **localMode 豁免注册策略（C5/G1-e 口径）**：`G1-e`（:568）可证伪的断言是「`bootstrap-status.localMode===true`（:586）+ 第二次注册 **201**（:598）」+ annotation 记录，而**不是**「第二次注册 403」。原因见 §3 的豁免说明；要验严格 403 需**非 localMode** 栈（本波未做）。
3. **BL-169（spec 假设错，非产品缺陷）**：localMode 免密重登分支会写入 tab 上下文（`router/index.ts`），所以 C4 的落点是**工作区视图**而不是「选择工作区」列表；用例因此断言「picker 条目 **或** 工作区视图」二选一。产品行为待裁定（A/B），本波不改。
4. **BL-170（分支内已有修复，B 类待裁定）**：路由守卫写入的会话原先不进 Pinia ⇒ 免密进入后首屏**看不到管理入口**、config/session 预载被跳过（刷新才正常）。本分支包含修复（`stores/auth.ts` 的 `adoptGuardSession()`、`router/index.ts` 守卫采用会话、`App.vue` 等 `router.isReady()`），属**产品代码变更**，合并前需用户裁定。
5. **BL-171（产品未改，车道绕开）**：自动创建的默认工作区固定 `managed_import` + docker 后端 ⇒ 在 docker 后端按冻结/不可用对待的当下，「首条回复」结构性不可达。§5 矩阵里 G2-e 是**自建 `direct_attach` 工作区**才通过的；产品侧默认值未改。
6. **BL-172（已修，带回归护栏）**：工作区选择面在"弹回"后永久停在 loading（早退分支不复位 + 弹回不清上下文 ⇒ bounce loop）。修复在 `WorkspacePicker.vue`/`WorkspaceView.vue`，并有 2 条单测护栏（回退修复即 2 failed）。

### 5.4 复跑这张矩阵（E2E 车道）

```powershell
# 全新隔离栈；每轮自建 PG 容器 + 随机端口，跑完 teardown
node scripts/e2e-host.mjs --batch=goldpath --retries=0
node scripts/e2e-host.mjs --batch=goldpath-closed --retries=0
# 等价的 mise 任务（单个 spec / 手工参数）
mise run test:e2e:host -- e2e/real/goldpath-first-run.spec.ts   # mise.toml:181
```

runner 的三个 gold path flag（`scripts/e2e-host.mjs:438-440`，默认**全关**，故既有批次行为不变）：

| flag | 语义 | 默认 |
|---|---|---|
| `--first-run=local` | 空库 + `XIHE_LOCAL_MODE=true` + `SERVER_ADDRESS=127.0.0.1` + **不 seed admin** | 关 |
| `--bootstrap-user=register\|none` | `register` = runner 注册首账号并据此导入 fake LLM profile；`none` = 由 spec 自己注册 | `none` |
| `--registration-policy=open\|closed` | 注入 `XIHE_AUTH_REGISTRATION_POLICY`（localMode 仍豁免首账号） | `open` |

四个批次（`scripts/e2e-batches.jsonc:144-175`）：

| 批次 | 内容 | 为什么有 skipped |
|---|---|---|
| `goldpath-first-run` | G1 全量（virgin 空库） | 无：栈是空的，G1-a..e 都应执行（`closed` 变体由 `goldpath-closed` 承担） |
| `goldpath` | G1-c/d + G2 + G3（+ G4 fixme 不收集） | G1-a/b/c 因 runner 已用 `--bootstrap-user=register` 初始化账号而自 skip；G1-e 需 closed 策略 → skip |
| `goldpath-closed` | G1-e 反向对照 | G2/G3 需 `--bootstrap-user=register` 账号车道 → skip；G1-c 需 virgin → skip |
| `goldpath-web`（可选，未进 smoke） | 用 `--grep G2-e` 跑单用例（~1.5 min） | 观察两轮后再决定是否并入 smoke |

## 6. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `dev:host` 起不来，端口被占 | 12630-12634 被其它栈/进程占用 | `mise run dev:host:check`（`mise.toml:307`）；或换槽位 `--stack 2` |
| CP 启动即退出，日志提示 localMode 需回环 | 只设了 `XIHE_LOCAL_MODE=true`，没设 `SERVER_ADDRESS=127.0.0.1`（或 `XIHE_ENV=prod`） | 补齐三条件（§3） |
| 工作区创建后操作报后端不可用 | 用了默认 `managed_import`（docker 后端，已冻结） | 改用 `direct_attach`（§4 第 1 步） |
| 发消息 `503 LLM_NOT_CONFIGURED` | 没有可用模型/连接（`missing_credentials`） | 建连接并 verify 到 `READY`；这是 G4-a 的现状（BL-152），不是本文路径的失败 |
| 发消息 `409 API_TYPE_REBIND_REQUIRED` | 会话没有钉住「连接 + 模板三元组」 | 用 UI 建会话，或 API 显式带三元组 |
| `POST /local-login` 404 | 非回环来源 / 非单用户实例（门禁 fail-closed 404） | 用 `127.0.0.1`/`localhost` 打开；确认实例只有一个可登录账号 |
| 免密进入后看不到管理入口，刷新就好 | BL-170 现状 | 见 §5.3 第 4 条（分支内已修，待裁定） |

## 7. 与 USER-001 / DEV-002 的分工

| 文档 | 负责 | 不重复的内容 |
|---|---|---|
| **本文（DEV-033）** | 空白实例 → 首条回复的最短路径；每条判据对应的 spec 断言；首跑车道（runner flags / 四批次） | 不写模块架构、不写运维 CLI、不写完整配置面 |
| [USER-001](USER-001-user-guide.md) | 有账号之后的**功能使用**（聊天、多模态、MCP 工具、成员、设置） | §1.4 只保留注册/登录并指向本文的"空实例首跑" |
| [DEV-002](DEV-002-developer-guide.md) | 环境搭建全量、运行模式 A/B/C/D、全栈调试、测试入口 | 不重复首跑判据，只在「模式 A」指向本文 |

术语按 [DEV-032](DEV-032-terminology.md)，本文不引入新术语：「本地模式」即代码/环境变量里的 `localMode`（`XIHE_LOCAL_MODE`）；「首跑 / gold path」指本文描述的「空白实例 → 首条回复」最短路径，取自 PLAN-0611 的计划名，仅在此处定义一次，不作第二个正名扩散。其余词（`bootstrap-status`、`SUPER_ADMIN`、`direct_attach`、`managed_import`）均为既有词。
