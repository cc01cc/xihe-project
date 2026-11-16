<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useAuthStore } from "../../../stores/auth";
import {
    Activity,
    Code,
    FileDiff,
    GitBranch,
    MoreHorizontal,
    PanelLeft,
    Plus,
    Users,
} from "@lucide/vue";
import { Button } from "../../../components/ui/button";
import {
    workspacePath,
    workspaceScheduledTasksPath,
    workspaceSettingsPath,
} from "../../../lib/routes";

/**
 * PLAN-0582 S3a (review P1-1): this row keeps only controls that belong here —
 * the dock toggles and the workspace-level dialog entries. Page tabs moved to
 * `WorkspaceTabBar`, file actions moved to the file-tree panel head, and the
 * workspace name is no longer repeated here (P1-2).
 */
const props = defineProps<{
    workspaceId: string;
    codeOpen?: boolean;
    changesOpen?: boolean;
    monitorOpen?: boolean;
    membersOpen?: boolean;
    /**
     * BL-317 / D-198：移动端成员入口的未读提及数（**服务端派生**：`readCursor.mentionCount`
     * 只求和，不累加、不持久化）。`0`/缺省 = 不显示徽标。
     */
    membersUnread?: number;
    /** PLAN-0659 T1.4：委派 DAG 面板是否处于当前 dock tab。 */
    delegationOpen?: boolean;
}>();

const emit = defineEmits<{
    agents: [];
    files: [];
    toggleCode: [];
    toggleChanges: [];
    toggleMonitor: [];
    toggleMembers: [];
    toggleDelegation: [];
}>();

const { t } = useI18n();
const router = useRouter(),
    auth = useAuthStore();

/** 徽标只做"呈现上限"处理（`@9+`），数值本身来自 props（服务端派生，前端不累加）。 */
const membersBadgeCount = computed(() => {
    const value = props.membersUnread ?? 0;
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
});

function openEnvironment() {
    const id = props.workspaceId || auth.currentWorkspaceId;
    if (id) router.push(`/workspace/${id}/environment`);
}

function openScheduledTasks() {
    const id = props.workspaceId || auth.currentWorkspaceId;
    if (id) router.push(workspaceScheduledTasksPath(id));
}

function openSettings() {
    const id = props.workspaceId || auth.currentWorkspaceId;
    if (id) router.push(workspaceSettingsPath(id));
}

// PLAN-0560 T3.7：移动端工具条收敛为 ＋ 新建对话 + ⋯ 溢出菜单。
const overflowOpen = ref(false);

function newChat() {
    const id = props.workspaceId || auth.currentWorkspaceId;
    overflowOpen.value = false;
    if (id) router.push({ path: workspacePath(id), query: { newChat: "1" } });
}

function overflowNav(navigate: () => void) {
    overflowOpen.value = false;
    navigate();
}
</script>

