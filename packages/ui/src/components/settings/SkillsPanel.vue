<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { AlertCircle, ChevronDown, LoaderCircle, Upload } from "@lucide/vue";

import { api, type SkillDefinitionSummary } from "../../composables/api";
import { logger } from "../../lib/logger";
import { useAuthStore } from "../../stores/auth";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import ResourceDetailLink from "../resources/ResourceDetailLink.vue";
import SkillsImportDialog from "./SkillsImportDialog.vue";

/**
 * task-83 / task-167 · 实例层「技能」列表 + 导入写面。
 *
 * <p>读面的口径（task-83，未变）：openapi `listSkills` 原文「Instance-scope definitions are
 * visible to every authenticated caller」—— 登录即可读，所以**读面不挂权限门**；列表不返回正文，
 * 展开才 `?includeBody=true` 单取。</p>
 *
 * <p>写面（task-167）：`POST /api/v1/skills/import` 是技能定义的**唯一写入口**。CP 的闸门是
 * **实例域原子 `MANAGE_SKILL_LIBRARY`**（`SkillAccessGuard.canManageInstanceLibrary()`，N5；
 * 不是粗粒度 `cap:instance:admin`）⇒ UI 用 `auth.hasInstanceAtom("MANAGE_SKILL_LIBRARY")` 判，
 * 与 CP 同源。**无权时入口不隐藏而是置灰 + 写清理由**：隐藏会让人以为产品没有导入能力。</p>
 */
const { t, locale } = useI18n();
const auth = useAuthStore();

const skills = ref<SkillDefinitionSummary[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);

/** 每行的展开态与正文缓存（正文只取一次；同一个 id 不重复请求）。 */
const open = reactive<Record<string, boolean>>({});
const bodies = reactive<Record<string, { loading: boolean; text: string | null; error: boolean }>>(
    {},
);

const importOpen = ref(false);

/** 写权限：与 CP 同一个原子（fail-closed —— atom 投影还没到就当作无权限）。 */
const canImport = computed(() => auth.hasInstanceAtom("MANAGE_SKILL_LIBRARY"));

const countLabel = computed(() => t("settings.skills.count", { count: skills.value.length }));

