package com.cc01cc.p.xihe.cp.config;

import com.zaxxer.hikari.HikariDataSource;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.context.annotation.Profile;
import org.springframework.core.env.Environment;

/**
 * Explicit PostgreSQL datasource for the opt-in native-aot build and host lane.
 * This prevents an embedded H2 dependency from becoming the fallback when the
 * datasource URL cannot be bound by AOT. If the explicit URL is absent, only a
 * run-scoped PostgreSQL port is accepted; the daily default port is never used.
 */
@Configuration(proxyBeanMethods = false)
@Profile("native-aot")
public class NativeAotDataSourceConfiguration {

    @Bean
    @Primary
    HikariDataSource nativeAotDataSource(Environment environment) {
        String jdbcUrl = environment.getProperty("XIHE_CP_DATASOURCE_URL");
        if (jdbcUrl == null || jdbcUrl.isBlank()) {
            String runScopedPort = environment.getProperty("XIHE_PG_PORT");
            if (runScopedPort == null || runScopedPort.isBlank()) {
                throw new IllegalStateException(
                        "XIHE_CP_DATASOURCE_URL or run-scoped XIHE_PG_PORT is required for the native-aot profile");
            }
            jdbcUrl = "jdbc:postgresql://127.0.0.1:" + runScopedPort + "/xihe";
        }

        HikariDataSource dataSource = new HikariDataSource();
        dataSource.setPoolName("cp-native-aot");
        dataSource.setJdbcUrl(jdbcUrl);
        dataSource.setUsername(environment.getProperty("XIHE_CP_DATASOURCE_USERNAME", "xihe"));
        dataSource.setPassword(environment.getProperty("XIHE_CP_DATASOURCE_PASSWORD", ""));
        dataSource.setDriverClassName(environment.getProperty(
                "XIHE_CP_DATASOURCE_DRIVER", "org.postgresql.Driver"));
        dataSource.setMaximumPoolSize(4);
        dataSource.setMinimumIdle(0);
        return dataSource;
    }
}
