<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AlertCircle, CheckCircle2, LoaderCircle } from "@lucide/vue";

import type { SkillImportRequestPayload, SkillImportResultPayload } from "../../composables/api";
import { logger } from "../../lib/logger";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import {
    buildPersonalSkillCreateRequest,
    mapSkillImportError,
    SKILL_REJECTION_I18N_KEYS,
} from "./skillImport";

/**
 * `task-312` · **个人层专用**的「新建技能」对话框（裁定 A：不新增 REST 端点，复用
 * `POST /skills/import` 提交**一条**）。
 *
 * <p><b>为什么名字里有 `Personal`</b>：这个对话框只对 `definitionScope={type:"user"}` 成立 —— 归属人
 * 由 CP 从 token 取（P-189-1），`definition_scope_id` 连字段都没有。实例层没有"新建"入口（实例库
 * 由目录导入/catalog 维护），所以把"个人层专用"写进**文件名**而不是注释里：谁想把它接到实例层，
 * 第一眼就该看见这五个字母。</p>
 *
 * <p><b>两条会翻车的点（本组件的全部理由）</b>：</p>
 * <ol>
 *   <li><b>请求体永不出现 `definition_scope_id` / `trusted`</b>：前者类型上没有（`user` 分支无 id）；
 *       后者个人层连 `false` 都整批 400（`SkillController.refusePersonalTrusted`）⇒ 本组件没有这两个
 *       输入，payload 由 {@link buildPersonalSkillCreateRequest} 生成，单测直接断言"键不存在"。</li>
 *   <li><b>失败绝不静默</b>：请求级失败走 {@link mapSkillImportError}（CP 英文 `detail` 只进 logger）；
 *       **200 也可能是"什么都没建"** —— 单条被拒时 `rejected[0]` 就是结论，此时**不关窗**、就地给原因；
 *       `unchanged`（同名同正文）如实说"没有做任何修改"，**不报"已创建"**。</li>
 * </ol>
 *
 * <p>同名覆盖确认：CP 的 upsert 键是 `(name, scopeType, scopeId)`（`SkillImportService:30-32`），
 * 同名**不同正文会直接覆盖**且旧版本不可恢复 ⇒ 提交前用面板已加载的列表比对一次，命中就弹确认框，
 * 文案里必须同时出现"会更新它（版本 +1）"与"原内容不可恢复"（只说"同名已存在"会被读成合并/另存）。</p>
 */
const props = defineProps<{
    open: boolean;
    submit: (payload: SkillImportRequestPayload) => Promise<SkillImportResultPayload>;
    /** 面板已加载的个人技能（只读快照）：用于同名覆盖确认，不参与提交。 */
    existing?: ReadonlyArray<{ name: string; version: number }>;
}>();

const emit = defineEmits<{
    "update:open": [boolean];
    imported: [SkillImportResultPayload];
}>();

const { t } = useI18n();

const name = ref("");
const description = ref("");
const body = ref("");
const submitting = ref(false);
const draftError = ref<{
    code: string;
    field: "name" | "description" | "body" | "sourcePath";
} | null>(null);
const requestError = ref<ReturnType<typeof mapSkillImportError> | null>(null);
/**
 * 上一次提交的"非成功"结论（逐条拒绝 / 未变）。成功（created/updated）会直接关窗，不进这里 ——
 * 关窗即成功是本组件唯一允许的"静默"，因为它不是静默：列表会刷新出行。
 */
const outcome = ref<null | { kind: "rejected"; code: string } | { kind: "unchanged" }>(null);
/** 等确认的同名覆盖：`payload` 先算好，确认后原样提交（不在确认路径上重新校验一次）。 */
const pendingOverwrite = ref<{
    name: string;
    version: number;
    payload: SkillImportRequestPayload;
} | null>(null);

const canSubmit = computed(() => !submitting.value);

/** 逐条拒绝的措辞与导入/实例面板**同一张码表**（不另造说法）。 */
function rejectedReason(code: string): string {
    const key = SKILL_REJECTION_I18N_KEYS[code];
    return key
        ? t(`settings.skills.import.rejected.${key}`)
        : t("settings.skills.import.rejected.unknown", { code });
}

function reset(): void {
    name.value = "";
    description.value = "";
    body.value = "";
    draftError.value = null;
    requestError.value = null;
    outcome.value = null;
    pendingOverwrite.value = null;
    submitting.value = false;
}

/** 关闭即清空：下次打开是干净表单，别把上一次的报错留在屏幕上。 */
watch(
    () => props.open,
    (open) => {
        if (!open) reset();
    },
);

function close(): void {
    emit("update:open", false);
}

/** 提交前的同名探测：命中即弹确认，**不**先把请求发出去。 */
function findExistingVersion(candidate: string): number | null {
    const hit = props.existing?.find((row) => row.name === candidate);
    return hit ? hit.version : null;
}