function formatTime(iso: string | null): string {
    if (!iso) return "—";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(locale.value, {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(date);
}

function scopeKeyOf(skill: SkillDefinitionSummary): string {
    return skill.definitionScope?.type === "workspace" ? "badgeWorkspace" : "badgeInstance";
}

async function load() {
    loading.value = true;
    loadError.value = null;
    try {
        skills.value = await api.listSkillDefinitions();
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logger.warn("Failed to load skill definitions: " + message);
        loadError.value = message;
    } finally {
        loading.value = false;
    }
}

/**
 * 展开/收起。首次展开才取正文 —— 这样 21 条定义打开页面时只发 1 个请求，
 * 而不是 N 个「反正要展开」的预取（正文是最大的列，见 openapi `getSkill` 的说明）。
 */
async function toggleBody(skill: SkillDefinitionSummary) {
    const id = skill.skillId;
    open[id] = !open[id];
    if (!open[id]) return;
    const cached = bodies[id];
    if (cached && (cached.text !== null || cached.loading)) return;
    bodies[id] = { loading: true, text: null, error: false };
    try {
        const detail = await api.getSkillDefinition(id, true);
        bodies[id] = { loading: false, text: detail?.body ?? null, error: false };
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logger.warn(`Failed to load skill body ${id}: ` + message);
        bodies[id] = { loading: false, text: null, error: true };
    }
}

/** 导入 = CP 的唯一写入口；成功/逐条拒绝的展示在对话框里，面板只负责刷新列表。 */
function submitImport(payload: Parameters<typeof api.importSkillDefinitions>[0]) {
    return api.importSkillDefinitions(payload);
}

/**
 * 导入成功后刷新列表即可：**不乐观插入**。`action=created/updated/unchanged` 与
 * `bodyTokensEst/version` 全是服务端算的，前端插一行就等于自己编版本号。
 */
async function onImported() {
    await load();
}

onMounted(() => {
    // 写权限来自原子投影（`GET /me/permissions`），单飞、失败 fail-closed；
    // 无权时入口仍渲染（置灰 + 理由），所以这里不需要等待结果才挂页面。
    void auth.ensureSelfPermissions();
    void load();
});
</script>

<template>
    <section data-testid="settings-skills-panel" class="space-y-4">
        <header class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 data-testid="settings-skills-heading" class="text-base font-medium">
                {{ t("settings.skills.title") }}
            </h2>
            <span data-testid="settings-skills-count" class="text-xs text-muted-foreground">
                {{ countLabel }}
            </span>
            <div class="ml-auto flex flex-wrap items-center gap-2">
                <!--
                    task-167：**入口恒在**，无权时置灰而不是隐藏 —— 隐藏会让人以为是产品缺口。
                    `aria-describedby` 指向下面那条理由，读屏用户也能拿到「为什么点不了」。
                -->
                <Button
                    data-testid="settings-skills-import"
                    size="sm"
                    :disabled="!canImport"
                    :aria-describedby="canImport ? undefined : 'settings-skills-import-reason'"
                    :title="
                        canImport
                            ? t('settings.skills.import.entryHint')
                            : t('settings.skills.import.disabledReason')
                    "
                    @click="importOpen = true"
                >
                    <Upload class="size-3.5" aria-hidden="true" />
                    {{ t("settings.skills.import.entry") }}
                </Button>
            </div>
        </header>
        <p
            v-if="!canImport"
            id="settings-skills-import-reason"
            data-testid="settings-skills-import-disabled-reason"
            class="text-xs leading-5 text-muted-foreground"
        >
            {{ t("settings.skills.import.disabledReason") }}
        </p>
        <p class="text-xs leading-5 text-muted-foreground">{{ t("settings.skills.subtitle") }}</p>

        <div
            v-if="loading"
            data-testid="settings-skills-loading"
            class="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"
        >
            <LoaderCircle class="size-4 animate-spin" aria-hidden="true" />
            {{ t("settings.skills.loading") }}
        </div>

        <div
            v-else-if="loadError"
            data-testid="settings-skills-error"
            class="flex flex-col items-center gap-2 py-8 text-sm text-destructive"
        >
            <AlertCircle class="size-6" aria-hidden="true" />
            <p>{{ t("settings.skills.errorTitle") }}</p>
            <p class="text-xs">{{ loadError }}</p>
            <Button variant="outline" size="sm" data-testid="settings-skills-retry" @click="load">
                {{ t("settings.skills.retry") }}
            </Button>
        </div>

        <div
            v-else-if="!skills.length"
            data-testid="settings-skills-empty"
            class="rounded-lg border border-dashed border-border px-4 py-8 text-center"
        >
            <p class="text-sm font-medium">{{ t("settings.skills.emptyTitle") }}</p>
            <p class="mt-1 text-xs text-muted-foreground">{{ t("settings.skills.emptyBody") }}</p>
        </div>

        <ul v-else class="space-y-2">
            <li
                v-for="skill in skills"
                :key="skill.skillId"
                :data-testid="`skill-item-${skill.skillId}`"
                class="rounded-lg border border-border bg-card px-3 py-2.5"
            >
                <div class="flex flex-wrap items-center gap-2">
                    <span class="text-sm font-medium">{{ skill.name }}</span>
                    <Badge variant="secondary" class="text-[11px] font-normal">
                        {{ t(`settings.skills.${scopeKeyOf(skill)}`) }}
                    </Badge>
                    <Badge
                        v-if="skill.oversize"
                        variant="outline"
                        :data-testid="`skill-oversize-${skill.skillId}`"
                        class="border-amber-500/40 text-[11px] font-normal text-amber-700 dark:text-amber-400"
                    >
                        {{ t("settings.skills.badgeOversize") }}
                    </Badge>
                    <Badge
                        v-if="skill.trusted"
                        variant="outline"
                        :data-testid="`skill-trusted-${skill.skillId}`"
                        class="text-[11px] font-normal"
                    >
                        {{ t("settings.skills.badgeTrusted") }}
                    </Badge>
                    <!-- task-228：行尾详情入口（纯增量链接；本面板恒为实例层）。 -->
                    <ResourceDetailLink
                        resource-id="skills"
                        layer="INSTANCE"
                        :pk="skill.skillId"
                        :name="skill.name"
                    />
                </div>

                <p
                    v-if="skill.description"
                    class="mt-1 text-[13px] leading-5 text-muted-foreground"
                >
                    {{ skill.description }}
                </p>

                <p class="mt-1 text-xs text-muted-foreground">
                    <span>{{ t("settings.skills.metaVersion", { version: skill.version }) }}</span>
                    <span class="mx-1.5 text-border">·</span>
                    <span>{{
                        t("settings.skills.metaTokens", { count: skill.bodyTokensEst })
                    }}</span>
                    <span class="mx-1.5 text-border">·</span>
                    <span>{{
                        t("settings.skills.metaUpdated", { time: formatTime(skill.updatedAt) })
                    }}</span>
                    <template v-if="skill.attachments.length">
                        <span class="mx-1.5 text-border">·</span>
                        <span>{{
                            t("settings.skills.attachments", { count: skill.attachments.length })
                        }}</span>
                    </template>
                </p>
                <p class="mt-0.5 truncate text-xs text-muted-foreground" :title="skill.sourcePath">
                    {{ t("settings.skills.metaSource", { path: skill.sourcePath }) }}
                </p>

                <Collapsible
                    :open="Boolean(open[skill.skillId])"
                    class="mt-2"
                    @update:open="toggleBody(skill)"
                >
                    <CollapsibleTrigger as-child>
                        <Button
                            variant="ghost"
                            size="sm"
                            :data-testid="`skill-body-toggle-${skill.skillId}`"
                            class="h-7 px-2 text-xs"
                        >
                            <ChevronDown
                                class="size-3.5 transition-transform"
                                :class="{ 'rotate-180': Boolean(open[skill.skillId]) }"
                                aria-hidden="true"
                            />
                            {{
                                open[skill.skillId]
                                    ? t("settings.skills.hideBody")
                                    : t("settings.skills.showBody")
                            }}
                        </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                        <div
                            :data-testid="`skill-body-${skill.skillId}`"
                            class="mt-1 rounded-md border border-border bg-muted/30 px-3 py-2"
                        >
                            <p
                                v-if="bodies[skill.skillId]?.loading"
                                class="text-xs text-muted-foreground"
                            >
                                {{ t("settings.skills.bodyLoading") }}
                            </p>
                            <p
                                v-else-if="bodies[skill.skillId]?.error"
                                class="text-xs text-destructive"
                            >
                                {{ t("settings.skills.bodyFailed") }}
                            </p>
                            <p
                                v-else-if="!bodies[skill.skillId]?.text"
                                class="text-xs text-muted-foreground"
                            >
                                {{ t("settings.skills.bodyEmpty") }}
                            </p>
                            <!--
                                正文是**最大的列**（openapi `getSkill`）：`max-h-64` + 滚动，
                                不让一条长定义把整页撑开；`whitespace-pre-wrap` 保留原文换行，
                                `break-words` 防长 token 撑出横向滚动。
                            -->
                            <pre
                                v-else
                                :aria-label="t('settings.skills.bodyAriaLabel')"
                                class="max-h-64 overflow-auto text-xs leading-5 whitespace-pre-wrap break-words text-foreground"
                                >{{ bodies[skill.skillId]?.text }}</pre>
                        </div>
                    </CollapsibleContent>
                </Collapsible>
            </li>
        </ul>

        <p class="text-xs leading-5 text-muted-foreground">
            {{ t("settings.skills.readOnlyNote") }}
        </p>

        <SkillsImportDialog
            :open="importOpen"
            :submit="submitImport"
            @update:open="importOpen = $event"
            @imported="onImported"
        />
    </section>
</template>
