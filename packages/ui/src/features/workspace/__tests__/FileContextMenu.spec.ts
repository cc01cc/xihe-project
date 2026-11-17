import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import { toast } from "vue-sonner";
import FileNodeMenu from "../components/FileNodeMenu.vue";
import FileContextMenu from "../components/FileContextMenu.vue";
import type { FileNode } from "../../../types";
import { i18n } from "../../../i18n";

// Singleton mock store: the component and the test must share the same vi.fn()
// instances, otherwise stubbed resolutions never reach the component.
const { storeMock } = vi.hoisted(() => ({
    storeMock: {
        deleteNode: vi.fn<(path: string) => Promise<boolean>>(),
        createFile: vi.fn<(parentDir: string, name: string) => Promise<boolean>>(),
        renameNode: vi.fn<(oldPath: string, newName: string) => Promise<boolean>>(),
        moveNode: vi.fn<(from: string, toDir: string) => Promise<boolean>>(),
        duplicateNode: vi.fn<(path: string) => Promise<boolean>>(),
        createDirectory: vi.fn<(parentDir: string, name: string) => Promise<boolean>>(),
        treeError: null as string | null,
    },
}));

vi.mock("../stores/workspace", () => ({
    useWorkspaceStore: () => storeMock,
}));

vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<typeof toast.success>(),
        error: vi.fn<typeof toast.error>(),
    },
}));

const dirWithDot: FileNode = { path: "src/v1.2", name: "v1.2", type: "directory" },
    fileNoExt: FileNode = { path: "Makefile", name: "Makefile", type: "file" };

function mountMenu(node: FileNode) {
    return mount(FileNodeMenu, {
        props: { node },
        slots: { default: "<button>row</button>" },
        attachTo: document.body,
        global: { plugins: [i18n] },
    });
}

function menuItems(): string[] {
    const menu = document.body.querySelector('[data-testid="file-context-menu"]');
    if (!menu) return [];
    return Array.from(menu.querySelectorAll('[role="menuitem"]')).map((e) =>
        (e.textContent ?? "").trim(),
    );
}

describe("FileNodeMenu content by node type (B-1)", () => {
    let wrappers: VueWrapper[] = [];
    afterEach(() => {
        wrappers.forEach((w) => w.unmount());
        wrappers = [];
    });

    it("directory with a dot in name still gets New File / New Directory, not file ops", async () => {
        const wrapper = mountMenu(dirWithDot);
        wrappers.push(wrapper);
        // Open the reka-ui context menu via right-click on the trigger row
        await wrapper.find("button").trigger("contextmenu");
        await nextTick();
        await new Promise((r) => setTimeout(r, 0));
        const items = menuItems();
        expect(items.join("|")).toContain("New File");
        expect(items.join("|")).toContain("New Directory");
        expect(items.join("|")).not.toContain("Duplicate");
    });

    it("extensionless file gets Rename/Move/Duplicate, not New File", async () => {
        const wrapper = mountMenu(fileNoExt);
        wrappers.push(wrapper);
        await wrapper.find("button").trigger("contextmenu");
        await nextTick();
        await new Promise((r) => setTimeout(r, 0));
        const items = menuItems();
        expect(items.join("|")).toContain("Rename");
        expect(items.join("|")).toContain("Duplicate");
        expect(items.join("|")).not.toContain("New File");
    });
});