async function performSubmit(payload: SkillImportRequestPayload): Promise<void> {
    submitting.value = true;
    requestError.value = null;
    outcome.value = null;
    try {
        const result = await props.submit(payload);
        if (result.summary.created > 0 || result.summary.updated > 0) {
            // 成功：关窗 + 让面板重取列表（不乐观插入，版本号是服务端算的）。
            emit("imported", result);
            close();
            return;
        }
        if (result.rejected.length > 0) {
            // 单条新建被拒 = 什么都没写；原因必须留在屏幕上，且窗不关。
            outcome.value = { kind: "rejected", code: result.rejected[0].code };
            emit("imported", result);
            return;
        }
        if (result.summary.unchanged > 0) {
            // 同名同正文：CP 什么都没改。**不许**说"已创建"。
            outcome.value = { kind: "unchanged" };
            emit("imported", result);
            return;
        }
        outcome.value = { kind: "rejected", code: "UNKNOWN" };
        emit("imported", result);
    } catch (cause) {
        // 英文 detail 只进日志；上屏走本地化映射（AGENTS.md：不得直显 CP 英文 detail）。
        logger.warn(
            "Personal skill create failed: " +
                (cause instanceof Error ? cause.message : String(cause)),
        );
        requestError.value = mapSkillImportError(cause);
    } finally {
        submitting.value = false;
    }
}

async function onSubmit(): Promise<void> {
    if (submitting.value) return;
    const draft = buildPersonalSkillCreateRequest({
        name: name.value,
        description: description.value,
        body: body.value,
    });
    if (!draft.ok) {
        // 本地预检：名字不合法 / 描述为空 / **正文 trim 后为空**一律不发请求（省一次往返 + 一条脏数据）。
        draftError.value = { code: draft.code, field: draft.field };
        requestError.value = null;
        outcome.value = null;
        return;
    }
    draftError.value = null;
    const existingVersion = findExistingVersion(name.value);
    if (existingVersion !== null) {
        pendingOverwrite.value = {
            name: name.value,
            version: existingVersion,
            payload: draft.payload,
        };
        return;
    }
    await performSubmit(draft.payload);
}

async function confirmOverwrite(): Promise<void> {
    const pending = pendingOverwrite.value;
    pendingOverwrite.value = null;
    if (!pending) return;
    await performSubmit(pending.payload);
}

const draftErrorField = computed(() => draftError.value?.field ?? null);
const draftErrorReason = computed(() =>
    draftError.value ? rejectedReason(draftError.value.code) : "",
);
</script>

