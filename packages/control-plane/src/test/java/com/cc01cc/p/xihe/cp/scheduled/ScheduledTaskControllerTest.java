package com.cc01cc.p.xihe.cp.scheduled;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * PLAN-0489 T1.4：scheduled-tasks 控制器 wire 面——Problem Details code、
 * RFC 9457 字段、camelCase 读 DTO 与 remove 幂等响应体。直接构造 controller
 * （对齐 {@code WorkspaceJobControllerTest} 单测风格）+ 轻量 MockMvc 断言 JSON 形态。
 */
class ScheduledTaskControllerTest {

    private static final String WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
    private static final String TASK_ID = "66666666-6666-4666-8666-666666666666";
    private static final String BASE = "/api/v1/workspaces/" + WORKSPACE_ID + "/scheduled-tasks";

    private ScheduledTaskApiService service;
    private ScheduledTaskController controller;
    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        service = Mockito.mock(ScheduledTaskApiService.class);
        controller = new ScheduledTaskController(service);
        mockMvc = MockMvcBuilders.standaloneSetup(controller)
                .setControllerAdvice(new com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler(5000))
                .build();
        TenantContext.setUserId("user-1");
    }

    @AfterEach
    void tearDown() {
        TenantContext.clear();
    }

    @Test
    void create_returns_201_with_seventeen_field_view() {
        ScheduledTaskApiService.TaskView view = view("scheduled");
        when(service.create(org.mockito.ArgumentMatchers.eq(WORKSPACE_ID), any(), any()))
                .thenReturn(view);

        ResponseEntity<?> response = controller.create(WORKSPACE_ID, new ScheduledTaskApiService.CreateRequest(
                "cron", "* * * * *", "UTC", "session_wakeup",
                "44444444-4444-4444-8444-444444444444", "wake up", null, null, null));

        assertEquals(HttpStatus.CREATED, response.getStatusCode());
        assertEquals(view, response.getBody());
    }

    @Test
    void create_propagates_problem_details_with_code() {
        when(service.create(any(), any(), any())).thenThrow(new CpApiException(
                HttpStatus.BAD_REQUEST, "INVALID_CRON_EXPR", "cron expression is invalid"));

        ResponseEntity<?> response = controller.create(WORKSPACE_ID, new ScheduledTaskApiService.CreateRequest(
                "cron", "bad", "UTC", "session_wakeup",
                "44444444-4444-4444-8444-444444444444", "wake up", null, null, null));

        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode());
        Map<?, ?> body = (Map<?, ?>) response.getBody();
        assertNotNull(body);
        assertEquals("INVALID_CRON_EXPR", body.get("code"));
        assertEquals("https://xihe.dev/problems/invalid_cron_expr", body.get("type"));
        assertNotNull(body.get("requestId"));
    }

    @Test
    void remove_idempotent_returns_changed_false_body() {
        ScheduledTaskApiService.DisposeResult result = new ScheduledTaskApiService.DisposeResult(
                TASK_ID, "cancelled", false, view("cancelled"));
        when(service.remove(any(), any(), any(), any())).thenReturn(result);

        ResponseEntity<?> response = controller.remove(WORKSPACE_ID, TASK_ID, null);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        Map<?, ?> body = (Map<?, ?>) response.getBody();
        assertNotNull(body);
        assertEquals(TASK_ID, body.get("taskId"));
        assertEquals(false, body.get("changed"));
        assertEquals("cancelled", body.get("status"));
    }

    @Test
    void delete_state_conflict_maps_to_409_with_code() {
        when(service.delete(any(), any(), any(), any())).thenThrow(new CpApiException(
                HttpStatus.CONFLICT, "SCHEDULED_TASK_STATE", "Task is missed; use /remove"));

        ResponseEntity<?> response = controller.delete(WORKSPACE_ID, TASK_ID, null);

        assertEquals(HttpStatus.CONFLICT, response.getStatusCode());
        assertEquals("SCHEDULED_TASK_STATE", ((Map<?, ?>) response.getBody()).get("code"));
    }

    @Test
    void list_returns_paged_camel_case_envelope() throws Exception {
        when(service.list(any(), any(), anyInt(), anyInt()))
                .thenReturn(new ScheduledTaskApiService.ListPage(WORKSPACE_ID, 0, 100,
                        List.of(view("scheduled"))));

        mockMvc.perform(get(BASE))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.workspaceId").value(WORKSPACE_ID))
                .andExpect(jsonPath("$.page").value(0))
                .andExpect(jsonPath("$.size").value(100))
                .andExpect(jsonPath("$.tasks[0].id").value(TASK_ID))
                .andExpect(jsonPath("$.tasks[0].triggerKind").value("cron"))
                .andExpect(jsonPath("$.tasks[0].nextFireAt").exists())
                .andExpect(jsonPath("$.tasks[0].createdBy.type").value("human"))
                .andExpect(jsonPath("$.tasks[0].createdBy.name").value("User One"))
                .andExpect(jsonPath("$.tasks[0].payload").doesNotExist())
                .andExpect(jsonPath("$.tasks[0].cancel_reason").doesNotExist());
    }

    @Test
    void postpone_maps_bad_request_code_through_problem_details() throws Exception {
        when(service.postpone(any(), any(), any(), any(), any())).thenThrow(new CpApiException(
                HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "postpone at must be a future instant"));

        mockMvc.perform(post(BASE + "/" + TASK_ID + "/postpone")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"at\":\"2020-01-01T00:00:00Z\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_REQUEST"))
                .andExpect(jsonPath("$.requestId").exists())
                .andExpect(jsonPath("$.status").value(400));
    }

    private static ScheduledTaskApiService.TaskView view(String status) {
        return new ScheduledTaskApiService.TaskView(TASK_ID, "cron", "* * * * *", "UTC",
                "session_wakeup", "44444444-4444-4444-8444-444444444444", "wake up", status,
                Instant.parse("2026-10-12T00:00:00Z").toString(), null, 0, null, null, null,
                new ScheduledTaskApiService.CreatedBy("User One", "human"),
                Instant.parse("2026-10-11T00:00:00Z").toString(),
                Instant.parse("2026-10-11T00:00:00Z").toString());
    }
}
