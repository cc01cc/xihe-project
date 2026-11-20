<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import {
    CircleUser,
    FolderOpen,
    FolderTree,
    LogOut,
    MessageSquare,
    MessagesSquare,
    PanelLeftClose,
    PanelLeftOpen,
    Plus,
    Search,
    Settings,
    Settings2,
    Users,
    X,
} from "@lucide/vue";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import StandaloneSessionDialog from "./StandaloneSessionDialog.vue";
import { useAuthStore } from "../../stores/auth";
import { toast } from "vue-sonner";
import WorkspaceSessionGroups from "../../features/workspace/chat/components/WorkspaceSessionGroups.vue";
import UserQuestionsEntry from "../../features/workspace/components/UserQuestionsEntry.vue";
// PLAN-0762 T2.1：NavRail 已提升为全局层（components/sidebar/GlobalRail.vue，App.vue 常驻），
// 本组件不再自带 rail —— 它只负责工作区模块的导航面板。
import { standaloneChatPath, workspacePath, workspaceSettingsPath } from "../../lib/routes";
import { useSessionStore } from "../../stores/session";
import { defaultLayerPath } from "../../lib/settingsIa";

const props = defineProps<{
    /**
     * S5-W2: the shell yielded the navigation panel to protect the workspace main
     * column. Render-only — the stored `open` state is untouched, so widening the
     * window restores the panel exactly as the user left it.
     */
    forceCollapsed?: boolean;
    open: boolean;
    width: number;
    isMobile: boolean;
    /**
     * PLAN-0753 T3: the shell's splitter bridge owns the pointer/keyboard resize;
     * this is render-only state for transition suppression, layer promotion and the
     * live width bubble. Never a width channel of its own.
     */
    resizing?: boolean;
}>();

const emit = defineEmits<{
    "update:open": [value: boolean];
}>();

const router = useRouter();
const { t } = useI18n();
const auth = useAuthStore();
const sessionStore = useSessionStore();

const isOpen = computed(() => Boolean(props.open) && !props.forceCollapsed);

/**
 * PLAN-0762 T2.1：全局条移到 App.vue 之后，桌面折叠态不再靠 rail 的展开按钮回归 ——
 * 折叠后本组件渲染一条 56px 的"折叠条"（只含展开控件），宽度由 AppLayout 的
 * SplitterPanel `collapsed-size=RAIL_WIDTH` 决定，语义与原 P-class 修复一致：
 * 面板关闭时仍然有可见、可点的重新打开入口；自动让位（forceCollapsed）不是用户选择，
 * 此时**不**渲染该条。
 */
const showCollapsedStrip = computed(
    () => !props.isMobile && !isOpen.value && !props.forceCollapsed,
);

function expandSidebar() {
    emit("update:open", true);
}

/**
 * task-172 / `D-1464`：会话区头的计数 = 左栏列表**当前渲染**的会话总数。
 *
 * <p>数据源只有**一处**：`WorkspaceSessionGroups.vue` 的 `renderedSessionCount` —— 它镜像
 * 自己的模板分支（独立会话区 + 各**已展开且已加载**的工作区分组之和；折叠组、loading、error、
 * 两种空态一律 0）。这里**不**自算第二份：两处各算一份必然漂移（典型分歧是「折叠但仍缓存」的
 * 分组：store 里有行、列表里没有行），而区头数字存在的意义就是可核。</p>
 *
 * <p>模板 ref 在首次渲染前是 `null` ⇒ 回落 0，不让区头出现 `undefined`。</p>
 */
const sessionGroupsRef = ref<{ renderedSessionCount: number } | null>(null);
const sessionCount = computed(() => sessionGroupsRef.value?.renderedSessionCount ?? 0);

const panelStyle = computed(() => (props.isMobile ? { width: "100%" } : undefined));

/**
 * task-352 / `D-1206`：分组头与会话项各自的「新建」都落到**那个工作区**，不是当前工作区。
 * 路径形式 `/workspace/{id}?newChat=1` 由路由守卫写 tab 上下文，所以这里只负责跳。
 */
function startNewChatInWorkspace(workspaceId: string) {
    void router.push({ path: workspacePath(workspaceId), query: { newChat: "1" } });
}

