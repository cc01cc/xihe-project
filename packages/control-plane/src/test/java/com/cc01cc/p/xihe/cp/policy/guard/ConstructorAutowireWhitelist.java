package com.cc01cc.p.xihe.cp.policy.guard;

import java.util.List;

/**
 * task-868 whitelist — <b>data in its own file</b>, not inline suppressions in the scan.
 *
 * <p>One entry allows one source file that has two or more constructors and no {@code @Autowired}.
 * That shape is only safe when every constructor is explicitly invoked by a caller (records,
 * value types, builder-ish classes) — for a Spring bean it makes the container fall back to a
 * no-argument constructor and the whole {@code @SpringBootTest} context fails to start (task-868:
 * {@code WorkspaceController} did exactly that).</p>
 *
 * <p>Contract (enforced by {@link ConstructorAutowireGuardTest}):</p>
 * <ul>
 *   <li>every entry carries {@code reason + owner + reviewDate};</li>
 *   <li><b>only-shrink</b> — an entry whose file no longer has the offending shape must be deleted
 *       (a stale allowance is a permanent hole);</li>
 *   <li>no entry may use {@code owner=task-868}: this card must leave zero non-whitelisted hits.</li>
 * </ul>
 *
 * <p>Currently empty: after task-868 removed the deprecated three-argument
 * {@code WorkspaceController} seam, a live scan of {@code controller/} and {@code service/} finds
 * no file with two or more constructors and no {@code @Autowired}.</p>
 */
final class ConstructorAutowireWhitelist {

    /** One whitelisted file: the class that legitimately declares several constructors without the annotation. */
    record Entry(String file, String reason, String owner, String reviewDate) {
    }

    static final List<Entry> ENTRIES = List.of();

    private ConstructorAutowireWhitelist() {
    }
}
