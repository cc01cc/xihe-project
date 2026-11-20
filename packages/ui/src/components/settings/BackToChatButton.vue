<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useSessionStore } from "../../stores/session";
import { ArrowLeft } from "@lucide/vue";
import { useAuthStore } from "../../stores/auth";
import { workspaceSessionPath, workspacePath } from "../../lib/routes";
import { Button } from "../ui/button";

const router = useRouter();
const { t } = useI18n();
const sessionStore = useSessionStore(),
    auth = useAuthStore();

/**
 * `task-40`（`task-39` 复核表 H-07）：**这个控件是导航，就该是链接**。
 *
 * <p>改前是一个原生 `<button @click>`：JS 里 `router.push` 能把它送到目标页，但**浏览器拿不到
 * URL** ⇒ 中键 / 右键「在新标签打开」/ ⌘-click / 「复制链接地址」全部失效，而这些是链接的默认
 * 能力、不是额外功能。判据因此是**结构性**的：渲染结果必须是真实 `<a href>`（此处由
 * `Button as-child` 包 `router-link` 得到，范本 `views/settings/SettingsForbiddenView.vue:23-25`），
 * 而不是"点一下确实跳了"。样式/文案/i18n/`data-testid` 逐项保持不变。</p>
 *
 * <p><b>为什么 href 与点击逻辑是两份</b>：`href` 是**给浏览器看的**（新标签、复制地址），点击是
 * **给 SPA 看的**（`task-36` ② 的历史语义：上一条历史就是聊天/工作区时 `router.back()`，不新增
 * 历史）。所以普通左键 / Enter 一律 `preventDefault` 后走 `goBack()`；带修饰键或非主键的点击
 * **不拦**，交给浏览器默认行为 —— 那正是本卡要恢复的能力。监听器用 `.capture`：`RouterLink` 自己的
 * `navigate` 挂在冒泡阶段且先判 `defaultPrevented`，捕获阶段先跑才能保证不会被它抢先 push 一遍。</p>
 */

/**
 * 「返回聊天」的目标页（**同时就是链接的 href**）：当前会话 → 该会话；否则 → 当前工作区；
 * 再否则 → 工作台模块入口（`task-34` 后是 `/workbench`）。
 * 这是**历史回退不可用时的兜底**，不是常规路径（常规路径见 `goBack`）。
 */
function chatTargetPath(): string {
    const id = sessionStore.currentSessionId;
    if (id) {
        const workspaceId = sessionStore.currentSession?.workspaceId ?? auth.currentWorkspaceId;
        return workspaceId ? workspaceSessionPath(workspaceId, id) : "/workbench";
    }
    const workspaceId = auth.currentWorkspaceId;
    return workspaceId ? workspacePath(workspaceId) : "/workbench";
}

const href = computed(chatTargetPath);

/**
 * `task-36` ②：返回聊天**优先走历史回退**。
 *
 * <p>原实现每次点都 `router.push(聊天)`，于是「聊天 → 设置 → 返回聊天 → 再进设置 → 再返回」每轮都新增一条
 * 历史，浏览器后退键要按很多下才回得去（<b>历史堆积</b>）。判据：</p>
 * <ol>
 *   <li>上一条历史就是聊天/工作区页 ⇒ `router.back()`：回到用户真正来的地方，且**不新增**历史；</li>
 *   <li>否则（新标签直链、上一条是另一个设置页、或根本没有历史）⇒ `router.push`：保证一次点击就能离开设置区，
 *       因为控件文案承诺的是「返回聊天」，把用户退回上一个设置页不算兑现。</li>
 * </ol>
 * <p>`router.options.history.state.back` 只在 web history 下有值（memory history 下为 null），读取时按未知形状防御。</p>
 */
function goBack() {
    const historyState = router.options.history.state as { back?: string | null } | undefined;
    const previous = historyState?.back ?? null;
    const cameFromChat =
        typeof previous === "string" &&
        (previous === "/workbench" || previous.startsWith("/workspace/"));
    if (cameFromChat) {
        router.back();
        return;
    }
    router.push(chatTargetPath());
}

/**
 * `task-40`：**只拦"SPA 点击"**。
 *
 * <p>修饰键（⌘/Ctrl/Shift/Alt）与非主键（如中键）是用户明确要求"新标签/新窗口"的手势 ⇒ 直接放行，
 * 让 `RouterLink` 的 `guardEvent` 与浏览器默认行为按 href 办（两处都只在主键无修饰时才导航）。
 * 其余（普通左键、键盘 Enter 触发的合成点击）`preventDefault` 后走 `goBack()`，保住 `task-36`
 * 的历史语义 —— 否则点一次「返回聊天」会新增一条历史，而用户拿不到原生链接能力的补偿。</p>
 */
function onNavigate(event: MouseEvent) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (event.button !== 0) return;
    event.preventDefault();
    goBack();
}
</script>

<template>
    <!--
        `as-child`：vendor `Button` 只提供样式与焦点语义，**渲染的必须是内层 `router-link` 的 `<a>`**
        （`Primitive as-child` 把 Button 的 class/aria 合并到子元素上，不额外包一层元素）。
        下面那串 class 是对 vendor 默认按钮外观的**逐项还原**（原控件是无边框、无底色、无内距的
        文字按钮）：`h-auto / px-0 / border-0 / justify-start / font-normal / transition-colors`
        覆盖 vendor 的 `h-8 / px-2.5 / border / justify-center / font-medium / transition-all`，
        `cn`（tailwind-merge）保证同族工具类后者胜出，所以视觉与改前逐项一致。
    -->
    <Button
        as-child
        variant="ghost"
        class="mb-3 flex h-auto justify-start gap-1 rounded-none border-0 bg-transparent px-0 text-sm font-normal text-muted-foreground transition-colors hover:bg-transparent hover:text-foreground"
    >
        <router-link
            :to="href"
            data-testid="settings-back-to-chat"
            class="flex items-center gap-1"
            @click.capture="onNavigate"
        >
            <ArrowLeft class="size-4" aria-hidden="true" />
            {{ t("chat.backToChat") }}
        </router-link>
    </Button>
</template>
