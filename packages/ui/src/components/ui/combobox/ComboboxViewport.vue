<script setup lang="ts">
import type { ComboboxViewportProps } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { reactiveOmit } from "@vueuse/core";
import { cn } from "@/lib/utils";
import { ComboboxViewport, useForwardProps } from "reka-ui";

const props = defineProps<ComboboxViewportProps & { class?: HTMLAttributes["class"] }>();

const delegatedProps = reactiveOmit(props, "class");

const forwarded = useForwardProps(delegatedProps);
</script>

<template>
    <!--
      task-215：显式 tabindex="-1" 是**必须**的，删掉它 Tab 会多停一跳。
      根因不在 reka：Chrome 130 起「没有可聚焦子项的可滚动容器」默认进入顺序焦点导航（官方：
      developer.chrome.com/blog/keyboard-focusable-scrollers ——「From Chrome 130, scrollers are
      keyboard focusable by default if they have no keyboard focusable children」，且「negative
      tabindex ⇒ the scroller will be skipped」）。本 viewport 是 overflow-y-auto 且 24 个选项全是
      tabindex="-1"（无可聚焦子项）⇒ 浏览器把它当 Tab 落点：表现为「第一次 Tab 停在 role=presentation
      的 div 上、层不关，第二次 Tab 才离开」。实测对照（internal/A03-xihe/evidence/2026-11-21-combobox-a11y/
      reading-a11y-tab-rootcause.json）：基线 Tab→viewport 且层 open；把 overflow 改 visible 后
      Tab→触发器且层关闭；显式 tabindex="-1" 后 Tab→触发器且层关闭；改成 tabindex="0" 又停回 viewport。
      为什么不「顺手」保留这一跳：该元素 role=presentation（无 ARIA 角色），停在它上面没有可传达的
      语义；层内键盘操作走 ComboboxInput（role=combobox + aria-activedescendant + 方向键），滚动跟随
      高亮项，不需要容器自己拿焦点。
    -->
    <ComboboxViewport
        data-slot="combobox-viewport"
        tabindex="-1"
        v-bind="forwarded"
        :class="
            cn(
                'no-scrollbar max-h-[min(calc(--spacing(72)---spacing(9)),calc(var(--available-height)---spacing(9)))] scroll-py-1 overflow-y-auto p-1 data-empty:p-0',
                props.class,
            )
        "
    >
        <slot />
    </ComboboxViewport>
</template>
