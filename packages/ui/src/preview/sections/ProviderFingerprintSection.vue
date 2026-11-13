<script setup lang="ts">
import SectionShell from "../SectionShell.vue";
import { Badge } from "@/components/ui/badge";
import ProviderRequestFingerprintPanel from "@/features/workspace/monitor/ProviderRequestFingerprintPanel.vue";
import {
    PREVIEW_FINGERPRINT_BASELINE_ID,
    PREVIEW_FINGERPRINT_RUN_ID,
    mockProviderFingerprintDiff,
    mockProviderFingerprintError,
    mockProviderFingerprintNotCaptured,
    mockProviderFingerprintView,
} from "../mockData";
import type {
    ProviderRequestFingerprintDiffView,
    ProviderRequestFingerprintView,
} from "../../types";

/**
 * PLAN-0679 T3.1 preview block: the **real** `ProviderRequestFingerprintPanel` driven by fixture
 * data through its fetch seam. Four states side by side — captured envelope, absent
 * (`not_captured`), fail-open error marker, and the two-run layer diff. Nothing on this page
 * talks to `/api/v1/**`.
 */
const againstOptions = [{ runId: PREVIEW_FINGERPRINT_BASELINE_ID, label: "上一轮 · success" }];

type AnyView = ProviderRequestFingerprintView | ProviderRequestFingerprintDiffView;

/** Answers the single-run view unless a baseline is requested — exactly the product contract. */
function singleRunFetcher(view: ProviderRequestFingerprintView) {
    return async (): Promise<AnyView> => view;
}

const diffFetcher = async (_runId: string, options: { against?: string } = {}): Promise<AnyView> =>
    options.against === PREVIEW_FINGERPRINT_BASELINE_ID
        ? mockProviderFingerprintDiff
        : mockProviderFingerprintView;

const states = [
    {
        key: "captured",
        title: "已采集（单 run 六层）",
        hint: "document 六层 hash/count/bytes + request 元信息 + outbound 整包校准行",
        fetcher: singleRunFetcher(mockProviderFingerprintView),
        initialAgainst: "",
    },
    {
        key: "not-captured",
        title: "未采集（not_captured）",
        hint: "缺席只在信封里说明，不伪造第三态指纹",
        fetcher: singleRunFetcher(mockProviderFingerprintNotCaptured),
        initialAgainst: "",
    },
    {
        key: "error-marker",
        title: "采集失败（FINGERPRINT_TOO_LARGE）",
        hint: "超 8 KB 存错误标记行，request 块仍保留",
        fetcher: singleRunFetcher(mockProviderFingerprintError),
        initialAgainst: "",
    },
    {
        key: "diff",
        title: "两 run diff（同 session）",
        hint: "unchanged / changed(sameShape|grew|shrank) / added / removed / unavailable",
        fetcher: diffFetcher,
        initialAgainst: PREVIEW_FINGERPRINT_BASELINE_ID,
    },
];
</script>

<template>
    <SectionShell
        id="provider-fingerprint"
        index="08"
        title="Provider 请求指纹（PLAN-0679）"
        description="会话监控里的 provider 层最终请求指纹：单 run 展示六层 hash/count/bytes 与 outbound 校准行；选同 session 基线后展示两 run 逐层 diff。四态并排（已采集 / 未采集 / 采集失败 / diff）。组件为真组件，服务层经 fetcher 注入 fixture，本页不请求 /api/v1/**。"
    >
        <div class="grid grid-cols-4 items-start gap-4">
            <div
                v-for="state in states"
                :key="state.key"
                class="space-y-2 rounded-xl border border-border bg-background p-3"
            >
                <div class="flex items-center gap-2">
                    <h3 class="text-xs font-medium text-foreground">{{ state.title }}</h3>
                    <Badge variant="outline" class="font-mono text-xs">{{ state.key }}</Badge>
                </div>
                <p class="text-xs leading-relaxed text-muted-foreground">{{ state.hint }}</p>
                <div class="rounded-md border border-border/70 p-2">
                    <ProviderRequestFingerprintPanel
                        :run-id="PREVIEW_FINGERPRINT_RUN_ID"
                        :against-options="againstOptions"
                        :initial-against="state.initialAgainst"
                        :fetcher="state.fetcher"
                    />
                </div>
            </div>
        </div>

        <p
            class="mt-4 rounded-xl border border-dashed border-border bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground"
        >
            <span class="font-mono">fetcher</span>
            是组件真实取数路径的注入点：产品里默认为
            <span class="font-mono">api.getRunProviderRequestFingerprint</span>，本页换成
            fixture；diff 卡片以
            <span class="font-mono">initial-against</span> 预选基线，取数分支与产品一致（有
            <span class="font-mono">against</span> 才返回 diff）。层名与状态枚举对齐
            <span class="font-mono">docs/api/openapi.yaml</span> 的
            <span class="font-mono">ProviderRequestFingerprint*</span> schema。
        </p>
    </SectionShell>
</template>
