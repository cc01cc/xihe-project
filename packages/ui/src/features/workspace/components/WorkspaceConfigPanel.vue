<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { LoaderCircle } from "@lucide/vue";
import ConfigLayerPanels from "../../../components/settings/ConfigLayerPanels.vue";
import { useAuthStore } from "../../../stores/auth";
import { useConfigStore } from "../../../stores/config";

/**
 * 工作区设置页的「配置」tab（PLAN-0773 `M4-1` / `task-190`，形态 `42A`=直连既有端点）。
 *
 * <p><b>为什么只渲染 `layer="workspace"`</b>：这一页要的就是**本工作区这一层**的可写域，
 * 而「哪些域属于这一层」的唯一来源是 `LAYER_DOMAINS`（`stores/config.ts`，CP
 * `WORKSPACE_WRITABLE_DOMAINS` 的镜像）—— 页面**不另写一份域清单**。因此这里没有 v-for
 * 枚举域，也没有任何域名字符串：换域集只改矩阵一处。</p>
 *
 * <p><b>身份从哪来</b>：per-workspace 层不需要新参数，`X-Workspace-Id` 由
 * `composables/api.ts:2441` 按页签工作区上下文自动注入（CP 侧 `ConfigController.java:172-180`
 * 解析）；所以本面板只要保证"当前页签上下文 = URL 里的这个工作区"。</p>
 *
 * <p><b>为什么自己 `loadLayerDomains`</b>：`ConfigLayerPanels` 只在 `layer === "instance"` /
 * 用户层的既有挂载点上自取数（那是它的历史行为，不为本页改造）；工作区层由本页驱动加载，
 * 与 `ConfigSettings.vue` 的实例/用户层同一套 store 方法（`loadLayerDomains`）。</p>
 *
 * <p><b>写权限口径（待确认项，明写不藏）</b>：per-workspace 写面在 CP 侧由工作区角色门
 * （`tasks.md:215` 记的 `V157` / `WorkspaceWriteGuard.java:104`）裁定，UI 侧目前用
 * `canManageWorkspace` 做只读镜像（**不是**新发明能力原子；若 CP 的门实际更细，这里要跟着改）。</p>
 */
const { t } = useI18n();
const configStore = useConfigStore();
const auth = useAuthStore();

const loading = ref(true);
const failed = ref(false);

const readonly = computed(() => !auth.canManageWorkspace);

onMounted(async () => {
    // task-472（D-1367，健壮性/潜在缺陷）：只读判据 `readonly` 来自 `/me/permissions` 投影
    // （`canManageWorkspace`，auth.ts:261-265），面板必须**自己确保它被加载** —— 否则
    // `user.capabilities` 缺失或过期的主体（cached pre-upgrade / 深链）在这里恒只读，
    // 页面不自给自足。**void 而不 await**：投影失败不得挡住配置域加载，且该 promise
    // 内部 try/catch 从不 reject（auth.ts:161-178）；单飞保证与设置页共用一次请求。
    void auth.ensureSelfPermissions();
    try {
        await configStore.loadLayerDomains("workspace");
        failed.value = false;
    } catch {
        // 失败必须显式呈现（BL-619 的教训：失败不许变成「看起来在加载」）。
        failed.value = true;
    } finally {
        loading.value = false;
    }
});
</script>

<template>
    <div data-testid="ws-settings-config">
        <div v-if="loading" class="flex items-center gap-2 px-1 py-6 text-sm text-muted-foreground">
            <LoaderCircle class="size-4 animate-spin" />
            {{ t("workspace.settingsConfigLoading") }}
        </div>

        <div
            v-else-if="failed"
            data-testid="ws-settings-config-error"
            class="rounded-lg border bg-muted/40 px-4 py-3 text-sm"
        >
            <p class="font-medium">{{ t("workspace.settingsConfigLoadFailed") }}</p>
            <p class="mt-1 text-muted-foreground">
                {{ t("workspace.settingsConfigLoadFailedHint") }}
            </p>
        </div>

        <ConfigLayerPanels v-else layer="workspace" :readonly="readonly" />
    </div>
</template>
