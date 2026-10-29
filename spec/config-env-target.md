# 配置目标态与 env 映射（config-env-target）

> 契约状态：`proposed`；实现状态：`partial`；Profile：`configuration`；Owner：CP ConfigService；来源：PLAN-0307（T3.1/T3.4/T3.5）、PLAN-0389、PLAN-0526；更新：2026-10-16。
> 消费者：CP / Agent / Runtime 各模块的 env 链 loader 与启动校验；`DEV-003-config-management.md`。
> 说明：本文件补齐历史上被多处引用（`§1.2/§1.5` 与 `§6`）但缺失的目标态规范；优先级模型另见 [`configuration/env-effective.md`](configuration/env-effective.md)，本文件只定义 **env 映射与危险默认清单**。

## 1 env 链与模块 loader

### 1.1 文件链

- 部署环境变量来源链（按加载顺序）：`.env` → `.env.$XIHE_ENV` → `.env.local`；再由进程 env 覆盖。
- 启动期由各模块**内置 loader** 读取；命中即成为该键的最终生效值（部署权威），业务域键不得进入该链。

### 1.2 加载顺序（loader 语义）

- 后加载覆盖先加载：文件链按 1.1 顺序覆盖，进程 env 覆盖所有文件；显式 CLI `--set` 覆盖进程 env。
- 已存在的进程 env 键视为**已锁定**：不得被文件链覆盖。
- loader 为**模块内置、按设计复制**（CP / Agent / Runtime 各一份），保证模块可独立启动；三份实现的键集合与覆盖语义必须一致。

### 1.3 进程可见性

- 只有启动期由 loader 注入进程的键，运行期代码才能读到；未注入的键对进程不可见。
- 运行期配置（ConfigService 域键）与启动 env 是两条独立通道，互不隐式兜底。

### 1.4 禁止入 env 的键

- 业务域（`llm-provider`、`context-policy` 等）的运行时配置不得写入 env 链；env 只承载**部署/引导类**变量（端口、数据库、密钥、模式开关等）。

### 1.5 模块内置 loader（复制策略）

- 由于模块需独立启动，loader 逻辑与键集合在 CP / Agent / Runtime 各自复制一份；**修改任一份必须三份同批同步**。
- 复制的是**机制**；`§6` 的键实际是**单一清单来源**（本文件），三份实现均须与本清单一致。

## 2 部署权威与锁定

- env 命中的键为最高部署权威：UI 显示 env 生效值并禁用编辑（见 `DEV-003`）。
- env 未设时回落到配置域解析链（`workspace > user > instance > 代码默认`）。

## 3 与配置域的关系

- 配置域三层（`instance / user / workspace`）与 env 相互正交：env 是部署权威，不占三层中的任一层。
- 详细解析链、域归属与凭证两级（`WORKSPACE > USER`）见 [`configuration/env-effective.md`](configuration/env-effective.md) 与 `DEV-003`。

## 4 发布门禁

- 发布（prod）必须**显式**设置 `XIHE_ENV=prod`；未显式设置时，启动校验只 WARN 不拒绝，发布流程须强制补齐。

## 5 验证映射

- 启动校验的键集合与行为以 `§6` 为准；CP / Agent / Runtime 各自的校验器（`SecurityDefaultsValidator`、`security_defaults.py`、`security_defaults.rs`）实现本清单。
- 变更 `§6` 时，三模块实现 + `DEV-003` + 本文件须同批更新。

## 6 危险默认键清单（prod fail-fast）

显式 `XIHE_ENV=prod` 时，下列键命中**出厂态危险默认**即**拒绝启动**并列键与修复指引；未设或 dev 仅 WARN。

| 键 | 危险默认/缺失条件 | 修复 |
|---|---|---|
| `XIHE_CP_JWT_SECRET` | 使用出厂默认值 | 设置强随机密钥 |
| `XIHE_CP_API_TOKEN` / `XIHE_AGENT_API_TOKEN` | 使用 dev token `dev-token-not-secure` | 设置强服务 token |
| `XIHE_CP_OAUTH_ENCRYPTION_KEY` | 未配置 | 提供 base64 AES-256 key |
| `XIHE_CP_OAUTH_ALLOW_DEV_KEY` | 为 `true` | 置 `false` |
| `XIHE_CP_PROVIDER_CREDENTIALS_KEY` | 未配置 | 提供 base64 AES-256 key |
| `XIHE_CP_PROVIDER_CREDENTIALS_ALLOW_DEV_KEY` | 为 `true` | 置 `false` |
| `XIHE_CP_CREDENTIALS_KEY` / `XIHE_CP_CREDENTIALS_KEY_RING` | 两者皆未配置 | 提供 key 或 key ring |
| `XIHE_CP_CREDENTIALS_FINGERPRINT_KEY` | 未配置 | 提供独立 base64 32-byte HMAC key（不得复用加密 key/环，PLAN-0576） |
| `XIHE_CP_CREDENTIALS_ALLOW_DEV_KEY` | 为 `true` | 置 `false` |
| `XIHE_LOCAL_MODE` | 为 `true`（PLAN-0526：本地单用户模式关闭登录入口，禁用于生产） | 置 `false` |
