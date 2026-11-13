<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, CircleAlert } from "@lucide/vue";
import { toast } from "vue-sonner";
import { logger } from "../../../../lib/logger";
import { usePolicyStore } from "../../../../stores/policy";
import { useSessionStore } from "../../../../stores/session";
import { useAuthStore } from "../../../../stores/auth";
import type { SessionPolicyMode } from "../../../../types";
import SessionContextTemplate from "./SessionContextTemplate.vue";
import SessionContextPanel from "../../components/SessionContextPanel.vue";

export interface SettingsBranchOption {
    branchId: string;
    label: string;
}

interface TemplateSummary {
    label: string | null;
    loading: boolean;
    failed: boolean;
}

const props = defineProps<{
    sessionId: string;
    branchOptions: SettingsBranchOption[];
    selectedBranchId: string;
    mainBranchId: string | null;
    /**
     * PLAN-0626 M2 (Q1 = C, Lead ruling 2026-11-02): the desktop summary row is an
     * **entry** to the dock's `context` panel; mobile has no dock, so it keeps the
     * in-place expansion. The two interaction paradigms are deliberately different.
     */
    isMobile?: boolean;
}>();

const emit = defineEmits<{
    /** Desktop only: ask the page to open the dock's `context` panel. */
    "open-context-panel": [];
}>();

const { t } = useI18n();
const policyStore = usePolicyStore();
const sessionStore = useSessionStore();
/**
 * BL-311：只读工作区（VIEWER）的「关闭自动放行」不能是可点按钮再吃 403 `WORKSPACE_READ_ONLY`。
 * 判定源沿用既有投影 `useAuthStore().canWriteWorkspace`（`stores/auth.ts:96-98`，与 composer
 * 发送守卫、文件树写操作、审批操作同一来源）—— CP 仍是权威，这里只决定 affordance。
 *
 * 按钮**保留可见但禁用**（不是藏掉）：自动放行开启是安全状态，横幅与"当前不可操作"必须同时可见，
 * 否则 VIEWER 会以为工作区没有自动放行；这也是项目既有纪律（点击前给不可用状态 + 原因）。
 */
const authStore = useAuthStore();
const canWriteWorkspace = computed(() => authStore.canWriteWorkspace);

const open = ref(false),
    closingAuto = ref(false);
const templateSummary = ref<TemplateSummary>({ label: null, loading: true, failed: false });

const panelId = computed(() => `session-settings-panel-${props.sessionId}`);
const policyState = computed(() => policyStore.getState(props.sessionId)),
    mode = computed<SessionPolicyMode | null>(() => policyState.value?.mode ?? null);
const modeLabel = computed(() => {
    if (!mode.value) return t("chat.approvalModeUnavailable");
    return mode.value === "manual" ? t("chat.approvalModeManual") : t("chat.approvalModeAuto");
});
const autoApproval = computed(() => mode.value === "auto");

const session = computed(
    () => sessionStore.sessions.find((item) => item.id === props.sessionId) ?? null,
);
const templateValue = computed(() => {
    if (templateSummary.value.label) return templateSummary.value.label;
    const bound = session.value;
    if (bound?.contextTemplateId && bound.contextTemplateVersion != null) {
        return `${bound.contextTemplateId} v${bound.contextTemplateVersion}`;
    }
    return null;
});
// A risk badge must never be derived from a still-loading projection (that would
// flash "not bound" on every session switch) — but a *failed* projection is a risk
// in itself, so it must NOT be suppressed (S4 audit P1-1: "failure looked safe").
const templateRisk = computed(() => {
    if (templateSummary.value.failed) return true;
    if (templateSummary.value.loading) return false;
    return templateValue.value === null;
});
const templateRiskText = computed(() =>
    templateSummary.value.failed
        ? t("sessionSettings.templateLoadFailed")
        : t("sessionSettings.templateUnbound"),
);
/**
 * Collapsed-summary value. `loading` shows a placeholder instead of the raw id (it
 * would flash on every session switch and read like a real binding) and `failed`
 * shows a localized failure line — the raw template id is unreadable either way.
 */
const templateDisplay = computed(() => {
    if (templateSummary.value.failed) return templateRiskText.value;
    if (templateSummary.value.loading) return "—";
    return templateValue.value ?? "—";
});
const branchLabel = computed(
    () =>
        props.branchOptions.find((branch) => branch.branchId === props.selectedBranchId)?.label ??
        t("chat.branchMainPath"),
);
const branchDetached = computed(
    () =>
        Boolean(props.selectedBranchId) &&
        Boolean(props.mainBranchId) &&
        props.selectedBranchId !== props.mainBranchId,
);

