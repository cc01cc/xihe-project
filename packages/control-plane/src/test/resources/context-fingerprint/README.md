# 真实投影 fixture（PLAN-0666 M1a）

`real-projection.json` 是**一条真实 `context_projections.payload`** 的脱敏副本，供
`ContextFingerprintRealDataTest` 做"两个独立 JVM 计算同一 fixture 必须相等"的验证（verify V1.4）。

## 为什么必须是真实数据

PostgreSQL 的 `jsonb` **不保留插入顺序**：写入时按键长度、再按字节序重排对象键（`payload::text`
导出的就是重排后的顺序）。手工构造的 fixture 无法复现这种真实漂移，而"canonical 化只在单进程
内有效"正是 design D6 / R2 要防的回归。

## 脱敏规则（确定性：同输入 → 同输出）

- `content` / `rendered_text` / `text` / `message` / `prompt` / `arguments` / `result` 等值 → `x` 重复
  （长度保留、上限 96 字符），**结构、键序、元素个数不变**；
- UUID → 稳定占位符（保留唯一性）；
- 其余 opaque 键（`path`/`*_hash`/`id`/`tool_call_id` 等）与超长字符串 → `x` 截断。

生成脚本：`src/test/scripts/refresh-context-fingerprint-fixture.mjs`（用法见脚本头注释，含 psql 取数命令）。

## 刷新时机

- 仅当 `context_projections.payload` 结构发生**契约级变化**（新增/重命名字段）时刷新；
- 刷新后必须重跑 `ContextFingerprintRealDataTest`，并确认 fixture 中不含任何真实内容（测试里有
  子串断言兜底）。
