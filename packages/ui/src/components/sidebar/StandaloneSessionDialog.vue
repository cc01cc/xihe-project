<script setup lang="ts">
/**
 * task-373 / `D-1236`：新建独立会话 —— 选一个**个人**智能体做 PRIMARY。
 *
 * <p>为什么必须选：CP `SessionService#createAgentSession` 缺 `agentPrincipalId` 直接 400
 * （PLAN-0689 B3：会话身份在创建时确定，不留到首次发送再选）。独立会话没有工作区 ⇒ 候选只能
 * 来自个人视图 `listMyAgentPrincipals`，不是工作区智能体。</p>
 *
 * <p>三态各有出口，不做死路：0 个 ⇒ 指向个人智能体页；1 个 ⇒ 不打断（点「新建」已经是确认）；
 * 多个 ⇒ 选一个再建。失败保留弹窗（先拿 payload 再关窗的顺序陷阱见 `packages/ui/AGENTS.md`）。</p>
 */
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { Loader2 } from "@lucide/vue";
import { toast } from "vue-sonner";
import BaseModal from "../shared/BaseModal.vue";
import { api, ApiError, type AgentPrincipalSummary } from "../../composables/api";
import { useSessionStore } from "../../stores/session";
import { logger } from "../../lib/logger";

const props = defineProps<{ show: boolean }>();
const emit = defineEmits<{ close: []; created: [sessionId: string] }>();

const { t } = useI18n();
const router = useRouter();
const sessionStore = useSessionStore();

const loading = ref(false);
const creating = ref(false);
const loadError = ref<string | null>(null);
const candidates = ref<AgentPrincipalSummary[]>([]);
const selected = ref("");

async function loadCandidates(): Promise<void> {
    loading.value = true;
    loadError.value = null;
    selected.value = "";
    try {
        const mine = await api.listMyAgentPrincipals();
        candidates.value = mine.filter((item) => !item.disabled);
        if (candidates.value.length === 1) {
            selected.value = candidates.value[0]!.principalId;
            await create();
        }
    } catch (cause) {
        loadError.value = cause instanceof ApiError ? cause.message : t("standaloneDialog.failed");
        logger.error("Load personal agent principals failed", cause);
    } finally {
        loading.value = false;
    }
}

async function create(): Promise<void> {
    const principalId = selected.value;
    if (!principalId || creating.value) return;
    creating.value = true;
    try {
        // task-52 / batch-02 ②：**默认标题走 i18n**，与工作区会话同一条口径。
        //
        // 原先这里不传 title ⇒ 标题由 CP 兜底 `"Untitled"`（`SessionService.normalizeTitle`）
        // ⇒ 独立会话也是「中文界面里出现英文默认名」，与本卡要修的侧栏 `New Chat` 同一个病、
        // 只是兜底在后端。改在调用点传值：CP 的兜底保持不动（它还要服务其它不传 title 的客户端），
        // 前端不再把「未命名」这件事交给别人的语言环境决定。
        const record = await api.createStandaloneSession(
            principalId,
            t("workspace.sessionDefaultTitle"),
        );
        sessionStore.addWorkspacelessSession(record);
        emit("created", record.id);
        emit("close");
    } catch (cause) {
        const message = cause instanceof ApiError ? cause.message : t("standaloneDialog.failed");
        logger.error("Create standalone session failed", cause);
        toast.error(message);
    } finally {
        creating.value = false;
    }
}

function goToAgents(): void {
    emit("close");
    // task-96：资源区的智能体页已摘除 ⇒ 个人智能体的新家是组织成员页（用户 2026-11-14 ④
    // 「智能体个人属于成员管理」）。**不再经 `/resources/agents` 中转**：那条路径现在是 302，
    // 二次跳转会让「新建会话时发现没有智能体 ⇒ 去建一个」的路径多一次地址栏闪烁。
    void router.push("/members");
}

// immediate：以「已打开」状态挂载（调用方用 v-if 或直接 :show="true"）时也要取候选，
// 否则弹窗停在「还没有个人智能体」空态 —— 那不是事实，是没取数。
watch(
    () => props.show,
    (show) => {
        if (show) void loadCandidates();
    },
    { immediate: true },
);
</script>

<template>
    <BaseModal :show="show" :title="t('standaloneDialog.title')" trap-focus @close="emit('close')">
        <div class="space-y-3" data-testid="standalone-dialog">
            <p class="text-sm text-muted-foreground">{{ t("standaloneDialog.body") }}</p>
            <!--
                task-547 F-A：**创建时就说清限制**，而不是让用户选完主体、进到会话、发出去才吃 400
                （CP：ChatController.java:616-629，workspace-less Session 不支持 TO/CC/代发/附件）。
            -->
            <p
                class="rounded border border-amber-500/40 px-2 py-1 text-xs text-amber-700 dark:text-amber-300"
                data-testid="standalone-dialog-limits"
            >
                {{ t("standaloneDialog.limits") }}
            </p>

            <div
                v-if="loading"
                data-testid="standalone-dialog-loading"
                class="flex items-center gap-2 py-4 text-sm text-muted-foreground"
            >
                <Loader2 class="size-3.5 animate-spin" aria-hidden="true" />
                {{ t("standaloneDialog.loading") }}
            </div>

            <div
                v-else-if="loadError"
                data-testid="standalone-dialog-error"
                class="space-y-2 py-2 text-sm"
            >
                <p class="break-words text-destructive">{{ loadError }}</p>
                <button
                    type="button"
                    data-testid="standalone-dialog-retry"
                    class="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    @click="loadCandidates"
                >
                    {{ t("common.retry") }}
                </button>
            </div>

            <div
                v-else-if="candidates.length === 0"
                data-testid="standalone-dialog-empty"
                class="space-y-2 py-2"
            >
                <p class="text-sm text-foreground">{{ t("standaloneDialog.emptyTitle") }}</p>
                <p class="text-xs text-muted-foreground">{{ t("standaloneDialog.emptyBody") }}</p>
                <button
                    type="button"
                    data-testid="standalone-dialog-create-agent"
                    class="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    @click="goToAgents"
                >
                    {{ t("standaloneDialog.emptyAction") }}
                </button>
            </div>

            <template v-else>
                <div role="radiogroup" :aria-label="t('standaloneDialog.title')" class="space-y-1">
                    <button
                        v-for="item in candidates"
                        :key="item.principalId"
                        type="button"
                        role="radio"
                        :aria-checked="selected === item.principalId"
                        :data-testid="`standalone-dialog-agent-${item.principalId}`"
                        class="flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        :class="
                            selected === item.principalId
                                ? 'border-primary bg-accent'
                                : 'border-border'
                        "
                        @click="selected = item.principalId"
                    >
                        <span class="min-w-0 truncate">{{ item.name }}</span>
                    </button>
                </div>
                <div class="flex justify-end gap-2 pt-1">
                    <button
                        type="button"
                        data-testid="standalone-dialog-cancel"
                        class="rounded-md border border-border px-2.5 py-1 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        @click="emit('close')"
                    >
                        {{ t("common.cancel") }}
                    </button>
                    <button
                        type="button"
                        data-testid="standalone-dialog-confirm"
                        :disabled="!selected || creating"
                        class="rounded-md bg-primary px-2.5 py-1 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        @click="create"
                    >
                        {{
                            creating ? t("standaloneDialog.creating") : t("standaloneDialog.create")
                        }}
                    </button>
                </div>
            </template>
        </div>
    </BaseModal>
</template>
