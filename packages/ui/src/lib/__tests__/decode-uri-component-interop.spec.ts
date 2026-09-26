import { createRequire } from "node:module";
import { expect, it } from "vitest";

const uiRequire = createRequire(import.meta.url);
// Resolve through Vite's actual optional Stylus dependency chain.
const viteRequire = createRequire(uiRequire.resolve("vite"));
const stylusRequire = createRequire(viteRequire.resolve("stylus"));
const cssRequire = createRequire(stylusRequire.resolve("css"));
const sourceMapPath = cssRequire.resolve("source-map-resolve");
const sourceMapRequire = createRequire(sourceMapPath);
const sourceMapResolver = sourceMapRequire(".");

it("keeps the nested CommonJS source-map decoder callable", () => {
    let readUrl: string | undefined;
    const result = sourceMapResolver.resolveSourceMapSync(
        "/*# sourceMappingURL=maps%2Fbundle.map */",
        "https://example.test/assets/bundle.css",
        (url: string) => {
            readUrl = url;
            return JSON.stringify({
                version: 3,
                sources: [],
                names: [],
                mappings: "",
            });
        },
    );

    expect(readUrl).toBe("https://example.test/assets/maps/bundle.map");
    expect(result.map.version).toBe(3);
});
