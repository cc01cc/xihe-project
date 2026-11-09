---
title: DEV-033 - 新手首跑（gold path）
category: dev-guide
sidebar_order: 33
lang: zh-Hans
sidebar_group: "开发指南"
status: active
created: 2026-11-01
updated: 2026-11-10
---

# DEV-033: 新手首跑（gold path）

> **定位**：从**空白实例**到**第一条助手回复**的最短可验证路径。面向第一次接触 XH 的人：每条命令都指向 `mise.toml` 的具体任务，每条「看到什么算成功」都能指到 `packages/ui/e2e/real/goldpath-first-run.spec.ts` 的具体断言（映射见 §5.2）。
>
> **本文的证据范围**：`plans/PLAN-0614-XH-first-run-blank-start/evidence/m3-goldpath.md` §3 的 **6 轮全新栈矩阵**（`goldpath` ×3 = 9 passed / 4 skipped；`goldpath-closed` ×3 = 5 passed / 8 skipped；0 failed / 0 flaky / 0 did-not-run）**加上 Lead 的 1 次独立复跑**（`goldpath` = 9 passed / 4 skipped）。矩阵之外的部分集中写在 §5.3，本文不据此宣称"已完成"。

## 1. 前置

| 项 | 要求 | 依据 |
|---|---|---|
| 工具链 | Node 24 / pnpm 10 / Python 3.14 / uv / Java 25 / Maven 3.9 / Rust 1.97.1，由 `mise install` 固定 | `mise.toml:23-30`（`[tools]`） |
| Docker | **仅 PostgreSQL** 用容器；服务容器化与 `xihe/workspace` 镜像构建已冻结，不要试图 `docker compose up` 全栈 | `mise.toml:1-16`（冻结说明） |
| 目录 | **任意目录**即可（单 clone）；不再是"必须在 `one/` 工作区内" | `mise run check:standalone`（`mise.toml:395`）自检「不依赖 one 根」 |
| 端口 | stack-1：UI 12630 / CP 12631 / Agent 12632 / Runtime 12633 / PG 12634 | `scripts/lib/stack-ports.mjs:20`（端口事实源） |
| 工作区 | **首启没有任何工作区**：注册/登录都不再自动创建，第一步是用户自己建（§3 第 2 步 / §4 第 1 步） | `AuthController.withFirstWorkspace`（`AuthController.java:137,165,196-201`） |

两种运行前提，按用途选：

1. **单机 dev 栈 + 已 seed 的管理员登录（新手默认）**：一套 `dev:host`（或 `dev:stack`）栈，首跑账号由 CP `DataSeeder` 建（`admin@xihe.local`），登录后按 §3/§4 走空库起步；密码来源见 §3。
2. **隔离 E2E 栈（复跑 §5 矩阵）**：`scripts/e2e-host.mjs` 每轮自建 PG 容器与随机端口（27xxx 段），见 §5.4。

> **本地模式（`XIHE_LOCAL_MODE`）已放弃（甲方案，2026-11-10）**：不作为首跑路径、不提供启用支持。§3/§5 里仍会出现它，因为 §5 矩阵的 `goldpath-first-run.spec.ts` 跑在 `--first-run=local` 车道上，保留的是**回归证据**；历史设计与残余风险见内部存档 `internal/A03-xihe/docs/localmode-enablement.md`（`status: deprecated`）。

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

## 3. 首跑（登录 dev 管理员 → 空白起步）

**「空白实例」= 没有工作区，不是没有账号**：CP 启动时 `DataSeeder` 在**非**本地模式下建 `admin@xihe.local`，并在同一事务里把它绑成 instance owner + `SUPER_ADMIN`（`DataSeeder.java:65-89`）。所以首跑不需要注册，也不需要（已放弃的）本地模式。

密码从哪来，按你的起栈方式二选一：

