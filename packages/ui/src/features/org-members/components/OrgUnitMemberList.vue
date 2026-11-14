<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Badge } from "../../../components/ui/badge";
import { Switch } from "../../../components/ui/switch";
import {
    api,
    ApiError,
    type ApiOrgUnitMember,
    type ApiOrgUnitNode,
} from "../../../composables/api";
import {
    classifyOrgTreeError,
    orgUnitNames,
    type OrgTreeErrorKind,
} from "../composables/useOrgUnitTree";
import OrgMemberDetailSheet from "./OrgMemberDetailSheet.vue";

const props = defineProps<{ unit: ApiOrgUnitNode | null }>();
const { t } = useI18n();

const members = ref<ApiOrgUnitMember[]>([]),
    loading = ref(false),
    error = ref<OrgTreeErrorKind | "">(""),
    errorDetail = ref(""),
    /**
     * 设计裁定（design §5.1）：「含子单元成员」默认开 —— 避免"点了父节点以为看全了"。
     *
     * **刻意不持久化**：开关只作用于当前这次列表查询（每次进页面都回到「含」）。
     * 理由：持久化会把「上次关过」变成一个用户想不起来的隐性状态，从而**重新制造**
     * "点了父节点发现人少了"这个要修的体验；默认开 + 可见的勾选框，语义比记忆用户偏好更稳。
     */
    includeDescendants = ref(true);

async function load() {
    if (!props.unit) return;
    loading.value = true;
    error.value = "";
    errorDetail.value = "";
    try {
        members.value = await api.listOrgUnitMembers(props.unit.id, {
            includeDescendants: includeDescendants.value,
        });
    } catch (cause) {
        error.value = classifyOrgTreeError(cause);
        errorDetail.value =
            cause instanceof ApiError ? (cause.problem.detail ?? cause.message) : String(cause);
        members.value = [];
    } finally {
        loading.value = false;
    }
}

watch(
    () => [props.unit?.id, includeDescendants.value],
    () => void load(),
    { immediate: true },
);

/**
 * 成员行的「所在单元」解析：树节点注册表（加载过的单元都有名字）。
 * 没加载过的单元（读面子集）没有名字可解析 —— 诚实显示 id 本身，**不编造名字**。
 */
function unitDisplayName(id: string): string {
    return orgUnitNames.value.get(id) ?? id;
}

/**
 * task-43：成员**详情面**（抽屉）。点开 = 只读视图：工作区成员角色 / 访问角色绑定 /
 * 权限可得性（B 形态）/ 所属单元 —— 四段各自的数据来源不同，见 `OrgMemberDetailSheet` 的头注释。
 */
const detailMember = ref<ApiOrgUnitMember | null>(null);
const detailUnitName = ref("");
const detailOpen = ref(false);

function openDetail(member: ApiOrgUnitMember) {
    detailMember.value = member;
    detailUnitName.value = unitDisplayName(member.orgUnitId);
    detailOpen.value = true;
}

const errorTitle = computed(() =>
    error.value === "not-found"
        ? t("orgMembers.notFoundTitle")
        : error.value === "forbidden"
          ? t("orgMembers.atomDeniedTitle")
          : t("orgMembers.membersError"),
);
const errorDesc = computed(() =>
    error.value === "not-found"
        ? t("orgMembers.notFoundDesc")
        : error.value === "forbidden"
          ? t("orgMembers.atomDeniedDesc")
          : errorDetail.value,
);
</script>

<template>
    <div class="flex h-full min-h-0 flex-col" data-testid="org-member-list">
        <div class="flex flex-wrap items-center gap-3 border-b px-4 py-3">
            <div class="min-w-0">
                <p class="truncate text-sm font-semibold" data-testid="org-member-scope">
                    {{ unit ? unit.name : t("orgMembers.membersTitle") }}
                </p>
            </div>
            <label
                class="ms-auto flex items-center gap-2 text-sm text-muted-foreground"
                :title="t('orgMembers.includeDescendantsTitle')"
            >
                {{ t("orgMembers.includeDescendants") }}
                <Switch
                    :checked="includeDescendants"
                    data-testid="org-member-descendants"
                    @update:checked="includeDescendants = $event"
                />
            </label>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto">
            <p v-if="!unit" data-testid="org-member-hint" class="p-4 text-sm text-muted-foreground">
                {{ t("orgMembers.selectUnit") }}
            </p>
            <p
                v-else-if="loading"
                data-testid="org-member-loading"
                class="p-4 text-sm text-muted-foreground"
            >
                {{ t("orgMembers.membersLoading") }}
            </p>
            <div v-else-if="error" data-testid="org-member-error" class="p-4">
                <p class="text-sm font-medium">{{ errorTitle }}</p>
                <p class="mt-1 text-sm text-muted-foreground">{{ errorDesc }}</p>
                <button
                    v-if="error === 'other'"
                    type="button"
                    data-testid="org-member-retry"
                    class="mt-2 rounded-md border px-2 py-1 text-sm hover:bg-accent"
                    @click="void load()"
                >
                    {{ t("orgMembers.retry") }}
                </button>
            </div>
            <p
                v-else-if="!members.length"
                data-testid="org-member-empty"
                class="p-4 text-sm text-muted-foreground"
            >
                {{ t("orgMembers.membersEmpty") }}
            </p>
            <table v-else class="w-full text-sm" data-testid="org-member-table">
                <thead>
                    <tr class="border-b text-left text-muted-foreground">
                        <th class="px-4 py-2 font-medium">{{ t("orgMembers.colName") }}</th>
                        <th class="px-4 py-2 font-medium">{{ t("orgMembers.colKind") }}</th>
                        <th class="px-4 py-2 font-medium">{{ t("orgMembers.colUnit") }}</th>
                    </tr>
                </thead>
                <tbody>
                    <tr
                        v-for="member in members"
                        :key="member.memberKind + ':' + member.memberId"
                        class="border-b last:border-0"
                        :data-testid="'org-member-row-' + member.memberId"
                    >
                        <td class="px-4 py-2">
                            <button
                                type="button"
                                class="text-left underline-offset-2 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 rounded-sm"
                                :data-testid="'org-member-open-' + member.memberId"
                                @click="openDetail(member)"
                            >
                                {{ member.displayName ?? "—" }}
                            </button>
                        </td>
                        <td class="px-4 py-2">
                            <Badge
                                variant="secondary"
                                :data-testid="'org-member-kind-' + member.memberId"
                            >
                                {{
                                    member.memberKind === "human"
                                        ? t("orgMembers.kindHuman")
                                        : t("orgMembers.kindAgent")
                                }}
                            </Badge>
                        </td>
                        <td class="px-4 py-2" :data-testid="'org-member-unit-' + member.memberId">
                            {{ unitDisplayName(member.orgUnitId) }}
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
        <OrgMemberDetailSheet
            :member="detailMember"
            :open="detailOpen"
            :unit-name="detailUnitName"
            @update:open="detailOpen = $event"
        />
    </div>
</template>
