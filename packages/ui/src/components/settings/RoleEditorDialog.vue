<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
    type ApiPreset,
    type ApiPresetAtom,
    type ApiPresetAtomInput,
    type ApiPresetCatalog,
    type ApiPresetWrite,
} from "../../composables/api";
import Dialog from "../ui/dialog/Dialog.vue";
import DialogContent from "../ui/dialog/DialogContent.vue";
import DialogHeader from "../ui/dialog/DialogHeader.vue";
import DialogTitle from "../ui/dialog/DialogTitle.vue";
import DialogDescription from "../ui/dialog/DialogDescription.vue";
import DialogFooter from "../ui/dialog/DialogFooter.vue";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Checkbox } from "../ui/checkbox";
import { LoaderCircle } from "@lucide/vue";

/**
 * PLAN-0610 W5b: create / edit one grant preset.
 *
 * The atom list is **entirely** driven by `GET /presets/catalog` — the UI keeps no vocabulary of its
 * own, so adding an atom on the CP side shows up here without a front-end change. Atoms are grouped
 * by the catalog's `scopeClass`:
 *
 * - `instance` — only meaningful on an instance binding (`capability` atoms and the instance-only
 *   action atoms); the group says so;
 * - `both` — work on instance *and* workspace bindings.
 *
 * System presets are display-name-only: CP answers `409 SYSTEM_ROLE_IMMUTABLE` for anything else, so
 * the dialog disables the name and the atoms instead of letting the user walk into that refusal.
 */
const props = defineProps<{
    open: boolean;
    /** null = create */
    preset: ApiPreset | null;
    catalog: ApiPresetCatalog | null;
    saving: boolean;
    /**
     * task-126：「用当前工作区」按钮预填的 uuid（`auth.currentWorkspaceId`，取不到就不显示按钮）。
     * 只做省粘贴，**不当校验**：输入框仍然接受任意文本，不存在的 uuid 要能一路走到 CP 拿到
     * `404 WORKSPACE_NOT_FOUND` 原文 —— 在 UI 里先拦住就等于替 CP 改口径。
     */
    currentWorkspaceId?: string | null;
}>();
const emit = defineEmits<{
    close: [];
    submit: [payload: ApiPresetWrite];
}>();

const { t } = useI18n();

const name = ref(""),
    displayName = ref(""),
    description = ref(""),
    selectedAtoms = ref<string[]>([]),
    /**
     * task-126：每个原子「资源前缀」输入的原文（键 = 原子名，值 = 用户所见所输）。
     * 空/缺键 ⇒ 该原子不收窄，提交裸串（CP 落 canonical `*`）。
     */
    atomResources = reactive<Record<string, string>>({}),
    error = ref("");

const isSystem = computed(() => props.preset?.system === true);
const title = computed(() =>
    props.preset ? t("settings.presetsEditorEditTitle") : t("settings.presetsEditorCreateTitle"),
);

/**
 * task-416 P1-3（D-1312）：原子目录条目多，平铺找不到东西。条目数以 GET /presets/catalog 返回为准，
 * 本文件不复制该数（D-1767；旧写「79 条」从未属实——词表规模演进见 PermissionAtomCatalog.java）。
 * **只过滤可见集，不动 selectedAtoms** —— 搜索是视图操作，不是选择操作。
 * 被否决候选：换成 vendor `Command`（CommandItem 是**单选菜单项**语义，会把「多选原子」
 * 变成「单选触发」，a11y 与既有 toggle 交互都要重做）；这里保留多选 checkbox 列表，
 * 只加一个 vendor 输入框，过滤逻辑是 name/displayName 的大小写不敏感子串匹配。
 */
const atomQuery = ref("");

function matchesAtomQuery(atom: ApiPresetAtom): boolean {
    const query = atomQuery.value.trim().toLowerCase();
    if (!query) return true;
    return (
        atom.name.toLowerCase().includes(query) ||
        (atom.displayName ?? "").toLowerCase().includes(query)
    );
}

