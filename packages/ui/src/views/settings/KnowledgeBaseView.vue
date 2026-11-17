<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { logger } from "../../lib/logger";
import { apiDelete, apiGet, apiPost } from "../../composables/api";
import { AlertCircle, LoaderCircle } from "@lucide/vue";

import SettingsPermissionGate from "../../components/settings/SettingsPermissionGate.vue";
import ConfirmModal from "../../components/shared/ConfirmModal.vue";

const { t } = useI18n(),
    files = ref<File[]>([]),
    uploading = ref(false),
    loading = ref(false),
    loadError = ref<string | null>(null),
    documents = ref<Array<{ id: string; filename: string; chunks: number }>>([]);

onMounted(async () => {
    await loadDocuments();
});

async function loadDocuments() {
    loading.value = true;
    loadError.value = null;
    try {
        const data = await apiGet<{
            documents?: Array<{ id: string; filename: string; chunks: number }>;
        }>("/rag/stats");
        documents.value = data.documents ?? [];
    } catch (e) {
        logger.warn("Failed to load documents: " + (e instanceof Error ? e.message : String(e)));
        loadError.value = e instanceof Error ? e.message : "Failed to load documents";
    }
    loading.value = false;
}

async function handleUpload() {
    if (!files.value.length) return;
    uploading.value = true;
    try {
        const form = new FormData();
        form.append("file", files.value[0]);
        await apiPost("/rag/ingest", form);
        files.value = [];
        await loadDocuments();
    } catch (e) {
        logger.warn("Document upload failed: " + (e instanceof Error ? e.message : String(e)));
        loadError.value = e instanceof Error ? e.message : "Upload failed";
    }
    uploading.value = false;
}

/**
 * task-109 站点 17：删除是**一步落盘**（`apiDelete` 直接打 RAG 文档删除），原先既没有确认、
 * 又把红色画在入口上。按 DEV-011:155「这个元素如果消失，用户会误操作吗？」—— 会（文档删除
 * 不可恢复），所以它属于 L4；而 :153 要求 L4 的红**只在确认时出现**。
 * 顺序不能反：先把确认面建起来，红才落到确认键上；只改颜色等于把危险动作藏起来。
 */
const pendingDeleteId = ref<string | null>(null),
    deleteError = ref<string | null>(null),
    deleting = ref(false);

function requestRemoveDoc(id: string) {
    deleteError.value = null;
    pendingDeleteId.value = id;
}

function cancelRemoveDoc() {
    pendingDeleteId.value = null;
}

const pendingDocName = () => {
    const id = pendingDeleteId.value;
    if (!id) return "";
    return documents.value.find((doc) => doc.id === id)?.filename ?? "";
};

async function confirmRemoveDoc() {
    const id = pendingDeleteId.value;
    if (!id || deleting.value) return;
    deleting.value = true;
    try {
        await apiDelete(`/rag/documents/${id}`);
        pendingDeleteId.value = null;
        await loadDocuments();
    } catch (e) {
        logger.warn("Document delete failed: " + (e instanceof Error ? e.message : String(e)));
        deleteError.value = e instanceof Error ? e.message : "Delete failed";
    } finally {
        deleting.value = false;
    }
}
</script>

<template>
    <div class="space-y-4">
        <!-- PLAN-0752 T4.4：RAG 面在 CP 侧只有 isAuthenticated + 租户下传（RagProxyController:74,87,139,166），
             没有 atom ⇒ 信息条，不是 403。 -->
        <SettingsPermissionGate variant="no-atom" />
        <h3 data-testid="settings-knowledge-heading" class="font-medium">
            {{ t("settings.knowledgeBase") }}
        </h3>

        <div
            v-if="loading"
            class="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center"
        >
            <LoaderCircle class="size-4 animate-spin" aria-hidden="true" />
            Loading documents...
        </div>

        <div
            v-else-if="loadError"
            class="flex flex-col items-center gap-2 py-8 text-sm text-destructive"
        >
            <AlertCircle class="size-6" aria-hidden="true" />
            <p>{{ loadError }}</p>
            <button class="text-xs text-primary hover:underline" @click="loadDocuments">
                Retry
            </button>
        </div>

        <div v-else>
            <div
                class="border-2 border-dashed rounded-lg p-6 text-center cursor-pointer hover:border-primary transition-colors"
                @click="($refs.fileInput as HTMLInputElement)?.click()"
            >
                <input
                    ref="fileInput"
                    type="file"
                    accept=".pdf,.txt,.md"
                    class="hidden"
                    @change="files = Array.from(($event.target as HTMLInputElement).files || [])"
                />
                <svg
                    class="w-8 h-8 mx-auto mb-2 text-muted-foreground"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="1.5"
                        d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                    />
                </svg>
                <p class="text-sm text-muted-foreground">
                    拖拽文件到此处或 <span class="text-primary underline">浏览</span>
                </p>
                <p class="text-xs text-muted-foreground mt-1">支持 PDF / TXT / Markdown</p>
            </div>
            <button
                v-if="files.length"
                class="w-full px-3 py-2 rounded bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
                :disabled="uploading"
                @click="handleUpload"
            >
                {{ uploading ? t("common.uploading") : t("common.upload") }}
            </button>

            <div v-if="documents.length" class="space-y-1">
                <div
                    v-for="doc in documents"
                    :key="doc.id"
                    class="flex items-center justify-between py-1 px-3 rounded bg-muted/50 text-sm"
                >
                    <span>{{ doc.filename }} ({{ doc.chunks }} chunks)</span>
                    <!--
                        task-109 站点 17：入口中性（红留给确认键，见 :153）。
                        这里的红不是"装饰"——它标记的是本对话框的终态动作（不可恢复的文档删除）。
                    -->
                    <button
                        class="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        :data-testid="`knowledge-doc-delete-${doc.id}`"
                        @click="requestRemoveDoc(doc.id)"
                    >
                        {{ t("common.delete") }}
                    </button>
                </div>
            </div>
            <p v-else-if="!loading" class="text-xs text-muted-foreground text-center py-8">
                {{ t("settings.noDocuments") }}
            </p>
        </div>

        <ConfirmModal
            :show="pendingDeleteId !== null"
            destructive
            :title="t('common.confirmDelete')"
            :description="`${pendingDocName()} — ${t('settings.knowledgeDeleteWarning')}`"
            :confirm-label="t('common.delete')"
            :cancel-label="t('common.cancel')"
            :loading="deleting"
            @confirm="confirmRemoveDoc"
            @cancel="cancelRemoveDoc"
            @close="cancelRemoveDoc"
        />
        <p v-if="deleteError" class="text-xs text-destructive" data-testid="knowledge-delete-error">
            {{ deleteError }}
        </p>
    </div>
</template>
