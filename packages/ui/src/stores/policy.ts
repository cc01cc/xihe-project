import { defineStore } from "pinia";
import { ref } from "vue";
import { api } from "../composables/api";
import { i18n } from "../i18n";
import { presentCauseError } from "../lib/errorMessages";
import { logger } from "../lib/logger";
import type { SessionPolicyMode, SessionPolicyModeState } from "../types";

export interface SessionPolicyState {
    mode: SessionPolicyMode | null;
    loading: boolean;
    changing: boolean;
    loaded: boolean;
    /**
     * task-45：**可读文案**（不再是 `CODE: english detail`）。原始 detail 只留在
     * `logger.warn` 的 cause 里；本字段当前没有渲染消费者（`SessionPolicyControls` 只判空、
     * 用自己的本地化文案），所以不额外存 detail —— 无消费者的字段会漂移。
     *
     * task-78 判定（**不改类型，刻意与 policyAdmin 不同**）：这处**不是诊断面**，判据不是
     * 「它长得像错误条」，而是**屏幕上有没有文案要求用户出示错误码**。
     * `SessionPolicyControls.vue:56-61` 对 `error` **只判空**，文案换成自己的
     * `chat.approvalModeLoadFailed` / `approvalModeChangeFailed`（两句都不提错误码），
     * 落点是聊天列里控件下方的一行内联提示（与聊天气泡/toast 同族）。按 AGENTS.md 错误面表
     * 该处归**瞬时面** ⇒ 只渲染 copy + `logger.warn` 留痕，**不加码、不加折叠控件**：
     * 给这种位置塞码属于「为了统一给瞬时面也加码」，是给用户加噪音。
     * ⇒ 因此本 store 保持 `string | null`；它现在的角色是「有没有失败」的布尔投影。
     */
    error: string | null;
}

function createState(): SessionPolicyState {
    return {
        mode: null,
        loading: false,
        changing: false,
        loaded: false,
        error: null,
    };
}

export const usePolicyStore = defineStore("policy", () => {
    const states = ref<Record<string, SessionPolicyState>>({}),
        loadPromises = new Map<string, Promise<void>>(),
        mutationGenerations = new Map<string, number>();

    function getState(sessionId: string): SessionPolicyState | undefined {
        return states.value[sessionId];
    }

    function stateFor(sessionId: string): SessionPolicyState {
        const existing = states.value[sessionId];
        if (existing) return existing;
        const created = createState();
        states.value[sessionId] = created;
        return states.value[sessionId]!;
    }

    function errorCopy(cause: unknown, fallback: string): string {
        return presentCauseError(i18n.global.t, cause, fallback).copy;
    }

    async function load(sessionId: string): Promise<void> {
        if (!sessionId) return;
        const existingRequest = loadPromises.get(sessionId);
        if (existingRequest) return existingRequest;

        const state = stateFor(sessionId);
        if (state.loaded) return;
        const mutationGeneration = mutationGenerations.get(sessionId) ?? 0;
        state.loading = true;
        state.error = null;
        const request = Promise.resolve().then(async () => {
            try {
                const result = await api.getPolicyMode(sessionId);
                if ((mutationGenerations.get(sessionId) ?? 0) === mutationGeneration) {
                    state.mode = result.mode;
                    state.loaded = true;
                }
            } catch (cause) {
                if ((mutationGenerations.get(sessionId) ?? 0) === mutationGeneration) {
                    state.error = errorCopy(cause, i18n.global.t("errors.requestFailed"));
                    logger.warn("Failed to load session policy mode", cause);
                }
            } finally {
                if (states.value[sessionId] === state) state.loading = false;
                if (loadPromises.get(sessionId) === request) loadPromises.delete(sessionId);
            }
        });
        loadPromises.set(sessionId, request);
        return request;
    }

    async function change(
        sessionId: string,
        mode: SessionPolicyMode,
    ): Promise<SessionPolicyModeState> {
        const state = stateFor(sessionId),
            generation = (mutationGenerations.get(sessionId) ?? 0) + 1;
        mutationGenerations.set(sessionId, generation);
        state.changing = true;
        state.error = null;
        try {
            const result = await api.setPolicyMode(sessionId, mode);
            if (mutationGenerations.get(sessionId) === generation) {
                state.mode = result.mode;
                state.loaded = true;
            }
            return result;
        } catch (cause) {
            if (mutationGenerations.get(sessionId) === generation) {
                state.error = errorCopy(cause, i18n.global.t("errors.requestFailed"));
                logger.warn("Failed to change session policy mode", cause);
            }
            throw cause;
        } finally {
            if (mutationGenerations.get(sessionId) === generation) state.changing = false;
        }
    }

    function reset() {
        states.value = {};
        loadPromises.clear();
        mutationGenerations.clear();
    }

    return { states, getState, stateFor, load, change, reset };
});