<template>
    <Dialog :open="open" @update:open="(next: boolean) => emit('update:open', next)">
        <DialogContent data-testid="personal-skill-create-dialog" class="max-w-2xl sm:max-w-2xl">
            <DialogHeader>
                <DialogTitle data-testid="personal-skill-create-title">
                    {{ t("resources.skills.create.title") }}
                </DialogTitle>
                <DialogDescription>
                    {{ t("resources.skills.create.description") }}
                </DialogDescription>
            </DialogHeader>

            <div class="space-y-3">
                <div class="space-y-1">
                    <Label for="personal-skill-create-name">
                        {{ t("resources.skills.create.nameLabel") }}
                    </Label>
                    <Input
                        id="personal-skill-create-name"
                        v-model="name"
                        data-testid="personal-skill-create-name"
                        :aria-invalid="draftErrorField === 'name'"
                        spellcheck="false"
                    />
                    <p class="text-xs text-muted-foreground">
                        {{ t("resources.skills.create.nameHint") }}
                    </p>
                    <p
                        v-if="draftErrorField === 'name'"
                        data-testid="personal-skill-create-name-error"
                        class="text-xs text-destructive"
                    >
                        {{ draftErrorReason }}
                    </p>
                </div>

                <div class="space-y-1">
                    <Label for="personal-skill-create-description">
                        {{ t("resources.skills.create.descriptionLabel") }}
                    </Label>
                    <Input
                        id="personal-skill-create-description"
                        v-model="description"
                        data-testid="personal-skill-create-description"
                        :aria-invalid="draftErrorField === 'description'"
                    />
                    <p class="text-xs text-muted-foreground">
                        {{ t("resources.skills.create.descriptionHint") }}
                    </p>
                    <p
                        v-if="draftErrorField === 'description'"
                        data-testid="personal-skill-create-description-error"
                        class="text-xs text-destructive"
                    >
                        {{ draftErrorReason }}
                    </p>
                </div>

                <div class="space-y-1">
                    <Label for="personal-skill-create-body">
                        {{ t("resources.skills.create.bodyLabel") }}
                    </Label>
                    <Textarea
                        id="personal-skill-create-body"
                        v-model="body"
                        data-testid="personal-skill-create-body"
                        :rows="10"
                        spellcheck="false"
                        class="min-h-48 text-xs"
                        :aria-invalid="draftErrorField === 'body'"
                    />
                    <p class="text-xs text-muted-foreground">
                        {{ t("resources.skills.create.bodyHint") }}
                    </p>
                    <p
                        v-if="draftErrorField === 'body'"
                        data-testid="personal-skill-create-body-error"
                        class="text-xs text-destructive"
                    >
                        {{ draftErrorReason }}
                    </p>
                </div>

                <Alert
                    v-if="requestError"
                    data-testid="personal-skill-create-request-error"
                    variant="destructive"
                >
                    <AlertCircle aria-hidden="true" />
                    <AlertTitle data-testid="personal-skill-create-request-error-title">
                        {{
                            t(
                                `settings.skills.import.error.${requestError.slug}.title`,
                                requestError.params,
                            )
                        }}
                    </AlertTitle>
                    <AlertDescription>
                        <p data-testid="personal-skill-create-request-error-body">
                            {{
                                t(
                                    `settings.skills.import.error.${requestError.slug}.body`,
                                    requestError.params,
                                )
                            }}
                        </p>
                        <p
                            data-testid="personal-skill-create-request-error-code"
                            class="mt-1 font-mono text-xs text-muted-foreground"
                        >
                            {{ t("settings.skills.import.errorCode", { code: requestError.code }) }}
                        </p>
                    </AlertDescription>
                </Alert>

                <Alert
                    v-if="outcome"
                    data-testid="personal-skill-create-outcome"
                    :variant="outcome.kind === 'rejected' ? 'destructive' : 'default'"
                >
                    <CheckCircle2 v-if="outcome.kind === 'unchanged'" aria-hidden="true" />
                    <AlertCircle v-else aria-hidden="true" />
                    <AlertTitle data-testid="personal-skill-create-outcome-title">
                        {{
                            outcome.kind === "unchanged"
                                ? t("resources.skills.create.unchangedTitle")
                                : t("resources.skills.create.rejectedTitle")
                        }}
                    </AlertTitle>
                    <AlertDescription>
                        <p
                            v-if="outcome.kind === 'unchanged'"
                            data-testid="personal-skill-create-outcome-body"
                        >
                            {{ t("resources.skills.create.unchanged") }}
                        </p>
                        <template v-else>
                            <p data-testid="personal-skill-create-outcome-body">
                                {{ rejectedReason(outcome.code) }}
                            </p>
                            <p class="text-xs">
                                {{ t("resources.skills.create.rejectedNote") }}
                            </p>
                        </template>
                    </AlertDescription>
                </Alert>
            </div>

            <DialogFooter>
                <Button variant="outline" data-testid="personal-skill-create-cancel" @click="close">
                    {{ t("resources.skills.create.cancel") }}
                </Button>
                <Button
                    data-testid="personal-skill-create-submit"
                    :disabled="!canSubmit"
                    @click="onSubmit"
                >
                    <LoaderCircle
                        v-if="submitting"
                        class="size-3.5 animate-spin"
                        aria-hidden="true"
                    />
                    {{
                        submitting
                            ? t("resources.skills.create.submitting")
                            : t("resources.skills.create.submit")
                    }}
                </Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>

    <!-- 同名覆盖确认：文案必须同时说出"会更新"与"不可恢复"，否则会被读成合并或另存。 -->
    <AlertDialog
        :open="pendingOverwrite !== null"
        @update:open="(next: boolean) => (pendingOverwrite = next ? pendingOverwrite : null)"
    >
        <AlertDialogContent data-testid="personal-skill-create-confirm">
            <AlertDialogHeader>
                <AlertDialogTitle>
                    {{ t("resources.skills.create.sameNameTitle") }}
                </AlertDialogTitle>
                <AlertDialogDescription data-testid="personal-skill-create-confirm-body">
                    {{
                        t("resources.skills.create.sameNameBody", {
                            name: pendingOverwrite?.name ?? "",
                            version: pendingOverwrite?.version ?? 0,
                        })
                    }}
                </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
                <AlertDialogCancel data-testid="personal-skill-create-confirm-cancel">
                    {{ t("resources.skills.create.cancel") }}
                </AlertDialogCancel>
                <!--
                    故意不用 `AlertDialogAction`：它点下即无条件关闭，而关闭会先同步把
                    `pendingOverwrite` 清空（`@update:open`），我们自己的 click 再读就已经是 null ——
                    实测表现是"点了确认但一个请求都没发"（监听顺序依赖，见 packages/ui/AGENTS.md
                    的 Reka 交互陷阱）。这里用普通 Button 显式控制关闭顺序：先取 payload 再关再提交。
                -->
                <Button
                    variant="destructive"
                    data-testid="personal-skill-create-confirm-action"
                    @click="confirmOverwrite"
                >
                    {{ t("resources.skills.create.sameNameConfirm") }}
                </Button>
            </AlertDialogFooter>
        </AlertDialogContent>
    </AlertDialog>
</template>