| 起栈方式 | 密码来源 |
|---|---|
| `mise run dev:stack`（模式 A2，`scripts/dev-stack.mjs start`） | D-766 自动注入：① `XIHE_DEV_ADMIN_PASSWORD` ② `.env` 链已配值 ③ 已持久化的 `.local/dev/admin-password` ④ 首次生成 24 字节 base64url 并持久到同一路径；日志只打 `source`/`length`/`file`，**不打密码值**（`scripts/lib/dev-admin-password.mjs`；细节见 [DEV-002](DEV-002-developer-guide.md) §4「dev 管理员密码自动注入」） |
| `mise run dev:host`（模式 A） | **不走** D-766：`DataSeeder` 用随机密码且不打印 ⇒ 起栈后先 `mise run reset-admin` 显式设一次（BL-523：密码走 stdin 或 `XIHE_RESET_ADMIN_PASSWORD`；账号行不存在时 exit 3，提示 `mise run dev:reset` 或重启让 `DataSeeder` 建行） |

步骤：

1. 打开 `http://localhost:12630/login`，用 `admin@xihe.local` + 上一步的密码登录（`POST /api/v1/auth/login` 200）。
2. 登录后落在 `/workspace` 的**空态**：显示「创建你的第一个工作区」，工作区条目 0，`GET /api/v1/workspaces` 返回**空数组**，`AuthResponse.workspaceId` 为 **`null`**（`AuthController.withFirstWorkspace`，注册与登录同一条路径）。
3. 该账号是 instance owner + `SUPER_ADMIN`（`InstanceOwnershipService.ensureAssigned` / `GrantDefaultService.ensureInstanceSuperAdmin`，seed 点在 `DataSeeder.java:86-89`），**无需自授权**即可管理 Agent 与设置。

> **注册路径不再是首跑主路径**：`/onboarding` 在非本地模式下仍可用（表单含**密码**；缺密码返回 **400 `INVALID_REQUEST`**，`AuthController.java:113-119`），但**注册不授予 instance owner / `SUPER_ADMIN`** —— 那两步 seed 只在本地模式分支里执行（`AuthController.java:126-136`，前提是 `XIHE_LOCAL_MODE=true`，而本地模式已放弃）。想让某个注册账号成为实例管理员，走授权面，不要靠开本地模式。

> **本地模式（`XIHE_LOCAL_MODE`）已放弃（甲方案，2026-11-10）**：它不再是可推荐的首跑路径，也不提供启用支持。当时的四条件门禁、单用户计数、prod fail-fast 与残余风险全部保留在内部存档 `internal/A03-xihe/docs/localmode-enablement.md`（`status: deprecated`）。

> **不再有"系统自动创建的工作区"**：注册 / 登录 / `local-login` / `refresh` 一律只**读取**该账号的第一个活跃工作区，不创建（`AuthController.withFirstWorkspace`）。既有账号不受影响（有工作区就照常返回第一个）。这也意味着旧缺陷 **BL-171**（首跑落在"聊天必失败"的默认工作区）不再存在——第一步就是用户自己选目录。

> **本地模式豁免注册策略（历史）**：`AuthController.register` 只在**非**本地模式时执行 `registrationPolicy.requireOpen()`（`AuthController.java:108-110`）。所以「`closed` 策略下首账号仍可注册」是设计内行为，不是缺陷；同一豁免也允许在同一实例继续注册第二个账号。**该豁免随 local mode 放弃**，现在只在 §5 的 E2E 车道里还能观察到（判据与边界见 §5.3 第 2 条）。

## 4. 从空态到第一条回复

1. **建第一个工作区**：点空态里的「创建你的第一个工作区」（`workspace-picker-create`）→ 打开真实的创建对话框：
   - 存储模式选 **`direct_attach`**（`workspace-storage-direct`）——这也是**唯一可选**的存储方式（`storageMode` 必填、无默认值：省略 → `400 INVALID_REQUEST`）。`managed_import` 走 docker 执行后端，已按完全冻结对待，会被 CP 直接拒绝（`409 BACKEND_DISABLED`，见 [DEV-014](DEV-014-control-plane-architecture.md) §8b）；
   - 填**宿主目录**（`workspace-source-path`）→「读取目录」（`workspace-source-read`）→ 目录浏览确认（`workspace-source-browser`）→「使用该目录」（`workspace-source-use`）；
   - 执行模式由**能力预检**决定：`windows-mxc` 可用则用 `windows-mxc`，否则退 `windows-host`（宿主执行需勾风险确认）。
