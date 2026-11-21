import { computed, onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from "vue";
import { onBeforeRouteLeave, onBeforeRouteUpdate } from "vue-router";

/**
 * task-190：设置页**整页草稿**的离开守卫（路由内离开 + 浏览器级离开）。
 *
 * <p>为什么抽成 composable 而不是写在 `SettingsDomainView` 里：守卫的判据（有草稿才拦、两个动作
 * 各自放行/留守、`beforeunload` 只在有草稿时挂）必须能脱离整页挂载被单测钉住 —— 写死在页面里
 * 就只能靠 e2e 验证，而「弹窗能弹能关但请求照发」这类假绿正是页面级脚本最容易漏的形态。</p>
 *
 * <p>草稿**来源**不在本 composable：页面把 `ConfigLayerPanels` 聚合出的 dirty 标签推进来
 * （`setDrafts`），本模块只负责「有草稿时把导航挂起并等用户拍板」。丢弃**不触发保存** ——
 * 这里没有任何保存动作，草稿由面板卸载自然消失（J4 的判据就是「丢弃后保存次数为 0」）。</p>
 */
export interface DraftLeaveGuard {
    /** 有未保存改动的域标签（给确认框点名用）。 */
    draftLabels: Ref<string[]>;
    pageDirty: ComputedRef<boolean>;
    /** 确认框开关（模板绑 vendor AlertDialog 的 `open`）。 */
    promptOpen: Ref<boolean>;
    /** 页面把聚合后的 dirty 标签推进来。 */
    setDrafts: (labels: string[]) => void;
    /** 用户选择「继续编辑」：取消这次导航。 */
    keepEditing: () => void;
    /** 用户选择「丢弃并离开」：放行这次导航（不保存任何东西）。 */
    discardDrafts: () => void;
    /** 供测试/调试直接问「现在会不会被拦」。 */
    confirmLeaveWithDraft: () => Promise<boolean>;
}

export function useDraftLeaveGuard(): DraftLeaveGuard {
    const draftLabels = ref<string[]>([]);
    const pageDirty = computed(() => draftLabels.value.length > 0);

    const promptOpen = ref(false);
    /**
     * 挂起中的导航决策。用 Promise 而不是布尔：守卫可以等用户点完再决定，等待期间路由不动、
     * 面板也还在（用户点「继续编辑」能原样接着改）。
     */
    let decision: ((allow: boolean) => void) | null = null;

    function confirmLeaveWithDraft(): Promise<boolean> {
        if (!pageDirty.value) return Promise.resolve(true);
        promptOpen.value = true;
        return new Promise<boolean>((resolve) => {
            decision = resolve;
        });
    }

    function settle(allow: boolean): void {
        promptOpen.value = false;
        const resolve = decision;
        decision = null;
        resolve?.(allow);
    }

    function setDrafts(labels: string[]): void {
        draftLabels.value = [...labels];
    }

    function keepEditing(): void {
        settle(false);
    }

    function discardDrafts(): void {
        // 只清聚合表 + 放行；草稿本体随面板卸载丢弃，这里绝不调用保存。
        draftLabels.value = [];
        settle(true);
    }

    onBeforeRouteLeave(() => confirmLeaveWithDraft());
    /**
     * 同一条守卫也要挂在 update 上：层与域都注册成**逐条路由**，多数切换触发 leave；同记录只改参数的
     * 导航（例如 `?tab=` 深链）只会触发 update，漏挂就是「换个 tab 静默丢草稿」。
     * 两处调的是**同一个** `confirmLeaveWithDraft`，不各写一套判据。
     */
    onBeforeRouteUpdate(() => confirmLeaveWithDraft());

    /**
     * 刷新 / 关标签页是**浏览器级**离开，路由守卫拦不到 ⇒ 只在有草稿时注册 `beforeunload`；
     * 无草稿与卸载都必须立即摘掉，漏摘会让整个站点每次刷新都弹「离开此网站？」。
     */
    function onBeforeUnload(event: BeforeUnloadEvent): void {
        event.preventDefault();
        // Chrome 只在设置了 returnValue 时才显示通用提示；文案由浏览器给，页面无法自定义。
        event.returnValue = "";
    }
    watch(pageDirty, (dirty) => {
        if (dirty) window.addEventListener("beforeunload", onBeforeUnload);
        else window.removeEventListener("beforeunload", onBeforeUnload);
    });
    onBeforeUnmount(() => {
        window.removeEventListener("beforeunload", onBeforeUnload);
        // 卸载时若还有挂起的导航（理论上不应发生），按「不放行」收口，不留悬挂 Promise。
        if (decision) settle(false);
    });

    return {
        draftLabels,
        pageDirty,
        promptOpen,
        setDrafts,
        keepEditing,
        discardDrafts,
        confirmLeaveWithDraft,
    };
}
