package com.cc01cc.p.xihe.cp.chat;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0630 V12 (design §7, D30-12): <b>零新事件名</b> as a static gate.
 *
 * <p>The verification finding was that M3/M5b emitted eight brand-new event names, each of which
 * would have to be synced into {@code spec/protocol/event-stream.md} and every consumer/alert rule.
 * The fix collapsed them into the pre-existing {@code [LIFECYCLE] service=cp event=…} envelope plus
 * a {@code reason}/{@code outcome} field, so the observable name set is the one that existed before
 * the PLAN.</p>
 *
 * <p>This gate scans the three source files that own the wake surface and pins the exact set of
 * {@code event=} tokens. Anything new fails here, which is the point: a new event name is a contract
 * change and must be argued in {@code design.md} first, then added to this list with that
 * justification. Runtime call-site assertions cannot catch this (log lines are not mockable
 * contracts); the durable append name is independently pinned by
 * {@link WakeChainServiceTest#onlyExistingEventNamesAreAppended()}.</p>
 *
 * <p>{@code wake_roster_unreadable} predates the M3/M5b work in this PLAN (PLAN-0630 M1-B, the
 * swallowed-roster-read diagnostic required by the exception-audit rule), so it is part of the
 * frozen baseline rather than a retired name.</p>
 */
class FrozenWakeEventNameScanTest {

    /** Surefire runs with the module directory as the working directory. */
    private static final Path MAIN_SOURCES = Path.of("src/main/java");

    private static final List<Path> SCANNED = List.of(
            Path.of("com/cc01cc/p/xihe/cp/chat/WakeChainService.java"),
            Path.of("com/cc01cc/p/xihe/cp/chat/WakeFanOutService.java"),
            Path.of("com/cc01cc/p/xihe/cp/service/WakeDispatchService.java"));

    /** The event names that existed before PLAN-0630 M3/M5b — the frozen contract surface. */
    private static final Set<String> FROZEN_EVENT_NAMES = Set.of(
            "wake_dispatch",
            "wake_chain_link",
            "wake_chain_refused",
            "wake_chain_depth_invalid",
            "wake_chain_depth_unreadable",
            "wake_roster_unreadable",
            "wake_mention_unresolved",
            "wake_recipient_failed",
            "wake_judge_failed",
            "wake_await_interrupted",
            "wake_await_timeout");

    /** The eight names the implementation invented; V12 collapsed every one of them. */
    private static final Set<String> RETIRED_EVENT_NAMES = Set.of(
            "wake_chain_ancestor_missing",
            "wake_chain_root_principal_missing",
            "wake_chain_policy_unreadable",
            "wake_chain_parent_invalid",
            "wake_chain_duplicate_refused",
            "wake_cc_ignored",
            "wake_cc_failed",
            "wake_cc_notify");

    private static final Pattern EVENT_TOKEN = Pattern.compile("event=([a-z][a-z0-9_]*)");

    @Test
    void emittedEventNamesAreTheFrozenSet() throws IOException {
        Map<String, Set<String>> namesByFile = new LinkedHashMap<>();
        for (Path relative : SCANNED) {
            Path file = MAIN_SOURCES.resolve(relative);
            assertTrue(Files.isRegularFile(file), "scanned source must exist: " + file.toAbsolutePath());
            namesByFile.put(relative.getFileName().toString(), eventNamesIn(
                    Files.readString(file, StandardCharsets.UTF_8)));
        }
        Set<String> actual = new LinkedHashSet<>();
        namesByFile.values().forEach(actual::addAll);

        assertEquals(FROZEN_EVENT_NAMES, actual,
                "a new event name is a contract change (design §7: 零新事件名) — carry the cause in the "
                        + "existing event's reason/outcome field instead; per file: " + namesByFile);
        Set<String> retiredStillEmitted = new LinkedHashSet<>(actual);
        retiredStillEmitted.retainAll(RETIRED_EVENT_NAMES);
        assertTrue(retiredStillEmitted.isEmpty(),
                "these names were collapsed by the V12 fix and must never come back: " + retiredStillEmitted);
    }

    private static Set<String> eventNamesIn(String source) {
        Set<String> names = new LinkedHashSet<>();
        Matcher matcher = EVENT_TOKEN.matcher(source);
        while (matcher.find()) {
            names.add(matcher.group(1));
        }
        return names;
    }
}
