<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { useEventListener } from "@vueuse/core";
import {
    CommandDialog,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
    CommandSeparator,
} from "@/components/ui/command";
import {
    DOMAIN_LABEL_KEY,
    SETTINGS_LAYERS,
    defaultLayerPath,
    domainsForLayer,
    settingsDomainPath,
    type SettingsLayer,
} from "../../lib/settingsIa";
import { SUPPORTED_LOCALES } from "../../i18n/locale";

/**
 * PLAN-0762 T3.4：`⌘K` / `Ctrl+K` 搜索**配置域**并跳转。
 *
 * <p>**域清单只有一个来源**：`domainsForLayer()`（`lib/settingsIa.ts` 的层×域矩阵，矩阵本身
 * 镜像 CP 的 `LAYER_DOMAINS`）。本组件**不**另造域数组，也不按名字硬编码任何域 —— 加域/改
 * 层归属只改矩阵一处，这里自动跟上（card 硬约束的原话：「域清单必须来自 settingsIa.ts 的单一矩阵」）。</p>
 *
 * <p>**跨层显式**：结果分「本层」与「其他层」两组，其他层每条都带目标层徽标；跳转前用户看得见
 * 自己会被带到哪一层 —— 不静默换层（换层是路由语义，不是本组件的副作用）。</p>
 *
 * <p>**⌘K 的监听器只有一个**：本组件在 `layouts/SettingsLayout.vue` 里**单实例**挂载（设置区
 * 任何路由都只有这一份），因此每个页面生命周期内恰好一次 `document` 级 keydown 注册。全局
 * `⌘/Ctrl+B` 由 vendor `ui/sidebar/SidebarProvider.vue:57` 自己注册（全局条那一份），本组件
 * **不碰 b 键**、也不引入第三个全局监听器 —— 两个快捷键各自的属主清晰。</p>
 *
 * <p>**缺口项不进结果**（判据）：`instanceResourceGroup()` / `userResourceGroup()` 里的
 * `gaps` 条目**不是配置域**、且**没有 path** —— 左栏对它们的语义是「弹缺口说明、不跳转」，
 * 而 ⌘K 的语义是「跳转」。把它们塞进结果会造出「按 Enter 什么都不发生」的死项，正是本卡
 * 与 B 批 P2-2 都在防的那类假入口。故不进，且不以「标不可达」代替（标了也是死项）。</p>
 */
const props = defineProps<{
    open: boolean;
    /** 当前层：由 `SettingsLayout.vue` 按路由 meta / 路径推导后传入（层只由一处决定）。 */
    layer: SettingsLayer;
}>();

const emit = defineEmits<{ "update:open": [value: boolean] }>();

const { t, locale, getLocaleMessage } = useI18n();
const router = useRouter();

/**
 * 另一语言的标签（task-46）：中文界面要能用 `log` 搜到「日志」，英文界面要能用「日志」搜到
 * `Logging` —— 候选集必须同时含**两种语言的标签 + 域名 key**，否则搜索面只有一个语言。
 *
 * <p>为什么不直接用 `t(key, { locale })`：vue-i18n 的 `t` 第二参在「命名插值 / 复数」之间有
 * 重载歧义，这里只需要**取原始字符串**，直接读该 locale 的 message 树最不含糊（域标签是纯文本、
 * 无插值）。取不到就返回空串，绝不回退成 key 本身（否则 `settings.domainLogging` 会变成噪音命中）。</p>
 */
function labelIn(localeName: string, key: string): string {
    const messages = getLocaleMessage(localeName) as Record<string, unknown>;
    const value = key
        .split(".")
        .reduce<unknown>(
            (acc, part) => (acc as Record<string, unknown> | undefined)?.[part],
            messages,
        );
    return typeof value === "string" ? value : "";
}

/** 非当前语言（`SUPPORTED_LOCALES` 是唯一来源，不在组件里另写一份语言清单）。 */
const otherLocale = computed(
    () => SUPPORTED_LOCALES.find((item) => item !== locale.value) ?? locale.value,
);

/** 搜索别名：`域名 key + 另一语言标签`（当前语言标签由 `label` 单独渲染）。 */
function searchAlias(domain: string, labelKey: string): string {
    return `${domain} ${labelIn(otherLocale.value, labelKey)}`.trim();
}

/** 层名文案键（与 `SettingsLayerHeader.vue` 的 `LAYER_TITLE_KEYS` 同键；这不是域清单）。 */
const LAYER_LABEL_KEY: Record<SettingsLayer, string> = {
    instance: "settings.ia.layerInstance",
    "workspace-default": "settings.ia.layerWorkspaceDefault",
    user: "settings.ia.layerUser",
};

interface PaletteEntry {
    /** 唯一值：`层:域` —— 同域在不同层是两条不同的跳转目标。 */
    value: string;
    label: string;
    path: string;
    /** 视觉隐藏的搜索别名（见 `searchAlias`），只喂 vendor 的 textContent 过滤器。 */
    alias: string;
}

