# task-11 全量分桶落地 — SUMMARY（dev-a，2026-11-08）

lane: A03-xihe/.worktrees/m5b-user-questions @ task/251-context-reuse；基线 9c432c33 → db79aa64 → 本轮

## 批跑（全部 -Dxihe.test.forkCount=1，单 JVM 串行）
| batch | EXIT | 墙钟 | context | tests | failed | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| batch1-66 | 1 | 60s | 5（应1） | 390 | 1F/259E | 池耗尽级联（首因 FATAL: too many clients） |
| batch20 | 1 | 46.3s | 1 | 133 | 2E | DataSeeder 启动种子缺失（DefaultSetMatrixTest） |
| batch20rd | 0 | 46.1s | 1 | 134 | 0 | R-D 快照库修复后全绿；探针 peak9/steady6 |
| batch45 | 0 | 67.3s | 1 | 259 | 0 | 探针未 attach（0 samples，见遗留） |
| batch71 | 0 | 95.8s | 1 | 413 | 0 | 探针 peak8/steady6 |
| soak-80 | 0 | 266.6s | 8（1 复用+7 per-class） | 482 | 0 | 混序 + scheduler 浸泡 |

## 连接探针（运行中 docker exec pg_stat_activity）
- 修复前 batch1-66：第 26 类即 FATAL: too many clients already（max_connections=100）。
- batch20（R-A 后）：peak=9 / steady last5=6；batch71：peak=8 / steady last5=6；batch20rd 同（9/6）。
- 全量 forkCount=1 运行中（前 280s 采样）：peak=18 / 基线稳态=7；per-class 上下文区段瞬态 17（7↔17 往返），
  不随 142 类线性增长。

## soak scheduler 触发证据（20:48:47–20:53:13，266.6s）
- 60s SessionForkRecovery：20:50:11.899 [scheduling-2] INFO SessionForkRecoveryService
  event=fork_cleanup_recovered childSessionId=3106138c…；临时证人行 state cleanup_pending→retryable 同时刻。
- 120s ChatRun 对账：20:51:23.373 [scheduling-2] DEBUG org.hibernate.SQL UPDATE chat_run_transport_attempts …
  FROM chat_runs …；20:51:30.973 INFO ChatRunReconciliationService event=terminal_transport_attempts_reconciled count=1。
- 120s Job 对账：20:51:23.414 [scheduling-2] DEBUG org.hibernate.SQL select wj1_0… from workspace_jobs …（findRunningSince）。
- 混合顺序：per-class 上下文在 run 中段创建（ChatAdmissionGovernorHttpTest 78.7s / ChatIntegrationTest 111.2s /
  SseParticipantDispatch 164.8s），其后复用类（service/*、support 夹具）仍 0 failed ⇒ reset hook 在真全量顺序下有效。

## 两轮全量（**不可跨口径并列**，见 l2-window-protocol §16.8）
- forkCount=1（**新基线/证据口径**）：WALL 784.9s（13m05s），Tomcat started=134，Tests run 3992 / 0F / 0E / 2 skipped。
- 默认 forkCount（与 15m29s 可比口径）：WALL **405.2s（6m45s）**，Tomcat started=135（2 fork 各 1 复用 context + per-class），Tests run 3992 / 0F / 0E / 2 skipped。
- 旧 15m29s（929s）只作**历史参照**；两轮不可跨口径并列（serial=新基线/证据口径；default=旧口径参照）。
- 口径存疑（交 verifier/Lead 判定）：仓库 `mise run test:cp` = `mvn test`（pom 默认 forkCount=2），若旧 L1 真为 2 fork 口径，则 929s=2 fork 反而比本树 405s 慢 2.3 倍，更可能旧轮是 forkCount=1 或不同负载；serial 784.9s 与 929s 差 144s（−15.5%）与 reuse 预期同量级。

## 白名单与守卫
- 141 个原基类体系类 = **70 per-class** + 71 reusable；R-D 夹具 ReuseSnapshotSeedFixtureTest 加入复用桶 ⇒ 142 = 70 + 72。
- TSV：src/test/resources/context-reuse/per-class-whitelist.tsv（表头含判定码枚举与计数；70 行）。
- 守卫 ContextReuseBucketingTest：R1 严格标记无逃生口（@DynamicPropertySource/@TestPropertySource/@ActiveProfiles/
  @DirtiesContext/mockito-bean/@Import…），可选标记（@BeforeAll/@AfterAll/@Nested/@Async…）需 // context-reuse-ok: 且逐条打印；
  R2/R3 清单互斥穷尽 + 判定码严格一致 + stale 红；Boot4 改名表打印/强制（@SpyBean→@MockitoSpyBean、@MockBean→@MockitoBean）。

## 生命周期（谁建谁关）
- 默认池：顺序启动期 Flyway/JPA validate 懒建，活到 JVM 退出，不按类关闭。
- 类级池：类首次取连接懒建，@AfterAll（失败路径也执行）closeTarget 幂等关闭。
- 快照库 xihe_t_reuse_seed：首个类测试前从默认库克隆一次（terminate 默认会话 + 5s 有界重试），容器内、JVM 结束随容器消失、不回收。
- emptyDatabase() 语义不变（迁移重放类仍自建空库）。

## 遗留/不确定
- 全量两轮均为**作者自检（L0/预检）**，不是合并证据；权威 L1 由 verifier 在候选 SHA 窗口跑（同口径 forkCount=1）。
- 默认 forkCount 轮未单独采 pg 探针（serial 轮已采样：peak=18 / 稳态 7）；2 fork ⇒ 双份上下文/池，未测。
- 收益降级：70 per-class ⇒ 复用桶 71；旧 3.6min 推算作废，按 1.56s/context 口径 ≈ **1.8 min**（lead 已确认）。
- batch45 探针 attach 失败（0 samples）；batch20rd 探针也因容器窗口错过（0），已由 batch71/全量覆盖同类证明。
- 全量默认 forkCount 轮：两个 fork 各自 1 个复用 context；context 数按两 JVM 合计报。
- 未提交大日志（soak.log 23.1MB、batch*.log）留在 lane target/ab-logs；仓库只提交代码/TSV/status 摘要。