async function startNewChat() {
    if (!auth.currentWorkspaceId) {
        await auth.hydrateWorkspace();
    }
    if (!auth.currentWorkspaceId) {
        toast.error(t("sidebar.noWorkspace"));
        return;
    }
    const workspaceId = auth.currentWorkspaceId;
    await router.push({ path: workspacePath(workspaceId), query: { newChat: "1" } });
}

/**
 * task-373 / `D-1236`：新建入口 = 搜索行 icon 的**两项菜单**（区头 ⊕ 仍是「新建工作区」，
 * 两者不混用，D-1206）。独立会话不进任何工作区，所以它不能复用 `startNewChat`。
 */
const standaloneDialogOpen = ref(false);

function openStandaloneDialog() {
    standaloneDialogOpen.value = true;
}

function onStandaloneCreated(sessionId: string) {
    void router.push(standaloneChatPath(sessionId));
}

function toggleSidebar() {
    emit("update:open", !props.open);
}

/**
 * PLAN-0753 T3: 指针 / 键盘 / 双击三条 resize 路径整体上移到壳层（AppLayout 的
 * `useSplitterPanelBridge`）——aside 现在是 splitter panel #1，宽度由 reka 的
 * flex-grow 拥有，本组件不再写 `style.width`、也不再 emit `update:width`。
 * 只剩两件 render-only 的事：`resizing` 驱动 will-change / transition 抑制，
 * 以及把气泡元素暴露给桥接做**命令式**文本写入（不建响应式宽度通道）。
 */
const bubbleRef = ref<HTMLElement | null>(null);
defineExpose({ bubbleRef });

function clearSearch() {
    sessionStore.searchQuery = "";
}

/**
 * D-1220 ②（task-365 B）：「新建工作区 / 导入源」从页内右上角搬进左栏「工作区」区头。
 * 两者都是**对一级列表做的事**（DSH 的 workspace.add 也在区头/菜单，不在工作区行上）；
 * 行上的 `+` 保持「在该工作区新建会话」语义，两者不可混用（D-1206）。
 * 走 query 而不是本地弹窗：左栏是全局 chrome，而创建/导入对话框分别住在
 * `WorkspacePicker`（无 tab 上下文时）与 `WorkspaceView`（有上下文时）——
 * query 让它们各自消费，顺带得到可分享深链。
 */
function openAddWorkspace() {
    void router.push({ path: "/workbench", query: { create: "1" } });
}

async function openImportSource() {
    if (!auth.currentWorkspaceId) {
        await auth.hydrateWorkspace();
    }
    const workspaceId = auth.currentWorkspaceId;
    if (!workspaceId) {
        toast.error(t("sidebar.noWorkspace"));
        return;
    }
    void router.push({ path: workspacePath(workspaceId), query: { importSource: "1" } });
}

/** task-113：指向最终地址（`lib/settingsIa` 的 SSOT），不再依赖 `/settings/config` 的 redirect。 */
function navigateSettings() {
    void router.push(defaultLayerPath("instance"));
}

/**
 * task-89 ①：区头的「搜索会话」是**常驻可见动作**（不是 hover 才出现的浮层）。
 * 它只负责把焦点送进搜索框（搜索面仍是那一行 input，避免同一件事两个控件）。
 */
const searchInputRef = ref<HTMLInputElement | null>(null);

function focusSearch() {
    searchInputRef.value?.focus();
}

/**
 * task-173 / `D-1464`：rail 态（56px 折叠条）此前**没有任何检索入口** —— 三条 UI 缺口里
 * 唯一「真丢功能」的那条。形态 **A**：折叠条内检索图标按钮 + 栈内 reka-ui Popover 弹出检索框；
 * 否决「点一下就把左栏展开再聚焦」—— 点击语义歧义（究竟是想检索还是想展开），且等于把
 * 「检索」偷偷换成「展开」。
 *
 * <p>数据面**复用** `sessionStore.searchQuery`（与展开态那一行 input 同一个 v-model）：
 * rail 里输入的过滤词展开后仍然生效，不需要第二套状态，也不会出现「两个搜索框各记一半」。
 * testid 也复用 `sidebar-session-search`（同一个「会话检索入口」，两态各渲染其一；折叠态下
 * #sidebar-panel 整套不挂载 ⇒ 任何一态都只有一处），Popover 里的输入框另给
 * `sidebar-session-search-input`。</p>
 */
