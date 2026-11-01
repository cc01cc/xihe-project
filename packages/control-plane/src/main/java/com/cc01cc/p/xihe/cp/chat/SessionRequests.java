package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.service.ContextTemplateService;
import org.springframework.http.HttpStatus;

/**
 * PLAN-0615 (BL-179 A1/A2): the session-creation request mapping shared by
 * {@link SessionController} and {@link WorkspaceSessionController}.
 *
 * <p>It used to live on {@code SessionController}, which made the path-addressed controller depend on
 * another controller just to parse a body. Parsing is a conversion, not a reception duty, so it lives
 * here; both controllers call it. Deliberately a plain class, not a service (decision #1: two pure
 * functions do not justify a bean).</p>
 */
public final class SessionRequests {

    private SessionRequests() {
    }

    public record CreateSessionRequest(String title, String modelProvider, String modelName,
                                       String providerConnectionId, String agentPrincipalId,
                                       String contextTemplateLayer, String contextTemplateId,
                                       Integer contextTemplateVersion) {}

    /** PLAN-0608: shared request mapping for both creation surfaces. */
    public static SessionCreationService.Params paramsFrom(CreateSessionRequest request) {
        if (request == null) {
            return new SessionCreationService.Params(null, null, null, null, null, null);
        }
        return new SessionCreationService.Params(request.title(), request.modelProvider(), request.modelName(),
                request.providerConnectionId(), request.agentPrincipalId(), templateSelection(request));
    }

    private static ContextTemplateService.TemplateSelection templateSelection(CreateSessionRequest request) {
        if (request == null) {
            return null;
        }
        boolean any = request.contextTemplateLayer() != null || request.contextTemplateId() != null
                || request.contextTemplateVersion() != null;
        if (!any) {
            return null;
        }
        if (request.contextTemplateLayer() == null || request.contextTemplateId() == null
                || request.contextTemplateVersion() == null) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "contextTemplateLayer, contextTemplateId and contextTemplateVersion must be provided together");
        }
        return new ContextTemplateService.TemplateSelection(request.contextTemplateLayer(),
                request.contextTemplateId(), request.contextTemplateVersion());
    }
}
