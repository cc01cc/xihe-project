package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.UUID;

/**
 * 2026-11-04 P0（task-24）：新会话的 provider 绑定默认值解析，唯一权威点。
 *
 * <p>背景：UI 建会话只发 {@code {agentPrincipalId, title}}，而 CP 以前对"三件套全空"的创建
 * 请求不补默认值，于是落一条"裸会话"（provider/model/connection/template 全 NULL），首次发消息
 * 被 {@code ApiRequestTemplateService.admissionSnapshot} 以 409 {@code API_TYPE_REBIND_REQUIRED}
 * 拦下。裸会话现在是<b>不可能状态</b>：本类解析不到默认值时抛 400 {@code PROVIDER_REQUIRED}。</p>
 *
 * <p>解析顺序（显式传值优先，只有三件套全空时才走到这里）：</p>
 * <ol>
 *   <li><b>agent 主体默认</b>：{@code AgentPrincipal.defaultModelProvider/defaultModelName}
 *       —— 落实 2026-11-04 裁定「模型由 agent 主体 / 连接配置决定」；连接留空，交由
 *       {@code SessionService.bindProviderConnection} 按"唯一可用 chat 连接"解析；</li>
 *   <li><b>生效 llm-provider profile</b>：{@code ConfigService.resolveLlmProfile}
 *       （workspace → user → instance 整层解析，并解析到具体 ready 连接 + revision）；</li>
 *   <li>两者都没有 ⇒ 400 {@code PROVIDER_REQUIRED}（提示先配 agent 默认模型或生效 profile）。</li>
 * </ol>
 *
 * <p>profile 存在但解析不到可用连接时，沿用 {@code ConfigService} 既有的 409
 * {@code LLM_PROFILE_CONFLICT} —— 那是"配置错"而不是"没配置"，不该被压平成 400。</p>
 */
@Service
public class SessionProviderDefaults {

    /** Resolved default binding. {@code providerConnectionId} may be null (resolve by unique candidate). */
    public record Defaults(String modelProvider, String modelName, String providerConnectionId,
                           String source) {}

    private final AgentPrincipalService agentPrincipalService;
    private final ConfigService configService;

    public SessionProviderDefaults(AgentPrincipalService agentPrincipalService,
                                   ConfigService configService) {
        this.agentPrincipalService = agentPrincipalService;
        this.configService = configService;
    }

    @Transactional(readOnly = true)
    public Defaults resolve(String userId, String workspaceId, String agentPrincipalId) {
        // D-687 (workspaceless sessions): the agent-default source is a WORKSPACE-layer default
        // (AgentPrincipalService.defaultModel requires an active workspace binding, D-49). With no
        // workspace it is explicitly not applicable — skip it instead of relaxing that binding gate;
        // the user -> instance llm-provider profile below remains the only default source.
        AgentPrincipalService.DefaultModel agentDefault = workspaceId == null
                ? null
                : agentPrincipalService.defaultModel(uuid(agentPrincipalId), uuid(workspaceId));
        if (agentDefault != null && hasText(agentDefault.provider()) && hasText(agentDefault.model())) {
            return new Defaults(agentDefault.provider().trim(), agentDefault.model().trim(), null,
                    "agent-principal");
        }
        ConfigService.ResolvedLlmProfile profile =
                configService.resolveLlmProfile(uuid(userId), uuid(workspaceId));
        if (profile != null) {
            return new Defaults(profile.providerId(), profile.model(), profile.providerConnectionId(),
                    "llm-profile");
        }
        throw new CpApiException(HttpStatus.BAD_REQUEST, "PROVIDER_REQUIRED",
                "No provider binding: set an agent default model or an effective llm-provider profile"
                        + " before creating a session");
    }

    private static boolean hasText(String value) {
        return value != null && !value.isBlank();
    }

    private static UUID uuid(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "Malformed id: " + value);
        }
    }
}