const railSearchOpen = ref(false);
const railSearchTriggerRef = ref<HTMLButtonElement | null>(null);
const railSearchInputRef = ref<HTMLInputElement | null>(null);

/** 打开后把焦点送进输入框（PopoverContent 的默认自动聚焦停在容器上，用户还得再按一次 Tab）。 */
async function onRailSearchOpenChange(open: boolean) {
    railSearchOpen.value = open;
    if (open) {
        await nextTick();
        railSearchInputRef.value?.focus();
    }
}

/** Esc 关闭并把焦点还给触发器 —— 否则焦点掉进 body，键盘用户得重新 Tab 一整圈。 */
function closeRailSearch() {
    railSearchOpen.value = false;
    railSearchTriggerRef.value?.focus();
}

/**
 * task-89 ②：区头的「配置工作区」常驻入口 —— 指向**当前工作区自己的**设置页与成员页
 * （四 tab 由工作区自身导航承载；不复制到会话页、不进容器页签）。
 * 没有活动工作区时触发器 disabled 并给出原因（sidebar.noWorkspace）。
 */
function openWorkspaceSettings() {
    const workspaceId = auth.currentWorkspaceId;
    if (!workspaceId) {
        toast.error(t("sidebar.noWorkspace"));
        return;
    }
    void router.push(workspaceSettingsPath(workspaceId));
}

function openWorkspaceMembers() {
    const workspaceId = auth.currentWorkspaceId;
    if (!workspaceId) {
        toast.error(t("sidebar.noWorkspace"));
        return;
    }
    void router.push(workspacePath(workspaceId) + "/members");
}

function handleLogout() {
    auth.logout();
    void router.push("/login");
}
</script>