2. **提交** → `POST /api/v1/workspaces` **201** → 地址变为 `/workspace/<newId>`，工作区视图显示「工作区暂无文件」（`workspace-empty-state`）。
3. **建 Agent 并绑定**：工作区 →「Agent 管理」→ 新建（`201`）→ 绑定到本工作区（`200`）。
4. **建会话**：「新建对话」→ 选已绑定 Agent → `201` → 进入 `/workspace/<ws>/chat/<session>`，输入框可见。
5. **发一条消息**：`POST /api/v1/chat` 返回 `200/202` + `runId`；随后出现助手气泡。
6. **刷新页面**：消息仍在（persistence）。

模型与连接：

- 手动首跑时，模型要么用 fake/本地 provider，要么先在设置页建一条 chat 连接（`POST /api/v1/provider-connections` → `201`，再 verify 到 `READY`）。
- 会话需要钉住「连接 + 请求模板三元组（`contextTemplateLayer/Id/Version`）」。**UI 建会话会带上**；**直接用 API 建会话时需自行带**，否则 `409 API_TYPE_REBIND_REQUIRED`。

## 5. 看到什么算成功

### 5.1 八条可见判据

> **读法（2026-11-10 起）**：C1 / C4 / C5 是 **E2E 本地模式车道**（`--first-run=local`）的判据，用途是守住 §5.2 那批 spec 断言 —— 本地模式**已放弃**，不再是首跑路径（首跑见 §3）。C2 / C3 / C6 / C7 / C8 与车道无关：空态、建 `direct_attach` 工作区、instance owner 权限、会话、首条回复。

| # | 你会看到什么 | 怎么确认 |
|---|---|---|
| C1 | 首访落在 `/onboarding`，且表单**没有密码框** | 地址栏 `…/onboarding?redirect=…`；标题「开始使用」；只有邮箱/名称两个输入；提交按钮禁用 |
| C2 | 提交后进的是**空态首屏**（没有任何工作区） | 页面显示「创建你的第一个工作区」按钮；工作区条目数为 **0**；`initialized` 变 true |
| C3 | 点该按钮**建出第一个工作区并进入** | 出现创建对话框（可选目录、能读到 source path）；提交后地址变成 `/workspace/<uuid>`，显示「工作区暂无文件」；移动端展开文件树后同样可见 |
| C4 | 换一个全新浏览器上下文再打开，**不再要求登录** | 无 `/login`，无账号/密码输入框，但本地持有服务端签发的 token |
| C5 | 点登出后再打开 `/workspace`，**自动免密回到落点** | 不出现登录表单；落在工作区视图或选择面（任一种都算，见 §5.3）；`GET /auth/me` 200 |
| C6 | 空实例首账号即最高权限：**无需任何授权步骤**就能进「Agent 管理」 | 导航出现管理入口；权限接口含 `instance:super`；Agent 管理弹窗可打开 |
| C7 | 建 Agent → 绑定 → 建会话，**输入框出现** | Agent 创建 201、绑定 200；会话 201 且地址为 `…/chat/<session>`；composer 可见 |
| C8 | 发一条消息后**助手气泡出现且刷新仍在** | 左侧助手消息文本非空、无内联错误块；刷新后消息条数 ≥2，会话条目仍在 |

补充（不在 C1–C8，但同批覆盖）：C9 连接「验证并保存」到 `READY` 且 fake 模型可选。

### 5.2 判据 → spec 断言映射

