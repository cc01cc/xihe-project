<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AlertCircle, CheckCircle2, LoaderCircle } from "@lucide/vue";

import type { SkillImportRequestPayload, SkillImportResultPayload } from "../../composables/api";
import { logger } from "../../lib/logger";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import {
    SKILL_IMPORT_MAX_BATCH,
    SKILL_REJECTION_I18N_KEYS,
    mapSkillImportError,
    parseSkillImportDraft,
    type SkillImportTargetScope,
} from "./skillImport";

/**
 * task-167 · 实例层「导入技能」对话框（技能定义的**唯一写面**）。
 *
 * <p>契约事实（`docs/api/openapi.yaml` 的 `importSkills`）：请求体是 **JSON 批**
 * `{definitionScope, skills[]}`（≤64 条），不是 zip/md 上传 —— 所以这里给的是「选一个 .json
 * 定义批 / 直接粘贴」两条等价入口，**不做包解压**（解包 + frontmatter 解析属另一个契约面，
 * 且本仓禁止手写成熟格式 parser）。</p>
 *
 * <p>三条错误口径：</p>
 * <ul>
 *   <li><b>请求级失败</b>（整批 400/403/401）走 {@link mapSkillImportError} 的 i18n 映射，每条都给
 *       「下一步能做什么」；**CP 的英文 `detail` 只进 logger，不上屏**。</li>
 *   <li><b>逐条拒绝</b>（`rejected[].code`）用同一张码表渲染，且明写「批里其它条目已生效」——
 *       否则用户会以为整批没导进去，重复提交。</li>
 *   <li><b>本地预检</b>产生的码与 CP 稳定枚举同名同译（见 `skillImport.ts`），不另造一套说法。</li>
 * </ul>
 *
 * <p>依赖注入：`submit` 由调用方给（面板传 `api.importSkillDefinitions`；预览页传 mock），
 * 这样单测与 mock 预览都不需要真的网络，组件自身不发请求。</p>
 */
const props = defineProps<{
    open: boolean;
    submit: (payload: SkillImportRequestPayload) => Promise<SkillImportResultPayload>;
    /**
     * 目标层（`T2b.3`）：决定预检接受的 `definitionScope.type`，也决定样例 JSON 里写哪一个。
     * 缺省 `instance`（既有调用点不变）；个人技能库传 `user`。
     */
    scope?: SkillImportTargetScope;
}>();

const emit = defineEmits<{
    "update:open": [boolean];
    imported: [SkillImportResultPayload];
}>();

const { t } = useI18n();

const targetScope = computed<SkillImportTargetScope>(() => props.scope ?? "instance");

/**
 * 输入框里的样例是**代码**不是文案，所以不做 i18n（也避免 vue-i18n 把 JSON 里的花括号当插值参数）。
 * 字段与 openapi `SkillImportRequest` 一致：记账字段（contentHash/bodyTokensEst/oversize/version）
 * 一律不填 —— 服务端算，客户端塞了也会被忽略。
 *
 * <p>作用域随页面层走：个人层样例写 `{"type":"user"}`（**没有 id 字段** —— 归属人由服务端从
 * 登录态取，见 P-189-1），并且**不出现 `trusted`**（个人层带这个键整批 400）。</p>
 */
const jsonSample = computed(() =>
    [
        "{",
        `  "definitionScope": { "type": "${targetScope.value}" },`,
        '  "skills": [',
        "    {",
        '      "name": "commit-msg-review",',
        '      "description": "按仓库提交规范检查 commit message",',
        '      "body": "……SKILL.md 去掉 frontmatter 之后的正文……",',
        '      "sourcePath": "skills/commit-msg-review/SKILL.md"',
        "    }",
        "  ]",
        "}",
    ].join("\n"),
);

const jsonText = ref("");
const fileError = ref<string | null>(null);
const draftError = ref<{ code: string; hint?: string } | null>(null);
const submitting = ref(false);
const error = ref<ReturnType<typeof mapSkillImportError> | null>(null);
const result = ref<SkillImportResultPayload | null>(null);

const canSubmit = computed(() => !submitting.value && jsonText.value.trim() !== "");

/** 关闭即清空：下次打开是干净表单，别把上一次的报错留在屏幕上。 */
watch(
    () => props.open,
    (open) => {
        if (open) return;
        jsonText.value = "";
        fileError.value = null;
        draftError.value = null;
        error.value = null;
        result.value = null;
        submitting.value = false;
    },
);

function close() {
    emit("update:open", false);
}

