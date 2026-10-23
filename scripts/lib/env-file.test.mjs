import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnvFileChain } from "../lib/env-file.mjs";

// PLAN-0547 T2.2: pins env-file.mjs chain semantics to mirror DotenvLoader:
// chain order, first-wins inside chain, OS env / existing keys never overwritten,
// missing files skipped, quote stripping, no interpolation.

function makeFakeRoot(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "envfile-"));
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

describe("loadEnvFileChain", () => {
    let fakeEnv;

    beforeEach(() => {
        fakeEnv = {};
    });

    test("chain order: .env < .env.dev < .env.local (first occurrence wins)", (t) => {
        const root = makeFakeRoot(t);
        fs.writeFileSync(path.join(root, ".env"), "A=base\nB=base\n");
        fs.writeFileSync(path.join(root, ".env.dev"), "B=dev\nC=dev\n");
        fs.writeFileSync(path.join(root, ".env.local"), "C=local\nD=local\n");
        const { count } = loadEnvFileChain({ env: fakeEnv, cwd: root });
        assert.equal(fakeEnv.A, "base");
        assert.equal(fakeEnv.B, "base"); // .env wins, .env.dev does NOT overwrite
        assert.equal(fakeEnv.C, "dev"); // .env.dev wins, .env.local does NOT overwrite
        assert.equal(fakeEnv.D, "local");
        assert.equal(count, 4);
    });

    test("existing keys are never overwritten (fill gaps only)", (t) => {
        const root = makeFakeRoot(t);
        fs.writeFileSync(path.join(root, ".env.local"), "A=from-file\n");
        fakeEnv.A = "from-os-env";
        const { count } = loadEnvFileChain({ env: fakeEnv, cwd: root });
        assert.equal(fakeEnv.A, "from-os-env");
        assert.equal(count, 0);
    });

    test("empty-string existing values are treated as gaps", (t) => {
        const root = makeFakeRoot(t);
        fs.writeFileSync(path.join(root, ".env"), "A=base\n");
        fakeEnv.A = "";
        loadEnvFileChain({ env: fakeEnv, cwd: root });
        assert.equal(fakeEnv.A, "base");
    });

    test("missing files are skipped silently", (t) => {
        const root = makeFakeRoot(t);
        fs.writeFileSync(path.join(root, ".env.local"), "A=local\n");
        const { files } = loadEnvFileChain({ env: fakeEnv, cwd: root });
        assert.equal(files.length, 1);
        assert.ok(files[0].endsWith(".env.local"));
        assert.equal(fakeEnv.A, "local");
    });

    test("quotes are stripped and comments/blank lines ignored", (t) => {
        const root = makeFakeRoot(t);
        fs.writeFileSync(
            path.join(root, ".env"),
            '# comment\n\nQ="quoted value"\nS=\'single\'\nBAD LINE\n=NOKEY\nN= \n',
        );
        loadEnvFileChain({ env: fakeEnv, cwd: root });
        assert.equal(fakeEnv.Q, "quoted value");
        assert.equal(fakeEnv.S, "single");
        assert.equal(fakeEnv.N, "");
        assert.equal("BAD LINE" in fakeEnv, false);
    });

    test("no interpolation: ${VAR} stays literal", (t) => {
        const root = makeFakeRoot(t);
        fs.writeFileSync(path.join(root, ".env"), "A=${B}\n");
        loadEnvFileChain({ env: fakeEnv, cwd: root });
        assert.equal(fakeEnv.A, "${B}");
    });

    test("root is found by walking up from cwd", (t) => {
        const root = makeFakeRoot(t);
        fs.writeFileSync(path.join(root, ".env"), "A=base\n");
        const nested = path.join(root, "packages", "control-plane");
        fs.mkdirSync(nested, { recursive: true });
        const { count } = loadEnvFileChain({ env: fakeEnv, cwd: nested });
        assert.equal(fakeEnv.A, "base");
        assert.equal(count, 1);
    });
});