describe("FileNodeMenu delete toast semantics (B-2)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    let wrappers: VueWrapper[] = [];
    afterEach(() => {
        wrappers.forEach((w) => w.unmount());
        wrappers = [];
    });

    async function openMenuAndClick(wrapper: VueWrapper, label: string) {
        await wrapper.find("button").trigger("contextmenu");
        await nextTick();
        await new Promise((r) => setTimeout(r, 0));
        const menu = document.body.querySelector('[data-testid="file-context-menu"]');
        expect(menu).toBeTruthy();
        const items = Array.from(menu!.querySelectorAll('[role="menuitem"]')),
            target = items.find((b) => (b.textContent ?? "").trim().startsWith(label)) as
                | HTMLElement
                | undefined;
        expect(target).toBeTruthy();
        // Programmatic selection path: dispatch the press sequence the platform
        // would produce, with hover + focus established first so the menu's
        // internal highlight/focus guards track the item before selection.
        target!.dispatchEvent(
            new PointerEvent("pointerover", {
                bubbles: true,
                button: 0,
                composed: true,
                clientX: 10,
                clientY: 10,
            }),
        );
        target!.dispatchEvent(
            new PointerEvent("pointerenter", {
                bubbles: true,
                button: 0,
                composed: true,
                clientX: 10,
                clientY: 10,
            }),
        );
        target!.dispatchEvent(
            new PointerEvent("pointermove", {
                bubbles: true,
                button: 0,
                composed: true,
                clientX: 10,
                clientY: 10,
            }),
        );
        target!.focus();
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"] as const) {
            const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
            target!.dispatchEvent(
                new Ctor(
                    type,
                    type === "click"
                        ? { bubbles: true, button: 0, composed: true, cancelable: true, detail: 1 }
                        : { bubbles: true, button: 0, composed: true, cancelable: true },
                ),
            );
            await nextTick();
        }
        await new Promise((r) => setTimeout(r, 50));
        await nextTick();
    }

    // NOTE (PLAN-262 M3): the three interaction tests below are skipped, not deleted.
    // reka-ui MenuItem selection requires a real platform press sequence
    // (pointerdown arms an internal ref, pointerup re-dispatches click, click
    // emits select). Six synthetic-event combinations were tried in jsdom
    // (bare click, pointerdown+up, +focus, +hover highlight, keyboard Space,
    // full press sequence with per-event ticks); the internal ref never arms,
    // so @select never fires and the follow-up modals never open. Covered
    // instead by: menu content per node type (tests above, passing), store
    // action true/false toast branching (workspace.spec.ts, passing), and the
    // full click-through flow in Playwright task 3.8.
    it.skip("shows success toast only when deletion actually succeeded", async () => {
        storeMock.deleteNode.mockResolvedValue(true);
        const wrapper = mountMenu(fileNoExt);
        wrappers.push(wrapper);

        await openMenuAndClick(wrapper, "Delete");
        // delete confirm is an inline BaseModal (not teleported away from wrapper tree)
        await nextTick();
        const modal = document.body.querySelector('[data-testid="modal-content"]');
        expect(modal).toBeTruthy();
        const confirmBtn = Array.from(modal!.querySelectorAll("button")).find(
            (b) => b.textContent?.trim() === "Delete",
        ) as HTMLButtonElement | undefined;
        expect(confirmBtn).toBeTruthy();
        confirmBtn!.click();
        await nextTick();
        await new Promise((r) => setTimeout(r, 0));

        expect(storeMock.deleteNode).toHaveBeenCalledWith("Makefile");
        expect(toast.success).toHaveBeenCalledWith('Deleted "Makefile"');
        expect(toast.error).not.toHaveBeenCalled();
    });

    it.skip("shows error toast (no success) when deletion failed", async () => {
        storeMock.deleteNode.mockResolvedValue(false);
        storeMock.treeError = "Failed to delete: boom";
        const wrapper = mountMenu(fileNoExt);
        wrappers.push(wrapper);

        await openMenuAndClick(wrapper, "Delete");
        await nextTick();
        const modal = document.body.querySelector('[data-testid="modal-content"]');
        expect(modal).toBeTruthy();
        const confirmBtn = Array.from(modal!.querySelectorAll("button")).find(
            (b) => b.textContent?.trim() === "Delete",
        ) as HTMLButtonElement | undefined;
        confirmBtn!.click();
        await nextTick();
        await new Promise((r) => setTimeout(r, 0));

        expect(toast.success).not.toHaveBeenCalled();
        expect(toast.error).toHaveBeenCalled();
    });

    it.skip("rename success toasts and calls renameNode", async () => {
        storeMock.renameNode.mockResolvedValue(true);
        const wrapper = mountMenu(fileNoExt);
        wrappers.push(wrapper);

        await openMenuAndClick(wrapper, "Rename");
        const input = document.body.querySelector(
            '[data-testid="modal-content"] input',
        ) as HTMLInputElement | null;
        expect(input).toBeTruthy();
        input!.value = "Makefile.new";
        input!.dispatchEvent(new Event("input", { bubbles: true }));
        await nextTick();
        const renameBtn = Array.from(
            document.body.querySelectorAll('[data-testid="modal-content"] button'),
        ).find((b) => b.textContent?.trim() === "Rename") as HTMLButtonElement | undefined;
        renameBtn!.click();
        await nextTick();
        await new Promise((r) => setTimeout(r, 0));

        expect(storeMock.renameNode).toHaveBeenCalledWith("Makefile", "Makefile.new");
        expect(toast.success).toHaveBeenCalled();
    });
});

