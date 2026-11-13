package com.cc01cc.p.xihe.cp.repository;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.UUID;

/**
 * PLAN-0773 M2-11 (batch B): the write side of the org-unit tree.
 *
 * <p><b>`path` and `depth` are maintained by the writer, in the same transaction as
 * `parent_id`</b> (design §3.1): the table stores all three, and the database enforces only the
 * parent/depth shape and the sibling name — a move that updated `parent_id` alone would leave a
 * tree whose rows disagree with its own index, and every subtree query would then be wrong in the
 * same direction (silently, because nothing compares the two).</p>
 *
 * <p>The move is two statements on purpose. A single update would have to special-case the moved
 * row (`subpath(path, nlevel(old))` is empty for it, so the concatenation would drop its own
 * label). Two statements also put the cycle trigger where it belongs: the trigger fires on the
 * moved row's `parent_id` update, and descendants are rewritten before it — so a ring is refused
 * by the database and the transaction rolls back with nothing half-shifted.</p>
 */
@Repository
public class OrgUnitWriteRepository {

    private final JdbcTemplate jdbc;

    public OrgUnitWriteRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Insert one unit. The id is the caller's, not generated here: the caller builds the path from
     * it (D-1116 labels are the unit's own UUID), so a second id generated in this method would
     * produce a row whose path label belongs to a different id than its primary key.
     */
    public void insert(UUID id, UUID parentId, String name, String path, int depth) {
        jdbc.update("INSERT INTO org_units (id, parent_id, name, path, depth) VALUES (?, ?, ?, ?::ltree, ?)",
                id, parentId, name, path, depth);
    }

    public void rename(UUID id, String name) {
        jdbc.update("UPDATE org_units SET name = ?, updated_at = now() WHERE id = ?", name, id);
    }

    /**
     * Rewrite every descendant of the moved unit onto the new prefix, then the unit itself.
     *
     * @param oldSelfPath the moved unit's path <b>before</b> the move; its label count is the offset
     *     into each descendant path
     * @param newSelfPath the moved unit's path <b>after</b> the move
     * @param depthDelta new depth minus old depth (the same shift applies to the whole subtree)
     */
    public void move(UUID id, UUID parentId, String newSelfPath, int newDepth, String oldSelfPath,
                     int depthDelta) {
        jdbc.update("UPDATE org_units"
                + " SET path = ?::ltree || subpath(path, nlevel(?::ltree)),"
                + "     depth = depth + ?, updated_at = now()"
                + " WHERE path <@ ?::ltree AND id <> ?",
                newSelfPath, oldSelfPath, depthDelta, oldSelfPath, id);
        jdbc.update("UPDATE org_units SET parent_id = ?, path = ?::ltree, depth = ?, updated_at = now()"
                + " WHERE id = ?", parentId, newSelfPath, newDepth, id);
    }
}
