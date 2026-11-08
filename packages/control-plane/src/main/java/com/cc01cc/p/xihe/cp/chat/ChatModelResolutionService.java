package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.UUID;

/**
 * PLAN-0642 T2.1 (D42-03): the runtime model resolution chain for an unbound Session.
 *
 * <p>Steps 2-5 of the frozen six-step chain (step 1, the public {@code ChatRequest.provider/model}
 * legacy hint, is intentionally ignored in this MVP: B-3 — "does the public wire hint apply to an
 * unbound Session" — is still pending user ruling, so the conservative default keeps today's
 * behaviour, i.e. the hint never decides anything and no wire/OpenAPI semantics change):</p>
 * <ol>
 *   <li>Session explicit binding (four columns complete; admission already validated the revision);</li>
 *   <li>PRIMARY Agent principal {@code default_model_*};</li>
 *   <li>effective {@code llm-provider.profile} (workspace → user → instance via ConfigService);</li>
 *   <li>nothing resolved ⇒ 409 {@code LLM_NOT_CONFIGURED} (code reused per B-2 — no new code).</li>
 * </ol>
 *
 * <p>The result is written to {@code chat_runs} only; the Session's model columns are never written
 * back (D42-08 stop-write). Ambiguous multi-candidate connection resolution fails closed with the
 * same reused code instead of silently picking one.</p>
 */
@Service
public class ChatModelResolutionService {

    private static final Logger logger = LoggerFactory.getLogger(ChatModelResolutionService.class);

    /** The resolved model identity + connection pinned onto the Run. */
    public record Resolution(String provider, String model, String providerConnectionId,
                             Long connectionRevision, String source) {}

    private final AgentPrincipalService agentPrincipals;
    private final ConfigService configService;
    private final ApiRequestTemplateService apiRequestTemplates;

    public ChatModelResolutionService(AgentPrincipalService agentPrincipals,
                                      ConfigService configService,
                                      ApiRequestTemplateService apiRequestTemplates) {
        this.agentPrincipals = agentPrincipals;
        this.configService = configService;
        this.apiRequestTemplates = apiRequestTemplates;
    }

    /**
     * Resolve the model identity for one Run.
     *
     * @param session                 the locked Session row
     * @param primaryAgentPrincipalId the PRIMARY participant's agent principal (may be null)
     */
    public Resolution resolve(Session session, String primaryAgentPrincipalId) {
        // Step 2: the Session's explicit override wins when complete (admission validated it).
        if (ApiRequestTemplateService.isModelBindingComplete(session)) {
            return new Resolution(session.getModelProvider(), session.getModelName(),
                    session.getProviderConnectionId(), session.getConnectionRevision(), "session");
        }
        if (ApiRequestTemplateService.isModelBindingPartial(session)) {
            throw rebindRequired("Session model binding is incomplete; rebind or clear it");
        }

        // Step 3: the PRIMARY Agent principal's declared model intent.
        if (primaryAgentPrincipalId != null && !primaryAgentPrincipalId.isBlank()) {
            AgentPrincipalService.DefaultModel intent = null;
            try {
                intent = agentPrincipals.defaultModel(UUID.fromString(primaryAgentPrincipalId),
                        UUID.fromString(session.getWorkspaceId()));
            } catch (CpApiException notBound) {
                // A legacy PRIMARY without an active workspace binding has no intent; the chain
                // falls through to the profile layer instead of failing here.
                logger.debug("[LIFECYCLE] service=cp event=model_resolution_principal_skipped "
                        + "principalId={} code={}", primaryAgentPrincipalId, notBound.getCode());
            }
            if (intent != null && hasText(intent.provider()) && hasText(intent.model())) {
                ProviderConnection connection = uniqueConnection(session, intent.provider().trim());
                return new Resolution(intent.provider().trim(), intent.model().trim(),
                        connection.getId().toString(), connection.getRevision(), "agent-principal");
            }
        }

        // Step 4/5: effective llm-provider profile (workspace → user → instance).
        ConfigService.ResolvedLlmProfile profile =
                configService.resolveLlmProfile(UUID.fromString(session.getUserId()),
                        UUID.fromString(session.getWorkspaceId()));
        if (profile != null) {
            return new Resolution(profile.providerId(), profile.model(), profile.providerConnectionId(),
                    profile.connectionRevision(), "llm-profile");
        }

        // Step 6: nothing resolvable — the reused code (B-2), no new error code.
        throw new CpApiException(HttpStatus.CONFLICT, "LLM_NOT_CONFIGURED",
                "No model resolved: set a PRIMARY agent default model or an effective llm-provider profile");
    }

    /**
     * Step 3's connection half: the principal declares (provider, model) intent but never holds a
     * connection, so exactly one usable chat connection for that provider must exist. Zero or many
     * candidates fail closed with the reused {@code LLM_NOT_CONFIGURED} code (B-2) instead of
     * guessing an owner.
     */
    private ProviderConnection uniqueConnection(Session session, String provider) {
        List<ProviderConnection> candidates = apiRequestTemplates.effectiveConnections(
                session.getUserId(), session.getWorkspaceId(), provider);
        if (candidates.size() == 1) {
            return candidates.getFirst();
        }
        if (candidates.isEmpty()) {
            throw new CpApiException(HttpStatus.CONFLICT, "LLM_NOT_CONFIGURED",
                    "No usable chat connection for resolved provider '" + provider
                            + "'; configure a ready provider connection first");
        }
        throw new CpApiException(HttpStatus.CONFLICT, "LLM_NOT_CONFIGURED",
                "Multiple usable chat connections for resolved provider '" + provider
                        + "'; bind the Session explicitly to choose one");
    }

    private static CpApiException rebindRequired(String message) {
        return new CpApiException(HttpStatus.CONFLICT, "API_TYPE_REBIND_REQUIRED", message)
                .withExtra(java.util.Map.of("reason", "partial_binding"));
    }

    private static boolean hasText(String value) {
        return value != null && !value.isBlank();
    }
}
