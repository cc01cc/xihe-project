package com.cc01cc.p.xihe.cp.support;

import java.util.Map;

/**
 * task-104 债②（infra-1，2026-11-11）：给 CP 测试自己起的 Testcontainers 容器打上「本轮归属」标签。
 *
 * <p><b>为什么需要它</b>（实测，非推断）：`mise run test:cp` 已经把自己的 run id 注入环境
 * （{@code scripts/cp-test-run.mjs:33-39}，提交 {@code ce8dde566}，
 * 环境变量名沿用 e2e 的 {@code XIHE_E2E_RUN_ID}），但**没有任何 Java 代码消费它** ——
 * 2026-11-11 20:02 抓 {@code docker events} 实测：那一轮 PG 容器的标签只有 Testcontainers 自带的
 * {@code org.testcontainers:true / .lang / .sessionId / .version}，没有 run id。
 * 于是「事后按 run 归因/清理」在 Testcontainers 容器上做不到，只能靠时间 + 随机容器名猜。</p>
 *
 * <p><b>为什么用独立 key 而不是 {@code xihe.e2e.run-id}</b>：{@code xihe.e2e.run-id} 已被
 * Runtime 的 workspace 沙箱容器占用（{@code packages/runtime/src/workspace.rs:248-251}），而
 * {@code scripts/e2e-host.mjs:1979/2384} 会按该标签做整轮清扫。若 Testcontainers 容器共用同一个 key，
 * 清扫会连带匹配这些随机名容器，而 {@code scripts/e2e-preflight.mjs:351} 的名字过滤
 * （{@code ^xihe-(workspace|ws-s\d+-ws_)}）又扫不到它们 ⇒ 造出「一侧会删、一侧看不见」的不对称。
 * 独立 key 保持两个命名空间互不干扰。</p>
 *
 * <p><b>缺省行为不变</b>：环境变量缺失或为空白时返回空 Map（不调用 {@code withLabels} 等价），
 * 即与打标之前逐项一致 —— 直接 {@code mvn test} 不走梯次时不会凭空多出标签。</p>
 */
public final class TestContainerLabels {

    /** CP 测试容器（Testcontainers）的 run 归属标签；与 e2e 的 {@code xihe.e2e.run-id} 刻意分开。 */
    public static final String RUN_ID_LABEL = "xihe.cp.test.run-id";

    /** 标签来源环境变量：由 {@code scripts/cp-test-run.mjs} / {@code scripts/xh-verify-gates.mjs} 注入。 */
    private static final String RUN_ID_ENV = "XIHE_E2E_RUN_ID";

    private TestContainerLabels() {
    }

    /**
     * 本轮的容器标签；没有 run id 时返回空 Map。
     *
     * <p>调用点一律写成 {@code .withLabels(TestContainerLabels.runId())}：{@code withLabels}
     * 接受空 Map（内部按条 forEach 添加），因此无需在调用点分支。</p>
     */
    public static Map<String, String> runId() {
        String runId = System.getenv(RUN_ID_ENV);
        if (runId == null || runId.isBlank()) {
            return Map.of();
        }
        return Map.of(RUN_ID_LABEL, runId);
    }
}
