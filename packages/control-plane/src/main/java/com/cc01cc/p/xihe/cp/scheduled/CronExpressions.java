package com.cc01cc.p.xihe.cp.scheduled;

import org.springframework.scheduling.support.CronExpression;

import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.zone.ZoneRulesException;

/**
 * PLAN-0489 T1.2（design 决策 #3）：cron 求值 = Spring {@code CronExpression} +
 * 5→6 段映射（前缀 {@code "0 "} 秒字段），ZoneId 按任务 timezone 快照（0486 D3-A）。
 *
 * <p>零新依赖（否决 cron-utils）；非法表达式/时区抛
 * {@link IllegalArgumentException} 供 API 层转 400（T1.4 {@code INVALID_CRON_EXPR}/
 * {@code INVALID_TIMEZONE}）。求值语义按 Spring：{@code next} 返回给定时刻之后的
 * 下一次匹配（严格大于），无未来匹配返回 null；DST 行为见
 * {@code CronExpressionsTest}（Europe/Berlin 2026 实测）。</p>
 */
public final class CronExpressions {

    private CronExpressions() {}

    /** 5 段（分 时 日 月 周）→ Spring 6 段（前缀秒字段 "0 "）；6 段原样通过。 */
    public static String toSpringCron(String cronExpr) {
        if (cronExpr == null || cronExpr.isBlank()) {
            throw new IllegalArgumentException("cron expression is required");
        }
        String[] fields = cronExpr.trim().split("\\s+");
        if (fields.length == 5) {
            return "0 " + cronExpr.trim();
        }
        if (fields.length == 6) {
            return cronExpr.trim();
        }
        throw new IllegalArgumentException("cron expression must have 5 fields (minute-grain), got "
                + fields.length);
    }

    /**
     * 任务时区中 {@code after} 之后的下一次触发 → UTC Instant；无未来匹配返回 null。
     *
     * @throws IllegalArgumentException 非法 cron 表达式或时区标识（API 层转 400）
     */
    public static Instant nextUtcInstant(String cronExpr, String timezone, Instant after) {
        ZoneId zone;
        try {
            zone = ZoneId.of(timezone);
        } catch (ZoneRulesException e) {
            throw new IllegalArgumentException("unknown timezone: " + timezone, e);
        }
        CronExpression expression = CronExpression.parse(toSpringCron(cronExpr));
        ZonedDateTime next = expression.next(ZonedDateTime.ofInstant(after, zone));
        return next == null ? null : next.toInstant();
    }
}
