<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { AlertCircle, LoaderCircle, Plus, Upload } from "@lucide/vue";

import {
    api,
    type SkillDefinitionSummary,
    type SkillImportResultPayload,
} from "../../composables/api";
import { logger } from "../../lib/logger";
import { useAuthStore } from "../../stores/auth";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import ResourceDetailLink from "./ResourceDetailLink.vue";
import PersonalSkillCreateDialog from "../settings/PersonalSkillCreateDialog.vue";
import SkillsImportDialog from "../settings/SkillsImportDialog.vue";
import { SKILL_REJECTION_I18N_KEYS } from "../settings/skillImport";

/**
 * `T2b.3` · 技能「我的技能」（`USER` 层）面板 —— 个人技能库的读面 + 唯一写面入口。
 *
 * <p><b>为什么单独一份而不是复用 `SkillsPanel`</b>（Lead 2026-11-12 裁定）：复用会把
 * `trusted` / `oversize` 两枚徽标的语义强行带进个人层，而 `trusted` 在个人层**恒 false 且由 CP
 * 拒绝**（`refusePersonalTrusted` 连 `false` 都整批 400，P-189-1）—— 复用得越像，越容易哪天顺手
 * 让它发出去。零回归面比 DRY 值钱。</p>
 *
 * <p><b>三条硬口径：</b></p>
 * <ul>
 *   <li><b>读面不挂原子</b>：`GET /skills?definitionScope=user` 只按登录态取自己的行
 *       （`openapi.yaml:5465`「takes no id (the caller is the owner)」，
 *       `SkillLibraryService.list:52-61` 只拒 `workspaceId`、没有账权检查）。P-189-3 明写
 *       **撤销 `MANAGE_PERSONAL_SKILLS` 之后读仍开放** ⇒ 本面板照常取数、照常渲染列表。</li>
 *   <li><b>写面按原子判、无权不隐藏</b>：两个写入口「新建技能」与「导入技能」恒在，无权时 `disabled`
 *       + 理由点名 `MANAGE_PERSONAL_SKILLS`，并明写读面不受该原子限制 —— 隐藏会让人以为产品没有这个能力，
 *       而只置灰不说原因会让人以为是自己操作错了。「新建」走 `POST /skills/import` 的**单条**批
 *       （`task-312` 裁定 A：不为 REST 手感新增端点）。</li>
 *   <li><b>`trusted` 永不出现</b>：请求体不带（本地预检也会拦，见 `skillImport.ts`），
 *       行上也不渲染该徽标 —— 个人层没有这个维度。</li>
 * </ul>
 */
const { t, locale } = useI18n();
const auth = useAuthStore();

const skills = ref<SkillDefinitionSummary[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);
const importOpen = ref(false);
/** `task-312` · 「新建」对话框（单条，裁定 A：复用 `POST /skills/import` 的 `type=user`）。 */
const createOpen = ref(false);
/** 上一次导入的结果（成功与逐条拒绝都在这里；对话框关掉后页面仍能看到结论）。 */
const lastImport = ref<SkillImportResultPayload | null>(null);

/**
 * 写权限：与 CP 同源（`SkillAccessGuard` 认 `MANAGE_PERSONAL_SKILLS`，`ToolFaceRegistry.java:87`），
 * fail-closed —— 原子投影还没到就当作无权限。
 */
const canImport = computed(() => auth.hasInstanceAtom("MANAGE_PERSONAL_SKILLS"));

const countLabel = computed(() =>
    t("resources.skills.count", { count: visibleSkills.value.length }),
);

/**
 * 只显示**确实属于个人库**的行（`definitionScope.type === "user"` 是契约里判归属的唯一字段）。
 *
 * <p>服务端已按 scope 过滤过（CP 的 user 分支只返回调用者自己的行），这里再挡一层：真栈/夹具出错时，
 * 个人页面上**绝不许**出现实例层或工作区层的行 —— 那不只是"显示错"，而是把别人的定义当成自己的
 * 个人技能（隐私口径比工作区面板更硬）。挡掉的条数必须说出来（静默丢弃 = 用户以为数据完好）。</p>
 */
const visibleSkills = computed(() =>
    skills.value.filter((skill) => skill.definitionScope?.type === "user"),
);
const foreignCount = computed(() => skills.value.length - visibleSkills.value.length);

/**
 * `task-312` · 新建对话框的同名覆盖确认只需要 `(name, version)`：面板已加载的列表就是权威快照
 * （`version` 是服务端算的，本地不猜）。命中同名时由对话框弹确认，文案里要能说出"当前版本 vN"。
 */
const existingPersonalSkills = computed(() =>
    visibleSkills.value.map((skill) => ({ name: skill.name, version: skill.version })),
);