const summaryText = computed(() =>
    [
        `${t("chat.approvalModeLabel")} ${modeLabel.value}`,
        `${t("chat.contextTemplateLabel")} ${templateDisplay.value}`,
        `${t("chat.branchSelectorLabel")} ${branchLabel.value}`,
    ].join(" · "),
);

watch(
    () => props.sessionId,
    () => {
        templateSummary.value = { label: null, loading: true, failed: false };
    },
);

/**
 * PLAN-0626 M2-3 moved the mode *control* into the dock, which also moved the only
 * `policyStore.load()` caller (`SessionPolicyControls`) out of the chat column. The
 * summary row still owns the mode value and the auto-approval safety banner, so it must
 * load the projection itself — otherwise both read "未提供" / disappear until the dock is
 * opened (2026-11-03 mock-lane 实测：`GET /api/v1/policy/mode` 一次都没发出，因为 dock
 * 默认关闭、面板从未挂载)。`load()` 自身按 `loaded` / 在途 promise 去重，与面板实例并存无副作用。
 */
watch(
    () => props.sessionId,
    (sessionId) => {
        if (sessionId) void policyStore.load(sessionId);
    },
    { immediate: true },
);

function handleTemplateSummary(summary: TemplateSummary) {
    templateSummary.value = summary;
}

/**
 * PLAN-0626 M2: desktop opens the dock `context` panel (the settings live there now);
 * mobile keeps the in-place expansion because a 390px sheet has no dock to open.
 */
function handleSummaryClick(): void {
    if (props.isMobile) {
        open.value = !open.value;
        return;
    }
    emit("open-context-panel");
}

async function closeAutoApproval() {
    const sessionId = props.sessionId;
    // BL-311：只读工作区不发写请求。按钮已 `disabled`（真实浏览器不会派发激活事件），
    // 这层是防守：将来有人只改模板、忘了语义时，写仍然不会被发出去。
    if (!sessionId || closingAuto.value || !canWriteWorkspace.value) return;
    closingAuto.value = true;
    try {
        await policyStore.change(sessionId, "manual");
        if (props.sessionId === sessionId) {
            toast.success(`${t("chat.approvalModeChanged")}: ${t("chat.approvalModeManual")}`);
        }
    } catch (cause) {
        logger.warn("Failed to close auto approval mode", cause);
        // S4 audit P1-2 (S5-10): turning auto approval off is a safety action. A
        // silent failure would leave the user believing it is off while it is still
        // on, so the failure must be visible even when the panel stays collapsed.
        if (props.sessionId === sessionId) {
            toast.error(t("chat.approvalAutoOffFailed"));
        }
    } finally {
        closingAuto.value = false;
    }
}
</script>