async function onFile(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    fileError.value = null;
    try {
        jsonText.value = await file.text();
        draftError.value = null;
        error.value = null;
        result.value = null;
    } catch (cause) {
        logger.warn(
            "Failed to read skill import file: " +
                (cause instanceof Error ? cause.message : String(cause)),
        );
        fileError.value = "readFailed";
    } finally {
        // 同一个文件连续选两次也要触发，清掉 value。
        input.value = "";
    }
}

function rejectedReason(code: string): string {
    const key = SKILL_REJECTION_I18N_KEYS[code];
    return key
        ? t(`settings.skills.import.rejected.${key}`)
        : t("settings.skills.import.rejected.unknown", { code });
}

async function submitBatch() {
    draftError.value = null;
    error.value = null;
    result.value = null;
    const parsed = parseSkillImportDraft(jsonText.value, targetScope.value);
    if (!parsed.ok) {
        draftError.value = { code: parsed.code, hint: parsed.hint };
        return;
    }
    submitting.value = true;
    try {
        const payload = await props.submit(parsed.payload);
        result.value = payload;
        emit("imported", payload);
    } catch (cause) {
        // 只记英文 detail 到日志；上屏走本地化映射（AGENTS.md：不得直显 CP 英文 detail）。
        logger.warn(
            "Skill import rejected: " + (cause instanceof Error ? cause.message : String(cause)),
        );
        error.value = mapSkillImportError(cause);
    } finally {
        submitting.value = false;
    }
}

const rejectedRows = computed(() =>
    (result.value?.rejected ?? []).map((row) => ({
        code: row.code,
        path: row.sourcePath ?? "—",
        reason: rejectedReason(row.code),
    })),
);
</script>

