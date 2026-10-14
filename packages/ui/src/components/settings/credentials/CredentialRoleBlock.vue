<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useCredentialsStore } from "../../../stores/credentials";

type Permission = { actionClass: string; resource?: string };

const props = defineProps<{
    permissions: Permission[];
}>();

const emit = defineEmits<{
    add: [atoms: Array<{ actionClass: string; resource: string }>];
    remove: [resource: string];
}>();

const { t } = useI18n(),
    store = useCredentialsStore();

const CREDENTIAL_USE_ACTION = "credential_use",
    CREDENTIAL_RESOURCE_PREFIX = "credential:";

const search = ref(""),
    selectedIds = ref<string[]>([]);

const attached = computed(() =>
    props.permissions
        .filter(
            (permission) =>
                permission.actionClass === CREDENTIAL_USE_ACTION &&
                permission.resource?.startsWith(CREDENTIAL_RESOURCE_PREFIX),
        )
        .map((permission) => ({
            resource: permission.resource!,
            id: permission.resource!.slice(CREDENTIAL_RESOURCE_PREFIX.length),
        })),
);

const candidates = computed(() => {
    const query = search.value.trim().toLowerCase();
    return store.credentials.filter(
        (credential) => !query || credential.label.toLowerCase().includes(query),
    );
});

function labelFor(id: string): string {
    return store.credentials.find((credential) => credential.id === id)?.label ?? id;
}

function toggle(id: string) {
    selectedIds.value = selectedIds.value.includes(id)
        ? selectedIds.value.filter((item) => item !== id)
        : [...selectedIds.value, id];
}

function attachSelected() {
    const existing = new Set(attached.value.map((item) => item.id));
    const atoms = store.credentials
        .filter(
            (credential) =>
                selectedIds.value.includes(credential.id) && !existing.has(credential.id),
        )
        .map((credential) => ({
            actionClass: CREDENTIAL_USE_ACTION,
            resource: `${CREDENTIAL_RESOURCE_PREFIX}${credential.id}`,
        }));
    if (atoms.length > 0) emit("add", atoms);
    selectedIds.value = [];
}

onMounted(() => {
    void store.load();
});
</script>

<template>
    <section
        class="space-y-2 rounded-md border border-dashed p-3"
        data-testid="credential-role-block"
    >
        <h5 class="text-sm font-medium">{{ t("credentials.roleBlockTitle") }}</h5>
        <p class="text-xs text-muted-foreground">{{ t("credentials.roleBlockHint") }}</p>

        <ul
            v-if="attached.length > 0"
            class="flex flex-wrap gap-2"
            data-testid="credential-role-attached"
        >
            <li
                v-for="item in attached"
                :key="item.resource"
                class="flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
            >
                <span>{{ labelFor(item.id) }}</span>
                <button
                    type="button"
                    class="text-destructive"
                    :aria-label="t('credentials.roleBlockRemove')"
                    :data-testid="`credential-role-remove-${item.id}`"
                    @click="emit('remove', item.resource)"
                >
                    ×
                </button>
            </li>
        </ul>
        <p v-else class="text-xs text-muted-foreground" data-testid="credential-role-none">
            {{ t("credentials.roleBlockNone") }}
        </p>

        <div class="flex gap-2">
            <input
                v-model="search"
                :aria-label="t('credentials.roleBlockSearch')"
                :placeholder="t('credentials.roleBlockSearch')"
                data-testid="credential-role-search"
                class="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs"
            />
            <button
                type="button"
                class="rounded-md border px-2 py-1 text-xs disabled:opacity-50"
                :disabled="selectedIds.length === 0"
                data-testid="credential-role-attach"
                @click="attachSelected"
            >
                {{ t("credentials.roleBlockAttach") }}
            </button>
        </div>

        <ul
            v-if="candidates.length > 0"
            class="max-h-40 space-y-1 overflow-auto"
            data-testid="credential-role-candidates"
        >
            <li v-for="credential in candidates" :key="credential.id">
                <label class="flex items-center gap-2 text-xs">
                    <input
                        type="checkbox"
                        :checked="selectedIds.includes(credential.id)"
                        :data-testid="`credential-role-option-${credential.id}`"
                        @change="toggle(credential.id)"
                    />
                    <span>{{ credential.label }}</span>
                    <span class="text-muted-foreground">{{
                        credential.deliveryTier === "lease"
                            ? t("credentials.tierLease")
                            : t("credentials.tierReveal")
                    }}</span>
                </label>
            </li>
        </ul>
        <p v-else class="text-xs text-muted-foreground" data-testid="credential-role-empty">
            {{ t("credentials.roleBlockEmpty") }}
        </p>
    </section>
</template>