const currentItems = computed<PaletteEntry[]>(() =>
    domainsForLayer(props.layer).map((domain) => ({
        value: `${props.layer}:${domain}`,
        label: t(DOMAIN_LABEL_KEY[domain]),
        path: settingsDomainPath(props.layer, domain),
        alias: searchAlias(domain, DOMAIN_LABEL_KEY[domain]),
    })),
);

const crossLayerGroups = computed(() =>
    SETTINGS_LAYERS.filter((layer) => layer !== props.layer).map((layer) => ({
        layer,
        label: t(LAYER_LABEL_KEY[layer]),
        items: domainsForLayer(layer).map<PaletteEntry>((domain) => ({
            value: `${layer}:${domain}`,
            label: t(DOMAIN_LABEL_KEY[domain]),
            path: settingsDomainPath(layer, domain),
            alias: searchAlias(domain, DOMAIN_LABEL_KEY[domain]),
        })),
    })),
);

/**
 * 清空搜索用：`Command` 的过滤词是 vendor 组件内部状态（`Command.vue` 的 `filterState.search`
 * 由 `CommandInput` 双向绑定，没有对外可控入口）。不去改 vendor，改为重挂 `CommandDialog`
 * —— 换 key 即回到空查询。空态出口因此不需要用户自己删字。
 */
const resetKey = ref(0);

function close() {
    emit("update:open", false);
}

function go(path: string) {
    close();
    void router.push(path);
}

function clearSearch() {
    resetKey.value += 1;
}

function goDefaultPage() {
    go(defaultLayerPath(props.layer));
}

useEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return;
    // ⌘K / Ctrl+K 归本组件；⌘B 归 vendor SidebarProvider（全局条），互不覆盖。
    event.preventDefault();
    emit("update:open", props.open ? false : true);
});
</script>

<template>
    <CommandDialog
        :key="resetKey"
        :open="open"
        :title="t('settings.commandk.title')"
        :description="t('settings.commandk.description')"
        class="sm:max-w-lg"
        @update:open="(value: boolean) => emit('update:open', value)"
    >
        <!-- testid 落在真 DOM 上：`CommandDialog` 的根是 reka `DialogRoot`（无 DOM），
             写在它上面的 `data-testid` 会被丢掉。 -->
        <CommandInput
            data-testid="settings-commandk-input"
            :placeholder="t('settings.commandk.placeholder')"
        />
        <CommandList>
            <CommandEmpty>
                <p class="text-sm">{{ t("settings.commandk.empty") }}</p>
                <p class="mt-1 text-xs text-muted-foreground">
                    {{ t("settings.commandk.emptyHint") }}
                </p>
                <div class="mt-3 flex items-center justify-center gap-2">
                    <button
                        type="button"
                        data-testid="commandk-clear"
                        class="rounded-md border px-3 py-1 text-xs hover:bg-muted"
                        @click="clearSearch"
                    >
                        {{ t("settings.commandk.clear") }}
                    </button>
                    <button
                        type="button"
                        data-testid="commandk-default-page"
                        class="rounded-md border px-3 py-1 text-xs hover:bg-muted"
                        @click="goDefaultPage"
                    >
                        {{ t("settings.commandk.openDefault") }}
                    </button>
                </div>
            </CommandEmpty>

            <CommandGroup
                :heading="
                    t('settings.commandk.groupCurrent', { layer: t(LAYER_LABEL_KEY[props.layer]) })
                "
            >
                <CommandItem
                    v-for="item in currentItems"
                    :key="item.value"
                    :value="item.value"
                    :data-testid="`commandk-item-${item.value}`"
                    @select="go(item.path)"
                >
                    <span>{{ item.label }}</span>
                    <!-- task-46 搜索别名：域名 key + 另一语言标签。`sr-only` 让它不出现在像素上，
                         `aria-hidden` 让它不出现在无障碍名里 —— 它只喂 vendor 的 textContent 索引
                         （`Command.vue:49-52` 用 `item.textContent` 建 `allItems`）。 -->
                    <span class="sr-only" aria-hidden="true" data-commandk-alias>{{
                        item.alias
                    }}</span>
                </CommandItem>
            </CommandGroup>

            <template v-for="group in crossLayerGroups" :key="group.layer">
                <CommandSeparator />
                <CommandGroup :heading="t('settings.commandk.groupOther', { layer: group.label })">
                    <CommandItem
                        v-for="item in group.items"
                        :key="item.value"
                        :value="item.value"
                        :data-testid="`commandk-item-${item.value}`"
                        @select="go(item.path)"
                    >
                        <span class="mr-auto">{{ item.label }}</span>
                        <span class="sr-only" aria-hidden="true" data-commandk-alias>{{
                            item.alias
                        }}</span>
                        <span
                            class="ml-2 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground"
                            :data-testid="`commandk-badge-${item.value}`"
                            >{{
                                t("settings.commandk.crossLayerBadge", { layer: group.label })
                            }}</span
                        >
                    </CommandItem>
                </CommandGroup>
            </template>
        </CommandList>
    </CommandDialog>
</template>
