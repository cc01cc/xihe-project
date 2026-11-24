<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
    api,
    type ApiPresetGovernanceAtom,
    type ApiPresetGovernanceCompare,
    type ApiPresetGovernanceRealignResult,
    type ApiPresetGovernanceScopeDiff,
    type ApiPresetGovernanceSubjectType,
    type ApiWorkspace,
} from "../../composables/api";
import { useAuthStore } from "../../stores/auth";
import { presetErrorMessage } from "../../components/settings/roleErrorMessages";
import Dialog from "../../components/ui/dialog/Dialog.vue";
import DialogContent from "../../components/ui/dialog/DialogContent.vue";
import DialogHeader from "../../components/ui/dialog/DialogHeader.vue";
import DialogTitle from "../../components/ui/dialog/DialogTitle.vue";
import DialogDescription from "../../components/ui/dialog/DialogDescription.vue";
import DialogFooter from "../../components/ui/dialog/DialogFooter.vue";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { LoaderCircle } from "@lucide/vue";

/**
 * task-948 R39：一个主体的「与模板对比」面。
 *
 * <p>差异本身**完全由服务端计算**（CP `PresetGovernanceService.classifyDiff`，与 realign 同一个
 * 内核）。本组件只渲染四桶，并在用户确认后调用 realign 重放导入组；它不维护任何本地差异推导，
 * 也不判断某个桶「该不该删」——那是 CP 的判据。</p>
 *
 * <p>重新对齐是写操作：`MANAGE_ROLES` 加每个被触及工作区的 `MANAGE_WORKSPACE_AGENTS`。页面的
 * 权限门已在 `RolesView` 上（`auth.canManageRoles`），这里再读同一个原子只是防直挂组件。</p>
 */
const props = defineProps<{
    open: boolean;
    subjectType: ApiPresetGovernanceSubjectType;
    subjectId: string;
    /** 行上已经解析好的展示名；对话框标题只用它，不额外查用户目录。 */
    subjectLabel: string;
    workspaces: ApiWorkspace[];
}>();
const emit = defineEmits<{ close: []; realigned: [] }>();

const { t } = useI18n();
const auth = useAuthStore();
const canManageRoles = computed(() => auth.canManageRoles);

const comparison = ref<ApiPresetGovernanceCompare | null>(null),
    loading = ref(false),
    error = ref(""),
    confirming = ref(false),
    realigning = ref(false),
    receipt = ref<ApiPresetGovernanceRealignResult | null>(null);

/**
 * task-949 / R78：canonical 原子名不上屏。动作类与 `cap:` 家族沿用 workspace 命名空间里既有
 * 的本地化键；大写原子按 camel 形态映射同名键；认不出的收敛成「其他权限」，不回落到裸名。
 */
const ACTION_KEYS: Record<string, string> = {
    read: "agentActionRead",
    write: "agentActionWrite",
    delete: "agentActionDelete",
    exec: "agentActionExec",
    network: "agentActionNetwork",
    credential: "agentActionCredential",
    credential_use: "agentActionCredentialUse",
    credential_reveal: "agentActionCredentialReveal",
    credential_manage: "agentActionCredentialManage",
    clone: "agentActionClone",
    approve: "agentActionApprove",
};
const CAP_KEYS: Record<string, string> = {
    "cap:instance:super": "agentAtomCapInstanceSuper",
    "cap:instance:admin": "agentAtomCapInstanceAdmin",
    "cap:workspace:admin": "agentAtomCapWorkspaceAdmin",
};

function workspaceLabel(key: string): string {
    const full = `workspace.${key}`;
    const label = t(full);
    return label === full ? t("settings.presetsDriftAtomOther") : label;
}

function camelizeAtom(atom: string): string {
    return atom
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map((part, index) =>
            index === 0
                ? part.charAt(0).toLowerCase() + part.slice(1).toLowerCase()
                : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase(),
        )
        .join("");
}

function atomDisplayLabel(actionClass: string): string {
    const raw = (actionClass ?? "").trim();
    if (raw === "") return t("settings.presetsDriftAtomOther");
    const capKey = CAP_KEYS[raw];
    if (capKey) return workspaceLabel(capKey);
    const bare = raw.startsWith("action:") ? raw.slice("action:".length) : raw;
    const actionKey = ACTION_KEYS[bare];
    if (actionKey) return workspaceLabel(actionKey);
    const camel = camelizeAtom(bare);
    return workspaceLabel(`agentAtom${camel.charAt(0).toUpperCase()}${camel.slice(1)}`);
}