<template>
    <!--
        task-365 E：给这条 chrome 一个稳定锚点 —— 「文件路径不在工具栏里」这条负例需要一个
        可定位的容器（否则只能断言某个不存在的 testid 计数为 0，那是恒真的假断言）。
    -->
    <div
        data-testid="workspace-toolbar"
        class="flex items-center gap-2 px-3 h-10 border-b shrink-0 bg-background/80"
    >
        <!--
            task-57（SC 2.5.8 24×24 AA）：原手搓 `<button class="p-1.5">` + `size-3.5` 图标 =
            5.25×2 + 12.25 = **22.75px**（ui-2 batch-4 实测 22.8）⇒ 换 vendor Button
            `variant="ghost" size="icon-sm"` = 24.5px（AGENTS：控件优先栈内 UI 库）。
            显式保留：`text-muted-foreground` / `hover:bg-accent`（盖过 ghost 默认的 muted 底与
            hover:text-foreground）、`md:hidden`（仅移动态）；图标仍 `size-3.5` —— vendor 的
            svg 尺寸规则 `[&_svg:not([class*=size-])]` 对**带 size 类**的图标不生效。
            接受的视觉变化（Lead 裁定 go）：圆角 `rounded` → token 档；白赚 focus ring 3 与
            按压 1px 位移。
        -->
        <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground hover:bg-accent md:hidden"
            :title="t('files.titleFiles')"
            :aria-label="t('common.files')"
            data-testid="workspace-toolbar-files-mobile"
            @click="emit('files')"
        >
            <PanelLeft class="size-3.5" />
        </Button>
        <!-- 同上（task-57）：命中盒 22.75 → 24.5px，vendor 换装；注释见 files 按钮上方。 -->
        <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground hover:bg-accent md:hidden"
            data-testid="workspace-toolbar-new-chat-mobile"
            :title="t('sidebar.newChat')"
            :aria-label="t('sidebar.newChat')"
            @click="newChat"
        >
            <Plus class="size-3.5" />
        </Button>
        <div class="relative md:hidden">
            <!-- 同上（task-57）：命中盒 22.75 → 24.5px，vendor 换装。
                 `aria-expanded` 走 fallthrough attrs 落到原生 button 上，不变。 -->
            <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                class="text-muted-foreground hover:bg-accent"
                data-testid="workspace-toolbar-more-mobile"
                :title="t('workspace.toolbarMore')"
                :aria-label="t('workspace.toolbarMore')"
                :aria-expanded="overflowOpen"
                @click="overflowOpen = !overflowOpen"
            >
                <MoreHorizontal class="size-3.5" />
            </Button>
            <!--
                BL-317（390×844 实测）：菜单原先是 `right-0`，但触发按钮在工具条**左侧**簇里，
                菜单（154px 宽）在 390 下会跑到 x=-61（左侧被裁掉，且页面不产生横向滚动 ⇒
                菜单项点不到）—— 改锚到 `left-0` 后落在 68..222，完整可见。
                只影响移动端（外层是 `md:hidden`），桌面零变化。
            -->
            <!--
                task-57（SC 2.5.8 24×24 AA）：菜单 7 项**统一命中盒** `min-h-12`（D-206 裁定）。
                本仓 `--spacing` = 3.5px ⇒ 12 步 = **42px**（token，不是任意值；24 档是 7 步）。
                改前是两档：monitor/members 带 `max-md:min-h-[44px]`（任意值），另 5 项只有
                `py-1.5` ⇒ 内容高 10.5 + 21.7 = 32.2px。**两档都 ≥24 ⇒ 都不违例**，
                要修的是「同族两档 + 任意值」这件事本身。
                D-206（Lead 2026-11-16 自裁，可逆）：统一到 **42px** 而非 24.5，四条理由 ——
                ①避免 44 → 32.2 的手感回归；②`min-h-12` 是 token；③7×42 = 294px 在 844 视口内；
                ④WCAG 24 是下限不是目标，iOS HIG 44 是推荐 ⇒ 取 42 兼顾两者。
                用户若要 44 档，改一个 token（`min-h-[12.5]` → 12.5 步 ≈ 43.75，或等 spacing 允许）。
            -->
            <div
                v-if="overflowOpen"
                class="absolute left-0 top-full mt-1 z-50 w-44 rounded-md border bg-popover p-1 shadow-md text-sm"
                data-testid="workspace-toolbar-more-menu"
            >
                <button
                    type="button"
                    class="w-full min-h-12 rounded px-2 py-1.5 text-left hover:bg-accent"
                    data-testid="workspace-toolbar-more-changes"
                    @click="overflowNav(() => emit('toggleChanges'))"
                >
                    {{ t("workspace.panelChanges") }}
                </button>
                <button
                    type="button"
                    class="w-full min-h-12 rounded px-2 py-1.5 text-left hover:bg-accent"
                    data-testid="workspace-toolbar-more-monitor"
                    @click="overflowNav(() => emit('toggleMonitor'))"
                >
                    {{ t("workspace.panelMonitor") }}
                </button>
                <!--
                    BL-317 / D-198：移动端成员面板入口。桌面那条 `workspace-toolbar-members`
                    在 `max-md` 下是 hidden（桌面 action cluster），所以移动端必须从这个溢出菜单进；
                    徽标只呈现**服务端**未读数（求和自 store 的 `readCursor.mentionCount`），
                    上限 `@9+`，并带 `aria-label`（不能只靠视觉）。
                -->
                <button
                    type="button"
                    class="flex w-full min-h-12 items-center justify-between gap-2 rounded px-2 py-1.5 text-left hover:bg-accent"
                    data-testid="workspace-toolbar-more-members"
                    :aria-label="
                        membersBadgeCount > 0
                            ? `${t('workspace.panelMembers')} · ${t('workspace.participantMentionBadge', { count: membersBadgeCount })}`
                            : t('workspace.panelMembers')
                    "
                    @click="overflowNav(() => emit('toggleMembers'))"
                >
                    <span>{{ t("workspace.panelMembers") }}</span>
                    <span
                        v-if="membersBadgeCount > 0"
                        class="rounded-full bg-primary px-1.5 py-0.5 text-xs leading-none text-primary-foreground"
                        data-testid="workspace-toolbar-more-members-badge"
                        aria-hidden="true"
                        >@{{ membersBadgeCount > 9 ? "9+" : membersBadgeCount }}</span
                    >
                </button>
                <button
                    type="button"
                    class="w-full min-h-12 rounded px-2 py-1.5 text-left hover:bg-accent"
                    data-testid="workspace-toolbar-more-delegation"
                    @click="overflowNav(() => emit('toggleDelegation'))"
                >
                    {{ t("workspace.panelDelegation") }}
                </button>
                <!--
                  C3 护栏（task-217，Lead 裁定）：下面三个溢出入口（more-environment /
                  more-scheduled / more-settings）是**窄屏唯一页面入口** —— 桌面页入口只有
                  二级导航（WorkspaceSecondaryNav），窄屏不渲染页签栏，这套「⋯」菜单是唯一
                  能到环境 / 定时任务 / 设置的地方。做 IA 清理时**不许**把它们当重复面删掉：
                  删它等于删移动端入口。
                -->
                <button
                    type="button"
                    class="w-full min-h-12 rounded px-2 py-1.5 text-left hover:bg-accent"
                    data-testid="workspace-toolbar-more-environment"
                    @click="overflowNav(openEnvironment)"
                >
                    {{ t("workspace.environmentState") }}
                </button>
                <button
                    type="button"
                    class="w-full min-h-12 rounded px-2 py-1.5 text-left hover:bg-accent"
                    data-testid="workspace-toolbar-more-scheduled"
                    @click="overflowNav(openScheduledTasks)"
                >
                    {{ t("workspace.scheduledTasks.nav") }}
                </button>
                <button
                    type="button"
                    class="w-full min-h-12 rounded px-2 py-1.5 text-left hover:bg-accent"
                    data-testid="workspace-toolbar-more-settings"
                    @click="overflowNav(openSettings)"
                >
                    {{ t("workspace.settingsTitle") }}
                </button>
            </div>
        </div>
        <!--
            task-365 E：文件路径面包屑**整段搬去文件树面板头**（FileTreePanel 的
            `workspace-tree-active-file`）—— 文件级状态归文件级容器，不占 workbench chrome 正中。
            这里留一个**空撑位**：它是把右侧控件推到右端的布局件（flex-1），删掉它右段会左移；
            外层宽度不变 ⇒ 右段 x 不变（D-1161 的零跳动纪律：改内容不改宽度）。
            与 D-1161 的关系：那条裁定删的是「未选择文件」**空态占位**，并把「挪回面板头」列为
            被否决方案 —— 否决的是空态文案的**存在必要性**；本卡搬的是**真有文件时的路径**，
            面板侧无文件时整行不渲染，不重新引入任何占位文案。
            树面板收起时路径仍可见：编辑器自己的页签条（EditorTabBar）钉着当前文件。
        -->
        <!--
            task-312（D-1161 用户裁定）：「未选择文件」整段删除，不搬位置。
            用户原话「这一行都没有必要」—— 是**存在必要性**问题，不是位置问题。
            判据：① 它是**文件级**状态，却挂在 workbench 层 chrome 的正中间；
            ② 出现在会话页顶部却描述文件面板；③ 没打开文件是**常态**，用全条最淡的
            text-muted-foreground/70 占住中段，信息量为零。
            被否决的两个方案（防复发）：挪回 FileTreePanel header（等于把同一问题换个
            地方）、保留但改文案（同病）。文件面板的空态应由该面板自己表达。
            宽度影响（[实测] 2026-11-13，mock 预览 5199，1920×1080 等效）：
            把该 span 按原 class 插回原位再量，中段 1077.91 → 1077.91、右段 274.83 → 274.83、
            页签 x 逐个不变 ⇒ 删除零跳动。中段是 flex-1，本来就与外层同宽，变的是内容不是宽度。
        -->
        <div class="min-w-0 flex-1" aria-hidden="true" />

        <div class="flex items-center gap-1 max-md:hidden">
            <button
                type="button"
                data-testid="workspace-toolbar-code"
                class="p-1.5 rounded transition-colors"
                :class="
                    codeOpen ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent'
                "
                :title="t('workspace.toggleCode')"
                :aria-label="t('workspace.toggleCode')"
                :aria-pressed="codeOpen === true"
                @click="emit('toggleCode')"
            >
                <Code class="size-3.5" />
            </button>
            <button
                type="button"
                data-testid="workspace-toolbar-changes"
                class="p-1.5 rounded transition-colors"
                :class="
                    changesOpen
                        ? 'bg-accent text-foreground'
                        : 'text-muted-foreground hover:bg-accent'
                "
                :title="t('workspace.toggleDiff')"
                :aria-label="t('workspace.toggleDiff')"
                :aria-pressed="changesOpen === true"
                @click="emit('toggleChanges')"
            >
                <FileDiff class="size-3.5" />
            </button>
            <button
                type="button"
                data-testid="workspace-toolbar-monitor"
                class="p-1.5 rounded transition-colors"
                :class="
                    monitorOpen
                        ? 'bg-accent text-foreground'
                        : 'text-muted-foreground hover:bg-accent'
                "
                :title="t('workspace.toggleMonitor')"
                :aria-label="t('workspace.toggleMonitor')"
                :aria-pressed="monitorOpen === true"
                @click="emit('toggleMonitor')"
            >
                <Activity class="size-3.5" />
            </button>
            <!-- PLAN-0623 U1：参与者面板入口（与 monitor 同构；移动端由 dock 溢出菜单进入）。 -->
            <button
                type="button"
                data-testid="workspace-toolbar-members"
                class="p-1.5 rounded transition-colors"
                :class="
                    membersOpen
                        ? 'bg-accent text-foreground'
                        : 'text-muted-foreground hover:bg-accent'
                "
                :title="t('workspace.toggleMembers')"
                :aria-label="t('workspace.toggleMembers')"
                :aria-pressed="membersOpen === true"
                @click="emit('toggleMembers')"
            >
                <Users class="size-3.5" />
            </button>
            <!-- PLAN-0659 T1.4：委派 DAG 面板入口（与 monitor/members 同构）。 -->
            <button
                type="button"
                data-testid="workspace-toolbar-delegation"
                class="p-1.5 rounded transition-colors"
                :class="
                    delegationOpen
                        ? 'bg-accent text-foreground'
                        : 'text-muted-foreground hover:bg-accent'
                "
                :title="t('workspace.toggleDelegation')"
                :aria-label="t('workspace.toggleDelegation')"
                :aria-pressed="delegationOpen === true"
                @click="emit('toggleDelegation')"
            >
                <GitBranch class="size-3.5" />
            </button>
        </div>
    </div>
</template>