| 判据 | spec 用例（行号） | 关键断言（行号） |
|---|---|---|
| C1 | `G1-a`（`goldpath-first-run.spec.ts:492`） | `bootstrap.localMode===true`（:497）、URL 匹配 `/onboarding?redirect=`（:502）、标题「开始使用」（:503）、`#email`/`#name` 可见（:506-507）、`#password` 数量为 0（:508）、提交按钮禁用（:509） |
| C2 | `G1-b`（:515） | 注册 **201**（:535）、`initialized===true`（:536）、**`workspace-picker-empty` 可见**（:544）、**`workspace-picker-create` 可见**（:545）、**`workspace-picker-item-*` 计数 0**（:547）、token 非空（:548）、`isInstanceSuper`（:555）、`nav-rail-settings` 可见（:558） |
| C3 | `G1-b2`（:561） | 空态可见（:573）、创建对话框可见（:577）、`workspace-source-browser` 可见（:586）、preflight 200（:599）、能力可用（:607）、创建 200/201（:622）、URL 为 `/workspace/<id>`（:626）、`workspace-empty-state` 可见（:629）、移动页签同断言（:639） |
| C4 | `G1-c`（:648） | `#identifier` 数量为 0（:662）、token 非空（:663） |
| C5 | `G1-d`（:669） | `#identifier` 为 0（:681）、token 非空（:719）、`/auth/me` 200（:721）；落点写进 annotation `goldpath-g1d-landing`（三态任一：空态 / 条目 / 工作区视图） |
| C6 | `G2-b`（:786） | `isInstanceSuper`（:782/:794）、权限 200（:800）且含 `instance:super`（:802）、`nav-rail-admin` 可见（:804）、Agent 管理弹窗（:814）与授权面板链接（:817） |
| C7 | `G2-c`（:807）+ `G2-d`（:851） | Agent 201（:832）、principal id 格式（:834）、未绑定列表含该 id（:835）、绑定 200（:844）；会话 201（:873）、URL 为 `…/chat/<session>`（:874）、`chat-input` 可见（:877） |
| C8 | `G2-e`（:880） | chat 200/202（:937）+ `runId` 非空（:938）、助手气泡可见（:943）、文本非空（:944-949）、`message-error` 计数 0（:950）、reload 后消息 ≥2（:955-961）、会话条目可见（:962） |
| C9（补充） | `G3-a`（:977）/ `G3-b`（:1043） | 连接 201（:1026）、verify 成功（:1034）、名称可见（:1040）；`model-item-*` 可见（:1055-1058） |

**没有测试支撑的判据：0 条。** §4 的 `409 API_TYPE_REBIND_REQUIRED`、§6 的 503/409/404 是**故障排查条目**，不按"成功判据"呈现，故不要求断言映射（其中 503 文案正是 G4-a 的 fixme 主题，见 §5.3）。

### 5.3 已知边界（必读，避免把"没绿"误读成回归）

1. **G4 两条是 `test.fixme`，且在 host 车道不被收集**：`G4-a`（:1069-1082，BL-152 错误文案可读性）与 `G4-b`（:1085-1092，F-09 连接→Agent 就绪）位于 `@gap` describe（:1068），而 host 车道的 Playwright 配置是 `grep: /@host/`（`packages/ui/e2e/playwright.config.ts:42`）⇒ 这两条**既不通过也不 skip，而是不进入 run 列表**；`--grep "@gap"` 也会被 config 的 grep 覆盖。要看它们需改配置或另开车道（本波不做）。
2. **本地模式豁免注册策略（G1-e 口径）**：`G1-e`（:724）可证伪的断言是「`bootstrap-status` 200（:741）+ `localMode=true`（:742）+ 第二次注册 **201**（:754）」，而**不是**「第二次注册 403」。原因见 §3 的豁免说明；要验严格 403 需**非本地模式**栈（本波未做）。（2026-11-10 补：该豁免随本地模式放弃，只在 E2E 车道仍可观察。）
3. **BL-169（已裁定：本地模式免密登录的上下文写入是有意行为）**：守卫在本地模式免密自动登录时会写入 tab 上下文（`router/index.ts` → `resolveLocalModeLanding`），所以 C5 的落点可能是**工作区视图**而不是选择面；用例因此接受三态任一。该例外已写入 `packages/ui/AGENTS.md`（I6 例外，`ef73ae12`）。（2026-11-10 补：该例外随本地模式放弃失去正当性，已作为残余风险记入 `localmode-enablement.md` §3.6。）
4. **BL-170（已修复，随 0614 M2 合入）**：守卫写入的会话原先不进 Pinia ⇒ 免密进入后首屏看不到管理入口、config/session 预载被跳过。修复：`stores/auth.ts#adoptGuardSession`（`:146`）、守卫采用该会话、`App.vue` 等 `router.isReady()`（`39e6f093`）。C6 依赖此修复。
5. **BL-171（已收口，由 PLAN-0614）**：旧行为是"注册即建一个 `managed_import` + docker 的默认工作区"，在 docker 后端按冻结/不可用对待后，首跑聊天结构性失败。0614 的空白起步把这条路径**移除**（不再自动建工作区），用户第一步就自己选 `direct_attach`。文档不再描述"默认工作区"。
6. **BL-172（已修，带回归护栏）**：工作区选择面在"弹回"后永久停在 loading（早退分支不复位 + 弹回不清上下文 ⇒ bounce loop）。修复在 `WorkspacePicker.vue`（`clearTabWorkspace()` / `loading` 复位）与 `WorkspaceView.vue`，并有 2 条单测护栏。
7. **BL-174（删除工作区的授权口径）**：`DELETE /api/v1/workspaces/{id}` 是**能力判定**——`WS_OWNER` ∪ `cap:workspace:admin`；**内容原子 `delete` 不构成凭据**（`WS_EDITOR` 删文件可以，删工作区 403 `WORKSPACE_FORBIDDEN`）。详见 [DEV-014](DEV-014-control-plane-architecture.md) §8b。

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
| `--first-run=local` | 空库 + `XIHE_LOCAL_MODE=true` + `SERVER_ADDRESS=127.0.0.1` + **不 seed admin**。**local mode 已弃用**：参数保留仅因 e2e 兼容，且它仍是 runner 唯一接受的取值 | 关 |
| `--bootstrap-user=register\|none` | `register` = runner 注册首账号并据此导入 fake LLM profile；`none` = 由 spec 自己注册 | `none` |
| `--registration-policy=open\|closed` | 注入 `XIHE_AUTH_REGISTRATION_POLICY`（本地模式仍豁免首账号） | `open` |

