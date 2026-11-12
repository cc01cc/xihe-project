<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import { type ResourceId, type ResourceLayer } from "../../lib/settingsIa";
import { resourceDetailPath } from "../../lib/resourceDetail";

/**
 * 资源列表行尾的**详情**入口（PLAN-0772 M2 / task-228）。
 *
 * <p>为什么单独一个组件而不是每行抄一段：三个面板（`CredentialsPanel` / `SkillsPanel` /
 * `WorkspaceSkillsPanel`）的行都要拿同一份「pk + 层 ⇒ 详情 URL」口径；抄三遍就会漂成三种
 * pk 语义（一边用 `credential.id`、一边用 `skill.name` 的那种事故）。本组件只做一件事：
 * 用 `resourceDetailPath` 拼 URL，层由**调用方传**（面板自己知道它渲染的是哪一层，
 * 不在这里猜 `?layer=`）。</p>
 *
 * <p>三条交互约束（Lead 2026-11-12 裁定 (a)）：</p>
 * <ul>
 *   <li><b>纯增量</b>：只加这一个链接，不改行内容、不动既有 testid、不改布局层级；</li>
 *   <li><b>不吞行点击</b>：`@click.stop` —— 行本身可能有点击/展开行为，详情入口不许抢走它；</li>
 *   <li><b>键盘可达</b>：`<router-link>` 原生 tab 可达，不用 `div + click` 仿链接。</li>
 * </ul>
 */
const props = defineProps<{
    resourceId: ResourceId;
    layer: ResourceLayer;
    /** 资源 + 层内唯一的 pk（凭据 = id、技能 = skillId、智能体 = principalId…）。 */
    pk: string;
    /** 可访问名里的人类可读名（缺省回落到 pk）。 */
    name?: string;
}>();

const { t } = useI18n();

const to = computed(() => resourceDetailPath(props.resourceId, props.layer, props.pk));
const aria = computed(() => t("resources.detail.linkAria", { name: props.name || props.pk }));
</script>

<template>
    <router-link
        :to="to"
        :aria-label="aria"
        :data-testid="`resource-detail-link-${pk}`"
        class="shrink-0 rounded-md border px-2 py-0.5 text-xs text-muted-foreground underline-offset-4 hover:bg-muted hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
        @click.stop
    >
        {{ t("resources.detail.link") }}
    </router-link>
</template>
