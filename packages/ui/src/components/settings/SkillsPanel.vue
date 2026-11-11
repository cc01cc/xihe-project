<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { AlertCircle, ChevronDown, LoaderCircle } from "@lucide/vue";

import { api, type SkillDefinitionSummary } from "../../composables/api";
import { logger } from "../../lib/logger";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";

/**
 * task-83 · 实例层「技能」列表（只读）。
 *
 * <p>为什么这一页不用 `SettingsPermissionGate`：<b>读面没有权限原子</b>。openapi `listSkills` 原文
 * 「Instance-scope definitions are visible to every authenticated caller」—— 登录即可读，
 * 不该出现「无 atom」信息条（那会暗示按归属收窄），更不该出现 403。写面（导入/绑定）才有闸门，
 * 而本页不给写入口，所以页内只留一句只读说明。</p>
 *
 * <p>三条口径：</p>
 * <ul>
 *   <li><b>正文不铺满</b>：列表接口**不返回** body（openapi：「The body is never included here」），
 *       展开时才 `?includeBody=true` 单取；容器给 `max-h` + 滚动，长文不把页面撑爆。</li>
 *   <li><b>不推算字段</b>：`bodyTokensEst` 是服务端算的估算值（`codePointCount/2`），前缀写「≈」，
 *       页面上不出现自己算的 token 数；`oversize` 是服务端**标记**（D28-15：只标记、不拒绝、不截断）。</li>
 *   <li><b>不暴露 workspaceId</b>：本页默认只列 instance 定义；若某行是 workspace 私有，只显示
 *       「工作区私有」徽标，**不打印 UUID**（它是内部标识，见 DEV-011 §E 术语）。</li>
 * </ul>
 */
const { t, locale } = useI18n();

const skills = ref<SkillDefinitionSummary[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);

/** 每行的展开态与正文缓存（正文只取一次；同一个 id 不重复请求）。 */
const open = reactive<Record<string, boolean>>({});
const bodies = reactive<Record<string, { loading: boolean; text: string | null; error: boolean }>>(
    {},
);

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

onMounted(load);
</script>

<template>
    <section data-testid="settings-skills-panel" class="space-y-4">
        <header class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 data-testid="settings-skills-heading" class="text-base font-medium">
                {{ t("settings.skills.title") }}
            </h3>
            <span data-testid="settings-skills-count" class="text-xs text-muted-foreground">
                {{ countLabel }}
            </span>
        </header>
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
    </section>
</template>
