package com.cc01cc.p.xihe.cp.scheduled;

import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0489 T1.2（design 决策 #3）：Spring CronExpression 5→6 段映射（段数只认 5 段，task-96）、时区求值
 * 与 DST 最小实测（Europe/Berlin 2026 边界：03-29 spring forward / 10-25 fall back）。
 * DST 断言按任务契约：不抛异常且 next 单调；墙钟跳时行为打印留证（不锁秒级值）。
 */
class CronExpressionsTest {

    @Test
    void maps_five_field_cron_to_spring_six_field_with_second_prefix() {
        assertEquals("0 */5 * * * *", CronExpressions.toSpringCron("*/5 * * * *"));
        assertEquals("0 30 9 * * 1", CronExpressions.toSpringCron("30 9 * * 1"));
        // 分钟字段为普通数字的形态（无步长、无通配）同样只加秒前缀。
        assertEquals("0 7 * * * *", CronExpressions.toSpringCron("7 * * * *"));
    }

    /**
     * 解析层判据：Spring 原生 6 段一律拒绝，与校验层 {@code ScheduledTaskContracts#requireCronExpression}
     * 的「5 段 only」同一口径（task-96，用户 18:56 裁案 5；原实现 6 段原样透传）。
     */
    @Test
    void rejects_six_field_cron_instead_of_passing_it_through() {
        IllegalArgumentException error = assertThrows(IllegalArgumentException.class,
                () -> CronExpressions.toSpringCron("0 30 9 * * *"));
        assertTrue(error.getMessage().contains("5 fields"),
                "message must name the 5-field rule: " + error.getMessage());
    }

    @Test
    void rejects_blank_and_non_five_field_cron() {
        assertThrows(IllegalArgumentException.class, () -> CronExpressions.toSpringCron(" "));
        assertThrows(IllegalArgumentException.class, () -> CronExpressions.toSpringCron(null));
        assertThrows(IllegalArgumentException.class, () -> CronExpressions.toSpringCron("* * *"));
        assertThrows(IllegalArgumentException.class,
                () -> CronExpressions.toSpringCron("* * * * * *"));
        assertThrows(IllegalArgumentException.class,
                () -> CronExpressions.toSpringCron("* * * * * * *"));
    }

    @Test
    void rejects_invalid_cron_and_timezone_with_illegal_argument() {
        assertThrows(IllegalArgumentException.class,
                () -> CronExpressions.nextUtcInstant("99 * * * *", "UTC", Instant.now()));
        assertThrows(IllegalArgumentException.class,
                () -> CronExpressions.nextUtcInstant("* * * * *", "Not/AZone", Instant.now()));
    }

    @Test
    void next_is_strictly_later_instant_in_the_task_zone() {
        Instant after = Instant.parse("2026-06-10T10:00:00Z");
        Instant next = CronExpressions.nextUtcInstant("30 12 * * *", "Europe/Berlin", after);
        assertNotNull(next);
        assertTrue(next.isAfter(after));
        // 2026-06-10 Berlin = UTC+2：12:30 本地 = 10:30Z。
        assertEquals("2026-06-10T10:30:00Z", next.toString());
    }

    @Test
    void dst_spring_forward_boundary_stays_monotonic_and_never_throws() {
        // Europe/Berlin 2026 spring forward：03-29 02:00→03:00（02:00–03:00 不存在）。
        ZoneId zone = ZoneId.of("Europe/Berlin");
        List<Instant> occurrences = successiveInstants(
                "30 2 * * *", zone, Instant.parse("2026-03-26T00:00:00Z"), 6);
        assertStrictlyIncreasing(occurrences);
        System.out.println("[DST-spring-forward] Europe/Berlin 02:30 daily wall-clock = "
                + wallClock(occurrences, zone));
    }

    @Test
    void dst_fall_back_boundary_stays_monotonic_and_never_throws() {
        // Europe/Berlin 2026 fall back：10-25 03:00→02:00（02:00–03:00 重复）。
        ZoneId zone = ZoneId.of("Europe/Berlin");
        List<Instant> occurrences = successiveInstants(
                "30 2 * * *", zone, Instant.parse("2026-10-22T00:00:00Z"), 6);
        assertStrictlyIncreasing(occurrences);
        System.out.println("[DST-fall-back] Europe/Berlin 02:30 daily wall-clock = "
                + wallClock(occurrences, zone));
    }

    private static List<Instant> successiveInstants(String cron, ZoneId zone, Instant start, int count) {
        List<Instant> result = new ArrayList<>();
        Instant cursor = start;
        for (int i = 0; i < count; i++) {
            Instant next = CronExpressions.nextUtcInstant(cron, zone.getId(), cursor);
            assertNotNull(next, "occurrence " + i + " must exist");
            result.add(next);
            cursor = next;
        }
        return result;
    }

    private static void assertStrictlyIncreasing(List<Instant> occurrences) {
        for (int i = 1; i < occurrences.size(); i++) {
            assertTrue(occurrences.get(i).isAfter(occurrences.get(i - 1)),
                    "occurrences must be strictly increasing: " + occurrences);
        }
    }

    private static List<String> wallClock(List<Instant> occurrences, ZoneId zone) {
        List<String> local = new ArrayList<>();
        for (Instant occurrence : occurrences) {
            local.add(ZonedDateTime.ofInstant(occurrence, zone).toString());
        }
        return local;
    }
}
