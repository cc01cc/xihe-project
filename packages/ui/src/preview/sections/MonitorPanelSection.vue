<script setup lang="ts">
/**
 * task-83 第三腿：`SessionMonitorPanel`（运行态监控面板）在 **dock 面板宽**下的行宽样本。
 *
 * 为什么单独开一块：这个面板是全包 `font-mono` 密度第 2 的地方（11 处），也是**唯一不在设置区**
 * 的高密度使用点，而它天生住在窄容器里（dock 宽 320–480）。只量宽容器（设置区 1152px 内容列）
 * 会得到一个「无顶行」的结论，却无法区分「真没有」与「这个容器宽根本不会顶行」。
 *
 * 三档宽度固定 320 / 400 / 480（dock 的 min / 常用 / max），每档一个真实面板实例，
 * 容器高 640px 与 dock 常态高度同量级。量法见 `one/.tmp/xh/task83/measure-mono-width.mjs`。
 *
 * 数据：全部走面板的 fetch seam 注入，**不发任何请求**（生产恒用 `api.*`）。
 * 四个 seam 都得给：面板会自动选中 activity[0] 的 run 并取 attempts / trace / 指纹，
 * 只挡 monitor 那一条的话，另外三条会打到 `/api/v1/**`（预览页的硬规则是「不调任何 /api/v1/**」）。
 */
import SectionShell from "../SectionShell.vue";
import SessionMonitorPanel from "../../features/workspace/monitor/SessionMonitorPanel.vue";
import { mockProviderFingerprintView, mockSessionMonitor } from "../mockData";
import type {
    ProviderRequestFingerprintView,
    RunTraceResponse,
    RunTransportAttemptsResponse,
    SessionMonitorResponse,
} from "../../types";

/** dock 面板宽的三档：最小 / 常用 / 最大（见 `useWorkspaceLayout.ts` 的 dock 常量）。 */
const DOCK_WIDTHS = [320, 400, 480] as const;

const previewSessionId = mockSessionMonitor.session.id;

const monitorFetcher = async (): Promise<SessionMonitorResponse> => mockSessionMonitor;

const attemptsFetcher = async (runId: string): Promise<RunTransportAttemptsResponse> => ({
    runId,
    attempts: [],
    aggregate: { attemptCount: 0, failedCount: 0, partialCount: 0 },
});

/**
 * trace 用**真实量级**的 id / 工具名 / 错误码：时间线里的 `font-mono` 就是这些长串，
 * 用短串填会得到「不折行」，那是 fixture 的产物不是产品的事实。
 */
const traceFetcher = async (runId: string): Promise<RunTraceResponse> => ({
    runId,
    asOf: "2026-11-11T04:30:00.000Z",
    completeness: "complete",
    provenance: {
        status: "complete",
        providerConnectionId: "conn-0f9e8d7c-6b5a-4f3e-2d1c-0b9a8f7e6d5c",
        connectionRevision: 7,
        apiTypeId: "openai-compatible",
        apiTypeVersion: 20261001,
        contextTemplateLayer: "workspace",
        contextTemplateId: "tpl-3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b",
        contextTemplateVersion: 12,
    },
    sources: [
        { source: "chat_run", status: "complete" },
        { source: "context_event", status: "complete" },
        { source: "provider_attempt", status: "unknown" },
        { source: "mcp_invocation", status: "not_applicable" },
    ],
    events: [
        {
            eventId: "5d4e6f70-8192-43a4-9b55-d2e3f4a5b6c7",
            occurredAt: "2026-11-11T04:29:12.000Z",
            source: "chat_run",
            kind: "run.lifecycle",
            status: "running",
            durationMs: null,
            toolName: null,
            providerId: null,
            modelId: null,
            errorCode: null,
            usage: null,
            references: {},
        },
        {
            eventId: "6e5f7081-92a3-44b5-8c66-e3f4a5b6c7d8",
            occurredAt: "2026-11-11T04:29:18.000Z",
            source: "provider_attempt",
            kind: "provider.attempt",
            status: "succeeded",
            durationMs: 4231,
            toolName: null,
            providerId: "openai-compatible",
            modelId: "deepseek-v3.2-exp-20261101",
            errorCode: null,
            usage: { inputTokens: 18342, outputTokens: 912, totalTokens: 19254 },
            references: { attemptId: "7f608192-a3b4-45c6-9d77-f4a5b6c7d8e9" },
        },
        {
            eventId: "70819203-b4c5-46d7-8e88-a5b6c7d8e9f0",
            occurredAt: "2026-11-11T04:29:41.000Z",
            source: "runtime_job",
            kind: "runtime.job",
            status: "failed",
            durationMs: 15000,
            toolName: "workspace_read_file",
            providerId: null,
            modelId: null,
            errorCode: "PROVIDER_TIMEOUT",
            usage: null,
            references: { runtimeJobId: "81920314-c5d6-47e8-9f99-b6c7d8e9f0a1" },
        },
    ],
    nextCursor: null,
});

const fingerprintFetcher = async (): Promise<ProviderRequestFingerprintView> =>
    mockProviderFingerprintView;
</script>

<template>
    <SectionShell
        id="monitor-panel"
        index="13"
        title="运行态监控面板（dock 面板宽 320 / 400 / 480）"
        description="验证等宽字段在窄容器里的折行：面板用 fetch seam 注入 fixture，不发请求；每档宽度都是一个真实面板实例，容器高 640px。判据是「每行文本的视觉行数（getClientRects 聚簇）」，不是「字符数 × advance」——折行是布局结果。"
    >
        <div class="flex flex-wrap items-start gap-6">
            <div
                v-for="width in DOCK_WIDTHS"
                :key="width"
                :data-mono-probe="'monitor-' + width"
                class="shrink-0 overflow-hidden rounded-md border border-border bg-background"
                :style="{ width: width + 'px' }"
            >
                <div
                    class="border-b border-border/70 px-2 py-1 font-mono text-[10px] text-muted-foreground"
                >
                    dock {{ width }} px
                </div>
                <div class="flex flex-col" :style="{ height: '640px' }">
                    <SessionMonitorPanel
                        :session-id="previewSessionId"
                        :monitor-fetcher="monitorFetcher"
                        :attempts-fetcher="attemptsFetcher"
                        :trace-fetcher="traceFetcher"
                        :fingerprint-fetcher="fingerprintFetcher"
                    />
                </div>
            </div>
        </div>
    </SectionShell>
</template>
