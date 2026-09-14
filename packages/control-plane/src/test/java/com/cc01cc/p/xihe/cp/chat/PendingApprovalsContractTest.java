package com.cc01cc.p.xihe.cp.chat;

import org.junit.jupiter.api.Test;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0328 M1 T1.16/T1.20 — route ↔ OpenAPI contract for the cross-session pending indicator
 * and the extended decision body. The route annotation is pinned here and the documented path
 * must stay in lockstep (spec/testing §2 "新端点 OpenAPI 同步").
 */
class PendingApprovalsContractTest {

    @Test
    void controllerRouteMatchesTheDocumentedPath() throws NoSuchMethodException {
        RequestMapping mapping = PendingApprovalsController.class.getAnnotation(RequestMapping.class);
        assertNotNull(mapping);
        assertEquals(List.of("/api/v1/approvals"), List.of(mapping.value()));

        GetMapping pending = PendingApprovalsController.class.getMethod("pending").getAnnotation(GetMapping.class);
        assertNotNull(pending);
        assertEquals(List.of("/pending"), List.of(pending.value()));
    }

    @Test
    void openApiDocumentsPendingIndicatorAndDecisionKinds() throws IOException {
        String yaml = Files.readString(openApiPath());

        assertTrue(yaml.contains("/api/v1/approvals/pending:"),
                "pending indicator path must be documented");
        assertTrue(yaml.contains("operationId: listPendingApprovals"));
        assertTrue(yaml.contains("PendingApprovalSummary"),
                "the response schema must be declared (counts only)");
        assertTrue(yaml.contains("ChatApprovalDecisionRequest"));
        assertTrue(yaml.contains("ChatApprovalGrantedRule"),
                "the granted-rule echo must be documented for the UI");
        assertTrue(yaml.contains("reject_always"), "the persistent deny kind must be documented");
        assertTrue(yaml.contains("feedback"), "rejection feedback must be documented");
        assertTrue(yaml.contains("AgentApprovalDecisionRequest"));
    }

    /** Resolves docs/api/openapi.yaml from the module working directory (surefire = module basedir). */
    private static Path openApiPath() {
        Path moduleRelative = Path.of("..", "..", "docs", "api", "openapi.yaml");
        if (Files.exists(moduleRelative)) {
            return moduleRelative;
        }
        Path repoRelative = Path.of("docs", "api", "openapi.yaml");
        if (Files.exists(repoRelative)) {
            return repoRelative;
        }
        throw new IllegalStateException(
                "openapi.yaml not found from working directory " + Path.of("").toAbsolutePath());
    }
}
