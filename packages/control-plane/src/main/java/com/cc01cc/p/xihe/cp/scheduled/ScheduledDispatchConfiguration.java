package com.cc01cc.p.xihe.cp.scheduled;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import java.util.concurrent.ThreadPoolExecutor;

/**
 * PLAN-0489 T1.2：定时任务分派的独立线程池（0486 §3——扫描线程只做发现与状态
 * 推进，分派动作不得占用 Spring 默认调度池 size=1，否则会饿死既有对账循环）。
 */
@Configuration
public class ScheduledDispatchConfiguration {

    /**
     * 池参数（PLAN-0489 design 决策：有界队列 + AbortPolicy，拒绝即可见失败）：
     * core=2 / max=4 / queue=64 / keepAlive=60s；{@code AbortPolicy} 拒绝由扫描侧
     * 捕获 {@code RejectedExecutionException} → 该行 missed(dispatch_failed)+日志
     * （不使用 CallerRunsPolicy，避免把慢分派反压回扫描线程）；单次分派超时 60s
     * 由扫描侧 {@code orTimeout} 兜底；shutdown 不等待在途分派——崩溃窗口由
     * firing 超时（grace 10min）转可见 missed（0486 B3）。
     */
    @Bean(name = "scheduledDispatchExecutor")
    public ThreadPoolTaskExecutor scheduledDispatchExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(2);
        executor.setMaxPoolSize(4);
        executor.setQueueCapacity(64);
        executor.setKeepAliveSeconds(60);
        executor.setThreadNamePrefix("scheduled-dispatch-");
        executor.setWaitForTasksToCompleteOnShutdown(false);
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.AbortPolicy());
        return executor;
    }
}