<template>
    <aside
        data-testid="sidebar"
        :aria-label="t('sidebar.panelLabel')"
        :aria-hidden="isMobile && !open ? 'true' : undefined"
        :inert="isMobile && !open ? true : undefined"
        class="flex h-full overflow-hidden bg-surface-canvas border-r border-sidebar-border"
        :class="[
            isMobile ? 'fixed left-0 top-0 z-40' : 'relative min-w-0',
            { 'shadow-lg': isMobile && open, 'is-resizing': resizing },
            resizing
                ? 'transition-none'
                : isMobile
                  ? 'transition-[width] duration-300'
                  : 'transition-[flex-grow] duration-300',
        ]"
    >
        <!--
            桌面折叠态：56px 折叠条（展开控件 + 检索入口）。全局条在 App.vue，不在这里。
            task-173 / `D-1464`：折叠后原先只剩展开按钮 ⇒ 检索功能**真丢**（其余两条缺口只是位置不对）。
            现在补检索图标按钮 + reka-ui Popover 检索框（形态 A）；展开按钮原样保留（e2e ⑥E2 断言它可见）。
        -->
        <div
            v-if="showCollapsedStrip"
            data-testid="sidebar-collapsed-strip"
            class="flex h-full w-full flex-col items-center justify-start gap-2 py-3"
        >
            <button
                type="button"
                data-testid="sidebar-expand"
                :aria-label="t('sidebar.expand')"
                :title="t('sidebar.expand')"
                class="rounded-md p-1.5 text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                @click="expandSidebar"
            >
                <PanelLeftOpen class="size-4" aria-hidden="true" />
            </button>
            <Popover :open="railSearchOpen" @update:open="onRailSearchOpenChange">
                <PopoverTrigger as-child>
                    <button
                        ref="railSearchTriggerRef"
                        type="button"
                        data-testid="sidebar-session-search"
                        :aria-label="t('sidebar.search')"
                        :title="t('sidebar.search')"
                        class="rounded-md p-1.5 text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <Search class="size-4" aria-hidden="true" />
                    </button>
                </PopoverTrigger>
                <PopoverContent side="right" align="start" :side-offset="8" class="w-64">
                    <div class="relative min-w-0">
                        <Search
                            class="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                            aria-hidden="true"
                        />
                        <input
                            ref="railSearchInputRef"
                            v-model="sessionStore.searchQuery"
                            data-testid="sidebar-session-search-input"
                            type="text"
                            autocomplete="off"
                            class="w-full rounded-md border border-sidebar-border bg-background py-1.5 pl-7 pr-2 text-sm text-sidebar-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                            :placeholder="t('sidebar.search')"
                            :aria-label="t('sidebar.search')"
                            @keydown.esc.prevent.stop="closeRailSearch"
                        />
                    </div>
                </PopoverContent>
            </Popover>
        </div>
        <!-- 桌面：panel #1 的剩余宽度全部归导航面板（全局条不在其中）。折叠态改渲染上面的折叠条。 -->
        <div
            v-else
            id="sidebar-panel"
            data-testid="sidebar-panel"
            :aria-hidden="!isMobile && !open ? 'true' : undefined"
            :inert="!isMobile && !open ? true : undefined"
            class="relative flex h-full min-w-0 flex-col overflow-hidden"
            :class="isMobile ? undefined : 'flex-1'"
            :style="panelStyle"
        >
            <!--
                D-1229（并入 task-365 B）：这一行是**左栏区头**，不再显示当前工作区名。
                此前工作区名在左栏出现两次（本行 + 分组头）再加行2 面包屑 = 三重冗余；
                现在名字只由分组头（列表内高亮）与面包屑表达，本行只回答「这一栏是什么」，
                并承载**对一级列表做的事**（导入源 / 新建工作区）+ 折叠。
                位置与高度不变（h-14 = 14 × 3.5 = 49px）：换内容不换组件（D-1229）。
            -->
            <div
                data-testid="sidebar-workspaces-header"
                class="flex h-14 shrink-0 items-center gap-1.5 px-2"
            >
                <span
                    class="flex min-w-0 flex-1 items-center gap-2 px-2 text-xs font-medium tracking-wider text-muted-foreground"
                >
                    <FolderTree class="size-4 shrink-0" aria-hidden="true" />
                    <span class="truncate">{{ t("sidebar.workspacesSection") }}</span>
                </span>
                <!--
                    task-89 ①：区头三个动作**常驻可见**（32px 命中区、gap-1.5、hover 底、aria-label），
                    一律不做「hover 才出现」—— hover-only 在触摸与键盘下等于不存在。
                    新建工作区仍是一级列表动作（导入源是它的同级菜单项，不是第二个图标），
                    与工作区行上的 +（在该组新建会话）语义分开（D-1206）。
                -->
                <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                        <button
                            type="button"
                            data-testid="sidebar-new-workspace"
                            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            :aria-label="t('workspace.addWorkspace')"
                            :title="t('workspace.addWorkspace')"
                        >
                            <Plus class="size-4" aria-hidden="true" />
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" class="w-56">
                        <DropdownMenuItem
                            data-testid="sidebar-add-workspace"
                            @select="openAddWorkspace"
                        >
                            <Plus class="size-4" aria-hidden="true" />
                            {{ t("workspace.addWorkspace") }}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            data-testid="sidebar-import-source"
                            @select="openImportSource"
                        >
                            <FolderOpen class="size-4" aria-hidden="true" />
                            {{ t("workspace.importSource") }}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
                <button
                    type="button"
                    data-testid="sidebar-search-action"
                    class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    :aria-label="t('sidebar.searchSessions')"
                    :title="t('sidebar.searchSessions')"
                    @click="focusSearch"
                >
                    <Search class="size-4" aria-hidden="true" />
                </button>
                <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                        <button
                            type="button"
                            data-testid="sidebar-workspace-config"
                            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                            :disabled="!auth.currentWorkspaceId"
                            :aria-label="t('sidebar.configureWorkspace')"
                            :title="
                                auth.currentWorkspaceId
                                    ? t('sidebar.configureWorkspace')
                                    : t('sidebar.noWorkspace')
                            "
                        >
                            <Settings2 class="size-4" aria-hidden="true" />
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" class="w-56">
                        <DropdownMenuItem
                            data-testid="sidebar-workspace-config-settings"
                            @select="openWorkspaceSettings"
                        >
                            <Settings2 class="size-4" aria-hidden="true" />
                            {{ t("sidebar.workspaceSettings") }}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            data-testid="sidebar-workspace-config-members"
                            @select="openWorkspaceMembers"
                        >
                            <Users class="size-4" aria-hidden="true" />
                            {{ t("workspace.membersTitle") }}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
                <button
                    type="button"
                    :data-testid="isMobile ? 'sidebar-close' : 'sidebar-collapse'"
                    :aria-label="t('sidebar.collapse')"
                    :title="t('sidebar.collapse')"
                    :aria-expanded="open"
                    class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    @click="toggleSidebar"
                >
                    <PanelLeftClose class="size-4" aria-hidden="true" />
                </button>
            </div>

            <!-- PLAN-0660 T5.21（B-7 全局导航入口）：有欠答时才占位，零态不渲染（见组件头注释）。 -->
            <div class="px-3 pb-2">
                <UserQuestionsEntry />
            </div>

            <!--
                D-1220 ①（task-365 A）：新建会话**不再是全宽实心主按钮**。
                判据「主按钮 = 高频 ∧ 无就近替代」它两条都不满足 —— 每个工作区行右侧的 `+`
                （带上文：新建的会话落在该工作区）与工作区空态里的「新建会话」已经在做这件事，
                而顶部这个按钮**不携带对象**（不知道在哪个工作区）。
                降级为与搜索同行的 icon 按钮：size-7（7 × 4px = 28px；3.5px 栅格时代是 24.5px）
                + 透明底 + size-4 图标（今天 16px），
                填充色 `--primary` → 透明 ⇒ 左栏 L3 强调占用 1 → 0（注意力预算：每屏 ≤2）。
                `data-testid="sidebar-new-chat"` 保持不变（e2e 引用它，改 testid 等于改别人的断言）。
                task-373 / `D-1236`：它现在是**两项菜单的触发器**（在此工作区新建 / 新建独立会话），
                不再是直接新建 —— 所以点它的 e2e 要再点一次菜单项（同批已改）。
            -->
            <div class="px-3 pb-2">
                <div class="sidebar-search-row flex items-center gap-1 overflow-hidden">
                    <div class="relative min-w-0 flex-1">
                        <Search
                            class="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                            aria-hidden="true"
                        />
                        <input
                            ref="searchInputRef"
                            v-model="sessionStore.searchQuery"
                            data-testid="sidebar-session-search"
                            type="text"
                            autocomplete="off"
                            class="w-full rounded-md border border-sidebar-border bg-background py-1.5 pl-7 pr-7 text-sm text-sidebar-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                            :placeholder="t('sidebar.search')"
                            :aria-label="t('sidebar.search')"
                        />
                        <button
                            v-if="sessionStore.searchQuery"
                            type="button"
                            data-testid="sidebar-search-clear"
                            class="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent"
                            :aria-label="t('sidebar.clearSearch')"
                            :title="t('sidebar.clearSearch')"
                            @click="clearSearch"
                        >
                            <X class="size-3.5" aria-hidden="true" />
                        </button>
                    </div>
                    <DropdownMenu>
                        <DropdownMenuTrigger as-child>
                            <button
                                type="button"
                                data-testid="sidebar-new-chat"
                                class="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                :aria-label="t('sidebar.newChat')"
                                :title="t('sidebar.newChat')"
                            >
                                <Plus class="size-4" aria-hidden="true" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" class="w-60">
                            <DropdownMenuItem
                                data-testid="sidebar-new-chat-workspace"
                                @select="startNewChat"
                            >
                                <FolderTree class="size-4" aria-hidden="true" />
                                {{ t("sidebar.groupNewSession") }}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                data-testid="sidebar-new-chat-standalone"
                                @select="openStandaloneDialog"
                            >
                                <MessageSquare class="size-4" aria-hidden="true" />
                                {{ t("sidebar.newChatStandalone") }}
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>

            <!--
                task-172 / `D-1464`：会话区头（含计数）。左栏此前只有「工作区」一个区头，会话行是裸的
                （直接 今天/昨天/更早 桶）—— 一级列表有区头、二级列表没有，且会话总数无处可读。
                排版复用工作区区头的语言（text-xs font-medium tracking-wider + muted-foreground +
                size-4 图标），高度取 h-9 < 工作区区头的 h-14：它管的是区头**之下**那层列表，不与之同高。
                计数是**独立节点**、不拼进 t() —— 译文不持有数字（数字随数据变，占位会漂移，DEV-011）。
            -->
            <div data-testid="sidebar-sessions-header" class="flex h-9 shrink-0 items-center px-2">
                <span
                    class="flex min-w-0 flex-1 items-center gap-2 px-2 text-xs font-medium tracking-wider text-muted-foreground"
                >
                    <MessagesSquare class="size-4 shrink-0" aria-hidden="true" />
                    <span class="truncate">{{ t("sidebar.sessionsSection") }}</span>
                </span>
                <span
                    data-testid="sidebar-sessions-count"
                    class="shrink-0 px-2 text-xs tabular-nums text-muted-foreground"
                >
                    {{ sessionCount }}
                </span>
            </div>

            <WorkspaceSessionGroups
                ref="sessionGroupsRef"
                @new-session="startNewChatInWorkspace"
                @new-standalone-session="openStandaloneDialog"
            />

            <StandaloneSessionDialog
                :show="standaloneDialogOpen"
                @close="standaloneDialogOpen = false"
                @created="onStandaloneCreated"
            />

            <div
                v-if="isMobile"
                class="shrink-0 space-y-1 border-t border-sidebar-border px-3 py-3"
            >
                <!-- task-36 ③ 的移动端紧凑语言开关：**已移除**（D-899，用户「语言切换放到设置里吧」；
                     Lead 裁定不分 rail/抽屉：移动端保留 = 两个入口）。移动端同走
                     设置页 · 用户层 · user-preference（/settings/user/user-preference）。 -->
                <div class="flex items-center gap-2 px-3 py-2 text-sm text-sidebar-foreground/70">
                    <CircleUser class="size-4" aria-hidden="true" />
                    <span class="truncate">{{ auth.userName }}</span>
                </div>
                <button
                    data-testid="sidebar-settings"
                    class="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
                    @click="navigateSettings"
                >
                    <Settings class="size-4" aria-hidden="true" />
                    {{ t("sidebar.settings") }}
                </button>
                <button
                    data-testid="sidebar-logout"
                    class="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
                    @click="handleLogout"
                >
                    <LogOut class="size-4" aria-hidden="true" />
                    {{ t("sidebar.logout") }}
                </button>
            </div>

            <!--
                PLAN-0753 T3: 宽度气泡的显隐由壳层桥接的 `resizing` 驱动，文本由桥接在
                `@resize` 里**命令式**写入（textContent）——不建响应式宽度通道。
            -->
            <span
                v-if="resizing"
                ref="bubbleRef"
                data-testid="sidebar-resize-bubble"
                aria-hidden="true"
                class="pointer-events-none absolute -right-1 top-1/2 z-30 translate-x-full -translate-y-1/2 rounded bg-foreground/85 px-1.5 py-0.5 text-xs tabular-nums text-background"
            />
        </div>
    </aside>
</template>

<style scoped>
/*
 * PLAN-0753 T3: reka 拥有 panel 宽度（flex-grow），拖拽期间抑制 transition 并把
 * 子节点设为 pointer-events: none —— 内容不会跟着每次 pointermove 重排，手感与
 * PLAN-0626 的"跟手不走响应式"一致。will-change 指向实际被动画的属性。
 */
/*
 * task-89 ④：面板是 inline-size 容器。展开动画期间 flex-grow 会把面板从 56px 拉到目标宽，
 * 那一瞬 58px 的搜索框与 28px 的新建会话按钮会相交 —— 面板窄于任何可用宽度时整行让位。
 */
#sidebar-panel {
    container-type: inline-size;
}

@container (max-width: 15rem) {
    .sidebar-search-row {
        display: none;
    }
}

.is-resizing {
    will-change: flex-grow;
}

.is-resizing :deep(*) {
    pointer-events: none;
}
</style>
