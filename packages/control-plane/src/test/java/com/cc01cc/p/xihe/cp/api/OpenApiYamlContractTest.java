package com.cc01cc.p.xihe.cp.api;

import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
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

    /** PLAN-0508: per-Run transport attempts route/schemas + session channel events. */
    @Test
    void openApiContainsTransportAttemptRouteSchemasAndSessionEvents() throws Exception {
        Path contract = Path.of("..", "..", "docs", "api", "openapi.yaml");
        try (InputStream input = Files.newInputStream(contract)) {
            Map<?, ?> document = new Yaml().load(input);
            Map<?, ?> paths = (Map<?, ?>) document.get("paths");
            assertTrue(paths.containsKey("/api/v1/chat/runs/{runId}/attempts"),
                    "per-run transport attempts route is contracted");

            Map<?, ?> schemas = (Map<?, ?>) ((Map<?, ?>) document.get("components")).get("schemas");
            assertInstanceOf(Map.class, schemas.get("RunTransportAttemptsResponse"),
                    "RunTransportAttemptsResponse schema is contracted");
            assertInstanceOf(Map.class, schemas.get("ChatTransportAggregate"),
                    "ChatTransportAggregate schema is contracted");
            Map<?, ?> attempt = (Map<?, ?>) schemas.get("ChatTransportAttempt");
            assertInstanceOf(Map.class, attempt, "ChatTransportAttempt schema is contracted");
            Map<?, ?> attemptProperties = (Map<?, ?>) attempt.get("properties");
            assertTrue(attemptProperties.containsKey("lastProgressStage"),
                    "bounded stage sample is part of the attempt projection");
            assertTrue(attemptProperties.containsKey("lastProgressElapsedMs"));
            assertTrue(attemptProperties.containsKey("uploadBytes"));
            assertTrue(attemptProperties.containsKey("downloadBytes"));

            Map<?, ?> monitor = (Map<?, ?>) schemas.get("SessionMonitorResponse");
            Map<?, ?> monitorProperties = (Map<?, ?>) monitor.get("properties");
            assertTrue(monitorProperties.containsKey("transport"),
                    "session monitor response carries the transport aggregate");

            Map<?, ?> events = (Map<?, ?>) paths.get("/api/v1/events");
            assertInstanceOf(Map.class, events, "session event stream route is contracted");
            Map<?, ?> get = (Map<?, ?>) events.get("get");
            String description = String.valueOf(get.get("description"));
            assertTrue(description.contains("transport_progress"),
                    "session channel must document transport_progress");
            assertTrue(description.contains("transport_attempt"),
                    "session channel must document transport_attempt");
            String example = String.valueOf(((Map<?, ?>) ((Map<?, ?>) get.get("responses"))
                    .get("200")).get("content"));
            assertTrue(example.contains("transport_progress"),
                    "session stream example must carry a transport_progress event");
            assertTrue(example.contains("transport_attempt"),
                    "session stream example must carry a transport_attempt event");
        }
    }

    /** PLAN-0497 T3.1/T3.2（wave review 补齐）：reveal 与 events 读面同批入契约。 */
    @Test
    void openApiContainsCredentialDeliveryRoutesAndSchemas() throws Exception {
        Path contract = Path.of("..", "..", "docs", "api", "openapi.yaml");
        try (InputStream input = Files.newInputStream(contract)) {
            Map<?, ?> document = new Yaml().load(input);
            Map<?, ?> paths = (Map<?, ?>) document.get("paths");
            assertTrue(paths.containsKey("/api/v1/credentials/{id}/reveal"),
                    "reveal route is contracted");
            assertTrue(paths.containsKey("/api/v1/credentials/{id}/events"),
                    "events read route is contracted");

            Map<?, ?> schemas = (Map<?, ?>) ((Map<?, ?>) document.get("components")).get("schemas");
            assertTrue(schemas.containsKey("CredentialRevealRequest"),
                    "CredentialRevealRequest schema is contracted");
            assertTrue(schemas.containsKey("CredentialRevealView"),
                    "CredentialRevealView schema is contracted");
            assertTrue(schemas.containsKey("CredentialEventsView"),
                    "CredentialEventsView schema is contracted");
        }
    }

    /** PLAN-0505 T1.1：delete-impact 读面与 CONNECTION_IN_USE 409 契约入 OpenAPI。 */
    @Test
    void openApiContainsDeleteImpactRouteAndBlockedDeleteContract() throws Exception {
        Path contract = Path.of("..", "..", "docs", "api", "openapi.yaml");
        try (InputStream input = Files.newInputStream(contract)) {
            Map<?, ?> document = new Yaml().load(input);
            Map<?, ?> paths = (Map<?, ?>) document.get("paths");
            assertTrue(paths.containsKey("/api/v1/provider-connections/{connectionId}/delete-impact"),
                    "delete-impact route is contracted");

            Map<?, ?> delete = (Map<?, ?>) paths.get("/api/v1/provider-connections/{connectionId}");
            assertInstanceOf(Map.class, delete, "provider connection item route is contracted");
            Map<?, ?> deleteMethod = (Map<?, ?>) delete.get("delete");
            assertInstanceOf(Map.class, deleteMethod, "DELETE method is contracted");
            Map<?, ?> responses = (Map<?, ?>) deleteMethod.get("responses");
            assertTrue(responses.containsKey("409"),
                    "DELETE must contract the CONNECTION_IN_USE 409 response");

            Map<?, ?> schemas = (Map<?, ?>) ((Map<?, ?>) document.get("components")).get("schemas");
            Map<?, ?> impact = (Map<?, ?>) schemas.get("DeleteImpactView");
            assertInstanceOf(Map.class, impact, "DeleteImpactView schema is contracted");
            Map<?, ?> properties = (Map<?, ?>) impact.get("properties");
            for (String field : List.of("bindingCount", "bindingUserScopes", "defaultTemplateRef",
                    "profileCount", "profileScopes", "sessionCount", "blocked")) {
                assertTrue(properties.containsKey(field),
                        "DeleteImpactView must carry " + field);
            }
            assertTrue(schemas.containsKey("ConnectionInUseProblem"),
                    "ConnectionInUseProblem schema is contracted");
        }
    }

    /** PLAN-0565：members API 面与账号标识 schema 同批入契约（T1.1/T1.0）。 */
    @Test
    void openApiContainsMemberRoutesAndAccountIdentifierSchemas() throws Exception {
        Path contract = Path.of("..", "..", "docs", "api", "openapi.yaml");
        try (InputStream input = Files.newInputStream(contract)) {
            Map<?, ?> document = new Yaml().load(input);
            Map<?, ?> paths = (Map<?, ?>) document.get("paths");
            String base = "/api/v1/workspaces/{workspaceId}/members";
            assertTrue(paths.containsKey(base), "members collection route is contracted");
            assertTrue(paths.containsKey(base + "/{userId}"), "members item route is contracted");

            Map<?, ?> collection = (Map<?, ?>) paths.get(base);
            assertInstanceOf(Map.class, collection, "members collection methods are contracted");
            assertTrue(collection.containsKey("get"), "member list is contracted");
            assertTrue(collection.containsKey("post"), "member add is contracted");
            Map<?, ?> item = (Map<?, ?>) paths.get(base + "/{userId}");
            assertInstanceOf(Map.class, item, "members item methods are contracted");
            assertTrue(item.containsKey("patch"), "member role update is contracted");
            assertTrue(item.containsKey("delete"), "member removal is contracted");

            Map<?, ?> schemas = (Map<?, ?>) ((Map<?, ?>) document.get("components")).get("schemas");
            Map<?, ?> memberView = (Map<?, ?>) schemas.get("MemberView");
            assertInstanceOf(Map.class, memberView, "MemberView schema is contracted");
            Map<?, ?> properties = (Map<?, ?>) memberView.get("properties");
            for (String field : List.of("userId", "username", "email", "name", "role", "createdAt")) {
                assertTrue(properties.containsKey(field), "MemberView must carry " + field);
            }
            assertTrue(schemas.containsKey("MemberAddRequest"), "MemberAddRequest schema is contracted");
            assertTrue(schemas.containsKey("MemberRoleUpdateRequest"),
                    "MemberRoleUpdateRequest schema is contracted");

            Map<?, ?> register = (Map<?, ?>) schemas.get("RegisterRequest");
            assertInstanceOf(Map.class, register, "RegisterRequest schema is contracted");
            assertTrue(((Map<?, ?>) register.get("properties")).containsKey("username"),
                    "RegisterRequest must carry the optional username (ruling #7)");
            Map<?, ?> login = (Map<?, ?>) schemas.get("LoginRequest");
            assertInstanceOf(Map.class, login, "LoginRequest schema is contracted");
            assertTrue(((Map<?, ?>) login.get("properties")).containsKey("identifier"),
                    "LoginRequest must carry the dual identifier (ruling #7)");
        }
    }

    /**
     * PLAN-0580 T3.1 / round-1 F13: the instance-ownership surface must be
     * contracted in the same wave as the implementation — two path entries
     * (three operations), the owner view (no account identifiers) and the role
     * enum on both request and response sides.
     */
    @Test
    void openApiContainsInstanceOwnershipRoutesAndRoleSchemas() throws Exception {
        Path contract = Path.of("..", "..", "docs", "api", "openapi.yaml");
        try (InputStream input = Files.newInputStream(contract)) {
            Map<?, ?> parsed = new Yaml().load(input);
            assertInstanceOf(Map.class, parsed);
            Map<?, ?> document = (Map<?, ?>) parsed;
            Map<?, ?> paths = (Map<?, ?>) document.get("paths");
            assertTrue(paths.containsKey("/api/v1/instance/owner"),
                    "GET/PUT /api/v1/instance/owner is contracted");
            // PLAN-0610 W3-2b: the legacy role route and its schemas are retired with users.role.
            assertFalse(paths.containsKey("/api/v1/users/{userId}/role"),
                    "PATCH /api/v1/users/{userId}/role is retired");
            assertTrue(paths.containsKey("/api/v1/me/permissions"),
                    "the self-service capability summary is contracted");

            Map<?, ?> ownerPath = (Map<?, ?>) paths.get("/api/v1/instance/owner");
            assertTrue(ownerPath.containsKey("get"), "owner read is contracted");
            assertTrue(ownerPath.containsKey("put"), "owner transfer is contracted");
            Map<?, ?> mePath = (Map<?, ?>) paths.get("/api/v1/me/permissions");
            assertTrue(mePath.containsKey("get"), "me/permissions read is contracted");

            Map<?, ?> schemas = (Map<?, ?>) ((Map<?, ?>) document.get("components")).get("schemas");
            Map<?, ?> ownerView = (Map<?, ?>) schemas.get("InstanceOwnerView");
            assertInstanceOf(Map.class, ownerView, "InstanceOwnerView schema is contracted");
            Map<?, ?> ownerProps = (Map<?, ?>) ownerView.get("properties");
            for (String field : List.of("ownerUserId", "assignedAt", "isCurrentUser")) {
                assertTrue(ownerProps.containsKey(field), "InstanceOwnerView must carry " + field);
            }
            for (String forbidden : List.of("username", "email", "name")) {
                assertTrue(!ownerProps.containsKey(forbidden),
                        "InstanceOwnerView must not expose " + forbidden + " (account enumeration)");
            }

            // PLAN-0610 W3-2b: the per-role wire schemas are retired; the capability projection is
            // the contracted replacement on UserAdminView and /auth/me.
            assertFalse(schemas.containsKey("UserRoleChangeRequest"),
                    "UserRoleChangeRequest schema is retired");
            assertFalse(schemas.containsKey("UserRoleView"),
                    "UserRoleView schema is retired");
            assertTrue(schemas.containsKey("UserCapabilities"),
                    "UserCapabilities schema is contracted");
            assertTrue(schemas.containsKey("InstanceOwnerTransferRequest"),
                    "InstanceOwnerTransferRequest schema is contracted");
        }
    }

    /**
     * PLAN-0581 T3.1 / verify V9: the user-management surface must be contracted in
     * the same wave as the implementation — six {@code /api/v1/users*} operations,
     * the admin view without credential/epoch columns, the status enum and the
     * closed-registration error code.
     */
    @Test
    void openApiContainsUserManagementRoutesAndRegistrationPolicyCode() throws Exception {
        Path contract = Path.of("..", "..", "docs", "api", "openapi.yaml");
        try (InputStream input = Files.newInputStream(contract)) {
            Map<?, ?> document = new Yaml().load(input);
            Map<?, ?> paths = (Map<?, ?>) document.get("paths");
            assertTrue(paths.containsKey("/api/v1/users"), "collection route is contracted");
            assertTrue(paths.containsKey("/api/v1/users/{userId}"), "detail/delete route is contracted");
            assertTrue(paths.containsKey("/api/v1/users/{userId}/status"), "status route is contracted");
            assertTrue(paths.containsKey("/api/v1/users/{userId}/password-reset"),
                    "password-reset route is contracted");
            // PLAN-0610 W3-2b: elevation is a role-binding write; the account role route is gone.
            assertFalse(paths.containsKey("/api/v1/users/{userId}/role"),
                    "the 0580 role route is retired");

            Map<?, ?> collection = (Map<?, ?>) paths.get("/api/v1/users");
            assertTrue(collection.containsKey("get"), "list is contracted");
            assertTrue(collection.containsKey("post"), "admin create is contracted");
            Map<?, ?> detail = (Map<?, ?>) paths.get("/api/v1/users/{userId}");
            assertTrue(detail.containsKey("get"), "detail is contracted");
            assertTrue(detail.containsKey("delete"), "soft delete is contracted");
            assertTrue(((Map<?, ?>) paths.get("/api/v1/users/{userId}/status")).containsKey("patch"));
            assertTrue(((Map<?, ?>) paths.get("/api/v1/users/{userId}/password-reset")).containsKey("post"));

            Map<?, ?> schemas = (Map<?, ?>) ((Map<?, ?>) document.get("components")).get("schemas");
            Map<?, ?> adminView = (Map<?, ?>) schemas.get("UserAdminView");
            assertInstanceOf(Map.class, adminView, "UserAdminView schema is contracted");
            Map<?, ?> viewProps = (Map<?, ?>) adminView.get("properties");
            for (String field : List.of("id", "email", "username", "name", "capabilities", "status",
                    "deletedAt", "createdAt")) {
                assertTrue(viewProps.containsKey(field), "UserAdminView must carry " + field);
            }
            assertFalse(viewProps.containsKey("role"),
                    "PLAN-0610 W3-2b: UserAdminView no longer exposes the legacy role string");
            for (String forbidden : List.of("passwordHash", "tokenVersion", "sessionVersion")) {
                assertTrue(!viewProps.containsKey(forbidden),
                        "UserAdminView must not expose " + forbidden);
            }
            String statusSchema = String.valueOf(
                    ((Map<?, ?>) ((Map<?, ?>) schemas.get("UserStatusRequest")).get("properties")).get("status"));
            assertTrue(statusSchema.contains("ACTIVE") && statusSchema.contains("DISABLED"),
                    "status enum is contracted: " + statusSchema);
            assertTrue(schemas.containsKey("UserAdminPage"), "UserAdminPage schema is contracted");
            assertTrue(schemas.containsKey("UserCreateRequest"), "UserCreateRequest schema is contracted");
            assertTrue(schemas.containsKey("UserCreatedResponse"), "UserCreatedResponse schema is contracted");
            assertTrue(schemas.containsKey("UserPasswordResetResponse"),
                    "UserPasswordResetResponse schema is contracted");
        }
    }

    /**
     * PLAN-0608 (C′): the workspace-addressed session creation route and its two new
     * workspace-context error codes must be contracted, not just described in prose.
     *
     * <p>Why this test exists: the 0608 verify pass found <b>zero</b> test hits for
     * {@code WORKSPACE_CONTEXT_CONFLICT} / {@code WORKSPACE_CONTEXT_REQUIRED} — the
     * route and both codes were written into the OpenAPI document while nothing
     * asserted them. This is the "documented but untested" gap in contract form.
     *
     * <p>Scope notes (deliberate, do not "fix" here):
     * <ul>
     *   <li>Both codes live in the operation's {@code description} because every
     *       error response is a bare {@code $ref} to the shared {@code Problem}
     *       response — so the assertion targets the description text, which is where
     *       the document actually names them.</li>
     *   <li>The legacy {@code POST /api/v1/sessions} declares a {@code 409} response
     *       but does not repeat the code in its own body; the code is named on the new
     *       route's description instead. The test therefore pins "409 is declared on
     *       the legacy operation" + "WORKSPACE_CONTEXT_REQUIRED is named in the
     *       document" rather than inventing a claim the file does not make.</li>
     *   <li>{@code WORKSPACE_READ_ONLY} is <b>not</b> restated on the new route (its
     *       403 is the shared {@code $ref}); it is asserted at document level
     *       (workspace-context preamble) so a rename/removal still fails this test.</li>
     * </ul>
     */
    @Test
    void openApiContainsWorkspaceAddressedSessionRouteAndContextErrorCodes() throws Exception {
        Path contract = Path.of("..", "..", "docs", "api", "openapi.yaml");
        String raw = Files.readString(contract);
        try (InputStream input = Files.newInputStream(contract)) {
            Object parsed = new Yaml().load(input);
            assertInstanceOf(Map.class, parsed);
            Map<?, ?> document = (Map<?, ?>) parsed;
            Map<?, ?> paths = (Map<?, ?>) document.get("paths");

            // 1–2: the path and the operation exist.
            assertTrue(paths.containsKey("/api/v1/workspaces/{workspaceId}/sessions"),
                    "workspace-addressed session creation is contracted");
            Map<?, ?> pathItem = (Map<?, ?>) paths.get("/api/v1/workspaces/{workspaceId}/sessions");
            assertTrue(pathItem.containsKey("post"), "the create operation is contracted");

            // 3: operationId is the stable handle clients/tests refer to.
            Map<?, ?> post = (Map<?, ?>) pathItem.get("post");
            assertEquals("createWorkspaceSession", post.get("operationId"),
                    "operationId is the one the implementation registers");

            // 4–7: the four documented outcomes (201 created; 400/401/403 failures).
            Map<?, ?> responses = (Map<?, ?>) post.get("responses");
            assertInstanceOf(Map.class, responses, "responses are contracted");
            for (String status : List.of("201", "400", "401", "403")) {
                assertTrue(responses.containsKey(status),
                        "the operation must contract " + status + ", got " + responses.keySet());
            }

            // 8 (reverse, PLAN-0608 R3): the create surface never produces 404 — a
            // missing workspace or a non-member is a 403 WORKSPACE_FORBIDDEN via
            // requireContextWorkspace, and session lookup happens after creation. The
            // contract therefore MUST NOT declare 404: a status code that can never
            // happen makes clients write dead error branches, which is worse than an
            // under-specified contract. This assertion is the regression net for that
            // rule (see spec/session-workspace-contract.md: "创建面不产生 404").
            assertFalse(responses.containsKey("404"),
                    "the create operation must not declare 404 (it is unreachable), got "
                            + responses.keySet());

            // 9: the path parameter is the ownership source (PLAN-0608 C′).
            List<?> parameters = (List<?>) post.get("parameters");
            boolean workspacePathParam = parameters.stream().anyMatch(parameter -> {
                Map<?, ?> entry = (Map<?, ?>) parameter;
                return "path".equals(entry.get("in")) && "workspaceId".equals(entry.get("name"));
            });
            assertTrue(workspacePathParam, "workspaceId must be a required path parameter");

            // 10–11: both new workspace-context codes are named in the contract text.
            String description = String.valueOf(post.get("description"));
            assertTrue(description.contains("WORKSPACE_CONTEXT_CONFLICT"),
                    "400 WORKSPACE_CONTEXT_CONFLICT must be named on the new route: " + description);
            assertTrue(description.contains("WORKSPACE_CONTEXT_REQUIRED"),
                    "409 WORKSPACE_CONTEXT_REQUIRED must be named in the document: " + description);

            // 12: the legacy route keeps its explicit 409 (the fallback path's contract).
            Map<?, ?> legacyPath = (Map<?, ?>) paths.get("/api/v1/sessions");
            assertInstanceOf(Map.class, legacyPath, "the legacy sessions path is still contracted");
            Map<?, ?> legacyPost = (Map<?, ?>) legacyPath.get("post");
            assertInstanceOf(Map.class, legacyPost, "the legacy create operation is still contracted");
            Map<?, ?> legacyResponses = (Map<?, ?>) legacyPost.get("responses");
            assertTrue(legacyResponses.containsKey("409"),
                    "the legacy create operation must declare the 409 fallback, got " + legacyResponses.keySet());

            // 13: the write-guard code is still defined at document level.
            assertTrue(raw.contains("WORKSPACE_READ_ONLY"),
                    "WORKSPACE_READ_ONLY must stay documented (write guard contract)");

            // 14: the 403 entry names BOTH codes, like every other workspace-scoped
            // operation in this document (openapi.yaml:131/150/173). A bare $ref here
            // would leave a reader unable to tell "not a member" (WORKSPACE_FORBIDDEN)
            // from "VIEWER write" (WORKSPACE_READ_ONLY) — the inconsistency the review
            // flagged.
            Map<?, ?> forbidden = (Map<?, ?>) responses.get("403");
            assertInstanceOf(Map.class, forbidden, "the 403 response is contracted");
            String forbiddenText = String.valueOf(forbidden.get("description"));
            assertTrue(forbiddenText.contains("WORKSPACE_FORBIDDEN") && forbiddenText.contains("WORKSPACE_READ_ONLY"),
                    "403 must name both WORKSPACE_FORBIDDEN and WORKSPACE_READ_ONLY: " + forbiddenText);
        }
    }

    /**
     * PLAN-0622 M0.1/T0.4: the agent-principal three-tier scope, the merged workspace-agent list,
     * the provider-connection resource limits and the {@code RESOURCE_EXHAUSTED} 429 shape are
     * contracted in the same wave as the implementation (contract frozen in task-46 §2; the field
     * names below are shared with the CLI and UI tracks and must not be renamed).
     */
    @Test
    void openApiContainsAgentPrincipalScopeAndResourceGovernorContracts() throws Exception {
        Path contract = Path.of("..", "..", "docs", "api", "openapi.yaml");
        String raw = Files.readString(contract);
        try (InputStream input = Files.newInputStream(contract)) {
            Map<?, ?> document = (Map<?, ?>) new Yaml().load(input);
            Map<?, ?> paths = (Map<?, ?>) document.get("paths");
            Map<?, ?> schemas = (Map<?, ?>) ((Map<?, ?>) document.get("components")).get("schemas");
            Map<?, ?> responses = (Map<?, ?>) ((Map<?, ?>) document.get("components")).get("responses");

            // 1: create + scoped list + disable routes.
            Map<?, ?> principals = (Map<?, ?>) paths.get("/api/v1/agent-principals");
            assertInstanceOf(Map.class, principals, "agent-principals collection is contracted");
            assertTrue(principals.containsKey("post"), "create is contracted");
            assertTrue(principals.containsKey("get"), "the scoped list is contracted (M1.2)");
            List<?> listParams = (List<?>) ((Map<?, ?>) principals.get("get")).get("parameters");
            for (String name : List.of("scope", "workspaceId")) {
                assertTrue(listParams.stream().anyMatch(candidate -> "query".equals(((Map<?, ?>) candidate).get("in"))
                                && name.equals(((Map<?, ?>) candidate).get("name"))),
                        "scoped list must carry the " + name + " query parameter");
            }
            Map<?, ?> disable = (Map<?, ?>) paths.get("/api/v1/agent-principals/{principalId}/disable");
            assertInstanceOf(Map.class, disable, "disable route is contracted");
            Map<?, ?> disableResponses = (Map<?, ?>) ((Map<?, ?>) disable.get("post")).get("responses");
            assertTrue(disableResponses.containsKey("204"), "disable answers 204");

            // 1b (PLAN-0625 M2 / Gap K + PLAN-0629 M1 / D29-21): the subject-document update surface
            // is contracted — no /hooks or /context-policy sub-resource, the principal's own PATCH
            // carries both documents.
            Map<?, ?> principalUpdate = (Map<?, ?>) paths.get("/api/v1/agent-principals/{principalId}");
            assertInstanceOf(Map.class, principalUpdate, "the principal update surface is contracted");
            assertInstanceOf(Map.class, principalUpdate.get("patch"),
                    "PATCH /api/v1/agent-principals/{principalId} carries the subject documents");
            Map<?, ?> updateBody = (Map<?, ?>) schemas.get("AgentPrincipalUpdateRequest");
            assertInstanceOf(Map.class, updateBody, "AgentPrincipalUpdateRequest is contracted");
            assertEquals(Boolean.FALSE, updateBody.get("additionalProperties"),
                    "D25-14/D29-21: only hooks/contextPolicy are accepted; any other key is a 400");
            assertEquals(1, updateBody.get("minProperties"),
                    "at least one document must be named (an empty PATCH body is a 400)");
            Map<?, ?> documentProps = (Map<?, ?>) updateBody.get("properties");
            for (String field : List.of("hooks", "contextPolicy")) {
                assertTrue(documentProps.containsKey(field), "the update body must carry " + field);
            }
            Map<?, ?> updateViewProps = (Map<?, ?>) ((Map<?, ?>) schemas.get("AgentPrincipalUpdateView"))
                    .get("properties");
            for (String field : List.of("principalId", "hooks", "contextPolicy")) {
                assertTrue(updateViewProps.containsKey(field), "the update view must echo " + field);
            }
            assertTrue(raw.contains("GUARD_HOOKS_IMMUTABLE"),
                    "the preset-guard refusal code is named on the wire contract");
            assertTrue(raw.contains("writeMode judge is not implemented in v1")
                            || raw.contains("judge` is reserved for M2"),
                    "the v1-reserved writeMode value is documented");

            // 2: the create request carries the frozen scope / model-intent fields.
            Map<?, ?> createProps = (Map<?, ?>) ((Map<?, ?>) schemas.get("AgentPrincipalCreateRequest"))
                    .get("properties");
            for (String field : List.of("name", "templateId", "scope", "defaultModelProvider",
                    "defaultModelName", "allowedModels")) {
                assertTrue(createProps.containsKey(field), "create request must carry " + field);
            }

            // 3: both principal views carry scope/owner/model intent with the three-tier enum.
            for (String schemaName : List.of("AgentPrincipalCreateView", "AgentPrincipalView")) {
                Map<?, ?> view = (Map<?, ?>) schemas.get(schemaName);
                assertInstanceOf(Map.class, view, schemaName + " is contracted");
                Map<?, ?> properties = (Map<?, ?>) view.get("properties");
                for (String field : List.of("principalId", "scope", "ownerUserId", "defaultModelProvider",
                        "defaultModelName", "allowedModels")) {
                    assertTrue(properties.containsKey(field), schemaName + " must carry " + field);
                }
                String scope = String.valueOf(properties.get("scope"));
                assertTrue(scope.contains("PERSONAL") && scope.contains("WORKSPACE") && scope.contains("INSTANCE"),
                        schemaName + ".scope must be the three tiers: " + scope);
            }

            // 4: the workspace agent list is a three-source envelope carrying source + the snapshot.
            Map<?, ?> list = (Map<?, ?>) schemas.get("WorkspaceAgentListResponse");
            assertInstanceOf(Map.class, list, "WorkspaceAgentListResponse is contracted");
            assertTrue(((Map<?, ?>) list.get("properties")).containsKey("agents"),
                    "the list is delivered as {agents:[...]}");
            Map<?, ?> agentProps = (Map<?, ?>) ((Map<?, ?>) schemas.get("WorkspaceAgentView")).get("properties");
            for (String field : List.of("principalId", "name", "templateId", "templateName", "createdAt",
                    "source", "permissionsSnapshot")) {
                assertTrue(agentProps.containsKey(field), "WorkspaceAgentView must carry " + field);
            }
            String source = String.valueOf(agentProps.get("source"));
            assertTrue(source.contains("workspace") && source.contains("personal") && source.contains("instance"),
                    "WorkspaceAgentView.source must be the three tiers: " + source);

            // 5: connection-level and model-level resource limits.
            Map<?, ?> updateProps = (Map<?, ?>) ((Map<?, ?>) schemas.get("ProviderConnectionUpdateRequest"))
                    .get("properties");
            Map<?, ?> connectionProps = (Map<?, ?>) ((Map<?, ?>) schemas.get("ProviderConnection"))
                    .get("properties");
            for (String field : List.of("maxInflight", "maxQueue", "windowTokenBudget", "windowSeconds",
                    "modelLimits")) {
                assertTrue(updateProps.containsKey(field), "connection update must carry " + field);
                assertTrue(connectionProps.containsKey(field), "ProviderConnection must carry " + field);
            }
            Map<?, ?> modelLimitProps = (Map<?, ?>) ((Map<?, ?>) schemas.get("ModelLimit")).get("properties");
            for (String field : List.of("provider", "model", "maxInflight", "windowTokenBudget",
                    "windowSeconds")) {
                assertTrue(modelLimitProps.containsKey(field), "ModelLimit must carry " + field);
            }

            // 6: RESOURCE_EXHAUSTED 429 (Retry-After) is one shared response and the lease path declares it.
            Map<?, ?> exhausted = (Map<?, ?>) responses.get("ResourceExhausted");
            assertInstanceOf(Map.class, exhausted, "ResourceExhausted response is contracted");
            assertTrue(((Map<?, ?>) exhausted.get("headers")).containsKey("Retry-After"),
                    "RESOURCE_EXHAUSTED carries Retry-After");
            assertTrue(String.valueOf(schemas.get("ResourceExhaustedProblem")).contains("RESOURCE_EXHAUSTED"),
                    "the 429 body names the RESOURCE_EXHAUSTED code");
            Map<?, ?> leasePost = (Map<?, ?>) ((Map<?, ?>) paths.get("/internal/v1/provider-leases/redeem")).get("post");
            assertTrue(((Map<?, ?>) leasePost.get("responses")).containsKey("429"),
                    "the lease admission path declares the 429 refusal");

            // 7: the new user-tier action is named in the contract text.
            assertTrue(raw.contains("CREATE_OWN_AGENT"), "CREATE_OWN_AGENT must be named in the contract");
        }
    }
}