四个批次（`scripts/e2e-batches.jsonc:144-175`）：

| 批次 | 内容 | 为什么有 skipped |
|---|---|---|
| `goldpath-first-run` | G1 全量（virgin 空库） | 无：栈是空的，G1-a..e 都应执行（`closed` 变体由 `goldpath-closed` 承担） |
| `goldpath` | G1-b2 + G1-d + G2 + G3（+ G4 fixme 不收集） | 4 个 skip：G1-a/G1-b/G1-c 是 virgin 用例（栈已被 `--bootstrap-user=register` 初始化）+ G1-e 需 closed 策略。**执行 9 条** |
| `goldpath-closed` | G1-a/G1-b/G1-b2/G1-d/G1-e | 8 个 skip：G1-c 需 virgin + G2/G3 需账号车道。**执行 5 条** |
| `goldpath-web`（可选，未进 smoke） | 用 `--grep G2-e` 跑单用例（~1.5 min） | 观察两轮后再决定是否并入 smoke |

**实测（原文见 `m3-goldpath.md` §3）**：`goldpath` 3 轮 = 9 passed / 4 skipped（22.9s / 22.9s / 24.9s），`goldpath-closed` 3 轮 = 5 passed / 8 skipped（9.2s / 8.8s / 11.2s），全部 exit 0、0 failed / 0 flaky / 0 did-not-run，teardown 均无残留；另有 Lead 1 次独立复跑 `goldpath` = 9 passed / 4 skipped。超出这个范围的不作断言。

### 5.5 截图对照（7 张，与断言同源）

> 截图拍摄于 2026-11 的**本地模式车道**（`--first-run=local`）：`01-onboarding.png` 的「只有邮箱/名称、没有密码框」就是该车道形态。本地模式已放弃，判据读法见 §5.1 注。

截图目录（不在 A03 仓库内，按需打开）：[t5.2-screenshots](../../../../plans/archive/PLAN-0611-XH-first-run-goldpath/evidence/t5.2-screenshots/)

| 文件 | 对应判据 / 用例 | 截到的关键画面 |
|---|---|---|
| `01-onboarding.png` | C1 / `G1-a` | `/onboarding` 表单：只有邮箱与名称，提交按钮禁用 |
| `02-empty-picker.png` | C2 / `G1-b` | 空态首屏：「创建你的第一个工作区」，无任何条目 |
| `03-create-workspace-dialog.png` | C3 / `G1-b2` | 创建对话框 + 已读到 source path |
| `04-workspace-view.png` | C3 / `G1-b2` | 进入新工作区，显示「工作区暂无文件」 |
| `05-agent-session.png` | C7 / `G2-c` | Agent 创建 + 绑定完成态 |
| `06-first-reply.png` | C8 / `G2-e` | 首条助手回复气泡 |
| `07-mobile-workspace.png` | C3 移动页签（390×844） | 展开文件树后同样可见空工作区 |

