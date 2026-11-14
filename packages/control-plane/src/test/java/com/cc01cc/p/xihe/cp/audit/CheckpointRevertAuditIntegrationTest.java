package com.cc01cc.p.xihe.cp.audit;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.RunCheckpoint;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.RunCheckpointRepository;
import com.cc01cc.p.xihe.cp.runtime.RuntimeCheckpointClient;
import com.cc01cc.p.xihe.cp.service.RunCheckpointService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

/**
 * task-548 判据①：回滚**产品写点**（{@code RunCheckpointService#recordRevert}）真的往 audit_logs 写一行，
 * 且能按 result 值筛出来、行内有 actor / checkpointId / 时间。
 *
 * <p><b>证明边界（必须写在报告里）</b>：本用例证明「代码路径被执行且落库」，
 * <b>不</b>证明「真 Runtime 真回滚后也写一行」—— 后者需要真栈，待 stack-1 CP 重建窗口复验。</p>
 */
class CheckpointRevertAuditIntegrationTest extends AbstractIntegrationTest {

    private static final String SLICE_REF = "slice-548";

    @MockitoBean
    private RuntimeCheckpointClient runtime;

    @Autowired
    private RunCheckpointService service;

    @Autowired
    private RunCheckpointRepository checkpoints;

    @Autowired
    private WorkspaceFixture workspaceFixture;

    @Autowired
    private JdbcTemplate jdbc;

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    @Test
    void revertWritesOneAuditRowQueryableByResult() {
        UUID userId = UUID.randomUUID();
        jdbc.update("INSERT INTO users (id, email, password_hash, username) VALUES (?, ?, ?, ?)",
                userId, userId + "@task548.test", "x", "task548-" + userId.toString().substring(0, 8));
        Workspace workspace = workspaceFixture.ensureOwnedWorkspace(userId);
        String workspaceId = workspace.getId().toString();
        // run_checkpoints.root_id 非空 ⇒ 需要一条真根（回滚门也要按根判）。
        UUID rootId = UUID.randomUUID();
        jdbc.update("INSERT INTO workspace_roots (id, workspace_id, position, host_path, created_by) "
                + "VALUES (?, ?, ?, ?, ?)", rootId, workspace.getId(), 0,
                "H:\\zeotmp\\t548\\ws", userId.toString());

        RunCheckpoint row = new RunCheckpoint();
        row.setId(UUID.randomUUID());
        row.setSourceRunId(UUID.randomUUID().toString());
        row.setWorkspaceId(workspaceId);
        row.setState(RunCheckpoint.STATE_CAPTURED);
        row.setRootId(rootId.toString());
        row.setSliceRef(SLICE_REF);
        row.setChangedFiles("[]");
        row.setCapturedAt(Instant.now());
        row.setSourceSessionId(UUID.randomUUID().toString());
        row.setOpaqueNestedRepos("[]");
        row.setCreatedAt(Instant.now());
        row.setUpdatedAt(Instant.now());
        checkpoints.save(row);

        // 有根的 slice 走带 revertRoot 的重载（5 参版本是根内默认路径），两个都钉住。
        RuntimeCheckpointClient.RevertResult ok = new RuntimeCheckpointClient.RevertResult(
                RuntimeCheckpointClient.Outcome.OK, SLICE_REF,
                new RuntimeCheckpointClient.ExecuteCounts(2, 1, 0),
                List.of(new RuntimeCheckpointClient.ExecuteEntry("src/a.txt", "restored", null)),
                5L, List.of(), List.of(), Map.of(), null);
        when(runtime.revert(anyString(), anyString(), anyString(), any(), anyBoolean(), any()))
                .thenReturn(ok);
        when(runtime.revert(anyString(), anyString(), any(), anyBoolean(), any())).thenReturn(ok);

        TenantContext.setUserId(userId.toString());
        service.revert(workspaceId, SLICE_REF, List.of(), false, List.of());

        String where = " WHERE action = '" + CheckpointRevertAudit.ACTION + "' AND resource_id = '"
                + row.getId() + "'";
        Integer rows = jdbc.queryForObject("SELECT count(*) FROM audit_logs" + where, Integer.class);
        assertEquals(1, rows, "一次回滚恰好一条审计，不是 0 条也不重复");

        String details = jdbc.queryForObject("SELECT details FROM audit_logs" + where, String.class);
        assertNotNull(details);
        assertTrue(details.startsWith("result=rolled_back"), "result 前缀可筛：" + details);
        assertTrue(details.contains("restored=2") && details.contains("deleted=1"),
                "结果计数要能回答「回滚结果」：" + details);

        // 谁 / 何时 / 哪个 checkpoint
        String actor = jdbc.queryForObject("SELECT user_id::text FROM audit_logs" + where, String.class);
        assertEquals(userId.toString(), actor, "谁发起的回滚");
        assertEquals(0, jdbc.queryForObject(
                "SELECT count(*) FROM audit_logs" + where + " AND created_at IS NULL", Integer.class),
                "何时由 created_at 给出");

        // 按 result 值筛：这才是判据要的「能按可逆操作结果筛出来」
        Integer filterable = jdbc.queryForObject("SELECT count(*) FROM audit_logs WHERE action = '"
                + CheckpointRevertAudit.ACTION + "' AND details LIKE 'result=rolled_back%'", Integer.class);
        assertTrue(filterable >= 1, "按 result=rolled_back 必须筛得到这一行");
    }
}