<template>
    <Dialog :open="open" @update:open="(next: boolean) => emit('update:open', next)">
        <!-- 宽度取 4xl：JSON 批是逐行结构，窄框折行会让人以为自己写错（12 号图实测 385px 时几乎每行都折）。 -->
        <DialogContent data-testid="skills-import-dialog" class="max-w-4xl sm:max-w-4xl">
            <DialogHeader>
                <DialogTitle data-testid="skills-import-title">
                    {{ t("settings.skills.import.title") }}
                </DialogTitle>
                <DialogDescription>
                    {{ t("settings.skills.import.subtitle", { max: SKILL_IMPORT_MAX_BATCH }) }}
                </DialogDescription>
            </DialogHeader>

            <!-- 成功路径：先给"这批发生了什么"，再列被拒的条目（批里其它条目已生效）。 -->
            <div v-if="result" class="space-y-3">
                <Alert data-testid="skills-import-result">
                    <CheckCircle2 aria-hidden="true" />
                    <AlertTitle>{{ t("settings.skills.import.resultTitle") }}</AlertTitle>
                    <AlertDescription>
                        <p data-testid="skills-import-result-summary">
                            {{
                                t("settings.skills.import.resultSummary", {
                                    created: result.summary.created,
                                    updated: result.summary.updated,
                                    unchanged: result.summary.unchanged,
                                    rejected: result.summary.rejected,
                                })
                            }}
                        </p>
                        <p
                            v-if="result.summary.oversize"
                            data-testid="skills-import-result-oversize"
                        >
                            {{
                                t("settings.skills.import.resultOversize", {
                                    count: result.summary.oversize,
                                })
                            }}
                        </p>
                    </AlertDescription>
                </Alert>

                <div
                    v-if="rejectedRows.length"
                    data-testid="skills-import-rejected"
                    class="space-y-1"
                >
                    <p class="text-xs font-medium text-foreground">
                        {{
                            t("settings.skills.import.rejectedTitle", {
                                count: rejectedRows.length,
                            })
                        }}
                    </p>
                    <p class="text-xs text-muted-foreground">
                        {{ t("settings.skills.import.rejectedNote") }}
                    </p>
                    <ul class="space-y-1">
                        <li
                            v-for="row in rejectedRows"
                            :key="`${row.path}-${row.code}`"
                            :data-testid="`skills-import-rejected-${row.code}`"
                            class="rounded-md border border-border px-2 py-1 text-xs"
                        >
                            <span class="text-muted-foreground">{{ row.path }}</span>
                            <span class="mx-1 text-border">·</span>
                            <span>{{ row.reason }}</span>
                            <span class="ml-1 font-mono text-[10px] text-muted-foreground">
                                {{ row.code }}
                            </span>
                        </li>
                    </ul>
                </div>
            </div>

            <!-- 表单路径 -->
            <div v-else class="space-y-3">
                <div class="space-y-1">
                    <label class="text-xs font-medium" for="skills-import-file">
                        {{ t("settings.skills.import.fileLabel") }}
                    </label>
                    <input
                        id="skills-import-file"
                        data-testid="skills-import-file"
                        type="file"
                        accept=".json,application/json"
                        class="block w-full text-xs text-muted-foreground file:mr-2 file:rounded file:border file:border-border file:bg-background file:px-2 file:py-1 file:text-xs"
                        @change="onFile"
                    />
                    <p class="text-[11px] text-muted-foreground">
                        {{ t("settings.skills.import.fileHint") }}
                    </p>
                    <p
                        v-if="fileError"
                        data-testid="skills-import-file-error"
                        class="text-xs text-destructive"
                    >
                        {{ t(`settings.skills.import.rejected.${fileError}`) }}
                    </p>
                </div>

                <div class="space-y-1">
                    <label class="text-xs font-medium" for="skills-import-json">
                        {{ t("settings.skills.import.jsonLabel") }}
                    </label>
                    <!-- 示例放在框**外面**：放进 placeholder 时它长得像"已经填好的内容"，
                        用户会直接点提交（12 号图自审的第一条）。示例是 **代码**，不经过 i18n。 -->
                    <p class="text-[11px] font-medium text-muted-foreground">
                        {{ t("settings.skills.import.exampleLabel") }}
                    </p>
                    <pre
                        data-testid="skills-import-example"
                        class="whitespace-pre-wrap break-all rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] leading-4 text-muted-foreground"
                        >{{ jsonSample }}</pre>
                    <p class="text-[11px] text-muted-foreground">
                        {{ t("settings.skills.import.exampleHint") }}
                    </p>
                    <Textarea
                        id="skills-import-json"
                        v-model="jsonText"
                        data-testid="skills-import-json"
                        :rows="10"
                        spellcheck="false"
                        class="min-h-56 whitespace-pre font-mono text-xs"
                        :placeholder="t('settings.skills.import.jsonPlaceholder')"
                    />
                </div>

                <Alert
                    v-if="draftError"
                    data-testid="skills-import-draft-error"
                    variant="destructive"
                >
                    <AlertCircle aria-hidden="true" />
                    <AlertTitle>{{ t("settings.skills.import.draftErrorTitle") }}</AlertTitle>
                    <AlertDescription>
                        <p data-testid="skills-import-draft-error-reason">
                            {{ rejectedReason(draftError.code) }}
                        </p>
                        <p
                            v-if="draftError.hint"
                            data-testid="skills-import-draft-error-hint"
                            class="text-xs"
                        >
                            {{
                                t("settings.skills.import.draftErrorHint", {
                                    hint: draftError.hint,
                                })
                            }}
                        </p>
                    </AlertDescription>
                </Alert>

                <Alert v-if="error" data-testid="skills-import-error" variant="destructive">
                    <AlertCircle aria-hidden="true" />
                    <AlertTitle data-testid="skills-import-error-title">
                        {{ t(`settings.skills.import.error.${error.slug}.title`, error.params) }}
                    </AlertTitle>
                    <AlertDescription>
                        <p data-testid="skills-import-error-body">
                            {{ t(`settings.skills.import.error.${error.slug}.body`, error.params) }}
                        </p>
                        <p data-testid="skills-import-error-action" class="text-xs">
                            {{
                                t(`settings.skills.import.error.${error.slug}.action`, error.params)
                            }}
                        </p>
                        <p
                            data-testid="skills-import-error-code"
                            class="mt-1 font-mono text-[10px] text-muted-foreground"
                        >
                            {{ t("settings.skills.import.errorCode", { code: error.code }) }}
                        </p>
                    </AlertDescription>
                </Alert>

                <ul class="space-y-1 text-[11px] leading-4 text-muted-foreground">
                    <li data-testid="skills-import-hint-idempotent">
                        · {{ t("settings.skills.import.hintIdempotent") }}
                    </li>
                    <li data-testid="skills-import-hint-oversize">
                        · {{ t("settings.skills.import.hintOversize") }}
                    </li>
                    <li data-testid="skills-import-hint-permission">
                        · {{ t("settings.skills.import.hintPermission") }}
                    </li>
                </ul>
            </div>

            <DialogFooter>
                <Button variant="outline" data-testid="skills-import-close" @click="close">
                    {{
                        result
                            ? t("settings.skills.import.close")
                            : t("settings.skills.import.cancel")
                    }}
                </Button>
                <Button
                    v-if="!result"
                    data-testid="skills-import-submit"
                    :disabled="!canSubmit"
                    @click="submitBatch"
                >
                    <LoaderCircle
                        v-if="submitting"
                        class="size-3.5 animate-spin"
                        aria-hidden="true"
                    />
                    {{
                        submitting
                            ? t("settings.skills.import.submitting")
                            : t("settings.skills.import.submit")
                    }}
                </Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>
</template>
