package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/sessions")
public class SessionController {
    private final SessionRepository sessions;

    public SessionController(SessionRepository sessions) {
        this.sessions = sessions;
    }

    @GetMapping
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public Map<String, List<Map<String, String>>> list() {
        String userId = TenantContext.getUserId();
        List<Map<String, String>> items = sessions.findByUserIdAndArchivedFalseOrderByCreatedAtDesc(userId)
                .stream()
                .map(session -> Map.of("id", session.getId(), "title", session.getTitle()))
                .toList();
        return Map.of("sessions", items);
    }

    @PostMapping
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<Map<String, String>> create(@RequestBody(required = false) CreateSessionRequest request) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        Session session = new Session(
                workspaceId == null ? "default" : workspaceId,
                userId,
                request == null || request.title() == null ? "Untitled" : request.title());
        session.setId(UUID.randomUUID().toString());
        sessions.save(session);
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(Map.of("id", session.getId(), "title", session.getTitle()));
    }

    @DeleteMapping("/{sessionId}")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<Void> delete(@PathVariable String sessionId) {
        sessions.findById(sessionId).ifPresent(session -> {
            if (session.getUserId().equals(TenantContext.getUserId())) {
                sessions.delete(session);
            }
        });
        return ResponseEntity.noContent().build();
    }

    public record CreateSessionRequest(String title) {}
}
