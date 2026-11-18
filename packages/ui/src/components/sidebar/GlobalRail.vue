<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useStorage } from "@vueuse/core";
import { LogOut, PanelLeftClose, PanelLeftOpen } from "@lucide/vue";
import { useAuthStore } from "../../stores/auth";
import {
    GLOBAL_RAIL_OPEN_WIDTH_DEFAULT,
    GLOBAL_RAIL_OPEN_WIDTH_MAX,
    GLOBAL_RAIL_OPEN_WIDTH_MIN,
} from "../../composables/useWorkspaceLayout";
import { GLOBAL_MODULES, moduleForPath, type GlobalModuleId } from "../../lib/globalModules";
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupContent,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarProvider,
    SidebarRail,
    SidebarSeparator,
} from "../ui/sidebar";
import GlobalRailModule from "./GlobalRailModule.vue";
import { RAIL_PANEL_PAGE_IDS } from "../../lib/workspacePages";
import { useWorkspaceNav } from "../../features/workspace/composables/useWorkspaceNav";

/**
 * PLAN-0762 T2.1/T2.3 —— 全局导航条（GlobalRail，DEV-010 §10.1 的唯一正名）。
 *
 * <p>主区只留三个模块：工作台（D-924 命名修正：模块名是「工作台」，工作区只是工作台模块内
 * 的对象，不是模块名）、资源、设置。D-933：「管理」按钮直接移除、不设替代入口 ——
 * config-locks/roles 本就是设置区安全组的 ADMIN-only 条目；「设置」在 footer、登出上方。</p>
 *
 * <p><b>双态（task-189 / BL-584 / D-896）</b>：56px 图标栏 ↔ 图标+文字宽栏。**必须有可见的
 * 切换控件**（`global-rail-toggle`：`aria-expanded` + `aria-label` + 键盘可达）—— 只靠
 * `SidebarRail` 的悬停与 ⌘/Ctrl+B 能切，但**没有可见入口**，这正是用户反复说「导航栏仍然
 * 不可展开」的原因。折叠态与展开态宽度**分开存**在同一份状态对象里（`{ open, width }`）：
 * 收起不改宽度、展开回原宽（PLAN-0582 的同一条纪律）。</p>
 *
 * <p><b>为什么状态键不是 `xihe-layout-global`</b>：那个键的 `navOpen` / `navWidth` 是**工作区
 * 内部 NavPanel** 的几何（`composables/useWorkspaceLayout.ts` 顶部 S2 注记明说「全局条的双态
 * 与这里拥有的 navOpen / navWidth 不是同一条状态」）⇒ 写进去会让「收起全局条」顺带收起工作区
 * 导航面板。两个不同的 UI 对象共用一颗开关，那是回归不是复用。故本组件用独立键
 * `xihe-global-rail` = `{ open, width }`（一个对象、两种宽度分开存，不设第二份布尔状态）。</p>
 *
 * <p><b>二级菜单（task-189 / D-896 / D-899）</b>：每个模块项都带二级菜单，载体是
 * `DropdownMenu`（`side=right` / `align=start`，D-896 的选型裁定：不用 `NavigationMenu`
 * —— 语义重复且自带 viewport 容器；不用 `Menubar`）。菜单内容**全部由 SSOT 派生**
 * （`lib/globalModules.ts` 投影 `settingsIa.ts` 的资源矩阵与域矩阵），本组件与行组件里都不写
 * 任何页面清单。</p>
 *
 * <p><b>打开通道只有两条：行内 chevron 点击、键盘 Tab/Enter</b>（`task-259` 回退）。**没有**
 * 「折叠态悬浮即开」：`D-896 ④b`（用户「不论是否折叠都要有悬浮二级菜单」）在同日 10:0x 由
 * 用户本人推翻 —— `D-899` 原话「悬浮二级菜单放 bl 先不做，太丑了」⇒ 不进产品 MVP、登记
 * `BL-578` 缓做。`task-189` 曾把该通道实现出来并绑定 `collapsed`，属违规实现，`task-259`
 * 已整条删除（连同 `RAIL_HOVER_OPEN_DELAY_MS`）。**改这一块前先核该面 D 号的最新状态**。</p>
 */
const { t } = useI18n();
const router = useRouter();
const route = useRoute();
const auth = useAuthStore();

interface GlobalRailState {
    open: boolean;
    /** 展开态宽度（px）。折叠态宽度恒为 vendor 的 `--sidebar-width-icon`（3.5rem = 56px）。 */
    width: number;
}

