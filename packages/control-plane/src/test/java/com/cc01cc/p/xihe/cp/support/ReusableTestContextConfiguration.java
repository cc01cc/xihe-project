package com.cc01cc.p.xihe.cp.support;

import org.springframework.jdbc.datasource.LazyConnectionDataSourceProxy;

import javax.sql.DataSource;

/**
 * task-251（A 方案试点）：上下文复用的测试配置。
 *
 * <p>只提供给 {@code AbstractReusableIntegrationTest} 的试点类使用（{@code @Import} 显式引入），
 * **不**影响既有两个基类。要点：
 *
 * <ul>
 *   <li>{@code @Primary} 覆盖 Boot 自动配置的 DataSource；产品侧 Flyway/JPA 都吃这一个 bean；</li>
 *   <li>外面套 {@link LazyConnectionDataSourceProxy}：路由必须推迟到事务真正取连接时，
 *       否则 JPA/事务管理器会在事务开始前就绑定到默认库（设计文档 §2/§4）；</li>
 *   <li>Flyway 在上下文启动时按默认库跑（迁移已由模板克隆完成 ⇒ 实际无操作）。</li>
 * </ul>
 */
@org.springframework.boot.test.context.TestConfiguration(proxyBeanMethods = false)
public class ReusableTestContextConfiguration {

    @org.springframework.context.annotation.Bean
    @org.springframework.context.annotation.Primary
    DataSource reusedRoutingDataSource() {
        return new LazyConnectionDataSourceProxy(new ReusableTestDatabaseRouting());
    }
}
