package com.cc01cc.p.xihe.cp.support;

import com.cc01cc.p.xihe.cp.integration.TestDatabaseProvider;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;

import javax.sql.DataSource;
import java.io.PrintWriter;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.logging.Logger;

/**
 * task-251（A 方案）：上下文复用时的**路由 DataSource**。
 *
 * <p>上下文只建一次，库仍然"每类一个"：按 {@link ReusableContextSupport#resolveKey()} 的键，
 * 懒建一个指向该类克隆库（{@code TestDatabaseProvider.migratedDatabase(...)}）的 Hikari DS 并缓存。
 * key 为 {@code null} 时落默认库（一个迁移过的独立库，供上下文启动期 Flyway/JPA validate 使用）。
 *
 * <p>**PG 不能按连接切库**，所以路由粒度 = "每个类一个 target DS/pool"，不用
 * "单库多 schema + SET search_path"（理由见 {@code internal/A03-xihe/docs/test-context-reuse-design.md} §2）。
 *
 * <p>**生命周期（谁建谁关，task-11 实测补）**：
 * <ul>
 *   <li><b>默认池</b>：上下文启动期首次 Flyway/JPA validate 时懒建（键 {@link #DEFAULT_KEY}）；
 *       活到 JVM 退出（进程结束即释放），**不按类关闭**；</li>
 *   <li><b>类级池</b>：每个类首次取连接时懒建；由 {@code AbstractReusableIntegrationTest} 的
 *       {@code @AfterAll} 调 {@link #closeTarget(String)} 关闭（失败路径也执行，幂等）；</li>
 *   <li><b>快照库</b>（{@link #SEED_DATABASE}）：首个类测试开始前由 {@link #prepareSeedSnapshot()}
 *       从默认库克隆一次（含 DataSeeder 等启动期写入）；它是容器内数据库，随 PG 容器在 JVM 结束
 *       时消失，不回收、不托管；类库从它克隆（{@code migratedDatabase()} 的源，{@code emptyDatabase()} 不变）。</li>
 * </ul>
 */
public class ReusableTestDatabaseRouting implements DataSource {

    static final String DEFAULT_KEY = "reuse-default";

    /** task-11 R-D：启动期写入快照库（容器内、JVM 结束随容器消失、不回收）。 */
    public static final String SEED_DATABASE = "xihe_t_reuse_seed";

    private final Map<String, HikariDataSource> targets = new ConcurrentHashMap<>();

    private volatile HikariDataSource defaultTarget;

    /** 默认库名（启动期由 provider 分配；快照库的克隆源）。 */
    private volatile String defaultDatabaseName;

    /** 快照是否已就绪（只建一次）。 */
    private volatile boolean seedSnapshotReady;

    /** 当前键对应的 target；键为空时落默认库。 */
    DataSource currentTarget() {
        String key = ReusableContextSupport.resolveKey();
        return target(key == null ? DEFAULT_KEY : key);
    }

    private synchronized HikariDataSource target(String key) {
        if (DEFAULT_KEY.equals(key) && defaultTarget != null) {
            return defaultTarget;
        }
        HikariDataSource existing = targets.get(key);
        if (existing != null) {
            return existing;
        }
        HikariDataSource created = create(key);
        targets.put(key, created);
        if (DEFAULT_KEY.equals(key)) {
            defaultTarget = created;
        }
        return created;
    }

    /**
     * task-11 R-D：取「启动期写入快照」。必须在**默认上下文启动完成后、首类测试开始前**调用
     * （基类 {@code @BeforeEach} 在 bind 之后调用）；本方法幂等，只建一次。
     *
     * <p>时序约束（Lead 硬条件①）：不得在 context refresh 中途取——routing 只在测试线程的
     * 非默认键路径调用它，而默认键的建库发生在上下文 refresh（Flyway）期间，两条路径不交叉。
     */
    public synchronized void prepareSeedSnapshot() {
        if (seedSnapshotReady) {
            return;
        }
        String source = defaultDatabaseName;
        if (source == null) {
            throw new IllegalStateException(
                    "default test database not initialised: context startup has not completed yet");
        }
        TestDatabaseProvider.snapshotOf(source, SEED_DATABASE);
        TestDatabaseProvider.useSnapshotSource(SEED_DATABASE);
        seedSnapshotReady = true;
        System.out.println("[test-db] reuse seed snapshot=" + SEED_DATABASE
                + " from=" + source + " (startup seeds included)");
    }

