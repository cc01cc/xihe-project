import assert from "node:assert/strict";
import { test } from "node:test";
import { scanRoot, scanSfc } from "./check-i18n-hardcoded.mjs";

test("v-if branch CJK text is detected", () => {
    const { hits } = scanSfc('<template><h2 v-if="ok">暂无工作区</h2></template>', "v-if.vue");
    assert.deepEqual(
        hits.map((hit) => hit.text),
        ["暂无工作区"],
    );
});

test("v-else branch CJK text is detected", () => {
    const { hits } = scanSfc(
        '<template><div><h2 v-if="ok">有工作区</h2><h2 v-else>暂无工作区</h2></div></template>',
        "v-else.vue",
    );
    assert.deepEqual(hits.map((hit) => hit.text).sort(), ["暂无工作区", "有工作区"].sort());
});

test("v-for child CJK text is detected", () => {
    const { hits } = scanSfc(
        '<template><ul><li v-for="item in items" :key="item.id">条目 {{ item.name }}</li></ul></template>',
        "v-for.vue",
    );
    assert.deepEqual(
        hits.map((hit) => hit.text),
        ["条目"],
    );
});

test("{{ }} interpolation is not a hardcoded literal", () => {
    const { hits } = scanSfc("<template><p>{{ message }}</p></template>", "interpolation.vue");
    assert.deepEqual(hits, []);
});

test(":aria-label binding with t() is not a hardcoded literal", () => {
    const { hits } = scanSfc(
        "<template><input :aria-label=\"t('search')\" /></template>",
        "bound-aria.vue",
    );
    assert.deepEqual(hits, []);
});

test("static class and SVG path data are not copy", () => {
    const { hits } = scanSfc(
        '<template><svg class="h-4 w-4"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9" /></svg></template>',
        "svg-attr.vue",
    );
    assert.deepEqual(hits, []);
});

test("WorkspaceView.vue:507 is in the real scan hit set", () => {
    const { hits } = scanRoot();
    const hit = hits.find(
        (entry) =>
            entry.file === "src/features/workspace/pages/WorkspaceView.vue" && entry.line === 507,
    );
    assert.ok(hit, "WorkspaceView.vue:507 must be detected (v-if branch regression)");
    assert.match(hit.text, /暂无工作区/);
});
