package com.cc01cc.p.xihe.cp.scheduled;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.time.Instant;
import java.util.List;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * task-163 wire 面：两个自动化读面端点（{@code GET /api/v1/scheduled-tasks} 与
 * {@code GET /api/v1/sessions/{sessionId}/scheduled-tasks}）。standalone MockMvc + 真实
 * {@link ProblemDetailsHandler}，断言的是**序列化后的 JSON 形状**（信封键、行内 origin、游标），
 * 而不是 Java 对象——那样才证明跨 converter 之后客户端读到什么。
 */
class ScheduledTaskReadFaceHttpTest {

    private static final String WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
    private static final String USER_ID = "22222222-2222-4222-8222-222222222222";
    private static final String SESSION_ID = "33333333-3333-4333-8333-333333333333";
    private static final String TASK_ID = "66666666-6666-4666-8666-666666666666";
    private static final String OTHER_WORKSPACE_ID = "77777777-7777-4777-8777-777777777777";
    private static final String AGGREGATE = "/api/v1/scheduled-tasks";
    private static final String BY_SESSION = "/api/v1/sessions/" + SESSION_ID + "/scheduled-tasks";

    private ScheduledTaskApiService service;
    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        service = Mockito.mock(ScheduledTaskApiService.class);
        mockMvc = MockMvcBuilders.standaloneSetup(new ScheduledTaskController(service))
                .setControllerAdvice(new ProblemDetailsHandler(5000))
                .build();
        TenantContext.setUserId(USER_ID);
        TenantContext.setWorkspaceId(WORKSPACE_ID);
    }

    @AfterEach
    void tearDown() {
        TenantContext.clear();
    }

    /**
     * The aggregate envelope: {@code size}/{@code hasMore}/{@code nextCursor} plus rows that carry the
     * owning {@code workspaceId} and the {@code origin} — the two facts a multi-workspace tab needs and
     * the single-workspace list could not express.
     */
    @Test
    void aggregate_face_returns_camel_case_envelope_with_workspace_and_origin() throws Exception {
        when(service.listAggregated(eq(USER_ID), anyInt(), any())).thenReturn(
                new ScheduledTaskApiService.AggregatePage(100, true, "cursor-token",
                        List.of(new ScheduledTaskApiService.AutomationRow(WORKSPACE_ID, "user", view()),
                                new ScheduledTaskApiService.AutomationRow(OTHER_WORKSPACE_ID, "system", view()))));

        mockMvc.perform(get(AGGREGATE))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.size").value(100))
                .andExpect(jsonPath("$.hasMore").value(true))
                .andExpect(jsonPath("$.nextCursor").value("cursor-token"))
                .andExpect(jsonPath("$.tasks.length()").value(2))
                .andExpect(jsonPath("$.tasks[0].workspaceId").value(WORKSPACE_ID))
                .andExpect(jsonPath("$.tasks[0].origin").value("user"))
                .andExpect(jsonPath("$.tasks[0].task.id").value(TASK_ID))
                .andExpect(jsonPath("$.tasks[0].task.createdBy.type").value("human"))
                .andExpect(jsonPath("$.tasks[0].task.payload").doesNotExist())
                .andExpect(jsonPath("$.tasks[1].workspaceId").value(OTHER_WORKSPACE_ID))
                .andExpect(jsonPath("$.tasks[1].origin").value("system"));
    }

    /** Both query parameters reach the service unchanged (no silent default substitution). */
    @Test
    void aggregate_face_passes_size_and_cursor_through() throws Exception {
        when(service.listAggregated(eq(USER_ID), eq(5), eq("opaque")))
                .thenReturn(new ScheduledTaskApiService.AggregatePage(
                        5, false, null, List.of(viewRow())));

        mockMvc.perform(get(AGGREGATE).param("size", "5").param("cursor", "opaque"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.hasMore").value(false))
                .andExpect(jsonPath("$.nextCursor").doesNotExist());
    }

    /** The session envelope names the session it was scoped to and lists both origins. */
    @Test
    void session_face_returns_session_scoped_envelope() throws Exception {
        when(service.listBySession(eq(SESSION_ID), eq(USER_ID), eq(WORKSPACE_ID), anyInt(), any()))
                .thenReturn(new ScheduledTaskApiService.SessionPage(SESSION_ID, 100, false, null,
                        List.of(new ScheduledTaskApiService.AutomationRow(WORKSPACE_ID, "user", view()),
                                new ScheduledTaskApiService.AutomationRow(WORKSPACE_ID, "system", view()))));

        mockMvc.perform(get(BY_SESSION))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.sessionId").value(SESSION_ID))
                .andExpect(jsonPath("$.size").value(100))
                .andExpect(jsonPath("$.hasMore").value(false))
                .andExpect(jsonPath("$.tasks[0].origin").value("user"))
                .andExpect(jsonPath("$.tasks[1].origin").value("system"))
                .andExpect(jsonPath("$.tasks[0].task.targetSessionId").value(SESSION_ID));
    }

    /** The read gate's 404 travels out as Problem Details, not as an empty page. */
    @Test
    void session_face_maps_read_gate_404_to_problem_details() throws Exception {
        when(service.listBySession(any(), any(), any(), anyInt(), any())).thenThrow(new CpApiException(
                HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND", "session not found"));

        mockMvc.perform(get(BY_SESSION))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("SESSION_NOT_FOUND"))
                .andExpect(jsonPath("$.requestId").exists())
                .andExpect(jsonPath("$.status").value(404));
    }

    /** A cursor the codec refuses is a 400 INVALID_CURSOR, the same code the message read face uses. */
    @Test
    void tampered_cursor_maps_to_400_invalid_cursor() throws Exception {
        when(service.listAggregated(any(), anyInt(), any())).thenThrow(new CpApiException(
                HttpStatus.BAD_REQUEST, "INVALID_CURSOR",
                "cursor is not an automation cursor issued by this endpoint"));

        mockMvc.perform(get(AGGREGATE).param("cursor", "tampered"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_CURSOR"))
                .andExpect(jsonPath("$.status").value(400));
    }

    /** Both new endpoints refuse to answer without an authenticated principal, like every sibling. */
    @Test
    void both_faces_require_a_principal() throws Exception {
        TenantContext.clear();

        mockMvc.perform(get(AGGREGATE))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("FORBIDDEN"))
                .andExpect(jsonPath("$.detail").value("Authentication context is required"));
        mockMvc.perform(get(BY_SESSION))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("FORBIDDEN"));

        Mockito.verifyNoInteractions(service);
    }

    private static ScheduledTaskApiService.AutomationRow viewRow() {
        return new ScheduledTaskApiService.AutomationRow(WORKSPACE_ID, "user", view());
    }

    private static ScheduledTaskApiService.TaskView view() {
        return new ScheduledTaskApiService.TaskView(TASK_ID, "cron", "* * * * *", "UTC",
                "session_wakeup", SESSION_ID, "wake up", "scheduled",
                Instant.parse("2026-10-12T00:00:00Z").toString(), null, 0, null, null, null,
                new ScheduledTaskApiService.CreatedBy("User One", "human"),
                Instant.parse("2026-10-11T00:00:00Z").toString(),
                Instant.parse("2026-10-11T00:00:00Z").toString());
    }
}