function atomLabel(atom: ApiPresetGovernanceAtom): string {
    return atomDisplayLabel(atom.actionClass);
}

function scopeLabel(scope: ApiPresetGovernanceScopeDiff): string {
    if (scope.scopeType === "instance") return t("settings.presetsDriftScopeInstance");
    const name = props.workspaces.find((workspace) => workspace.id === scope.scopeId)?.name;
    return t("settings.presetsDriftScopeWorkspace", { name: name ?? scope.scopeId ?? "" });
}

interface DriftBucket {
    key: string;
    label: string;
    atoms: ApiPresetGovernanceAtom[];
}

function bucketsOf(scope: ApiPresetGovernanceScopeDiff): DriftBucket[] {
    return [
        { key: "missing", label: t("settings.presetsDriftMissing"), atoms: scope.missing },
        { key: "extra", label: t("settings.presetsDriftExtra"), atoms: scope.extra },
        { key: "localAdded", label: t("settings.presetsDriftLocalAdded"), atoms: scope.localAdded },
        {
            key: "overridden",
            label: t("settings.presetsDriftOverridden"),
            atoms: scope.overridden,
        },
    ];
}

const summary = computed(() => comparison.value?.summary ?? null);
const hasDrift = computed(() => {
    const value = summary.value;
    return (
        value !== null &&
        (value.missing > 0 || value.extra > 0 || value.localAdded > 0 || value.overridden > 0)
    );
});

function reset() {
    comparison.value = null;
    error.value = "";
    confirming.value = false;
    realigning.value = false;
    receipt.value = null;
}

async function loadComparison() {
    if (!props.subjectId) return;
    loading.value = true;
    error.value = "";
    try {
        comparison.value = await api.comparePresetGovernance(props.subjectType, props.subjectId);
    } catch (cause) {
        comparison.value = null;
        error.value = presetErrorMessage(cause, t);
    } finally {
        loading.value = false;
    }
}

watch(
    () => [props.open, props.subjectId] as const,
    ([open]) => {
        if (open) {
            reset();
            void loadComparison();
        }
    },
    { immediate: true },
);

async function confirmRealign() {
    if (realigning.value) return;
    realigning.value = true;
    error.value = "";
    try {
        receipt.value = await api.realignPresetGovernance(props.subjectType, props.subjectId);
        confirming.value = false;
        emit("realigned");
        await loadComparison();
    } catch (cause) {
        error.value = presetErrorMessage(cause, t);
    } finally {
        realigning.value = false;
    }
}
</script>