function formatTime(iso: string | null): string {
    if (!iso) return "—";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(locale.value, {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(date);
}

/** 逐条拒绝的措辞与实例面板同一张表（CP 稳定枚举码 ⇒ i18n），不另造说法。 */
function rejectedReason(code: string): string {
    const key = SKILL_REJECTION_I18N_KEYS[code];
    return key
        ? t(`settings.skills.import.rejected.${key}`)
        : t("settings.skills.import.rejected.unknown", { code });
}

const rejectedRows = computed(() =>
    (lastImport.value?.rejected ?? []).map((row) => ({
        code: row.code,
        path: row.sourcePath ?? "—",
        reason: rejectedReason(row.code),
    })),
);

async function load(): Promise<void> {
    loading.value = true;
    loadError.value = null;
    try {
        skills.value = await api.listPersonalSkills();
    } catch (cause) {
        // 失败必须说清"读不到"而不是"没有"：空列表会把接口挂了说成没有个人技能。
        skills.value = [];
        loadError.value = cause instanceof Error ? cause.message : String(cause);
        logger.warn("Failed to load personal skills: " + String(cause));
    } finally {
        loading.value = false;
    }
}

/** 写面 = CP 的唯一写入口（`POST /skills/import`，`definitionScope={type:'user'}`）。 */
function submitImport(payload: Parameters<typeof api.importSkillDefinitions>[0]) {
    return api.importSkillDefinitions(payload);
}

/**
 * 导入成功后**重新取列表**，不乐观插入：`action` / `version` / `bodyTokensEst` 全是服务端算的，
 * 前端插一行就等于自己编版本号。逐条拒绝的展示在 `lastImport` 里，页面与对话框都能读到。
 */
async function onImported(result: SkillImportResultPayload): Promise<void> {
    lastImport.value = result;
    await load();
}

onMounted(() => {
    // 原子投影单飞、失败 fail-closed；无权时按钮仍渲染（置灰 + 理由），不需要等它才挂页面。
    void auth.ensureSelfPermissions();
    void load();
});
</script>

<template>
    <section data-testid="personal-skills-panel" class="space-y-4">
        <header class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 data-testid="personal-skills-heading" class="text-base font-medium">
                {{ t("resources.skills.panelMine") }}
            </h2>
            <span data-testid="personal-skills-count" class="text-xs text-muted-foreground">
                {{ countLabel }}
            </span>
            <div class="ml-auto flex flex-wrap items-center gap-2">
                <!-- 两个入口恒在：无权时置灰 + 理由，不隐藏（隐藏 = 让人以为产品没有个人技能库）。
                     「新建」是主 CTA（单条字段表单），「导入」是 JSON 批的次入口。 -->
                <Button
                    data-testid="personal-skills-create"
                    size="sm"
                    :disabled="!canImport"
                    :aria-describedby="canImport ? undefined : 'personal-skills-import-reason'"
                    :title="
                        canImport
                            ? t('resources.skills.create.cta')
                            : t('resources.skills.importDisabledReason')
                    "
                    @click="createOpen = true"
                >
                    <Plus class="size-3.5" aria-hidden="true" />
                    {{ t("resources.skills.create.cta") }}
                </Button>
                <Button
                    data-testid="personal-skills-import"
                    variant="outline"
                    size="sm"
                    :disabled="!canImport"
                    :aria-describedby="canImport ? undefined : 'personal-skills-import-reason'"
                    :title="
                        canImport
                            ? t('resources.skills.importMine')
                            : t('resources.skills.importDisabledReason')
                    "
                    @click="importOpen = true"
                >
                    <Upload class="size-3.5" aria-hidden="true" />
                    {{ t("resources.skills.importMine") }}
                </Button>
            </div>
        </header>
        <p
            v-if="!canImport"
            id="personal-skills-import-reason"
            data-testid="personal-skills-import-disabled-reason"
            class="text-xs leading-5 text-muted-foreground"
        >
            {{ t("resources.skills.importDisabledReason") }}
        </p>
        <p class="text-xs leading-5 text-muted-foreground">
            {{ t("resources.skills.subtitleMine") }}
        </p>
        <p class="text-xs leading-5 text-muted-foreground">
            {{ t("resources.skills.importEntryNote") }}
        </p>
        <!-- 挡掉的行必须说出来：静默丢弃会让用户以为"个人库就这些"。 -->
        <p
            v-if="foreignCount > 0"
            data-testid="personal-skills-foreign-ignored"
            class="text-xs leading-5 text-amber-600 dark:text-amber-500"
        >
            {{ t("resources.skills.foreignIgnored", { count: foreignCount }) }}
        </p>

        <div
            v-if="loading"
            data-testid="personal-skills-loading"
            class="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"
        >
            <LoaderCircle class="size-4 animate-spin" aria-hidden="true" />
            {{ t("resources.skills.loading") }}
        </div>

        <div
            v-else-if="loadError"
            data-testid="personal-skills-error"
            class="flex flex-col items-center gap-2 py-8 text-sm text-destructive"
        >
            <AlertCircle class="size-6" aria-hidden="true" />
            <p>{{ t("resources.skills.loadErrorTitle") }}</p>
            <p class="text-xs text-balance">{{ loadError }}</p>
            <p class="text-xs text-balance text-muted-foreground">
                {{ t("resources.skills.loadErrorBody") }}
            </p>
            <Button variant="outline" size="sm" data-testid="personal-skills-retry" @click="load">
                {{ t("resources.skills.retry") }}
            </Button>
        </div>

        <div
            v-else-if="!visibleSkills.length"
            data-testid="personal-skills-empty"
            class="rounded-lg border border-dashed border-border px-4 py-8 text-center"
        >
            <p class="text-sm font-medium">{{ t("resources.skills.emptyTitle") }}</p>
            <p class="mt-1 text-xs text-muted-foreground">{{ t("resources.skills.emptyBody") }}</p>
        </div>

        <ul v-else class="space-y-2">
            <li
                v-for="skill in visibleSkills"
                :key="skill.skillId"
                :data-testid="`personal-skill-item-${skill.skillId}`"
                class="rounded-lg border border-border bg-card px-3 py-2.5"
            >
                <div class="flex flex-wrap items-center gap-2">
                    <span class="text-sm font-medium">{{ skill.name }}</span>
                    <Badge variant="secondary" class="text-xs font-normal">
                        {{ t("resources.layerUser") }}
                    </Badge>
                    <!-- 个人层没有 trusted 维度（CP 恒存 false 且拒收该键）⇒ 这里**不渲染**该徽标。 -->
                    <Badge
                        v-if="skill.oversize"
                        variant="outline"
                        :data-testid="`personal-skill-oversize-${skill.skillId}`"
                        class="border-amber-500/40 text-xs font-normal text-amber-700 dark:text-amber-400"
                    >
                        {{ t("settings.skills.badgeOversize") }}
                    </Badge>
                    <ResourceDetailLink
                        resource-id="skills"
                        layer="USER"
                        :pk="skill.skillId"
                        :name="skill.name"
                    />
                </div>
                <p class="mt-1 font-mono text-xs break-all text-muted-foreground">
                    {{ skill.skillId }}
                </p>
                <p class="mt-1 text-xs text-muted-foreground">
                    v{{ skill.version }} · {{ skill.bodyTokensEst }} tok ·
                    {{ formatTime(skill.updatedAt) }}
                </p>
            </li>
        </ul>

        <section
            v-if="lastImport"
            data-testid="personal-skills-import-result"
            class="rounded-lg border border-border bg-muted/30 px-3 py-2.5"
        >
            <p class="text-sm font-medium">{{ t("resources.skills.importResultTitle") }}</p>
            <p data-testid="personal-skills-import-summary" class="mt-1 text-xs">
                {{
                    t("resources.skills.importResultLine", {
                        created: lastImport.summary.created,
                        updated: lastImport.summary.updated,
                        unchanged: lastImport.summary.unchanged,
                        rejected: lastImport.summary.rejected,
                        oversize: lastImport.summary.oversize,
                    })
                }}
            </p>
            <p class="mt-1 text-xs text-muted-foreground">
                {{ t("resources.skills.importRefreshed") }}
            </p>
            <template v-if="rejectedRows.length">
                <p class="mt-2 text-xs font-medium">{{ t("resources.skills.rejectedHeading") }}</p>
                <ul class="mt-1 space-y-1">
                    <li
                        v-for="(row, index) in rejectedRows"
                        :key="`${row.code}-${index}`"
                        :data-testid="`personal-skills-rejected-${index}`"
                        class="text-xs text-destructive"
                    >
                        {{
                            t("resources.skills.rejectedRow", {
                                path: row.path,
                                reason: row.reason,
                            })
                        }}
                    </li>
                </ul>
            </template>
        </section>

        <PersonalSkillCreateDialog
            :open="createOpen"
            :submit="submitImport"
            :existing="existingPersonalSkills"
            @update:open="createOpen = $event"
            @imported="onImported"
        />

        <SkillsImportDialog
            :open="importOpen"
            scope="user"
            :submit="submitImport"
            @update:open="importOpen = $event"
            @imported="onImported"
        />
    </section>
</template>
