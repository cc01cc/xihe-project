---
title: "xihe-control-plane"
category: api
sidebar_group: "@xihe/control-plane"
sidebar_order: 2
lang: zh-Hans
---

# xihe-control-plane

羲和控制平面 — 基于 Spring Boot 的管理服务，负责配置管理、用户认证和 Agent 编排。

## 技术栈

- **Java 25** + **Spring Boot 4.0.6**
- **PostgreSQL** — 数据存储
- **Maven** — 构建工具

## 开发

```bash
./mvnw spring-boot:run    # 默认 JVM 模式启动开发服务器
./mvnw test               # 运行测试
```

## 实验性 Native Image（仅 Windows x64）

当前原生镜像兼容性工作只针对 Windows x64，工具链选择 GraalVM Community Edition 25.4.4.1.1（JDK 25.0.4.1.1）。`native-compat` host lane 已在隔离栈上验收通过（`journey-a` + `plan0584-native-config-schema`，2 passed / 1 skipped / 0 failed），但该 executable 仍为实验产物，不作为受支持的发布产物。日常 `dev:cp` / `spring-boot:run` 仍使用普通 JVM。

在 PowerShell 当前进程中设置 portable GraalVM 的 `JAVA_HOME` 并将其 `bin` 加入 `PATH`。AOT 会启动 CP 应用上下文，因此使用每轮独立的临时 PostgreSQL 与 Runtime channel；不要连接日常开发数据库。

Maven `native-aot` profile 会激活对应的 Spring `native-aot` profile。`application-native-aot.properties` 禁用 AOT 的 `.env` 文件加载，只允许每轮独立的 `XIHE_CP_DATASOURCE_URL` 或本轮 PG port。profile-only `NativeAotDataSourceConfiguration` 根据显式 URL 创建 primary Hikari DataSource；URL 缺失时只使用本轮端口上的隔离 bootstrap DB `xihe`，URL 和端口都缺失即失败，避免嵌入式 H2 或日常端口 fallback。它还启用 `spring.aot.jpa.repositories.use-entitymanager=true` 让 Spring Data JPA 使用真实 `EntityManagerFactory`。数据库密码只经当前进程环境传递；native host runner 会激活同一 Spring profile，普通 JVM/H2 tests 不受影响。
Boot `process-aot` 绑定在 `prepare-package` 阶段；Native Build Tools 的 `native:compile` 会 fork package lifecycle。为保留 AOT profile 配置，在 `packages/control-plane` 同一 Maven session 先跑该阶段再执行 no-fork goal：

```powershell
$env:JAVA_HOME = '<portable GraalVM root>'
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
$env:XIHE_CP_DATASOURCE_URL = 'jdbc:postgresql://127.0.0.1:<port>/<throwaway-database>'
$env:XIHE_CP_DATASOURCE_USERNAME = 'xihe'
$env:XIHE_CP_DATASOURCE_PASSWORD = '<ephemeral password>'
$env:XIHE_CHANNEL_ENABLED = 'true'
$env:XIHE_LOAD_DOTENV = '0'
mvn -Pnative,native-build,native-aot -DskipTests prepare-package native:compile-no-fork
```

独立 PostgreSQL project/port 与 teardown 步骤见 DEV-002 / PLAN-0584 smoke runbook。

Windows 原生产物为 `target/control-plane.exe`。构建还需要受支持的 Visual Studio C/C++ build tools 和 Windows SDK。已验证的构建 envelope：Native Image builder heap 8 GiB、单 worker、Maven heap 512 MiB、deadline 2700 秒，H: 至少保留 20 GiB 空闲；supervisor 强制执行 deadline 与磁盘保留线。

### 选择性 NativeTest 探针

激活 portable GraalVM JDK 后，在 `packages/control-plane` 运行有界组件探针：

```powershell
mvn -PnativeTest,native-build,native-test-probe -Dtest=NativeImageCompatibilityProbeTest test
```

`native-test-probe` profile 只编译该测试类，并让 Spring Test AOT 与 Native Build Tools 共用 probe-only test output。已验证探针覆盖 JWT access-token round-trip、`AuthResponse` accessToken JSON 序列化、ConfigDomainSchema 资源发现/验证、PDFBox split/FileProxy 输出；Windows native test image 中 4 项通过。组件探针不替代仍在验收中的 `native-compat` host lane。

Native runtime 限制：测试所用 GraalVM native executable 不支持 Tomcat platform MBean 路径，因此 `native-aot` profile 排除 `TomcatMetricsAutoConfiguration`；普通 JVM metrics 配置不变。native executable 仍为实验产物，暂不作为受支持的 release artifact。

### 已验证平台矩阵（PLAN-0584）

| 范围 | 验证状态 |
| --- | --- |
| OS 与架构 | Windows 11 Pro x64（10.0.26300），当前唯一选择并实测的 builder 平台；Linux/macOS 未验证。 |
| GraalVM | Community Edition 25.4.4.1.1 / JDK 25.0.4.1.1，portable、进程级配置。 |
| Native 编译前置 | Visual Studio 18 Community、MSVC 14.51.36231、Windows SDK 10.0.26100.0；`cl.exe`、`link.exe`、Windows headers 与 UCRT libraries 存在，且较早代码版本曾成功生成 full CP executable。 |
| NativeTest 组件探针 | 选择性 Native Image probe 四项通过：JWT round-trip、AuthResponse JSON、ConfigDomainSchema、PDFBox。 |
| Full CP host lane | **已验收（2026-10-31）**：隔离栈上 `--jar-mode=native --batch=native-compat` 为 2 passed / 1 skipped / 0 failed（`journey-a` + `plan0584-native-config-schema`）；覆盖 provider connection、CP→Agent chat、`write_file` 审批、SSE 终态、消息读回、checkpoint capture、Runtime MCP 与 channel handshake（`channel_connected` + `heartbeat: suppressed`），teardown 后容器/卷/网络/Sandbox 反查为 0。 |
| Native metadata 来源 | `NativeAotRuntimeHints` 的 record hint 来自 GraalVM tracing agent 在 JVM host lane 的实测采集（`evidence/agent-metadata-r5`），只注册 `INVOKE_PUBLIC_METHODS` + `INVOKE_PUBLIC_CONSTRUCTORS`，无包级放行；其中请求侧 record 属防御性注册，后续 host run 证明冗余即可裁剪。 |
| Native 专属限制 | `native-aot` 禁用 Tomcat platform-MBean metrics；普通 JVM 行为不变。`/ready` 需鉴权（匿名访问返回 401）；Linux/macOS 未验证。 |
| 构建 envelope | builder heap 8 GiB、单 worker、Maven heap 512 MiB、deadline 2700 秒、H: 空闲至少 20 GiB；supervisor 强制磁盘保留线。 |

该矩阵记录本机实测兼容范围，不构成 release 支持承诺。