const instanceAtoms = computed<ApiPresetAtom[]>(() =>
    (props.catalog?.atoms ?? []).filter(
        (atom) => atom.scopeClass === "instance" && matchesAtomQuery(atom),
    ),
);
const bothAtoms = computed<ApiPresetAtom[]>(() =>
    (props.catalog?.atoms ?? []).filter(
        (atom) => atom.scopeClass === "both" && matchesAtomQuery(atom),
    ),
);
const noAtomMatches = computed(
    () =>
        Boolean(props.catalog) &&
        atomQuery.value.trim() !== "" &&
        instanceAtoms.value.length === 0 &&
        bothAtoms.value.length === 0,
);

/**
 * 服务端对该授权预设**实际存的**资源前缀，只收窄过的（canonical `*` 不是收窄）。
 * 用途有二：编辑时回填输入框；行内标一句「这是当前生效的前缀」，让用户在改之前看清基线。
 */
const storedResources = computed<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const atom of props.preset?.atoms ?? []) {
        if (atom.resource && atom.resource !== "*") map[atom.name] = atom.resource;
    }
    return map;
});

function reset() {
    const preset = props.preset;
    name.value = preset?.name ?? "";
    displayName.value = preset?.displayName ?? "";
    description.value = preset?.description ?? "";
    selectedAtoms.value = preset ? preset.atoms.map((atom) => atom.name) : [];
    for (const atomName of Object.keys(atomResources)) delete atomResources[atomName];
    for (const [atomName, resource] of Object.entries(storedResources.value)) {
        atomResources[atomName] = resource;
    }
    atomQuery.value = "";
    error.value = "";
}

watch(
    () => [props.open, props.preset?.id] as const,
    () => {
        if (props.open) reset();
    },
    { immediate: true },
);

function toggleAtom(atomName: string) {
    if (isSystem.value) return;
    selectedAtoms.value = selectedAtoms.value.includes(atomName)
        ? selectedAtoms.value.filter((name_) => name_ !== atomName)
        : [...selectedAtoms.value, atomName];
}

/**
 * task-126：一个原子最终的 wire 形态。**输入框留空 = 不收窄 ⇒ 仍送裸串**，与 task-126 之前的
 * 请求字节完全一致（CP 的 `GrantResourcePattern.resolve` 对 null/blank 返回 canonical `*`），
 * 所以老行为不受影响；只有用户真填了前缀才切成对象形态。
 */
function atomWire(atomName: string): string | ApiPresetAtomInput {
    const resource = (atomResources[atomName] ?? "").trim();
    return resource ? { actionClass: atomName, resource } : atomName;
}

/** 「用当前工作区」：只把 `fs:<uuid>` 填进去省粘贴（`fs:<uuid>` 本身合法 = 收窄到整个工作区）。 */
function useCurrentWorkspace(atomName: string) {
    const workspaceId = props.currentWorkspaceId;
    if (!workspaceId) return;
    atomResources[atomName] = `fs:${workspaceId}`;
}

/** 该行在服务端当前生效的前缀（没有则空串 = 整域）。 */
function storedResource(atomName: string): string {
    return storedResources.value[atomName] ?? "";
}

function submit() {
    error.value = "";
    const trimmedName = name.value.trim();
    if (!props.preset && !trimmedName) {
        error.value = t("settings.presetsEditorNameRequired");
        return;
    }
    if (!displayName.value.trim()) {
        error.value = t("settings.presetsEditorDisplayNameRequired");
        return;
    }
    if (!props.preset && selectedAtoms.value.length === 0) {
        error.value = t("settings.presetsEditorAtomsRequired");
        return;
    }
    // PATCH is partial: null means "unchanged". A system preset only ever sends the display name, so
    // the request cannot carry a forbidden field even if the template was tampered with.
    const payload: ApiPresetWrite = props.preset
        ? isSystem.value
            ? { displayName: displayName.value.trim(), description: description.value.trim() }
            : {
                  name: trimmedName,
                  displayName: displayName.value.trim(),
                  description: description.value.trim(),
                  atoms: selectedAtoms.value.map(atomWire),
              }
        : {
              name: trimmedName,
              displayName: displayName.value.trim(),
              description: description.value.trim(),
              atoms: selectedAtoms.value.map(atomWire),
          };
    emit("submit", payload);
}

