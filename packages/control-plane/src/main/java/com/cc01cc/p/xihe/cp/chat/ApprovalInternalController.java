package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * G3-a C4-approval (task-188 D-1834): internal service-Bearer read mouth for the Agent's
 * approval resume claim. Frozen shape mirrors the user-question mouth: {@code {runId, items[]}}
 * with zero or one item of {@code {requestId, state, expiresAt?}} — omitted-never-null keys.
 *
 * <p>Deliberate C5/D-1820 non-symmetry: this mouth reads the waiting fact and NEVER consumes
 * it — reading an approved/rejected row leaves the row (and {@code grant_consumed_at}) untouched.
 * Only an overdue pending row is lazily settled to expired (in the DB), same as the
 * user-question mouth.</p>
 */
@RestController
@RequestMapping("/internal/v1/chat/runs/{runId}/approval")
public class ApprovalInternalController {

    private final ApprovalService approvalService;

    public ApprovalInternalController(ApprovalService approvalService) {
        this.approvalService = approvalService;
    }

    @GetMapping("/waiting")
    public ResponseEntity<?> waiting(@PathVariable String runId) {
        try {
            List<Map<String, Object>> items = approvalService.agentWaitingRow(runId)
                    .map(view -> {
                        Map<String, Object> item = new LinkedHashMap<>();
                        item.put("requestId", view.requestId());
                        item.put("state", view.state());
                        if (view.expiresAt() != null) {
                            item.put("expiresAt", view.expiresAt().toString());
                        }
                        return item;
                    })
                    .map(List::of)
                    .orElse(List.of());
            return ResponseEntity.ok(Map.of("runId", runId, "items", items));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }
}
