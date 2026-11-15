package com.cc01cc.p.xihe.cp.integration;

import com.cc01cc.p.xihe.cp.support.TestContainerLabels;
import org.flywaydb.core.Flyway;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.testcontainers.containers.PostgreSQLContainer;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * PLAN-eff / task-13 M1（A1 路线）：<b>JVM 级 PostgreSQL 单例 + 每类从"已迁移模板库"克隆</b>。
 *
 * <p>动机（M0 实测，见 one/.tmp/plan-eff-l2/M0-report.md）：旧形状是"每个测试类起一个
 * pgvector 容器 + 在容器里跑一遍 Flyway V1→V96"，118 次容器启停（220 s）+ 118 次 Flyway
 * （141 s）占了整轮 L2 的 ~38%。每个类真正需要的只是"<b>一个全新的、已迁移的、带迁移种子的
 * 数据库</b>"，而不是"一个新容器"。</p>
 *
 * <p>隔离语义（刻意保持与旧形状**逐项等价**）：
 * <ul>
 *   <li>模板库 {@code xihe_cp_tpl} 只迁移一次（Flyway，locations 与生产相同：{@code classpath:db/migration}）；</li>
 *   <li>每个测试类拿到的是 {@code CREATE DATABASE <name> TEMPLATE xihe_cp_tpl} 的**独立数据库**
 *       （独立 oid、独立 flyway 历史、独立序列、独立锁空间），因此"空数据断言"和"迁移种子依赖"
 *       两类测试的假设都不变；</li>
 *   <li>迁移重放类（自己跑 Flyway 到指定版本）用 {@link #emptyDatabase(String)} 拿**空库**，
 *       不会看到模板里的历史；</li>
 *   <li>库名带类/用途标签 + 序号（{@code xihe_t_it_007}），失败后可直接进容器看现场；
 *       库在容器生命周期内保留（容器是抛一次性的，JVM 退出由 Testcontainers 回收）。</li>
 * </ul>
 *
 * <p>容器只 {@code start()} 一次；随后由 Testcontainers 的 shutdown hook / Ryuk 回收，
 * 不额外注册清理线程（避免和 surefire fork 退出竞争）。
 */
public final class TestDatabaseProvider {

    /** 与 {@code AbstractIntegrationTest} 历史镜像保持一致（pgvector 是 V1 的 vector 扩展前提）。 */
    private static final String IMAGE = "pgvector/pgvector:pg17";
    /** 容器自带的引导库：只用来下发 CREATE DATABASE，不放业务表。 */
    private static final String BOOT_DATABASE = "xihe_cp_boot";
    /** 已迁移模板库：全 JVM 只迁移一次。 */
    private static final String TEMPLATE_DATABASE = "xihe_cp_tpl";
    private static final String USERNAME = "test";
    private static final String PASSWORD = TestDataFactory.PASSWORD;
    private static final String DRIVER = "org.postgresql.Driver";

    private static final Logger LOG = LoggerFactory.getLogger(TestDatabaseProvider.class);

    /**
     * task-199（2026-11-13）：**只在显式设了 env 时才放宽容器启动预算**。名字与建议值写在这里是因为
     * "环境变量名就是契约"，但**默认值不存在**：未设 ⇒ 不调用 {@code withStartupTimeout}，走 Testcontainers
     * 自己的 readiness 预算（与改前逐字节一致）。
     *
     * <p>为什么不改默认值：真栈那次 62.19 s 的 {@code ContainerLaunchException} 是**负载下的假红**
     * （同镜像同机 09:05/09:12 两轮绿），但"挂死"也是真实可能 —— 把默认预算调到 180 s 等于把挂死判据
     * 放宽给所有人和所有 CI 机器。所以这里只提供一个**显式开关**，谁遇到假红谁自己设。</p>
     */
    private static final String STARTUP_TIMEOUT_ENV = "XIHE_TESTCONTAINER_STARTUP_TIMEOUT";

    private static final Object LOCK = new Object();
    private static final AtomicInteger SEQUENCE = new AtomicInteger();

    private static PostgreSQLContainer<?> container;
    private static boolean templateReady;

    /**
     * task-11 R-D：默认上下文启动完成后的**快照库**名。它把启动期写入（DataSeeder 的 admin /
     * InstanceOwnership / SUPER_ADMIN binding、ApplicationReady 期 recovery 等）带进每个类库。
     *
     * <p>生命周期：容器内数据库，随测试 PG 容器在 JVM 结束时一起消失；**不回收、不托管**——
     * 不是可复用的外部资源，也不要当持久资产引用。
     */
    private static final String SEED_SNAPSHOT_DATABASE = "xihe_t_reuse_seed";

    /** 非空时 {@link #migratedDatabase(String)} 改为从快照库克隆（{@link #emptyDatabase(String)} 不变）。 */
    private static volatile String snapshotSource;

    private TestDatabaseProvider() {
    }

    /** 一个可交给 Spring 的数据库引用（每类一个，互不相同）。 */
    public record DatabaseRef(String databaseName, String jdbcUrl, String username, String password) {
    }

    /**
     * 分配一个**已迁移**的独立数据库（模板克隆）：等价于旧形状里"新容器 + Flyway 全量迁移"。
     *
     * @param label 用途标签（只进库名，便于失败现场定位）
     */
    public static DatabaseRef migratedDatabase(String label) {
        return allocate(label, true);
    }

    /**
     * 克隆**模板库**：迁到 head、但**没有**启动期写入 —— 负例夹具专用（task-200）。
     *
     * <p>为什么不能用 {@link #migratedDatabase(String)} 代替：那个方法在快照就绪后会**改从快照库克隆**
     * （{@code snapshotSource != null}），于是「迁过但没种子」的库会变成「迁过且有种子」——
     * 断言的前提随**之前跑过哪个上下文**漂移（task-200 全量首跑实测：负例在 Spring 类之后跑就假红）。
     * 负例夹具必须**自己指定克隆源**，这就是 {@code D-1566}/{@code R2}「用例的断言前提必须由用例自己建立」。</p>
     */
    public static DatabaseRef templateClone(String label) {
        ensureStarted();
        ensureTemplate();
        String databaseName = databaseName(label);
        createDatabase(databaseName, TEMPLATE_DATABASE, false, label);
        lastDatabaseName = databaseName;
        return new DatabaseRef(databaseName, jdbcUrl(databaseName), USERNAME, PASSWORD);
    }

    /**
     * 分配一个**空**数据库（不克隆模板）：给"迁移重放"类用——它们要自己把 Flyway 跑到目标版本。
     *
     * @param label 用途标签（只进库名）
     */
    public static DatabaseRef emptyDatabase(String label) {
        return allocate(label, false);
    }

    /** 当前 JVM 最近一次分配的数据库名（仅用于诊断日志；不要用于断言）。 */
    public static String lastDatabaseName() {
        return lastDatabaseName;
    }

    private static volatile String lastDatabaseName = "(none)";

    private static DatabaseRef allocate(String label, boolean fromTemplate) {
        ensureStarted();
        if (fromTemplate) {
            // 只有"需要已迁移库"的类才值得付模板迁移的 1.2 s；迁移重放类只领空库。
            ensureTemplate();
        }
        String databaseName = databaseName(label);
        String templateDatabase = fromTemplate && snapshotSource != null
                ? snapshotSource
                : (fromTemplate ? TEMPLATE_DATABASE : null);
        createDatabase(databaseName, templateDatabase, false, label);
        lastDatabaseName = databaseName;
        return new DatabaseRef(databaseName, jdbcUrl(databaseName), USERNAME, PASSWORD);
    }

    private static void ensureStarted() {
        synchronized (LOCK) {
            if (container == null) {
                PostgreSQLContainer<?> started = new PostgreSQLContainer<>(IMAGE)
                        .withDatabaseName(BOOT_DATABASE)
                        .withUsername(USERNAME)
                        .withPassword(PASSWORD)
                        // task-104 债②：带本轮 run id（缺省无标签 ⇒ 与打标前逐项一致）。
                        .withLabels(TestContainerLabels.runId());
                long startupTimeoutSeconds = startupTimeoutSeconds();
                if (startupTimeoutSeconds > 0) {
                    started.withStartupTimeout(Duration.ofSeconds(startupTimeoutSeconds));
                    LOG.info("Testcontainers startup timeout = {} s (from {})",
                            startupTimeoutSeconds, STARTUP_TIMEOUT_ENV);
                }
                started.start();
                container = started;
            }
        }
    }

    /**
     * 读 {@link #STARTUP_TIMEOUT_ENV}（秒）。缺省/空白 ⇒ 0（= 不做任何改动）；给了但不合法 ⇒ fail-fast，
     * 不静默回落到默认值（"我设了却没生效"比"没设"更难查）。
     */
    private static long startupTimeoutSeconds() {
        String raw = System.getenv(STARTUP_TIMEOUT_ENV);
        if (raw == null || raw.isBlank()) {
            return 0L;
        }
        try {
            long seconds = Long.parseLong(raw.trim());
            if (seconds <= 0) {
                throw new IllegalStateException(STARTUP_TIMEOUT_ENV + " must be a positive integer (seconds), got: " + raw);
            }
            return seconds;
        } catch (NumberFormatException failure) {
            throw new IllegalStateException(STARTUP_TIMEOUT_ENV + " must be a positive integer (seconds), got: " + raw, failure);
        }
    }

    /** 模板库只在第一次需要"已迁移库"时才建（避免纯迁移重放 shard 白付一次 Flyway）。 */
    private static void ensureTemplate() {
        synchronized (LOCK) {
            if (templateReady) {
                return;
            }
            prepareTemplate();
            templateReady = true;
        }
    }

    /** 建模板库并把 96 个迁移跑一遍（与生产 Spring Flyway 同 locations / 同 baseline 策略）。 */
    private static void prepareTemplate() {
        try (Connection connection = connect(BOOT_DATABASE);
             Statement statement = connection.createStatement()) {
            statement.execute("CREATE DATABASE " + TEMPLATE_DATABASE);
        } catch (SQLException failure) {
            throw new IllegalStateException("could not create template database " + TEMPLATE_DATABASE, failure);
        }
        Flyway.configure()
                .dataSource(jdbcUrl(TEMPLATE_DATABASE), USERNAME, PASSWORD)
                .locations("classpath:db/migration")
                .baselineOnMigrate(false)
                .load()
                .migrate();
        // 防御：TEMPLATE 克隆要求模板库上没有其他会话（Flyway 正常会关连接；万一没关就显式踢掉）。
        try (Connection connection = connect(BOOT_DATABASE);
             Statement statement = connection.createStatement()) {
            statement.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity"
                    + " WHERE datname = '" + TEMPLATE_DATABASE + "' AND pid <> pg_backend_pid()");
        } catch (SQLException failure) {
            throw new IllegalStateException("could not release template database sessions", failure);
        }
    }

    /**
     * task-11 R-D：把默认库（已含启动期写入）快照成固定名库，作为后续类库的克隆源。
     * 由路由在**默认上下文启动完成后、首个类测试开始前**调用一次；先 terminate 默认库会话，
     * 再用有界重试做 {@code CREATE DATABASE ... TEMPLATE}。
     */
    public static DatabaseRef snapshotOf(String sourceDatabaseName, String targetDatabaseName) {
        ensureStarted();
        createDatabase(targetDatabaseName, sourceDatabaseName, true, "snapshot");
        return new DatabaseRef(targetDatabaseName, jdbcUrl(targetDatabaseName), USERNAME, PASSWORD);
    }

    /** task-11 R-D：切换 {@link #migratedDatabase(String)} 的克隆源（由路由在快照完成后调用）。 */
    public static void useSnapshotSource(String databaseName) {
        snapshotSource = databaseName;
    }

    /**
     * 建库（可带 TEMPLATE）。{@code terminateSource} 时先踢掉模板库上的会话（PG 的 TEMPLATE 克隆
     * 要求源库无其它连接）；失败按 **5 s 预算的有界重试**（100 ms 间隔）——这是为模板库会话竞态
     * 准备的诊断式重试，不是无条件等待。
     */
    private static void createDatabase(String targetName, String templateName,
                                       boolean terminateSource, String label) {
        long deadlineNanos = System.nanoTime() + 5_000_000_000L;
        SQLException lastFailure = null;
        int attempt = 0;
        while (true) {
            attempt++;
            try (Connection connection = connect(BOOT_DATABASE);
                 Statement statement = connection.createStatement()) {
                if (terminateSource && templateName != null) {
                    statement.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity"
                            + " WHERE datname = '" + templateName + "' AND pid <> pg_backend_pid()");
                }
                statement.execute(templateName == null
                        ? "CREATE DATABASE " + targetName
                        : "CREATE DATABASE " + targetName + " TEMPLATE " + templateName);
                return;
            } catch (SQLException failure) {
                if (isDuplicateDatabase(failure)) {
                    // task-200（D-1575）：重复建库是**永久错误**——重试只会白烧 5 s 预算（实测 47 次）。
                    // 那个 5 s 重试是为「TEMPLATE 克隆时源库还有会话」准备的，与名字冲突无关。
                    throw new IllegalStateException("test database " + targetName
                            + " already exists (SQLState 42P04, label=" + label
                            + "); refusing to retry — a duplicate name is a permanent condition,"
                            + " not a TEMPLATE-session race", failure);
                }
                lastFailure = failure;
            }
            if (System.nanoTime() >= deadlineNanos) {
                throw new IllegalStateException("could not create test database " + targetName
                        + " in " + attempt + " attempts (label=" + label + ")", lastFailure);
            }
            try {
                Thread.sleep(100L);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("interrupted while creating test database " + targetName, lastFailure);
            }
        }
    }

    /** PG {@code duplicate_database} = SQLState {@code 42P04}；只认 SQLState，不认文案。 */
    private static boolean isDuplicateDatabase(SQLException failure) {
        return "42P04".equals(failure.getSQLState());
    }

    /**
     * task-200（{@code D-1575}）：快照库的**内容校验**，供「已存在即复用」路径调用。
     *
     * <p>复用一个已存在的库，只有在**内容确定正确**时才算修好；否则就是把「确定性失败」
     * 换成「静默复用脏库」（比原缺陷更糟）。所以这里给两条可复算判据，任一不成立即抛：</p>
     * <ol>
     *   <li><b>schema 已迁到模板 head</b>：{@code flyway_schema_history} 中成功记录的最大 version
     *       等于模板库 {@link #TEMPLATE_DATABASE} 的同名读数（空库 / 半迁移库在这里被拒；
     *       表不存在按 0 处理，于是同样落到「不是模板 head」这条消息上）；</li>
     *   <li><b>启动期写入在</b>：{@code users} 有且仅有 1 行 {@code admin@xihe.local}，
     *       且 {@code instance_owner} 至少 1 行 —— 这正是快照存在的理由（{@code DataSeeder} 的
     *       admin / InstanceOwnership 指针）。</li>
     * </ol>
     *
     * <p>抛 {@link IllegalStateException}（fail-closed）而不是 WARN：复用到一个空库会让类库静默
     * 从「没有种子」克隆，症状会散落到几十个不相干用例里（「空集绿」家族）。</p>
     */
    public static void verifySeedSnapshotContent(String databaseName) {
        ensureStarted();
        ensureTemplate();
        long expected = maxAppliedMigration(TEMPLATE_DATABASE);
        long actual = maxAppliedMigration(databaseName);
        if (actual != expected) {
            throw new IllegalStateException("seed snapshot " + databaseName
                    + " is not at the template head: max applied migration " + actual
                    + " != template " + expected + " (empty or half-migrated database)");
        }
        int admins = scalar(databaseName, "select count(*) from users where email = 'admin@xihe.local'");
        int owners = scalar(databaseName, "select count(*) from instance_owner");
        if (admins != 1 || owners < 1) {
            throw new IllegalStateException("seed snapshot " + databaseName
                    + " lacks the startup seeds: admin@xihe.local rows=" + admins
                    + ", instance_owner rows=" + owners
                    + " (DataSeeder output missing — refusing to clone class databases from it)");
        }
    }

    /** 成功迁移记录里的最大 version（{@code version} 是字符串列，按数值比较）。 */
    private static long maxAppliedMigration(String databaseName) {
        String sql = "select coalesce(max(version::numeric), 0) from flyway_schema_history where success";
        try (Connection connection = connect(databaseName);
             Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            rows.next();
            return rows.getLong(1);
        } catch (SQLException failure) {
            if ("42P01".equals(failure.getSQLState())) {
                // undefined_table：这个库连 Flyway 都没跑过 ⇒ 交给调用方按「不是 head」处理。
                return 0L;
            }
            throw new IllegalStateException("could not read flyway history of " + databaseName, failure);
        }
    }

    private static int scalar(String databaseName, String sql) {
        try (Connection connection = connect(databaseName);
             Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            rows.next();
            return rows.getInt(1);
        } catch (SQLException failure) {
            throw new IllegalStateException("could not run [" + sql + "] on " + databaseName, failure);
        }
    }

    private static String databaseName(String label) {
        String slug = (label == null ? "db" : label).toLowerCase(java.util.Locale.ROOT)
                .replaceAll("[^a-z0-9]+", "_")
                .replaceAll("^_+|_+$", "");
        if (slug.isEmpty()) {
            slug = "db";
        }
        if (slug.length() > 40) {
            slug = slug.substring(0, 40);
        }
        return "xihe_t_" + slug + "_" + String.format("%03d", SEQUENCE.incrementAndGet());
    }

    private static String jdbcUrl(String databaseName) {
        return String.format("jdbc:postgresql://%s:%d/%s",
                container.getHost(), container.getMappedPort(PostgreSQLContainer.POSTGRESQL_PORT), databaseName);
    }

    private static Connection connect(String databaseName) throws SQLException {
        return DriverManager.getConnection(jdbcUrl(databaseName), USERNAME, PASSWORD);
    }

    /** Spring 用的 driver-class-name 常量（与旧形状一致，避免各处重复字面量）。 */
    public static String driverClassName() {
        return DRIVER;
    }
}
