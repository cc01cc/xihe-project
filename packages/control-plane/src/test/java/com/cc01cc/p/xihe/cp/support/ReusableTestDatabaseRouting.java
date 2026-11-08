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
 */
public class ReusableTestDatabaseRouting implements DataSource {

    static final String DEFAULT_KEY = "reuse-default";

    private final Map<String, HikariDataSource> targets = new ConcurrentHashMap<>();

    private volatile HikariDataSource defaultTarget;

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

    private static HikariDataSource create(String key) {
        TestDatabaseProvider.DatabaseRef database = TestDatabaseProvider.migratedDatabase(safeLabel(key));
        HikariConfig config = new HikariConfig();
        config.setJdbcUrl(database.jdbcUrl());
        config.setUsername(database.username());
        config.setPassword(database.password());
        config.setMaximumPoolSize(4);
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

    /** 关闭所有懒建的 pool（{@code @AfterAll} 调用；上下文仍在时不关闭）。 */
    public synchronized void closeTargets() {
        targets.values().forEach(HikariDataSource::close);
        targets.clear();
        defaultTarget = null;
    }
}
