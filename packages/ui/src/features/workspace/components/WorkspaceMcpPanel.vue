<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import McpStdioServerList from "../../../components/settings/McpStdioServerList.vue";
import { api } from "../../../composables/api";
import { logger } from "../../../lib/logger";

// PLAN-0560 T2.8: MCP 区块从全局设置 Workspace tab 迁入工作区设置页；data-testid
// （mcp-*、remote-mcp-*）保持不变以免既有 E2E 失效。
const props = withDefaults(
    defineProps<{
        workspaceId: string;
        readonly?: boolean;
    }>(),
    { readonly: false },
);

const { t } = useI18n();

const mcpJson = ref(""),
    mcpError = ref(""),
    mcpSaving = ref(false);
type RemoteMcpServer = {
    id: string;
    name: string;
    url: string;
    oauth: {
        clientId: string;
        authorizationEndpoint: string;
        tokenEndpoint: string;
        scope: string;
        redirectUri?: string;
    };
};
type AuthorizationStatus = "required" | "authorizing" | "authorized" | "failed";
const oauthStatus = ref<Record<string, AuthorizationStatus>>({}),
    oauthError = ref("");

const builtInTools = [
    "read_file",
    "write_file",
    "list_directory",
    "execute_command",
    "glob",
    "grep",
    "edit_file",
    "delete_file",
    "delete_directory",
    "read_file_range",
    "mkdir",
    "move_file",
    "copy_file",
    "get_file_info",
    "watch_directory",
    "extract_pdf_text",
    "apply_patch",
    "start_background_process",
    "list_background_processes",
    "get_background_process",
    "cancel_background_process",
    "read_command_output",
];

async function loadMcpConfig() {
    try {
        const resp = await api.getMcpConfig(props.workspaceId);
        if (resp.mcpServers) {
            const value =
                typeof resp.mcpServers === "string" ? JSON.parse(resp.mcpServers) : resp.mcpServers;
            mcpJson.value = JSON.stringify(
                value.mcpServers ? value : { mcpServers: value },
                null,
                2,
            );
        } else {
            mcpJson.value = JSON.stringify({ mcpServers: {} }, null, 2);
        }
    } catch (e) {
        logger.warn("Failed to load MCP config, using empty default", e);
        mcpJson.value = JSON.stringify({ mcpServers: {} }, null, 2);
    }
}

function getRemoteServers(): RemoteMcpServer[] {
    try {
        const parsed = JSON.parse(mcpJson.value) as Record<string, unknown>;
        const servers = (
            parsed.mcpServers && typeof parsed.mcpServers === "object" ? parsed.mcpServers : parsed
        ) as Record<string, Record<string, unknown>>;
        return Object.entries(servers).flatMap(([id, server]) => {
            if (typeof server.url !== "string" || !server.url) return [];
            const oauth = (
                typeof server.oauth === "object" && server.oauth !== null ? server.oauth : {}
            ) as Record<string, unknown>;
            const value = (key: string) => oauth[key] ?? server[key],
                clientId = value("clientId") ?? value("client_id"),
                authorizationEndpoint =
                    value("authorizationEndpoint") ?? value("authorization_endpoint"),
                tokenEndpoint = value("tokenEndpoint") ?? value("token_endpoint"),
                scope = value("scope");
            if (
                [clientId, authorizationEndpoint, tokenEndpoint, scope].some(
                    (item) => typeof item !== "string" || !item,
                )
            )
                return [];
            const redirectUri = value("redirectUri") ?? value("redirect_uri");
            return [
                {
                    id,
                    name: typeof server.name === "string" ? server.name : id,
                    url: server.url,
                    oauth: {
                        clientId: clientId as string,
                        authorizationEndpoint: authorizationEndpoint as string,
                        tokenEndpoint: tokenEndpoint as string,
                        scope: scope as string,
                        redirectUri: typeof redirectUri === "string" ? redirectUri : undefined,
                    },
                },
            ];
        });
    } catch (e) {
        logger.warn("Failed to parse remote MCP OAuth configuration", e);
        return [];
    }
}

function oauthStatusFor(serverId: string): AuthorizationStatus {
    return (
        oauthStatus.value[serverId] ??
        (sessionStorage.getItem(`xihe-oauth-authorized:${serverId}`) === "true"
            ? "authorized"
            : "required")
    );
}

async function handleOAuthCallback() {
    const params = new URLSearchParams(window.location.search),
        state = params.get("state"),
        code = params.get("code"),
        error = params.get("error");
    if (!state || (!code && !error)) return;
    const pendingKey = `xihe-oauth-pending:${state}`,
        serverId = sessionStorage.getItem(pendingKey);
    if (!serverId) return;
    oauthStatus.value[serverId] = "authorizing";
    try {
        if (error) throw new Error(error);
        const result = await api.completeOAuthSession(state, code as string);
        if (result.status !== "authorized") throw new Error("OAuth callback was not authorized");
        sessionStorage.setItem(`xihe-oauth-authorized:${serverId}`, "true");
        oauthStatus.value[serverId] = "authorized";
    } catch (e) {
        logger.warn("Remote MCP OAuth callback failed", e);
        oauthStatus.value[serverId] = "failed";
        oauthError.value = t("settings.authorizationFailed");
    } finally {
        sessionStorage.removeItem(pendingKey);
        window.history.replaceState(
            {},
            document.title,
            `${window.location.pathname}${window.location.hash}`,
        );
    }
}