    private HikariDataSource create(String key) {
        TestDatabaseProvider.DatabaseRef database;
        if (DEFAULT_KEY.equals(key)) {
            database = TestDatabaseProvider.migratedDatabase(safeLabel(key));
            defaultDatabaseName = database.databaseName();
        } else {
            prepareSeedSnapshot();
            database = TestDatabaseProvider.migratedDatabase(safeLabel(key));
        }
        HikariConfig config = new HikariConfig();
        config.setJdbcUrl(database.jdbcUrl());
        config.setUsername(database.username());
        config.setPassword(database.password());
        // task-11（batch1 实测）：每类一个池，类末由基类 @AfterAll 关闭；池子必须
        // minimumIdle=0 + 上限 2，否则 25 类 × 4 连接就会打到 PG max_connections=100
        // （实测 FATAL: sorry, too many clients already，随后每类首连接级联失败）。
        config.setMinimumIdle(0);
        config.setMaximumPoolSize(2);
        config.setPoolName("xh-reuse-" + safeLabel(key));
        return new HikariDataSource(config);
    }

    /** 库名标签只留小写字母数字（DB 名由 provider 派生，避免特殊字符）。 */
    static String safeLabel(String key) {
        String normalized = key.replaceAll("[^a-z0-9]", "").toLowerCase();
        if (normalized.isEmpty()) {
            normalized = "default";
        }
        return "reuse" + normalized.substring(0, Math.min(10, normalized.length()));
    }

    @Override
    public Connection getConnection() throws SQLException {
        return currentTarget().getConnection();
    }

    @Override
    public Connection getConnection(String username, String password) throws SQLException {
        return currentTarget().getConnection(username, password);
    }

    @Override
    public PrintWriter getLogWriter() throws SQLException {
        return currentTarget().getLogWriter();
    }

    @Override
    public void setLogWriter(PrintWriter out) throws SQLException {
        currentTarget().setLogWriter(out);
    }

    @Override
    public void setLoginTimeout(int seconds) throws SQLException {
        currentTarget().setLoginTimeout(seconds);
    }

    @Override
    public int getLoginTimeout() throws SQLException {
        return currentTarget().getLoginTimeout();
    }

    @Override
    public Logger getParentLogger() {
        return Logger.getLogger("com.cc01cc.p.xihe.cp.support");
    }

    @Override
    public <T> T unwrap(Class<T> iface) throws SQLException {
        if (iface.isAssignableFrom(getClass())) {
            return iface.cast(this);
        }
        return currentTarget().unwrap(iface);
    }

    @Override
    public boolean isWrapperFor(Class<?> iface) throws SQLException {
        return iface.isAssignableFrom(getClass()) || currentTarget().isWrapperFor(iface);
    }

    /**
     * 关闭并移除某个类键的 target（幂等）。由 {@code AbstractReusableIntegrationTest} 的
     * {@code @AfterAll} 在类末调用（JUnit 保证失败路径也执行，内部再用 try/finally 兜住）。
     *
     * <p>默认池（{@link #DEFAULT_KEY}）与快照库（{@link #SEED_DATABASE}，无池）**不在此列**：
     * 默认池由上下文懒建一次、活到 JVM 退出（进程结束即释放，谁建谁关 = 本路由实例）；快照库是
     * 容器内一次性库，随容器消失、不回收。类级池才按类开关，峰值连接 ≈ 活跃类 2 + 默认池 2。
     */
    public synchronized void closeTarget(String key) {
        if (key == null || key.isBlank()) {
            return;
        }
        HikariDataSource removed = targets.remove(key);
        if (removed != null) {
            removed.close();
        }
    }

    /** 关闭所有懒建的 pool（含默认池；仅供整体收尾/诊断，类级清理用 {@link #closeTarget(String)}）。 */
    public synchronized void closeTargets() {
        targets.values().forEach(HikariDataSource::close);
        targets.clear();
        defaultTarget = null;
    }
}
