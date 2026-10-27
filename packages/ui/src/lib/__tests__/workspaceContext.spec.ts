import { beforeEach, describe, expect, it } from "vitest";
import {
    clearTabWorkspace,
    migrateLegacyWorkspace,
    readTabWorkspace,
    readTabWorkspaceId,
    writeTabWorkspace,
    writeTabWorkspaceId,
} from "../workspaceContext";

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
});

describe("workspaceContext", () => {
    it("reads and writes the tab workspace", () => {
        writeTabWorkspace({ id: "ws-1", name: "One" });
        expect(readTabWorkspaceId()).toBe("ws-1");
        expect(readTabWorkspace()?.name).toBe("One");
        expect(localStorage.getItem("xihe-workspace")).toBeNull();
    });

    it("updates the id while preserving the cached name", () => {
        writeTabWorkspace({ id: "ws-1", name: "One" });
        writeTabWorkspaceId("ws-2");
        expect(readTabWorkspace()).toMatchObject({ id: "ws-2", name: "One" });
    });

    it("migrates the legacy localStorage value once and removes it", () => {
        localStorage.setItem("xihe-workspace", JSON.stringify({ id: "legacy", name: "L" }));
        migrateLegacyWorkspace();
        expect(readTabWorkspaceId()).toBe("legacy");
        expect(localStorage.getItem("xihe-workspace")).toBeNull();
    });

    it("does not overwrite an existing tab workspace during migration", () => {
        writeTabWorkspace({ id: "tab", name: "T" });
        localStorage.setItem("xihe-workspace", JSON.stringify({ id: "legacy" }));
        migrateLegacyWorkspace();
        expect(readTabWorkspaceId()).toBe("tab");
        expect(localStorage.getItem("xihe-workspace")).toBeNull();
    });

    it("clears the tab key", () => {
        writeTabWorkspace({ id: "ws-1" });
        clearTabWorkspace();
        expect(readTabWorkspaceId()).toBeNull();
    });
});
