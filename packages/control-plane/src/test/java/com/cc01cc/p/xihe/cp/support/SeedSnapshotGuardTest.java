package com.cc01cc.p.xihe.cp.support;

import com.cc01cc.p.xihe.cp.integration.TestDatabaseProvider;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-200（{@code D-1575}）的守卫探针：**不需要 Spring 上下文**，只碰 provider 的建库/校验面。
 *
 * <p>为什么单开一个非 Spring 类：这三条断言要证明的是「<b>机制</b>」而不是业务行为——</p>
 * <ol>
 *   <li>重复建库必须**立即**失败（旧行为是 47 次 × 100 ms ≈ 4.7 s 的 5 s 预算空转）；</li>
 *   <li>被拒绝的重复建库**不许**碰到已存在的那个库（fail-closed 的"不留脏库"要可复算）；</li>
 *   <li>「已存在即复用」的**内容校验**两条负例：空库、迁过但没种子的库都必须被拒。</li>
 * </ol>
 *
 * <p>正例不在这里造：它由 Spring 侧的 {@code ReuseSnapshotSeedFixtureTest} 机器断言
 * （类库里 {@code admin@xihe.local} + {@code instance_owner} + {@code SUPER_ADMIN} 绑定齐全），
 * 那个断言的库正是从快照克隆出来的——即"复用到内容正确的库"的端到端证据。</p>
 */
class SeedSnapshotGuardTest {

    private static final AtomicInteger SEQUENCE = new AtomicInteger();

    private static String uniqueName(String prefix) {
        return prefix + "_" + SEQUENCE.incrementAndGet();
    }

    /**
     * 重复建库 = 永久错误 ⇒ 必须立刻抛，不许吃满 5 s 重试预算。
     * <p>判据：抛出的消息点名库名与 {@code 42P04}，且耗时 **< 3 s**（旧行为 ≈ 4.7 s）。</p>
     */
    @Test
    void duplicateCreateFailsImmediatelyInsteadOfSpendingTheFiveSecondBudget() {
        String source = TestDatabaseProvider.migratedDatabase("guard-src").databaseName();
        String target = uniqueName("xihe_t_guard_dup");
        TestDatabaseProvider.snapshotOf(source, target);

        long startedAt = System.nanoTime();
        IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> TestDatabaseProvider.snapshotOf(source, target));
        long elapsedMs = Duration.ofNanos(System.nanoTime() - startedAt).toMillis();

        assertTrue(failure.getMessage().contains(target),
                "the refusal must name the database, got: " + failure.getMessage());
        assertTrue(failure.getMessage().contains("42P04"),
                "the refusal must carry the SQLState, got: " + failure.getMessage());
        assertTrue(elapsedMs < 3000,
                "duplicate create took " + elapsedMs + " ms — it must fail immediately,"
                        + " not retry for the 5 s TEMPLATE-session budget");
    }

    /**
     * fail-closed 的"不留脏库"：重复建库被拒之后，原库里的数据必须**逐字未变**。
     */
    @Test
    void theExistingDatabaseIsNotTouchedWhenTheDuplicateIsRefused() throws SQLException {
        TestDatabaseProvider.DatabaseRef source =
                TestDatabaseProvider.migratedDatabase("guard-src-marked");
        String target = uniqueName("xihe_t_guard_marked");
        TestDatabaseProvider.DatabaseRef created =
                TestDatabaseProvider.snapshotOf(source.databaseName(), target);
        try (Connection connection = open(created);
             Statement statement = connection.createStatement()) {
            statement.execute("create table guard_marker(value int)");
            statement.execute("insert into guard_marker values (42)");
        }

        assertThrows(IllegalStateException.class,
                () -> TestDatabaseProvider.snapshotOf(source.databaseName(), target));

        assertEquals(42, scalar(created, "select value from guard_marker"),
                "the pre-existing database must keep its rows after the refused duplicate create");
    }

    /** 内容校验负例①：连 Flyway 都没跑过的空库不许复用。 */
    @Test
    void contentVerificationRefusesAnEmptyDatabase() {
        String empty = TestDatabaseProvider.emptyDatabase("guard-empty").databaseName();
        IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> TestDatabaseProvider.verifySeedSnapshotContent(empty));
        assertTrue(failure.getMessage().contains("not at the template head"),
                "an unmigrated database must be refused as 'not at the template head', got: "
                        + failure.getMessage());
    }

    /** 内容校验负例②：迁到 head 但**没有启动期写入**的库（模板克隆就是这种）也不许复用。 */
    @Test
    void contentVerificationRefusesAMigratedButUnseededDatabase() {
        String migrated = TestDatabaseProvider.migratedDatabase("guard-unseeded").databaseName();
        IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> TestDatabaseProvider.verifySeedSnapshotContent(migrated));
        assertTrue(failure.getMessage().contains("lacks the startup seeds"),
                "a migrated-but-unseeded database must be refused for missing seeds, got: "
                        + failure.getMessage());
    }

    private static Connection open(TestDatabaseProvider.DatabaseRef database) throws SQLException {
        return DriverManager.getConnection(database.jdbcUrl(), database.username(), database.password());
    }

    private static int scalar(TestDatabaseProvider.DatabaseRef database, String sql) throws SQLException {
        try (Connection connection = open(database);
             Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            rows.next();
            return rows.getInt(1);
        }
    }
}
