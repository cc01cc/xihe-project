package com.cc01cc.p.xihe.cp.observability;

import com.cc01cc.p.xihe.cp.audit.CheckpointRevertAudit;
import com.cc01cc.p.xihe.cp.audit.SessionSnapshotAudit;
import com.cc01cc.p.xihe.cp.service.RunCheckpointService;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.LongSupplier;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * 审计写入 fail-open 计数器的可观测出口（task-597）。
 *
 * <p>三处欠账（542 会话快照冻结 / 548 checkpoint 回滚 / 575 工作区创建）此前只有计数器与事件名，
 * 没有任何可读出口 —— 按 D-1074「看不见的缺口等于没有门」，缺了失败也没人能看见。本类把四个
 * fail-open 计数器接到 Micrometer，统一前缀 {@code xihe.audit.fail_open.}。</p>
 *
 * <p><b>「读数为 0」怎么解释</b>（本类的存在理由）：光有 {@code failures=0} 分不清「没失败」与
 * 「没接线」，所以同时发布三个接线读数 —— {@code wiring.registered}（已注册的计数器个数）、
 * {@code wiring.expected}（应有个数）、{@code wiring.incomplete}（差额）。判读规则：
 * {@code incomplete == 0} 时 {@code failures=0} 表示没失败；{@code incomplete > 0} 或整组指标不存在
 * 表示没接线（缺 bean / 未注册）。</p>
 *
 * <p>只读出口：不改变 fail-open 语义（审计写失败仍不阻断业务），也不改任何写入路径。</p>
 */
@Component
public class AuditFailOpenMetrics {

    /** 统一前缀：一条查询 {@code xihe_audit_fail_open_*} 即可看全。 */
    public static final String METRIC_PREFIX = "xihe.audit.fail_open.";

    /** 期望接线的计数器标识（顺序即登记顺序，便于日志/读数对账）。 */
    public static final List<String> COMPONENTS = List.of(
            "workspace_created",
            "session_snapshot",
            "checkpoint_revert",
            "checkpoint_revert_unwired");

    private final MeterRegistry registry;
    private final Map<String, LongSupplier> suppliers;

    @Autowired
    public AuditFailOpenMetrics(MeterRegistry registry,
            ObjectProvider<WorkspaceService> workspaces,
            ObjectProvider<SessionSnapshotAudit> snapshots,
            ObjectProvider<CheckpointRevertAudit> reverts,
            ObjectProvider<RunCheckpointService> checkpoints) {
        this(registry, collect(workspaces, snapshots, reverts, checkpoints));
    }

    AuditFailOpenMetrics(MeterRegistry registry, Map<String, LongSupplier> suppliers) {
        this.registry = registry;
        this.suppliers = new LinkedHashMap<>(suppliers);
        register();
    }

    private static Map<String, LongSupplier> collect(ObjectProvider<WorkspaceService> workspaces,
            ObjectProvider<SessionSnapshotAudit> snapshots,
            ObjectProvider<CheckpointRevertAudit> reverts,
            ObjectProvider<RunCheckpointService> checkpoints) {
        Map<String, LongSupplier> wired = new LinkedHashMap<>();
        WorkspaceService workspaceService = workspaces.getIfAvailable();
        if (workspaceService != null) {
            wired.put("workspace_created", workspaceService::createdAuditFailureCount);
        }
        SessionSnapshotAudit snapshotAudit = snapshots.getIfAvailable();
        if (snapshotAudit != null) {
            wired.put("session_snapshot", snapshotAudit::failureCount);
        }
        CheckpointRevertAudit revertAudit = reverts.getIfAvailable();
        if (revertAudit != null) {
            wired.put("checkpoint_revert", revertAudit::failureCount);
        }
        RunCheckpointService checkpointService = checkpoints.getIfAvailable();
        if (checkpointService != null) {
            wired.put("checkpoint_revert_unwired", checkpointService::revertAuditUnwiredCount);
        }
        return wired;
    }

    private void register() {
        suppliers.forEach((component, value) -> Gauge
                .builder(METRIC_PREFIX + "failures", value, LongSupplier::getAsLong)
                .tag("component", component)
                .description("fail-open audit write failures (0 = no failure, see wiring.incomplete)")
                .register(registry));
        Gauge.builder(METRIC_PREFIX + "wiring.registered", suppliers, Map::size)
                .description("fail-open counters actually registered")
                .register(registry);
        Gauge.builder(METRIC_PREFIX + "wiring.expected", COMPONENTS, List::size)
                .description("fail-open counters this build expects to expose")
                .register(registry);
        Gauge.builder(METRIC_PREFIX + "wiring.incomplete",
                        suppliers, wired -> (double) (COMPONENTS.size() - wired.size()))
                .description("0 = wiring complete; >0 = counters not wired (0 failures is then unreadable)")
                .register(registry);
    }

    /** 已注册的计数器标识（同一份事实供测试与运维对账）。 */
    public List<String> wiredComponents() {
        return List.copyOf(suppliers.keySet());
    }
}