<template>
    <section
        data-testid="session-settings"
        class="shrink-0 border-b bg-background/80"
        :aria-label="t('sessionSettings.title')"
    >
        <button
            type="button"
            data-testid="session-settings-summary"
            class="flex h-9 w-full min-w-0 items-center gap-2 px-3 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            :aria-expanded="isMobile ? open : undefined"
            :aria-controls="isMobile ? panelId : undefined"
            :aria-label="isMobile ? undefined : t('sessionSettings.openInPanel')"
            :title="isMobile ? summaryText : t('sessionSettings.openInPanel')"
            @click="handleSummaryClick"
        >
            <ChevronDown
                class="size-3.5 shrink-0 transition-transform"
                :class="open ? 'rotate-180' : ''"
                aria-hidden="true"
            />
            <span class="sr-only">{{
                isMobile
                    ? open
                        ? t("sessionSettings.collapse")
                        : t("sessionSettings.expand")
                    : t("sessionSettings.openInPanel")
            }}</span>
            <span class="flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap">
                <span class="shrink-0" data-testid="session-settings-summary-approval">
                    {{ t("chat.approvalModeLabel") }}
                    <span class="font-medium text-foreground">{{ modeLabel }}</span>
                </span>
                <span class="shrink-0 text-muted-foreground/50">·</span>
                <span
                    class="min-w-0 truncate"
                    data-testid="session-context-template-current"
                    :title="templateDisplay"
                >
                    {{ t("chat.contextTemplateLabel") }}
                    <span
                        class="font-medium"
                        :class="templateRisk ? 'text-amber-700' : 'text-foreground'"
                    >
                        {{ templateDisplay }}
                    </span>
                </span>
                <span class="shrink-0 text-muted-foreground/50">·</span>
                <span class="shrink-0" data-testid="session-settings-summary-branch">
                    {{ t("chat.branchSelectorLabel") }}
                    <span class="font-medium text-foreground">{{ branchLabel }}</span>
                </span>
            </span>
            <span
                v-if="templateRisk"
                data-testid="session-settings-risk-template"
                class="inline-flex max-w-36 shrink-0 items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700"
                :title="templateRiskText"
            >
                <CircleAlert class="size-3 shrink-0" aria-hidden="true" />
                <span class="truncate">{{ templateRiskText }}</span>
            </span>
            <span
                v-if="branchDetached"
                data-testid="session-settings-risk-branch"
                class="inline-flex max-w-36 shrink-0 items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700"
                :title="t('sessionSettings.branchDetached')"
            >
                <CircleAlert class="size-3 shrink-0" aria-hidden="true" />
                <span class="truncate">{{ t("sessionSettings.branchDetached") }}</span>
            </span>
        </button>

        <!-- Safety warning: auto approval must stay visible while the panel is collapsed. -->
        <div
            v-if="autoApproval"
            data-testid="session-policy-auto-banner"
            role="alert"
            class="flex items-center justify-between gap-2 border-t border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700"
        >
            <span class="flex min-w-0 items-center gap-1.5">
                <CircleAlert class="size-3.5 shrink-0" aria-hidden="true" />
                <span class="line-clamp-2 min-w-0">{{ t("chat.approvalAutoWarning") }}</span>
            </span>
            <button
                type="button"
                data-testid="session-policy-auto-close"
                class="shrink-0 rounded-md border border-amber-500/40 px-2 py-0.5 text-xs font-medium transition hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                :disabled="closingAuto || Boolean(policyState?.changing) || !canWriteWorkspace"
                :title="canWriteWorkspace ? undefined : t('workspace.viewerReadOnly')"
                @click="closeAutoApproval"
            >
                {{ t("chat.approvalAutoClose") }}
            </button>
        </div>

        <!--
            The template projection must exist even when the controls live in the dock:
            this invisible adapter keeps the summary row's "模板 + 版本 + 风险" honest
            (M2 首版不做 composable 抽象 — Lead 纪律 1).
        -->
        <SessionContextTemplate
            :session-id="sessionId"
            summary-only
            class="sr-only"
            @update:summary="handleTemplateSummary"
        />

        <!--
            Mobile only: there is no dock on a 390px sheet, so the same panel component is
            rendered in place instead of a second copy of the four partitions.

            2026-11-03 (真机 e2e 实测): this must be `v-if="isMobile"`, not only `v-show="open"`.
            With `v-show` the desktop layout still mounted a hidden copy of the whole panel
            alongside the dock's copy, so every testid inside it resolved to 2 elements
            (`session-context-panel`, `session-policy-mode`, `u1-toggle`, `session-branch-select` …)
            and Playwright strict mode failed the specs. Mounting it only for the mobile sheet
            keeps one instance in the DOM at any viewport.

            2026-11-12 (task-90): that fix removed the *desktop* duplicate but left a
            *mobile* one — this wrapper also carried `data-testid="session-settings-expanded"`
            and `id="session-settings-panel-<id>"`, i.e. the exact pair the nested
            `SessionContextPanel` body carries (see its header comment). wrapper → body was
            then 2 nodes for both attributes. This wrapper is a scroll/disclosure shell
            (`max-h-[60vh] overflow-y-auto border-t` + `v-show`/`inert`), **not** a second
            settings surface ⇒ it is the one that gets scoped names; the body keeps the
            semantic testid because that is what the e2e specs and the two unit specs mean by
            "the expanded settings". Uniqueness is machine-asserted, not commented:
            `chat/__tests__/sessionSettingsExpandedUnique.spec.ts`.
        -->
        <template v-if="isMobile">
            <div
                v-show="open"
                :id="panelId"
                :inert="!open"
                data-testid="session-settings-mobile-sheet"
                class="max-h-[60vh] overflow-y-auto border-t"
            >
                <SessionContextPanel :session-id="sessionId" />
            </div>
        </template>
    </section>
</template>
