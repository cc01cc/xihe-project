import { describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { i18n } from "../../../i18n";
import { ApiError } from "../../../composables/api";
import SettingsErrorSurface from "../SettingsErrorSurface.vue";

/**
 * task-168（F-18）：设置区统一错误面。两类形态——
 * ① 404 / MOCK_ENDPOINT_MISSING ⇒ 后端缺口（虚线卡 + 解释弹窗）；
 * ② 其余错误 ⇒ 本地化文案 + 可选重试出口。
 * 共同硬约束：任何形态都不得把原始负载（detail / code / mock 标记 / HTTP 状态原文）渲染进页面。
 */

function apiError(status: number, code: string, detail?: string): ApiError {
    return new ApiError({ status, code, detail, requestId: "req-1" });
}

function mountSurface(cause: unknown, extra: { retry?: () => void; message?: string } = {}) {
    return mount(SettingsErrorSurface, {
        props: { cause, retry: extra.retry, message: extra.message },
        global: { plugins: [i18n] },
    });
}

describe("SettingsErrorSurface（task-168 / F-18）", () => {
    it("404 渲染后端缺口态（缺口徽标 + 解释弹窗），不渲染原始负载", async () => {
        const w = mountSurface(apiError(404, "NOT_FOUND", "API error 404"));

        const gap = w.get('[data-testid="settings-error-gap"]');
        expect(gap.attributes("role")).toBe("status");
        expect(gap.text()).toContain(i18n.global.t("settings.ia.backendGapBadgeGeneric"));
        // 原始负载三件套：HTTP 文案 / 状态码 / code 都不得出现。
        expect(w.text()).not.toContain("API error");
        expect(w.text()).not.toContain("404");
        expect(w.text()).not.toContain("NOT_FOUND");
        expect(w.find('[data-testid="settings-error-panel"]').exists()).toBe(false);

        await w.get('[data-testid="settings-error-gap-more"]').trigger("click");
        await flushPromises();
        // Teleport 在 jsdom 未挂 document.body 的 wrapper 里可能原地渲染，两处都查。
        const teleported = document.body.querySelector('[data-testid="settings-error-gap-dialog"]');
        const inline = w.find('[data-testid="settings-error-gap-dialog"]');
        const dialogText = teleported?.textContent ?? (inline.exists() ? inline.text() : "");
        expect(dialogText).toContain(i18n.global.t("settings.errorSurface.gapDialogBody"));
    });

    it("MOCK_ENDPOINT_MISSING 视为后端缺口，且不出现 mock 标记原文", () => {
        const w = mountSurface(apiError(500, "MOCK_ENDPOINT_MISSING"));
        expect(w.find('[data-testid="settings-error-gap"]').exists()).toBe(true);
        expect(w.text()).not.toContain("MOCK_ENDPOINT_MISSING");
        expect(w.text()).not.toContain("500");
    });

    it("已知权限码映射本地化文案 + 重试出口；code/detail 不直渲", async () => {
        const retry = vi.fn<() => void>();
        const w = mountSurface(apiError(403, "FORBIDDEN", "english detail"), { retry });

        const panel = w.get('[data-testid="settings-error-panel"]');
        expect(panel.attributes("role")).toBe("alert");
        expect(panel.text()).toContain(i18n.global.t("settings.errorSurface.forbidden"));
        expect(panel.text()).not.toContain("FORBIDDEN");
        expect(panel.text()).not.toContain("english detail");

        await w.get('[data-testid="settings-error-retry"]').trigger("click");
        expect(retry).toHaveBeenCalledOnce();
    });

    it("未映射码与非 ApiError 错误走通用文案，detail/message 原文不直渲", () => {
        const w1 = mountSurface(apiError(500, "UNMAPPED_ERROR", "raw detail"));
        expect(w1.get('[data-testid="settings-error-panel"]').text()).toContain(
            i18n.global.t("settings.errorSurface.generic"),
        );
        expect(w1.text()).not.toContain("raw detail");
        expect(w1.text()).not.toContain("UNMAPPED_ERROR");

        const w2 = mountSurface(new Error("boom"));
        expect(w2.get('[data-testid="settings-error-panel"]').text()).toContain(
            i18n.global.t("settings.errorSurface.generic"),
        );
        expect(w2.text()).not.toContain("boom");
    });

    it("调用方预本地化 message 优先于通用文案（缺口态除外）", () => {
        const w = mountSurface(new Error("x"), { message: "角色仍被绑定引用，无法删除。" });
        expect(w.get('[data-testid="settings-error-panel"]').text()).toContain(
            "角色仍被绑定引用，无法删除。",
        );
    });

    it("cause 为 null 时不渲染任何形态", () => {
        const w = mountSurface(null);
        expect(w.find('[data-testid="settings-error-gap"]').exists()).toBe(false);
        expect(w.find('[data-testid="settings-error-panel"]').exists()).toBe(false);
    });
});