/**
 * task-164：FileContextMenu 的删除确认走 ConfirmModal（task-150 契约：resolve = 调用方
 * 断言成功）。deleteNode 失败返回 false —— 这里必须 reject（文案取它写好的 treeError），
 * 失败才能留在确认窗内（confirm-error）而不是闪现 "Operation completed"。
 * FileContextMenu 是纯 DOM 菜单（无 reka 按下序列问题），可直接挂载点穿。
 * 注：本文件名下的旧用例测的是 FileNodeMenu（reka 菜单，交互用例因 jsdom 限制 skip），
 * 那两个组件不是同一个；这里补的是 FileContextMenu 自己的覆盖。
 */
describe("FileContextMenu 删除失败路径（task-164）", () => {
    let wrappers: VueWrapper[] = [];
    beforeEach(() => {
        vi.clearAllMocks();
        storeMock.treeError = null;
    });
    afterEach(() => {
        wrappers.forEach((w) => w.unmount());
        wrappers = [];
        storeMock.treeError = null;
    });

    function mountMenuDirect() {
        const wrapper = mount(FileContextMenu, {
            props: { path: "Makefile", nodeType: "file", x: 10, y: 10 },
            attachTo: document.body,
            global: { plugins: [i18n] },
        });
        wrappers.push(wrapper);
        return wrapper;
    }

    async function openConfirmModal(wrapper: VueWrapper) {
        const deleteEntry = wrapper.findAll("button").find((b) => b.text().includes("Delete"));
        expect(deleteEntry).toBeTruthy();
        await deleteEntry!.trigger("click");
        await nextTick();
        const modal = document.body.querySelector('[data-testid="modal-content"]');
        expect(modal).toBeTruthy();
        return modal as HTMLElement;
    }

    it("deleteNode 返回 false ⇒ 窗内 confirm-error 可见（treeError 文案）、无成功闪现、可重试", async () => {
        storeMock.deleteNode.mockResolvedValue(false);
        storeMock.treeError = "删除失败：workspace 锁定";
        const wrapper = mountMenuDirect();
        const modal = await openConfirmModal(wrapper);

        const confirmBtn = Array.from(modal.querySelectorAll("button")).find(
            (b) => b.textContent?.trim() === "Delete",
        ) as HTMLButtonElement;
        confirmBtn.click();
        await flushPromises();

        const errorBox = document.body.querySelector('[data-testid="confirm-error"]');
        expect(errorBox).toBeTruthy();
        expect(errorBox!.textContent).toContain("删除失败：workspace 锁定");
        expect(modal.textContent).not.toContain("Operation completed");
        // 窗没自动关（组件仍渲染），可以重试：第二次 confirm 真发出去了。
        confirmBtn.click();
        await flushPromises();
        expect(storeMock.deleteNode).toHaveBeenCalledTimes(2);
    });

    it("deleteNode 成功 ⇒ 闪现 Operation completed 并 toast.success", async () => {
        storeMock.deleteNode.mockResolvedValue(true);
        const wrapper = mountMenuDirect();
        const modal = await openConfirmModal(wrapper);

        const confirmBtn = Array.from(modal.querySelectorAll("button")).find(
            (b) => b.textContent?.trim() === "Delete",
        ) as HTMLButtonElement;
        confirmBtn.click();
        await flushPromises();

        expect(modal.textContent).toContain("Operation completed");
        expect(toast.success).toHaveBeenCalledWith('Deleted "Makefile"');
        expect(document.body.querySelector('[data-testid="confirm-error"]')).toBeNull();
    });
});