async function authorizeRemoteServer(server: RemoteMcpServer) {
    oauthError.value = "";
    oauthStatus.value[server.id] = "authorizing";
    try {
        const redirectUri =
            server.oauth.redirectUri || `${window.location.origin}${window.location.pathname}`;
        const result = await api.startOAuthSession({
            workspaceId: props.workspaceId,
            serverId: server.id,
            remoteEndpoint: server.url,
            clientId: server.oauth.clientId,
            authorizationEndpoint: server.oauth.authorizationEndpoint,
            tokenEndpoint: server.oauth.tokenEndpoint,
            redirectUri,
            scope: server.oauth.scope,
        });
        sessionStorage.setItem(`xihe-oauth-pending:${result.state}`, server.id);
        window.location.assign(result.authorizationUrl);
    } catch (e) {
        logger.warn(`Failed to start OAuth for remote MCP server ${server.id}`, e);
        oauthStatus.value[server.id] = "failed";
        oauthError.value = t("settings.authorizationFailed");
    }
}

async function saveMcpConfig() {
    mcpSaving.value = true;
    mcpError.value = "";
    try {
        const parsed = JSON.parse(mcpJson.value);
        await api.saveMcpConfig(props.workspaceId, parsed.mcpServers);
        toast.success(t("common.saved"));
    } catch (e) {
        if (e instanceof SyntaxError) {
            mcpError.value = t("settings.invalidJson");
        } else {
            toast.error(t("settings.saveFailed"));
        }
    } finally {
        mcpSaving.value = false;
    }
}

onMounted(async () => {
    await handleOAuthCallback();
    await loadMcpConfig();
});
</script>

<template>
    <div class="border rounded-lg mb-2 overflow-hidden">
        <div class="px-4 py-3 text-sm font-medium bg-muted/30">
            {{ t("settings.domainMcp") }}
        </div>
        <div class="px-4 pb-3 space-y-3">
            <McpStdioServerList :workspace-id="props.workspaceId" />
            <div class="space-y-2">
                <div class="flex flex-wrap gap-2 mb-3">
                    <span
                        v-for="tool in builtInTools"
                        :key="tool"
                        class="text-xs px-2 py-1 rounded-full bg-primary/10 text-primary"
                    >
                        {{ tool }}
                    </span>
                </div>
                <textarea
                    v-model="mcpJson"
                    data-testid="mcp-config-textarea"
                    class="w-full h-48 px-4 py-3 rounded-lg border bg-background font-mono text-sm resize-y disabled:opacity-60"
                    :disabled="readonly"
                />
                <p v-if="mcpError" class="text-xs text-destructive">
                    {{ mcpError }}
                </p>
                <div v-if="!readonly" class="flex gap-2">
                    <button
                        class="px-3 py-1 text-xs bg-primary text-primary-foreground rounded hover:opacity-90 disabled:opacity-50"
                        :disabled="mcpSaving"
                        @click="saveMcpConfig"
                    >
                        {{ mcpSaving ? t("common.saving") : t("common.save") }}
                    </button>
                </div>
                <div v-if="getRemoteServers().length" class="border-t pt-3 space-y-2">
                    <div class="text-sm font-medium">
                        {{ t("settings.remoteMcp") }}
                    </div>
                    <div
                        v-for="server in getRemoteServers()"
                        :key="server.id"
                        class="flex items-center justify-between gap-3 text-sm"
                        :data-testid="`remote-mcp-${server.id}`"
                    >
                        <span>{{ server.name }}</span>
                        <span class="flex items-center gap-2">
                            <span class="text-xs text-muted-foreground">
                                {{
                                    oauthStatusFor(server.id) === "authorized"
                                        ? t("settings.authorized")
                                        : oauthStatusFor(server.id) === "authorizing"
                                          ? t("settings.authorizing")
                                          : oauthStatusFor(server.id) === "failed"
                                            ? t("settings.authorizationFailed")
                                            : t("settings.authorizationRequired")
                                }}
                            </span>
                            <button
                                v-if="!readonly"
                                class="px-3 py-1 text-xs border rounded hover:bg-muted disabled:opacity-50"
                                :disabled="oauthStatusFor(server.id) === 'authorizing'"
                                @click="authorizeRemoteServer(server)"
                            >
                                {{
                                    oauthStatusFor(server.id) === "authorized"
                                        ? t("settings.authorized")
                                        : t("settings.authorize")
                                }}
                            </button>
                        </span>
                    </div>
                    <p v-if="oauthError" class="text-xs text-destructive">
                        {{ oauthError }}
                    </p>
                </div>
            </div>
        </div>
    </div>
</template>
