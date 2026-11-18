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
 * G3-a C4: internal service-Bearer read mouth for the Agent's resume claim ("is my run
 * still waiting, and was it answered while I was away?"). Frozen shape:
 * spec/session/user-channel.md §5.2 minimisation applies — the question prompt never
 * appears on this mouth; only the envelope (state + answer) crosses, and only inside
 * the CP↔Agent trust domain.
 */
@RestController
@RequestMapping("/internal/v1/chat/runs/{runId}/user-questions")
public class UserQuestionInternalController {

    private final UserQuestionService service;

    public UserQuestionInternalController(UserQuestionService service) {
        this.service = service;
    }

    @GetMapping("/waiting")
    public ResponseEntity<?> waiting(@PathVariable String runId) {
        try {
            List<Map<String, Object>> items = service.agentWaitingRow(runId)
                    .map(view -> {
                        Map<String, Object> item = new LinkedHashMap<>();
                        item.put("questionId", view.questionId());
                        item.put("state", view.state());
                        if (view.answer() != null) {
                            item.put("answer", view.answer());
                        }
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
