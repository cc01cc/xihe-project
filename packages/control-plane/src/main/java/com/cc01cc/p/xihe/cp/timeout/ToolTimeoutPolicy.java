package com.cc01cc.p.xihe.cp.timeout;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * PLAN-0308 M1（spec S1/S2）：工具超时的**唯一计算点**。
 *
 * <p>输入优先级：per-call &gt; 数据库（remote 的 {@code tool_timeout_s} / 系统工具的
 * {@code agent-runtime.systemToolTimeoutS}）&gt; 代码默认；输出三跳最终等待值
 * （Runtime = B、CP = B+2、Agent = B+4），并标注性质（per-call | config）。
 * 执行模块只消费，不做任何计算。
 */
@Component
public class ToolTimeoutPolicy {

    private static final Logger logger = LoggerFactory.getLogger(ToolTimeoutPolicy.class);

    /** 系统工具预算的 config 域/键（决策 #22a/#24；配合三方同步）。 */
    public static final String SYSTEM_TOOL_DOMAIN = "agent-runtime";
    public static final String SYSTEM_TOOL_KEY = "systemToolTimeoutS";
    /** 单次工具返回的字节上限授权（决策 #31②；调用方只可收窄）。 */
    public static final String OUTPUT_LIMIT_KEY = "toolOutputLimitBytes";

    /** 预算代码默认（离线/无配置时的缺省；T3.1 维持 30s）。 */
    public static final long DEFAULT_BUDGET_SECONDS = 30L;
    /** 外层余量：仅下游挂死不回包时兜底，正常路径不产生延迟。 */
    public static final long CP_MARGIN_SECONDS = 2L;
    public static final long AGENT_MARGIN_SECONDS = 4L;
    /**
     * 预算上限（T3.1，用户 2026-09-13 裁定）：per-call 与数据库配置**同顶** 30s，
     * 使 SDK 传输层默认 read=300s 结构上不可达（决策见 PLAN-0308 design #35）；
     * 超过此上限的同步等待应改走异步 job，不做静默截断。
     */
    public static final long MAX_BUDGET_SECONDS = 30L;

    /** T3.1 评审修复：遗留超限配置只告警一次（本方法在每次 tools/call 与每个映射项被调用）。 */
    private final Set<String> warnedConfigValues = ConcurrentHashMap.newKeySet();

    /** 三跳最终等待值 + 值性质（camelCase，随请求下发）。 */
    public record ToolWaits(long runtimeSeconds, long cpSeconds, long agentSeconds, String origin) {}

    /** run 请求 per-call 映射的校验结果：合法 → tool→秒数；非法 → 首个错误（调用方 400 + 署名）。 */
    public record PerCallMap(Map<String, Integer> values, String error) {
        public boolean valid() {
            return error == null;
        }
    }

    /**
     * 校验 run 请求携带的 per-call 映射（T1.9，决策 #28/#29）：每个值必须为正整数秒且
     * ≤ {@link #MAX_BUDGET_SECONDS}；非法/超限记录首个错误由调用方 400 拒绝，**不静默截断**。
     */
    public PerCallMap validatePerCallMap(Object raw) {
        if (raw == null) {
            return new PerCallMap(Map.of(), null);
        }
        if (!(raw instanceof Map<?, ?> map)) {
            return new PerCallMap(Map.of(), "toolTimeouts must be an object mapping tool names to seconds");
        }
        Map<String, Integer> values = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            String tool = entry.getKey() == null ? null : String.valueOf(entry.getKey()).trim();
            if (tool == null || tool.isEmpty()) {
                return new PerCallMap(Map.of(), "toolTimeouts contains a blank tool name");
            }
            Long seconds = parsePerCallValue(entry.getValue());
            if (seconds == null) {
                return new PerCallMap(Map.of(), "toolTimeouts." + tool
                        + " must be a positive integer <= " + MAX_BUDGET_SECONDS
                        + " (got " + entry.getValue() + ")");
            }
            values.put(tool, seconds.intValue());
        }
        return new PerCallMap(values, null);
    }

    /** per-call 值（JSON 整数或数字字符串）→ 秒数；非法（含小数/布尔/超限）返回 null。 */
    private Long parsePerCallValue(Object value) {
        if (value instanceof Boolean) {
            return null;
        }
        if (value instanceof Number number) {
            double asDouble = number.doubleValue();
            if (asDouble != Math.rint(asDouble)) {
                return null;
            }
            return parsePerCall(String.valueOf(number.longValue()));
        }
        if (value instanceof String text) {
            return parsePerCall(text);
        }
        return null;
    }

    /** per-call 校验结果：合法返回秒数，非法返回 null（调用方负责 400 + 署名）。 */
    public Long parsePerCall(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        long value;
        try {
            value = Long.parseLong(raw.trim());
        } catch (NumberFormatException e) {
            return null;
        }
        if (value <= 0 || value > MAX_BUDGET_SECONDS) {
            return null;
        }
        return value;
    }

    /** 预算 B：per-call &gt; 配置值 &gt; 代码默认。 */
    public long budget(Integer perCallSeconds, Integer configSeconds) {
        if (perCallSeconds != null && perCallSeconds > 0) {
            return perCallSeconds;
        }
        if (configSeconds != null && configSeconds > 0) {
            return configSeconds;
        }
        return DEFAULT_BUDGET_SECONDS;
    }

    /** 值性质：per-call（本次调用显式指定）或 config（按配置/默认算出）。 */
    public String origin(Integer perCallSeconds) {
        return (perCallSeconds != null && perCallSeconds > 0) ? "per-call" : "config";
    }

    /** 由预算派生三跳等待值（固定余量，不随预算放大）。 */
    public ToolWaits waits(long budgetSeconds, String origin) {
        return new ToolWaits(
                budgetSeconds,
                budgetSeconds + CP_MARGIN_SECONDS,
                budgetSeconds + AGENT_MARGIN_SECONDS,
                origin);
    }

    /** 便捷入口：一步得到三跳等待值。 */
    public ToolWaits resolve(Integer perCallSeconds, Integer configSeconds) {
        long budget = budget(perCallSeconds, configSeconds);
        return waits(budget, origin(perCallSeconds));
    }

    /**
     * 把配置字符串解析为正的秒数（非法/空/非正/超上限 {@link #MAX_BUDGET_SECONDS} → null）。
     *
     * <p>T3.1：数据库预算与 per-call 同顶 30s；超限视为无效并回落代码默认（写入侧由
     * config schema 的 `maximum` 拦数值、`pattern` 拦字符串——配置实际以字符串提交；
     * 遗留大值在此告警一次后回落，而不是静默截断或每次刷日志）。
     */
    public Integer parseConfigSeconds(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            int value = Integer.parseInt(raw.trim());
            if (value <= 0) {
                return null;
            }
            if (value > MAX_BUDGET_SECONDS) {
                if (warnedConfigValues.add(String.valueOf(value))) {
                    logger.warn(
                            "Tool timeout config value {} exceeds MAX_BUDGET_SECONDS={}; falling back to default {}",
                            value, MAX_BUDGET_SECONDS, DEFAULT_BUDGET_SECONDS);
                }
                return null;
            }
            return value;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /** 把配置字符串解析为正整数（输出上限等；非法/空/非正 → null）。 */
    public Long parsePositiveLong(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            long value = Long.parseLong(raw.trim());
            return value > 0 ? value : null;
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
