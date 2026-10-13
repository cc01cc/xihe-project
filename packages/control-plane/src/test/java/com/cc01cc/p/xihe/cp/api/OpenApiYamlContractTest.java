package com.cc01cc.p.xihe.cp.api;

import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

class OpenApiYamlContractTest {

    @Test
    void openApiParsesAndContainsFollowUpQueueRoutes() throws Exception {
        Path contract = Path.of("..", "..", "docs", "api", "openapi.yaml");
        try (InputStream input = Files.newInputStream(contract)) {
            Object parsed = new Yaml().load(input);
            assertInstanceOf(Map.class, parsed);
            Map<?, ?> document = (Map<?, ?>) parsed;
            assertInstanceOf(Map.class, document.get("paths"));
            Map<?, ?> paths = (Map<?, ?>) document.get("paths");
            assertTrue(paths.containsKey("/api/v1/sessions/{sessionId}/follow-ups"));
            assertTrue(paths.containsKey("/api/v1/sessions/{sessionId}/follow-ups/{itemId}"));
            assertTrue(paths.containsKey("/api/v1/sessions/{sessionId}/follow-ups/continue"));
        }
    }

    /** PLAN-0489 T1.4：scheduled-tasks API 面与 workspace_jobs.source 枚举同批入契约。 */
    @Test
    void openApiContainsScheduledTaskRoutesAndSourceEnum() throws Exception {
        Path contract = Path.of("..", "..", "docs", "api", "openapi.yaml");
        try (InputStream input = Files.newInputStream(contract)) {
            Map<?, ?> document = new Yaml().load(input);
            Map<?, ?> paths = (Map<?, ?>) document.get("paths");
            String base = "/api/v1/workspaces/{workspaceId}/scheduled-tasks";
            assertTrue(paths.containsKey(base), "scheduled-tasks collection route is contracted");
            assertTrue(paths.containsKey(base + "/{taskId}"), "scheduled-tasks item route is contracted");
            assertTrue(paths.containsKey(base + "/{taskId}/rerun"), "rerun disposition route is contracted");
            assertTrue(paths.containsKey(base + "/{taskId}/remove"), "remove disposition route is contracted");
            assertTrue(paths.containsKey(base + "/{taskId}/postpone"), "postpone disposition route is contracted");

            Map<?, ?> schemas = (Map<?, ?>) ((Map<?, ?>) document.get("components")).get("schemas");
            assertSourceEnumContains(schemas, "WorkspaceJob");
            assertSourceEnumContains(schemas, "WorkspaceJobStartRequest");

            Map<?, ?> scheduledTask = (Map<?, ?>) schemas.get("ScheduledTask");
            assertInstanceOf(Map.class, scheduledTask, "ScheduledTask schema is contracted");
            Map<?, ?> properties = (Map<?, ?>) scheduledTask.get("properties");
            assertTrue(properties.containsKey("createdBy"), "read DTO carries createdBy");
            assertTrue(properties.containsKey("missedReason"), "read DTO carries missedReason");
        }
    }

    /** PLAN-0507: Session monitor aggregate route and schema blocks are contracted. */
    @Test
    void openApiContainsSessionMonitorRouteAndSchemaBlocks() throws Exception {
        Path contract = Path.of("..", "..", "docs", "api", "openapi.yaml");
        try (InputStream input = Files.newInputStream(contract)) {
            Map<?, ?> document = new Yaml().load(input);
            Map<?, ?> paths = (Map<?, ?>) document.get("paths");
            assertTrue(paths.containsKey("/api/v1/chat/sessions/{sessionId}/monitor"),
                    "session monitor route is contracted");

            Map<?, ?> schemas = (Map<?, ?>) ((Map<?, ?>) document.get("components")).get("schemas");
            Map<?, ?> monitor = (Map<?, ?>) schemas.get("SessionMonitorResponse");
            assertInstanceOf(Map.class, monitor, "SessionMonitorResponse schema is contracted");
            Map<?, ?> properties = (Map<?, ?>) monitor.get("properties");
            assertTrue(properties.containsKey("generatedAt"));
            assertTrue(properties.containsKey("session"));
            assertTrue(properties.containsKey("activity"));
            assertTrue(properties.containsKey("history"));
            assertTrue(properties.containsKey("readiness"));

            Map<?, ?> history = (Map<?, ?>) schemas.get("SessionMonitorHistory");
            assertInstanceOf(Map.class, history, "SessionMonitorHistory schema is contracted");
            Map<?, ?> historyProperties = (Map<?, ?>) history.get("properties");
            assertTrue(historyProperties.containsKey("windowSize"));
            assertTrue(historyProperties.containsKey("counts"));
            assertTrue(historyProperties.containsKey("recent"));

            Map<?, ?> readiness = (Map<?, ?>) schemas.get("SessionMonitorReadiness");
            assertInstanceOf(Map.class, readiness, "SessionMonitorReadiness schema is contracted");
            Map<?, ?> readinessProperties = (Map<?, ?>) readiness.get("properties");
            assertTrue(readinessProperties.containsKey("connection"));
            assertTrue(readinessProperties.containsKey("agent"));
            assertTrue(readinessProperties.containsKey("lastObservedRun"));
        }
    }

    @SuppressWarnings("unchecked")
    private static void assertSourceEnumContains(Map<?, ?> schemas, String schemaName) {
        Map<?, ?> schema = (Map<?, ?>) schemas.get(schemaName);
        assertInstanceOf(Map.class, schema, schemaName + " schema is contracted");
        Map<?, ?> properties = (Map<?, ?>) schema.get("properties");
        Map<?, ?> source = (Map<?, ?>) properties.get("source");
        List<Object> enumValues = (List<Object>) source.get("enum");
        assertTrue(enumValues.contains("scheduled"),
                schemaName + ".source enum must include scheduled (PLAN-0489 T1.3/T1.4)");
    }

    /** PLAN-0489 T1.5：workspace SSE 流登记 scheduled_tasks_changed 粗粒度失效事件。 */
    @Test
    void openApiWorkspaceEventStreamDocumentsScheduledTasksChangedKind() throws Exception {
        Path contract = Path.of("..", "..", "docs", "api", "openapi.yaml");
        try (InputStream input = Files.newInputStream(contract)) {
            Map<?, ?> document = new Yaml().load(input);
            Map<?, ?> paths = (Map<?, ?>) document.get("paths");
            Map<?, ?> events = (Map<?, ?>) paths.get("/api/v1/workspaces/{workspaceId}/events");
            assertInstanceOf(Map.class, events, "workspace event stream route is contracted");
            Map<?, ?> get = (Map<?, ?>) events.get("get");
            String description = String.valueOf(get.get("description"));
            assertTrue(description.contains("scheduled_tasks_changed"),
                    "workspace event stream must document the scheduled_tasks_changed invalidation kind");
            assertTrue(description.contains("scheduled-tasks"),
                    "scheduled_tasks_changed must point clients at the scheduled-tasks refetch route");
            String example = String.valueOf(((Map<?, ?>) ((Map<?, ?>) get.get("responses"))
                    .get("200")).get("content"));
            assertTrue(example.contains("scheduled_tasks_changed"),
                    "workspace event stream example must carry the scheduled_tasks_changed event");
        }
    }
}