defineExpose({ error });
</script>

<template>
    <Dialog :open="open" @update:open="(value) => !value && emit('close')">
        <DialogContent
            width="config"
            data-testid="role-editor-dialog"
            class="max-h-[85vh] overflow-y-auto"
        >
            <DialogHeader>
                <DialogTitle>{{ title }}</DialogTitle>
                <DialogDescription>{{ t("settings.presetsEditorSubtitle") }}</DialogDescription>
            </DialogHeader>

            <div class="space-y-3">
                <label class="block text-xs text-muted-foreground">
                    {{ t("settings.presetsEditorName") }}
                    <Input
                        v-model="name"
                        data-testid="role-editor-name"
                        class="mt-1"
                        :disabled="isSystem"
                        :placeholder="t('settings.presetsEditorNamePlaceholder')"
                    />
                </label>
                <label class="block text-xs text-muted-foreground">
                    {{ t("settings.presetsEditorDisplayName") }}
                    <Input
                        v-model="displayName"
                        data-testid="role-editor-display-name"
                        class="mt-1"
                    />
                </label>
                <label class="block text-xs text-muted-foreground">
                    {{ t("settings.presetsEditorDescription") }}
                    <Textarea
                        v-model="description"
                        data-testid="role-editor-description"
                        class="mt-1"
                        rows="2"
                    />
                </label>

                <p
                    v-if="isSystem"
                    data-testid="role-editor-system-hint"
                    class="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs"
                >
                    {{ t("settings.presetsEditorSystemHint") }}
                </p>

                <fieldset
                    v-if="catalog"
                    data-testid="role-editor-atoms"
                    class="space-y-3 rounded border p-3"
                    :disabled="isSystem"
                >
                    <legend class="px-1 text-xs text-muted-foreground">
                        {{ t("settings.presetsEditorAtoms") }}
                    </legend>

                    <!-- task-416 P1-3：只过滤可见集，多选语义与 toggle 路径保持不变。 -->
                    <Input
                        v-model="atomQuery"
                        type="search"
                        class="mb-2 h-8 text-sm"
                        data-testid="role-editor-atom-search"
                        :placeholder="t('settings.presetsEditorAtomSearch')"
                        :aria-label="t('settings.presetsEditorAtomSearch')"
                    />
                    <p
                        v-if="noAtomMatches"
                        class="mb-2 text-xs text-muted-foreground"
                        data-testid="role-editor-atoms-no-match"
                    >
                        {{ t("settings.presetsEditorAtomNoMatch") }}
                    </p>
                    <div data-testid="role-editor-atoms-instance">
                        <p class="mb-1 text-xs font-medium">
                            {{ t("settings.presetsEditorGroupInstance") }}
                        </p>
                        <p class="mb-2 text-xs text-muted-foreground">
                            {{ t("settings.presetsEditorGroupInstanceHint") }}
                        </p>
                        <div class="grid gap-1 sm:grid-cols-2">
                            <div v-for="atom in instanceAtoms" :key="atom.name" class="space-y-0.5">
                                <label
                                    class="flex items-center gap-2 text-sm"
                                    :data-testid="`role-editor-atom-${atom.name}`"
                                >
                                    <Checkbox
                                        :model-value="selectedAtoms.includes(atom.name)"
                                        :disabled="isSystem"
                                        @update:model-value="toggleAtom(atom.name)"
                                    />
                                    <!-- D51-37: 标签由服务端按 ?locale 解析，UI 不自建词表；wire 名保留为次级信息 -->
                                    <span class="text-sm">{{ atom.displayName ?? atom.name }}</span>
                                    <span class="font-mono text-xs text-muted-foreground">
                                        {{ atom.name }}
                                    </span>
                                    <span
                                        v-if="atom.capability"
                                        class="text-xs text-muted-foreground"
                                    >
                                        {{ t("settings.presetsEditorCapabilityBadge") }}
                                    </span>
                                </label>
                                <!-- task-126: 只有 both 作用域的原子能收窄；这两组不显示输入框，但要说明理由，不做静默丢弃 -->
                                <p
                                    v-if="selectedAtoms.includes(atom.name)"
                                    class="ml-6 text-xs text-muted-foreground"
                                >
                                    {{
                                        atom.capability
                                            ? t("settings.presetsEditorCapabilityNoResource")
                                            : t("settings.presetsEditorInstanceNoResource")
                                    }}
                                </p>
                            </div>
                        </div>
                    </div>

                    <div data-testid="role-editor-atoms-both">
                        <p class="mb-1 text-xs font-medium">
                            {{ t("settings.presetsEditorGroupBoth") }}
                        </p>
                        <p class="mb-2 text-xs text-muted-foreground">
                            {{ t("settings.presetsEditorGroupBothHint") }}
                        </p>
                        <div class="grid gap-2 sm:grid-cols-2">
                            <div v-for="atom in bothAtoms" :key="atom.name" class="space-y-1">
                                <label
                                    class="flex items-center gap-2 text-sm"
                                    :data-testid="`role-editor-atom-${atom.name}`"
                                >
                                    <Checkbox
                                        :model-value="selectedAtoms.includes(atom.name)"
                                        :disabled="isSystem"
                                        @update:model-value="toggleAtom(atom.name)"
                                    />
                                    <!-- D51-37: 标签由服务端按 ?locale 解析，UI 不自建词表；wire 名保留为次级信息 -->
                                    <span class="text-sm">{{ atom.displayName ?? atom.name }}</span>
                                    <span class="font-mono text-xs text-muted-foreground">
                                        {{ atom.name }}
                                    </span>
                                </label>
                                <!-- task-126: 留空 = 整域（送裸串，与旧客户端同字节）；填了就原样送，UI 不做本地预校验，
                                     否则 CP 的 400/404/403 原文到不了用户。 -->
                                <div
                                    v-if="selectedAtoms.includes(atom.name)"
                                    class="ml-6 space-y-1"
                                    :data-testid="`role-editor-atom-resource-block-${atom.name}`"
                                >
                                    <div class="flex items-center gap-2">
                                        <Input
                                            v-model="atomResources[atom.name]"
                                            class="h-8 font-mono text-xs"
                                            :data-testid="`role-editor-atom-resource-${atom.name}`"
                                            :placeholder="
                                                t('settings.presetsEditorResourcePlaceholder')
                                            "
                                            :aria-label="t('settings.presetsEditorResourceLabel')"
                                        />
                                        <Button
                                            v-if="currentWorkspaceId"
                                            type="button"
                                            variant="ghost"
                                            size="xs"
                                            class="shrink-0"
                                            :data-testid="`role-editor-atom-use-workspace-${atom.name}`"
                                            @click.prevent="useCurrentWorkspace(atom.name)"
                                        >
                                            {{ t("settings.presetsEditorResourceUseWorkspace") }}
                                        </Button>
                                    </div>
                                    <p class="text-xs text-muted-foreground">
                                        {{ t("settings.presetsEditorResourceHint") }}
                                    </p>
                                    <p
                                        v-if="storedResource(atom.name)"
                                        class="text-xs text-muted-foreground"
                                    >
                                        {{ t("settings.presetsEditorResourceEffective") }}:
                                        <span class="font-mono">{{
                                            storedResource(atom.name)
                                        }}</span>
                                    </p>
                                </div>
                            </div>
                        </div>
                    </div>
                </fieldset>

                <p
                    v-if="!catalog"
                    data-testid="role-editor-catalog-missing"
                    class="text-xs text-destructive"
                >
                    {{ t("settings.presetsEditorCatalogUnavailable") }}
                </p>

                <p v-if="error" data-testid="role-editor-error" class="text-xs text-destructive">
                    {{ error }}
                </p>
            </div>

            <DialogFooter>
                <Button variant="ghost" @click="emit('close')">{{
                    t("settings.presetsCancel")
                }}</Button>
                <Button
                    data-testid="role-editor-submit"
                    :disabled="saving || !catalog"
                    :title="!catalog ? t('settings.presetsCreateDisabledNoCatalog') : undefined"
                    @click="submit"
                >
                    <LoaderCircle v-if="saving" class="animate-spin" aria-hidden="true" />
                    {{ t("settings.presetsSave") }}
                </Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>
</template>