<template>
    <Dialog :open="open" @update:open="(value) => !value && emit('close')">
        <DialogContent
            width="config"
            data-testid="role-preset-drift-dialog"
            class="max-h-[85vh] overflow-y-auto"
        >
            <DialogHeader>
                <DialogTitle data-testid="role-preset-drift-title">
                    {{ t("settings.presetsDriftTitle", { name: subjectLabel }) }}
                </DialogTitle>
                <DialogDescription>{{ t("settings.presetsDriftSubtitle") }}</DialogDescription>
            </DialogHeader>

            <p
                v-if="error"
                data-testid="role-preset-drift-error"
                class="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-700"
            >
                {{ error }}
            </p>

            <p
                v-if="receipt"
                data-testid="role-preset-drift-receipt"
                class="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700"
            >
                {{
                    receipt.changed
                        ? t("settings.presetsDriftDone", {
                              created: receipt.created,
                              deleted: receipt.deleted,
                          })
                        : t("settings.presetsDriftNoChange")
                }}
            </p>

            <div
                v-if="loading"
                class="text-xs text-muted-foreground"
                data-testid="role-preset-drift-loading"
            >
                {{ t("settings.presetsDriftLoading") }}
            </div>

            <template v-else-if="comparison">
                <p class="text-xs text-muted-foreground" data-testid="role-preset-drift-summary">
                    {{
                        t("settings.presetsDriftSummary", {
                            missing: comparison.summary.missing,
                            extra: comparison.summary.extra,
                            localAdded: comparison.summary.localAdded,
                            overridden: comparison.summary.overridden,
                        })
                    }}
                </p>

                <p
                    v-if="!hasDrift"
                    data-testid="role-preset-drift-in-sync"
                    class="rounded border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
                >
                    {{ t("settings.presetsDriftInSync") }}
                </p>

                <section
                    v-for="scope in comparison.scopes"
                    :key="`${scope.scopeType}-${scope.scopeId ?? 'instance'}`"
                    :data-testid="`role-preset-drift-scope-${scope.scopeType}-${scope.scopeId ?? 'instance'}`"
                    class="rounded border p-3"
                >
                    <div class="flex items-center justify-between">
                        <h3 class="text-sm font-medium">{{ scopeLabel(scope) }}</h3>
                        <Badge
                            v-if="scope.inSync"
                            variant="secondary"
                            data-testid="role-preset-drift-scope-in-sync"
                        >
                            {{ t("settings.presetsDriftInSync") }}
                        </Badge>
                    </div>

                    <div class="mt-2 space-y-2 text-xs">
                        <div
                            v-for="bucket in bucketsOf(scope)"
                            :key="bucket.key"
                            :data-testid="`role-preset-drift-bucket-${bucket.key}`"
                        >
                            <p class="font-medium text-muted-foreground">{{ bucket.label }}</p>
                            <p v-if="bucket.atoms.length === 0" class="text-muted-foreground">
                                {{ t("settings.presetsDriftEmptyBucket") }}
                            </p>
                            <ul v-else class="flex flex-wrap gap-1">
                                <li
                                    v-for="atom in bucket.atoms"
                                    :key="`${bucket.key}-${atom.actionClass}-${atom.resource}`"
                                    class="rounded bg-muted px-1.5 py-0.5"
                                    :data-testid="`role-preset-drift-atom-${bucket.key}`"
                                >
                                    <span>{{ atomLabel(atom) }}</span>
                                    <span
                                        class="ml-1 font-mono text-[10px] text-muted-foreground"
                                        >{{ atom.resource }}</span
                                    >
                                </li>
                            </ul>
                        </div>
                    </div>
                </section>
            </template>

            <DialogFooter>
                <Button
                    variant="ghost"
                    data-testid="role-preset-drift-close"
                    @click="emit('close')"
                >
                    {{ t("settings.presetsDriftClose") }}
                </Button>
                <Button
                    v-if="canManageRoles"
                    variant="outline"
                    data-testid="role-preset-drift-refresh"
                    :disabled="loading"
                    @click="loadComparison"
                >
                    <LoaderCircle v-if="loading" class="animate-spin" aria-hidden="true" />
                    {{ t("settings.presetsDriftRefresh") }}
                </Button>
                <Button
                    v-if="canManageRoles && comparison && summary && summary.changed && !confirming"
                    data-testid="role-preset-drift-realign"
                    :disabled="realigning"
                    @click="confirming = true"
                >
                    {{ t("settings.presetsDriftRealign") }}
                </Button>
            </DialogFooter>

            <div
                v-if="confirming && summary"
                data-testid="role-preset-drift-confirm"
                class="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs"
            >
                <p class="font-medium">{{ t("settings.presetsDriftRealignConfirmTitle") }}</p>
                <p class="mt-1 text-muted-foreground">
                    {{
                        t("settings.presetsDriftRealignConfirmBody", {
                            missing: summary.missing,
                            extra: summary.extra,
                        })
                    }}
                </p>
                <div class="mt-2 flex gap-2">
                    <Button
                        variant="ghost"
                        data-testid="role-preset-drift-confirm-cancel"
                        @click="confirming = false"
                    >
                        {{ t("settings.presetsDriftCancel") }}
                    </Button>
                    <Button
                        data-testid="role-preset-drift-confirm-realigned"
                        :disabled="realigning"
                        @click="confirmRealign"
                    >
                        <LoaderCircle v-if="realigning" class="animate-spin" aria-hidden="true" />
                        {{ t("settings.presetsDriftRealignConfirm") }}
                    </Button>
                </div>
            </div>
        </DialogContent>
    </Dialog>
</template>
