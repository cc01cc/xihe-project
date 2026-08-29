# DEV-012: Known Issues (Supplement)

本文件收录不属于 AGENTS.md 最关键的 5 项的已知问题，供排查时参考。

## 环境 / Docker

- **WSL2 OOM**: 修改 vitest config 前需 `bash ../../scripts/cleanup-wsl-resources.sh`
- **Container name**: `docker compose up -d` 前先 `docker rm -f xihe-*` 清理残留

## Code

- **Jackson 3.x fieldNames**: Spring Boot 4.x 使用 Jackson 3.x (`tools.jackson.databind`)。`JsonNode.fieldNames()` 已移除，改为 `JsonNode.propertyNames()`（返回 `Collection<String>` 而非 `Iterator<String>`）
- **JSONB @JdbcTypeCode**: JPA 实体含 `columnDefinition = "jsonb"` 的 String 字段必须加 `@JdbcTypeCode(SqlTypes.JSON)`，否则 PG 报类型不匹配
- **ConfigClient URL 路径**（Agent `config_client.py`、Runtime `config_client.rs`）：CP 内部端点路径为 `/internal/v1/config/{layer}/{domain}`（注意是 `/internal/v1` 前缀，非 `/internal`，亦非 `/api/v1/internal`）。PLAN-049 T3 测试暴露了此 bug——Agent/Runtime ConfigClient 曾误用 `/api/v1/internal/config/...`。新增模块调用时确认路径为 `/internal/v1/config/...`
