# official.kv-selftest

**TEST-ONLY fixture — 不作发布物。** PLAN-0691 B-6 ① / T1.5 的插件包，用来给 `plugin_kv` 数据面
（`spec/data-plane.md` DP-1、API-1..4、SEC-1/SEC-2、QUOTA-1..5）留一条**真 MCP 链路**的复验入口：
CP 代理 → 本 fixture → CP 数据面。它不进打包产物、不进 allowlist 发布面、不是可安装给用户的功能。

## 包里有什么

| 文件 | 角色 |
|---|---|
| `manifest.json` | 合法 v1 manifest（`source=builtin`、`runtime.kind=mcp-http`、`storage.kv` 四个声明值）；`digest` 是按 `manifest-rules.md` §3 规范化后算出的真值，`PluginManifestValidator` 会复算并比对 |
| `server.py` | fixture 级 MCP server：`POST /mcp` 提供 `initialize` / `tools/list` / `tools/call`，工具 `kv_selftest` 跑 CAS 契约自检；`GET /healthz` 给 runner 探就绪 |
| `client.json` | 声明式 client：`kv_selftest` 每一步的方法/路径/头/体/期望，与 `server.py` 的步骤一一对应 |
| 本文件 | 说明边界；不是用户文档 |

## 三条硬约束（为什么它能躺在 `plugins/official/` 下）

1. **不碰数据库**：唯一的外部依赖是 CP 的 KV HTTP 端点，没有 SQL、没有 JDBC、没有 psycopg。
   `cross-layer-matrix.md` V1 / `db-design-checklist` 明确插件不得直连 PostgreSQL。
2. **不存凭据**：binding scoped token 从环境变量进来（SEC-1，TTL 300 s），不打日志、不回显、不落盘（B-5）。
3. **只用标准库、单文件、无安装步骤**：需要预置依赖的 fixture 会静默腐烂。

## 怎么跑

CP 侧先备好一个 `state=enabled` 的 binding，并由 CP 签发该 binding 的 300 s token：

```text
XIHE_PLUGIN_KV_BASE=http://127.0.0.1:8080
XIHE_PLUGIN_KV_BINDING=<binding-uuid>
XIHE_PLUGIN_KV_TOKEN=<jwt>
python server.py --port 7331
```

`--port` 默认 7331，与 `manifest.json` 的 `runtime.endpoint` 同值；`XIHE_KV_SELFTEST_PORT` 可覆盖。
`XIHE_PLUGIN_KV_BASE` / `XIHE_PLUGIN_KV_BINDING` / `XIHE_PLUGIN_KV_TOKEN` 缺失时工具**报错并说明缺哪个**，
不会静默通过——fixture 假装成功比 fixture 报错更贵。

自检覆盖的契约（失败第一步即停，返回 `isError: true` 与该步实测状态）：

| 步 | 期望 | 出处 |
|---|---|---|
| 无前置条件 PUT | 412 `PLUGIN_PRECONDITION_REQUIRED` | API-2 |
| `If-Match: *` PUT | 200，version 1 | API-2 |
| GET | 200，值等于写入值 | API-1 |
| 用过期 version PUT | 412 `PLUGIN_PRECONDITION_FAILED` | API-2、API-11 |
| 用过期的 version PUT 后再 GET | 值未被改写 | API-2 |
| 用当前 version PUT | 200，version 2 | API-2 |
| 用当前 version DELETE | 204 | API-3 |
| DELETE 后 GET | 404 `PLUGIN_NOT_FOUND` | API-1、API-11 |

配额面（65536 B 上限、10000 键预算、`ttl` 上限、429/`Retry-After`）由 `PluginKvQuotaTest` 直接打
CP 端点验证，不经过本 fixture——那几条要求精确控制并发与行数，绕一层 MCP 只会变慢、不会更真。

## 与卡片/文档的关系

- `tasks.md` T1.5 要求「fixture 级 mcp-http server + manifest + 声明式 client + README，标 test-only」，
  本目录即该项交付。
- `client.json` 的**格式**没有 spec 冻结（`manifest.schema.json` 只冻结 manifest，`data-plane.md` 只冻结
  wire 契约），因此它是 fixture 私有格式，写在这里仅为人读与将来 runner 复用，**不要**把它当成对外契约。
- `manifest.json` 的 `digest` 一旦改动 manifest 任何字段就必须重算，否则 `PluginManifestValidator` 会以
  422 `PLUGIN_MANIFEST_INVALID` 拒绝安装（这正是 V7 要的行为）。
