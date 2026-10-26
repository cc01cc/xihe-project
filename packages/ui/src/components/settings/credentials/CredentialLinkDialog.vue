<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { LoaderCircle } from "@lucide/vue";
import Dialog from "../../ui/dialog/Dialog.vue";
import DialogContent from "../../ui/dialog/DialogContent.vue";
import DialogHeader from "../../ui/dialog/DialogHeader.vue";
import DialogTitle from "../../ui/dialog/DialogTitle.vue";
import DialogDescription from "../../ui/dialog/DialogDescription.vue";
import DialogFooter from "../../ui/dialog/DialogFooter.vue";
import { Button } from "../../ui/button";
import { listProviderConnections, updateProviderConnection } from "../../../services/providerConnectionService";
import type { ProviderConnection } from "../../../types/providerConnection";

const props = withDefaults(
    defineProps<{
        open: boolean;
        credentialId: string;
        credentialLabel?: string;
    }>(),
    { open: false, credentialLabel: "" },
);

const emit = defineEmits<{
    close: [];
    linked: [];
}>();

const { t } = useI18n();
const connections = ref<ProviderConnection[]>([]),
    loading = ref(false),
    linkingId = ref<string | null>(null),
    error = ref("");

watch(
    () => props.open,
    async (open) => {
        if (!open) return;
        loading.value = true;
        error.value = "";
        linkingId.value = null;
        try {
            const result = await listProviderConnections();
            connections.value = result.connections ?? [];
        } catch (e) {
            error.value = e instanceof Error ? e.message : String(e);
            connections.value = [];
        } finally {
            loading.value = false;
        }
    },
    { immediate: true },
);

async function link(connection: ProviderConnection) {
    linkingId.value = connection.id;
    error.value = "";
    try {
        await updateProviderConnection(connection.id, {
            credentialId: props.credentialId,
            expectedRevision: connection.revision,
        });
        toast.success(t("credentials.linkSuccess"));
        emit("linked");
        emit("close");
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    } finally {
        linkingId.value = null;
    }
}
</script>

<template>
    <Dialog :open="open" @update:open="(value: boolean) => !value && emit('close')">
        <DialogContent class="max-w-2xl" data-testid="credentials-link-dialog">
            <DialogHeader>
                <DialogTitle>{{ t("credentials.linkTitle") }}</DialogTitle>
                <DialogDescription>
                    {{ t("credentials.linkDesc", { label: credentialLabel }) }}
                </DialogDescription>
            </DialogHeader>

            <div
                v-if="error"
                data-testid="credentials-link-error"
                class="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
            >
                {{ error }}
            </div>

            <div v-if="loading" class="p-4 text-sm text-muted-foreground">
                {{ t("common.loading") }}
            </div>
            <div
                v-else-if="connections.length === 0"
                class="p-4 text-sm text-muted-foreground"
                data-testid="credentials-link-empty"
            >
                {{ t("credentials.linkEmpty") }}
            </div>
            <ul v-else class="max-h-80 divide-y divide-border overflow-y-auto">
                <li
                    v-for="connection in connections"
                    :key="connection.id"
                    class="flex flex-wrap items-center justify-between gap-3 px-1 py-2"
                    :data-testid="`credentials-link-row-${connection.id}`"
                >
                    <div class="min-w-0">
                        <p class="truncate text-sm font-medium">
                            {{ connection.label }}
                        </p>
                        <p class="text-xs text-muted-foreground">
                            {{ connection.providerId }} · {{ connection.connectionKey }} ·
                            {{ connection.scope }}
                        </p>
                    </div>
                    <div class="flex items-center gap-2">
                        <span
                            v-if="connection.credentialId === credentialId"
                            class="text-xs text-muted-foreground"
                        >
                            {{ t("credentials.linkCurrent") }}
                        </span>
                        <span
                            v-else-if="connection.credentialId"
                            class="text-xs text-amber-700"
                        >
                            {{ t("credentials.linkOther") }}
                        </span>
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            :disabled="linkingId !== null"
                            :data-testid="`credentials-link-${connection.id}`"
                            @click="link(connection)"
                        >
                            <LoaderCircle
                                v-if="linkingId === connection.id"
                                class="animate-spin"
                                aria-hidden="true"
                            />
                            {{ t("credentials.linkAction") }}
                        </Button>
                    </div>
                </li>
            </ul>

            <DialogFooter>
                <Button type="button" variant="outline" @click="emit('close')">
                    {{ t("common.cancel") }}
                </Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>
</template>
