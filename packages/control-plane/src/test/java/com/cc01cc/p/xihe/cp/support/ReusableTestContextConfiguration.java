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

    /**
     * task-11（batch1 实测的连接耗尽修复）：路由实例单独暴露为 bean，供基类
     * {@code @AfterAll} 按类关闭 target 池（{@code @Primary} 的 DataSource 只是它的一层
     * 懒连接代理，产品侧 Flyway/JPA 仍只吃那一个 {@code @Primary} bean）。
     *
     * <p>生命周期：本 Bean 的值（含默认池）由 Spring 上下文持有、活到上下文关闭（复用场景下 =
     * JVM 退出 → 进程结束即释放）；**类级池**由 {@code AbstractReusableIntegrationTest} 的
     * {@code @AfterAll} 显式关闭。因此峰值连接 ≈ 活跃类 2 + 默认池 2。
     */
    @org.springframework.context.annotation.Bean
    ReusableTestDatabaseRouting reusableTestDatabaseRouting() {
        return new ReusableTestDatabaseRouting();
    }

    @org.springframework.context.annotation.Bean
    @org.springframework.context.annotation.Primary
    DataSource reusedRoutingDataSource(ReusableTestDatabaseRouting routing) {
        return new LazyConnectionDataSourceProxy(routing);
    }
}