## 6. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `dev:host` 起不来，端口被占 | 12630-12634 被其它栈/进程占用 | `mise run dev:host:check`（`mise.toml:307`）；或换槽位 `--stack 2` |
| CP 启动即退出，日志提示本地模式需回环 | 只设了 `XIHE_LOCAL_MODE=true`，没设 `SERVER_ADDRESS=127.0.0.1`（或 `XIHE_ENV=prod`） | 补齐三条件（见存档 `localmode-enablement.md` §1）。**local mode 已弃用**：该现象只会在 §5 的 E2E 车道或历史存档语境下遇到 |
| 登录后是空白页面、没有任何工作区 | **正常**（0614 起不再自动创建工作区） | 点「创建你的第一个工作区」（§4 第 1 步） |
| 创建对话框里目录读不出来 | 路径不是 Runtime 可见的宿主目录，或后端不可用 | 换一个真实存在的宿主目录；先跑 `POST /api/v1/workspaces/capabilities/preflight` 看 `available=false` 的 `reason` |
| 建工作区返回 `409 BACKEND_DISABLED` | 选了 `managed_import`（docker 后端已完全冻结） | 改选 `direct_attach` |
| 建工作区返回 `400 INVALID_REQUEST` | 请求没带 `storageMode`（该字段必填、无默认值，PLAN-0618） | 显式传 `direct_attach` + `hostPath` + `executionMode`；UI 对话框默认即 `direct_attach` |
| 发消息/建会话返回 `503 BACKEND_DISABLED` | 目标工作区是既有 docker（`managed_import`）工作区，执行后端已冻结 | 新建一个 `direct_attach` 工作区后继续（详见 [DEV-018](DEV-018-known-issues.md)） |
| 发消息 `503 LLM_NOT_CONFIGURED` | 没有可用模型/连接（`missing_credentials`） | 建连接并 verify 到 `READY`；这是 G4-a 的现状（BL-152），不是本文路径的失败 |
| 发消息 `409 API_TYPE_REBIND_REQUIRED` | 会话没有钉住「连接 + 模板三元组」 | 用 UI 建会话，或 API 显式带三元组 |
| `POST /local-login` 404 | 非回环来源 / 非单用户实例（门禁 fail-closed 404） | 用 `127.0.0.1`/`localhost` 打开；确认实例只有一个可登录账号。**`/local-login` 随本地模式弃用**（代码保留仅供 E2E 车道），首跑请用 `/login` |
| 工作区选择面一直停在"正在加载" | BL-172 的旧症状（已修） | 升级到含 `39e6f093` 的版本；若仍复现，按 §5.3 第 6 条取证 |

## 7. 与 USER-001 / DEV-002 的分工

| 文档 | 负责 | 不重复的内容 |
|---|---|---|
| **本文（DEV-033）** | 空白实例 → 建第一个工作区 → 首条回复的最短路径；每条判据对应的 spec 断言；首跑车道（runner flags / 四批次 / 截图） | 不写模块架构、不写运维 CLI、不写完整配置面 |
| [USER-001](USER-001-user-guide.md) | 有账号之后的**功能使用**（聊天、多模态、MCP 工具、成员、设置） | §1.4 只保留注册/登录并指向本文的「空白实例首跑」 |
| [DEV-002](DEV-002-developer-guide.md) | 环境搭建全量、运行模式 A/B/C/D、全栈调试、测试入口 | 不重复首跑判据，只在「模式 A」指向本文 |

术语按 [DEV-032](DEV-032-terminology.md)，本文不引入新术语：「本地模式」即代码/环境变量里的 `localMode`（`XIHE_LOCAL_MODE`，**已放弃**，2026-11-10；本文件只在 §5 的 E2E 车道语境里使用该词）；「首跑 / gold path」指本文描述的「空白实例 → 首条回复」最短路径，取自 PLAN-0611 的计划名，仅在此处定义一次，不作第二个正名扩散。其余词（`bootstrap-status`、`SUPER_ADMIN`、`direct_attach`、`managed_import`、`workspace-picker-*` 为 testid）均为既有词或选择器字面。