const RAIL_STORAGE_KEY = "xihe-global-rail";
/** 旧键（布尔形态，task-64 起使用）：一次性迁移后清除，避免同一语义两个键并存。 */
const LEGACY_RAIL_OPEN_KEY = "xihe-global-rail-open";

const railState = useStorage<GlobalRailState>(RAIL_STORAGE_KEY, {
    open: false,
    width: GLOBAL_RAIL_OPEN_WIDTH_DEFAULT,
});

/**
 * 旧布尔键迁移（task-189）：只在「没有新键且旧键为 true」时生效一次，随后清掉旧键。
 * 不清掉的话，用户下次收起再刷新会被旧键顶回去 —— 两个键写同一语义时，迟到的那份赢。
 */
function migrateLegacyRailKey() {
    try {
        const storage = globalThis.localStorage;
        if (!storage) return;
        if (storage.getItem(RAIL_STORAGE_KEY)) {
            storage.removeItem(LEGACY_RAIL_OPEN_KEY);
            return;
        }
        if (storage.getItem(LEGACY_RAIL_OPEN_KEY) === "true") {
            railState.value = { ...railState.value, open: true };
        }
        storage.removeItem(LEGACY_RAIL_OPEN_KEY);
    } catch {
        // localStorage 被禁用（隐私模式）时保持默认折叠态：不影响导航可用性。
    }
}
migrateLegacyRailKey();

const railOpen = computed({
    get: () => railState.value.open,
    set: (value: boolean) => {
        railState.value = { ...railState.value, open: value };
    },
});

const railWidthCss = computed(() => {
    const raw = Number.isFinite(railState.value.width)
        ? railState.value.width
        : GLOBAL_RAIL_OPEN_WIDTH_DEFAULT;
    const clamped = Math.min(GLOBAL_RAIL_OPEN_WIDTH_MAX, Math.max(GLOBAL_RAIL_OPEN_WIDTH_MIN, raw));
    return `${clamped}px`;
});

/** 二级菜单的打开者（同一时刻只开一个：两个菜单同时开着会互相遮挡）。 */
const openMenuId = ref<GlobalModuleId | null>(null);

/**
 * 当前路由归哪个模块 —— **问 `moduleForPath`，不在组件里再比一遍前缀**（task-34）。
 *
 * <p>为什么不能比 `module.basePath`：工作台模块的入口搬到 `/workbench` 后，容器页
 * （`/workspace/:id/**`）的归属由 `moduleForPath` 的容器前缀兜底；组件自己比 basePath 会
 * 让"进了工作区 rail 一个都不亮"。归属判据只许有一处。</p>
 */
function isModuleActive(moduleId: GlobalModuleId) {
    return moduleForPath(route.path ?? "")?.id === moduleId;
}

function navigate(path: string) {
    openMenuId.value = null;
    void router.push(path);
}

function onMenuOpenChange(moduleId: GlobalModuleId, open: boolean) {
    if (open) openMenuId.value = moduleId;
    else if (openMenuId.value === moduleId) openMenuId.value = null;
}

function handleLogout() {
    auth.logout();
    void router.push("/login");
}

const contentModules = computed(() => GLOBAL_MODULES.filter((module) => module.id !== "settings"));
const footerModules = computed(() => GLOBAL_MODULES.filter((module) => module.id === "settings"));

/**
 * `D-1220` ③（`task-365` C-1）：**工作区面板组** —— 把已存在的工作区页注册进最左 rail，
 * 而不是在页内再加一行。第一批只有「定时任务」（允许清单在 `lib/workspacePages.ts`）。
 *
 * <p>数据仍然只来自路由 `meta.workspacePage`（`useWorkspaceNav` 派生标签/图标/地址），
 * 本组件不写页面清单；回退工作区 id 用 tab 上下文，所以在 `/settings` 上这一组也在。</p>
 *
 * <p><b>没有工作区上下文时整组不渲染</b>：地址带 workspaceId，无 id 时给一个点不动的行
 * 等于假入口（`D-1136`：无合法替代路径的拒绝不许做；反过来，无目标的入口也不许做）。</p>
 *
 * <p><b>testid 前缀刻意与模块不同</b>（`global-rail-panel-*` vs `global-rail-module-*`）：
 * 既有 e2e 钉「rail 有 4 个模块」（`resources-ia.spec.ts`），面板项不是模块，
 * 混用前缀会让那条计数断言把面板当模块 —— 那是把两种东西合成一个数。</p>
 */
