<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
    type ApiRole,
    type ApiRoleAtom,
    type ApiRoleCatalog,
    type ApiRoleWrite,
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
 * PLAN-0610 W5b: create / edit one access role.
 *
 * The atom list is **entirely** driven by `GET /roles/catalog` — the UI keeps no vocabulary of its
 * own, so adding an atom on the CP side shows up here without a front-end change. Atoms are grouped
 * by the catalog's `scopeClass`:
 *
 * - `instance` — only meaningful on an instance binding (`capability` atoms and the instance-only
 *   action atoms); the group says so;
 * - `both` — work on instance *and* workspace bindings.
 *
 * System roles are display-name-only: CP answers `409 SYSTEM_ROLE_IMMUTABLE` for anything else, so
 * the dialog disables the name and the atoms instead of letting the user walk into that refusal.
 */
const props = defineProps<{
    open: boolean;
    /** null = create */
    role: ApiRole | null;
    catalog: ApiRoleCatalog | null;
    saving: boolean;
}>();
const emit = defineEmits<{
    close: [];
    submit: [payload: ApiRoleWrite];
}>();

const { t } = useI18n();

const name = ref(""),
    displayName = ref(""),
    description = ref(""),
    selectedAtoms = ref<string[]>([]),
    error = ref("");

const isSystem = computed(() => props.role?.system === true);
const title = computed(() =>
    props.role ? t("settings.rolesEditorEditTitle") : t("settings.rolesEditorCreateTitle"),
);

const instanceAtoms = computed<ApiRoleAtom[]>(
    () => props.catalog?.atoms.filter((atom) => atom.scopeClass === "instance") ?? [],
);
const bothAtoms = computed<ApiRoleAtom[]>(
    () => props.catalog?.atoms.filter((atom) => atom.scopeClass === "both") ?? [],
);

function reset() {
    const role = props.role;
    name.value = role?.name ?? "";
    displayName.value = role?.displayName ?? "";
    description.value = role?.description ?? "";
    selectedAtoms.value = role ? role.atoms.map((atom) => atom.name) : [];
    error.value = "";
}

watch(
    () => [props.open, props.role?.id] as const,
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

function submit() {
    error.value = "";
    const trimmedName = name.value.trim();
    if (!props.role && !trimmedName) {
        error.value = t("settings.rolesEditorNameRequired");
        return;
    }
    if (!displayName.value.trim()) {
        error.value = t("settings.rolesEditorDisplayNameRequired");
        return;
    }
    if (!props.role && selectedAtoms.value.length === 0) {
        error.value = t("settings.rolesEditorAtomsRequired");
        return;
    }
    // PATCH is partial: null means "unchanged". A system role only ever sends the display name, so
    // the request cannot carry a forbidden field even if the template was tampered with.
    const payload: ApiRoleWrite = props.role
        ? isSystem.value
            ? { displayName: displayName.value.trim(), description: description.value.trim() }
            : {
                  name: trimmedName,
                  displayName: displayName.value.trim(),
                  description: description.value.trim(),
                  atoms: [...selectedAtoms.value],
              }
        : {
              name: trimmedName,
              displayName: displayName.value.trim(),
              description: description.value.trim(),
              atoms: [...selectedAtoms.value],
          };
    emit("submit", payload);
}

defineExpose({ error });
</script>

<template>
    <Dialog :open="open" @update:open="(value) => !value && emit('close')">
        <DialogContent data-testid="role-editor-dialog" class="max-w-2xl">
            <DialogHeader>
                <DialogTitle>{{ title }}</DialogTitle>
                <DialogDescription>{{ t("settings.rolesEditorSubtitle") }}</DialogDescription>
            </DialogHeader>

            <div class="space-y-3">
                <label class="block text-xs text-muted-foreground">
                    {{ t("settings.rolesEditorName") }}
                    <Input
                        v-model="name"
                        data-testid="role-editor-name"
                        class="mt-1"
                        :disabled="isSystem"
                        :placeholder="t('settings.rolesEditorNamePlaceholder')"
                    />
                </label>
                <label class="block text-xs text-muted-foreground">
                    {{ t("settings.rolesEditorDisplayName") }}
                    <Input
                        v-model="displayName"
                        data-testid="role-editor-display-name"
                        class="mt-1"
                    />
                </label>
                <label class="block text-xs text-muted-foreground">
                    {{ t("settings.rolesEditorDescription") }}
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
                    {{ t("settings.rolesEditorSystemHint") }}
                </p>

                <fieldset
                    v-if="catalog"
                    data-testid="role-editor-atoms"
                    class="space-y-3 rounded border p-3"
                    :disabled="isSystem"
                >
                    <legend class="px-1 text-xs text-muted-foreground">
                        {{ t("settings.rolesEditorAtoms") }}
                    </legend>

                    <div data-testid="role-editor-atoms-instance">
                        <p class="mb-1 text-xs font-medium">
                            {{ t("settings.rolesEditorGroupInstance") }}
                        </p>
                        <p class="mb-2 text-xs text-muted-foreground">
                            {{ t("settings.rolesEditorGroupInstanceHint") }}
                        </p>
                        <div class="grid gap-1 sm:grid-cols-2">
                            <label
                                v-for="atom in instanceAtoms"
                                :key="atom.name"
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
                                <span class="font-mono text-[11px] text-muted-foreground">
                                    {{ atom.name }}
                                </span>
                                <span v-if="atom.capability" class="text-xs text-muted-foreground">
                                    {{ t("settings.rolesEditorCapabilityBadge") }}
                                </span>
                            </label>
                        </div>
                    </div>

                    <div data-testid="role-editor-atoms-both">
                        <p class="mb-1 text-xs font-medium">
                            {{ t("settings.rolesEditorGroupBoth") }}
                        </p>
                        <p class="mb-2 text-xs text-muted-foreground">
                            {{ t("settings.rolesEditorGroupBothHint") }}
                        </p>
                        <div class="grid gap-1 sm:grid-cols-2">
                            <label
                                v-for="atom in bothAtoms"
                                :key="atom.name"
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
                                <span class="font-mono text-[11px] text-muted-foreground">
                                    {{ atom.name }}
                                </span>
                            </label>
                        </div>
                    </div>
                </fieldset>

                <p
                    v-if="!catalog"
                    data-testid="role-editor-catalog-missing"
                    class="text-xs text-destructive"
                >
                    {{ t("settings.rolesEditorCatalogUnavailable") }}
                </p>

                <p v-if="error" data-testid="role-editor-error" class="text-xs text-destructive">
                    {{ error }}
                </p>
            </div>

            <DialogFooter>
                <Button variant="ghost" @click="emit('close')">{{
                    t("settings.rolesCancel")
                }}</Button>
                <Button
                    data-testid="role-editor-submit"
                    :disabled="saving || !catalog"
                    :title="!catalog ? t('settings.rolesCreateDisabledNoCatalog') : undefined"
                    @click="submit"
                >
                    <LoaderCircle v-if="saving" class="animate-spin" aria-hidden="true" />
                    {{ t("settings.rolesSave") }}
                </Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>
</template>
