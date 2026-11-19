package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * task-106 (user ruling 2026-11-20 00:28, option A): which agent a Session gets when the caller does
 * not name one.
 *
 * <p>The chain, highest priority first — the same D-928 order {@link ConfigService#resolve} uses, so
 * this key behaves like every other config key (env &gt; administrator lock &gt; workspace &gt;
 * workspace-default &gt; user &gt; instance):</p>
 *
 * <ol>
 *   <li><b>env</b> — {@code AGENT_RUNTIME_DEFAULTAGENTPRINCIPALID}-style override;</li>
 *   <li><b>administrator lock</b> — a pinned instance value ends the chain exactly as it does in
 *       {@code ConfigService.resolve};</li>
 *   <li><b>workspace default binding</b> — {@code workspace_agents.is_default} (V177), the answer the
 *       users actually pick in the UI;</li>
 *   <li><b>workspace</b> / <b>workspace-default</b> / <b>user</b> / <b>instance</b> layers of
 *       {@code agent-runtime.defaultAgentPrincipalId};</li>
 * </ol>
 *
 * <p>Two boundaries that are deliberate:</p>
 * <ul>
 *   <li>a workspace-less Session skips the three workspace-scoped sources (D-687: there is no
 *       workspace context to resolve from);</li>
 *   <li>every candidate is re-validated ({@link AgentPrincipalService#isSessionAgentUsable}) before it
 *       is returned: a stale or disabled principal is skipped with a WARN and the chain continues —
 *       same rule as {@link WorkspacelessDefaultRoster} ("a default must never block creating a
 *       session"). Only when nothing usable exists does the create fail, and it fails with the
 *       actionable message below rather than the old bare "agentPrincipalId is required".</li>
 * </ul>
 */
@Service
public class SessionAgentDefaults {

    /** D-928 config domain that owns the key (same domain as {@code defaultParticipants}). */
    public static final String DOMAIN = "agent-runtime";

    /** task-106: the config key the chain reads when no workspace default binding is set. */
    public static final String KEY = "defaultAgentPrincipalId";

    private static final Logger logger = LoggerFactory.getLogger(SessionAgentDefaults.class);

    private final ConfigService configService;
    private final AgentPrincipalService agentPrincipalService;

    public SessionAgentDefaults(ConfigService configService, AgentPrincipalService agentPrincipalService) {
        this.configService = configService;
        this.agentPrincipalService = agentPrincipalService;
    }

    /**
     * Resolve the agent for a Session that did not name one.
     *
     * @return the usable principal id as text (the wire/id shape the callers already carry)
     * @throws CpApiException 400 {@code INVALID_REQUEST} when every source is empty or unusable
     */
    @Transactional(readOnly = true)
    public String resolve(String userId, String workspaceId) {
        UUID userUuid = hasText(userId) ? uuid(userId) : null;
        UUID workspaceUuid = hasText(workspaceId) ? uuid(workspaceId) : null;
        for (Candidate candidate : candidates(userUuid, workspaceUuid)) {
            String raw = candidate.value();
            if (!hasText(raw)) {
                continue;
            }
            UUID principalId;
            try {
                principalId = UUID.fromString(raw.trim());
            } catch (IllegalArgumentException e) {
                // A malformed value is a configuration mistake, not a reason to fail the create.
                logger.warn("[task-106] event=default_agent_skipped layer={} reason=invalid_uuid length={}",
                        candidate.layer(), raw.trim().length());
                continue;
            }
            if (!agentPrincipalService.isSessionAgentUsable(workspaceUuid, principalId)) {
                logger.warn("[task-106] event=default_agent_skipped layer={} principalId={} workspaceId={} "
                        + "reason=principal_not_usable", candidate.layer(), principalId, workspaceUuid);
                continue;
            }
            return principalId.toString();
        }
        throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                "agentPrincipalId is required: no usable default agent was resolved for this session. "
                        + "Set one with PUT /api/v1/workspaces/{workspaceId}/agents/{principalId}/default, "
                        + "or configure " + DOMAIN + "." + KEY + " (workspace > workspace-default > user > "
                        + "instance). A default only counts while the principal is enabled and bound to "
                        + "the workspace.");
    }

    /**
     * The ordered candidate list. Kept separate from {@link #resolve} so the chain shape is readable in
     * one place; entries with a {@code null} value are "this layer has no row" and are skipped.
     */
    private List<Candidate> candidates(UUID userUuid, UUID workspaceUuid) {
        List<Candidate> chain = new ArrayList<>();
        chain.add(new Candidate("env", configService.envOverridden(DOMAIN).get(KEY)));
        if (configService.isAdminLocked(DOMAIN, KEY)) {
            // The lock pins an instance value and outranks every DB layer in ConfigService.resolve —
            // keep that shape here instead of inventing a shorter chain.
            chain.add(new Candidate("instance-lock", configService.instanceValue(DOMAIN, KEY)));
            return chain;
        }
        if (workspaceUuid != null) {
            // The workspace-level default binding is the strongest layer D-928 did not have yet:
            // "this workspace picked a default agent" outranks a hand-set config value at the same
            // workspace scope, because the former is a first-class product action (PUT .../default).
            UUID boundDefault = agentPrincipalService.workspaceDefaultAgentPrincipalId(workspaceUuid);
            chain.add(new Candidate("workspace-default-binding",
                    boundDefault == null ? null : boundDefault.toString()));
            chain.add(new Candidate("workspace",
                    configService.layerEntries("workspace", DOMAIN, null, workspaceUuid).get(KEY)));
            chain.add(new Candidate("workspace-default",
                    configService.layerEntries("workspace-default", DOMAIN, null, null).get(KEY)));
        }
        if (userUuid != null) {
            chain.add(new Candidate("user",
                    configService.layerEntries("user", DOMAIN, userUuid, null).get(KEY)));
        }
        chain.add(new Candidate("instance", configService.instanceValue(DOMAIN, KEY)));
        return chain;
    }

    private static UUID uuid(String value) {
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            // Same contract as SessionProviderDefaults: a malformed caller id is a 400, not a 500.
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Malformed id: " + value);
        }
    }

    private static boolean hasText(String value) {
        return value != null && !value.isBlank();
    }

    /** One source of the chain; {@code layer} exists for the WARN lines and never reaches the wire. */
    private record Candidate(String layer, String value) {}
}