const workspaceNav = useWorkspaceNav(() => auth.currentWorkspaceId ?? "");
/** 当前容器 id：路由参数优先，其次 tab 上下文（与 `useWorkspaceNav` 同一优先级）。 */
const railWorkspaceId = computed(
    () => String(route.params.workspaceId ?? "") || auth.currentWorkspaceId || "",
);
const railPanels = computed(() =>
    // 无 id ⇒ 整组不渲染：`items` 本身与 id 无关（它派生自路由表），少了这道闸就会渲染出
    // 一个指向 `/workspace//scheduled-tasks` 的死入口。
    railWorkspaceId.value
        ? workspaceNav.items.value.filter((item) => RAIL_PANEL_PAGE_IDS.includes(item.id))
        : [],
);

function isPanelActive(name: string) {
    return route.name === name;
}
</script>

<template>
    <SidebarProvider
        v-model:open="railOpen"
        class="h-full w-auto min-h-0 shrink-0"
        :style="{ '--sidebar-width': railWidthCss, '--sidebar-width-icon': '3.5rem' }"
    >
        <Sidebar
            collapsible="icon"
            data-testid="global-rail"
            class="border-r border-sidebar-border"
            role="navigation"
            :aria-label="t('common.globalNav')"
        >
            <!--
                task-84（D-1869① · WCAG 2.4.1 bypass blocks）：跳过链接是文档里**第一个可聚焦元素**，
                所以放在 Sidebar 的第一个子节点 —— rail 在 App.vue 里排在 ModuleStage 之前 ⇒ DOM 序即文档序。

                为什么是 native <a href="#main-content">：W3C 技术 G1 原文要求「Activating the link **sets focus**
                beyond the other content to the main content」—— 手搓 JS scrollIntoView 只滚动不移动焦点，不满足；
                目标 <main> 因此带 id="main-content" + tabindex="-1"（无 tabindex 的元素不可聚焦，焦点落不进去）。
                sr-only / focus:not-sr-only 是 Tailwind 既有工具类，未新增样式令牌：G1 明写「只在有焦点时可见」
                也可以满足 2.4.1（原文：links that are visible only when they have focus can meet this SC）。

                role="navigation" + aria-label 挂在 <Sidebar> 上（Vue 属性透传落到 vendor 根 div）：
                rail 承载 GLOBAL_MODULES 模块链接（主导航），APG 对 complementary 的定义要求「与 main 内容相关」，
                并明写「not related to the main content ⇒ 用更通用角色」⇒ 本面取 navigation 不取 aside，
                且只挂这一个角色。
            -->
            <a
                href="#main-content"
                data-testid="skip-to-main"
                class="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:shadow-md"
                >{{ t("common.skipToMain") }}</a
            >

            <!--
                task-64 · 左上角 logo 槽位（形态由用户 2026-11-12 定：rail 顶部、28×28 方片、黑底白字 XH，暗色自动反转）。

                几何（4px 栅格 = Tailwind 默认 `--spacing`，D-1842 起）：
                  `size-8` = 8 × 4 = 32px；`my-2` = 2 × 4 = 8px（上下各一）
                  槽位块高 = 8 + 32 + 8 = 48 ⇒ 下方分组的 `p-3`(12) 把首个按钮推到 y = 48 + 12 = 60
                  （纵向仍与 logo 槽位同一节奏：槽位块高 + 分组内距 = 首个按钮的 y）
                  注：D-1842 之前是 3.5px 步进 ⇒ 7 + 28 + 7 = 42、p-4(14) ⇒ y = 56。
                  两个数各自都对，**不可混乘**（用 4px 的 p-4=16 配 3.5px 的 size-8=28 就是错的读法）。
                水平（task-224）：**两态同 x 才是判据，居中不是**。
                  改前写的是 `self-center` —— 它只对**折起态**成立（56px 栏 ⇒ (56 − 28) / 2 = 14 每侧，
                  那是 28px logo / 3.5px 栅格时代的数）；展开态栏宽 192px，「居中于当前宽度」= (192 − 28) / 2
                  = 82 ⇒ logo 相对折起态右移 68px。判据只算了折起态就宣布「天然居中」= 判据只覆盖一半状态
                  （用户 2026-11-13 看截图直述「展开后 logo 不该移动」）。
                  现在固定左内距：`ml-3.5` = 3.5 个单位 × `--spacing`。4px 栅格（D-1842 起）⇒ **14px**
                  （3.5px 栅格时代同一行代码是 12.25px —— 值变了但**判据没变**：判据是「两态同 x」，
                  固定内距天然满足，不依赖栏宽）。
                  与图标列的关系（有意，非缺陷）：折起态图标列左缘 = `p-3` = 12px，logo 在 14px ⇒ 差 2px。
                  这与 3.5px 时代的 1.75px 偏移同量级，**不是被判据锚定的像素**；若将来要求逐像素对齐，
                  改 `ml-3`（=12px）并同步 GlobalRail.spec.ts 的类断言。
                  配 `self-start`：交叉轴对齐不再参与水平定位（父级是 flex 列，`self-*` 管交叉轴）。

                  实测（`[实测]` ui-2，真浏览器 1920×1080，钉 `ede53f115`；选择器
                  `[data-testid="global-rail"] [data-testid="global-rail-logo"]`）：
                    rail 宽 56 → 192；logo `getBoundingClientRect().x` **12.25 → 12.25（Δ = 0）**；
                    `computed marginLeft` 两态均 12.25px ⇒ **判据成立**（同 x，且与居中位差 1.75px 是刻意的、
                    不可见的；判据是「两态同 x」，不是「等于居中位」）。
                  反证（同构建内运行时把类换回 `self-center`，不改仓库/不渲染旧版）：展开态 x = **81.5**，
                  相对 12.25 差 **+69.25px**；几何推算 (192 − 28) / 2 − (56 − 28) / 2 = **68px**
                  （**推算值，与实测 69.25 不同源，别混写成一个数**：推算取 rail 外框宽，
                  `self-center` 实际居中在内容盒）。
                  **注（D-1842 起）**：上面 12.25 / 1.75 / 69.25 都是 3.5px 栅格时代钉在 `ede53f115` 的读数，
                  保留作反证依据，**不是现值**。现值：`ml-3.5` = 14px ⇒ 两态 x 均 14（Δ 仍 0）；
                  居中位差与反证量只由栏宽和 logo 尺寸决定，判据（两态同 x）不受 `--spacing` 影响。

                配色为什么用 token 而不是 #000/#fff（`[源码]` styles/themes/color-shadcn-neutral.css）：
                  亮色 `--primary: oklch(0.205 0 0)`（近黑）/ `--primary-foreground: oklch(0.985 0 0)`（近白）
                  暗色 `--primary: oklch(0.922 0 0)`（近白）/ `--primary-foreground: oklch(0.205 0 0)`（近黑）
                ⇒ `bg-primary text-primary-foreground` 天然就是「亮色黑底白字 / 暗色白底黑字」，无需 dark 分支。

                不可点击（用户没要求可点）：`pointer-events-none` + 无 hover 态。
                `aria-hidden`：这里只是品牌占位/装饰；将来换真 logo 时必须连 aria 一起换
                （纯展示用 `role=img aria-label`；可点回首页则改 `<a>` 并补 `focus-visible` 环）。
            -->
            <div
                data-testid="global-rail-logo"
                aria-hidden="true"
                class="pointer-events-none my-2 flex size-8 shrink-0 items-center justify-center self-start ml-3.5 bg-primary text-primary-foreground select-none"
            >
                <span class="text-xs leading-none font-semibold tracking-tight">XH</span>
            </div>
            <SidebarContent>
                <!--
                    task-50 B2：折起态（icon 栏）内距必须与 56px 栏宽**逐像素闭合**。
                    栏宽是 `--sidebar-width-icon: 3.5rem` = **56px 字面值**（见上方 Provider 的 :style，
                    不由 `--spacing` 推导）；按钮是 vendor `size-8!` = 8 步。于是内距只能是
                    一条等式：`2 × 内距 + size-8 = 56`。
                    - 4px 栅格（现状，D-1842 已把 `--spacing` 恢复默认）：size-8 = 32 ⇒ 内距 = 12 = `p-3`。
                    - vendor 的 `p-2` 是给 48px 默认栏（`SIDEBAR_WIDTH_ICON` 3rem）设计的常量，
                      我们覆盖成 56px 后「宽度」与「内距」各自看着合理、相乘才错，所以不能直接用 p-2。
                    D-1842 之前这里是 `p-4`：那是按 3.5px 步进算的 14 + 28 + 14 = 56（同样闭合），
                    间距回 4px 后 `p-4` = 16 而 `size-8` = 32 ⇒ 16+32+16 = 64 > 56，图标会被 clipped。
                    所以这里跟 `--spacing` 一起改成 `p-3`，不是「顺手调小」。
                -->
                <SidebarGroup class="group-data-[collapsible=icon]:p-3">
                    <SidebarGroupContent>
                        <SidebarMenu>
                            <GlobalRailModule
                                v-for="module in contentModules"
                                :key="module.id"
                                :module="module"
                                :open="openMenuId === module.id"
                                :active="isModuleActive(module.id)"
                                :active-path="route.path ?? ''"
                                @navigate="navigate"
                                @update:open="(open: boolean) => onMenuOpenChange(module.id, open)"
                            />
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
                <!-- D-1220 ③：工作区面板组（注册既有页，不新增页内顶部行）。 -->
                <SidebarGroup
                    v-if="railPanels.length > 0"
                    data-testid="global-rail-panels"
                    class="group-data-[collapsible=icon]:p-3"
                >
                    <SidebarGroupContent>
                        <SidebarMenu>
                            <SidebarMenuItem v-for="panel in railPanels" :key="panel.id">
                                <SidebarMenuButton
                                    :data-testid="`global-rail-panel-${panel.id}`"
                                    :is-active="isPanelActive(panel.name)"
                                    :aria-current="isPanelActive(panel.name) ? 'page' : undefined"
                                    :title="t(panel.labelKey)"
                                    class="data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground data-[active=true]:font-medium"
                                    @click="navigate(panel.path)"
                                >
                                    <component
                                        :is="panel.icon"
                                        class="size-4 shrink-0"
                                        aria-hidden="true"
                                    />
                                    <span class="truncate group-data-[collapsible=icon]:hidden">{{
                                        t(panel.labelKey)
                                    }}</span>
                                </SidebarMenuButton>
                            </SidebarMenuItem>
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
            </SidebarContent>
            <!-- task-50 B2：footer 与顶部组同一内距，折起态两个图标各自居中。 -->
            <!--
                task-214（用户 2026-11-13 裁定）：footer 里**两类东西不许混排** ——
                动作项（设置 / 退出登录，是「对应用做的事」）与框架控件（收起/展开，是
                「对这根栏做的事」）。收起属于**栏的边界**，贴最底；两者之间用 vendored
                `SidebarSeparator` 分隔（既有 token `bg-sidebar-border`，不新增色阶）。
                这里只移动、不改任何 class/tooltip/aria。
            -->
            <SidebarFooter class="group-data-[collapsible=icon]:p-3">
                <SidebarMenu>
                    <GlobalRailModule
                        v-for="module in footerModules"
                        :key="module.id"
                        :module="module"
                        :open="openMenuId === module.id"
                        :active="isModuleActive(module.id)"
                        :active-path="route.path ?? ''"
                        @navigate="navigate"
                        @update:open="(open: boolean) => onMenuOpenChange(module.id, open)"
                    />
                    <SidebarMenuItem>
                        <!--
                            task-30：折叠态下标签 span 是 `display:none` ⇒ 退出登录也是 icon-only，
                            而 `:tooltip` **不构成可访问名**（实测 `ariaSnapshot` 仍是 `- button`）；
                            名字只能由 `aria-label` 给，与可见文本同值（不新增 i18n 键）。
                        -->
                        <SidebarMenuButton
                            data-testid="global-rail-logout"
                            :aria-label="t('sidebar.logout')"
                            :tooltip="t('sidebar.logout')"
                            @click="handleLogout"
                        >
                            <LogOut class="size-4 shrink-0" aria-hidden="true" />
                            <span class="truncate group-data-[collapsible=icon]:hidden">{{
                                t("sidebar.logout")
                            }}</span>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                </SidebarMenu>
                <SidebarSeparator />
                <SidebarMenu>
                    <!--
                        task-189 双态切换控件（D-896 的「必须有可见切换控件」）：
                        `aria-expanded` 反映真实状态、`aria-label` 随态变化、原生 button ⇒
                        Enter/Space 可切；折叠态它自己也有 tooltip（rail 里没有文字时靠它认路）。

                        task-214：位置移到动作组之后（footer 最底）—— 控件本身一字未改。
                    -->
                    <SidebarMenuItem>
                        <SidebarMenuButton
                            data-testid="global-rail-toggle"
                            :aria-expanded="railOpen"
                            :aria-label="railOpen ? t('sidebar.collapse') : t('sidebar.expand')"
                            :tooltip="railOpen ? undefined : t('sidebar.expand')"
                            @click="railOpen = !railOpen"
                        >
                            <PanelLeftClose
                                v-if="railOpen"
                                class="size-4 shrink-0"
                                aria-hidden="true"
                            />
                            <PanelLeftOpen v-else class="size-4 shrink-0" aria-hidden="true" />
                            <span class="truncate group-data-[collapsible=icon]:hidden">{{
                                t("sidebar.collapse")
                            }}</span>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarFooter>
            <SidebarRail />
        </Sidebar>
    </SidebarProvider>
</template>
