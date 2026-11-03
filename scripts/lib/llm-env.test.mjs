/**
 * PLAN-0650 B-1 tests: the Agent LLM env table, lane by lane.
 *
 * The load-bearing case is the real lane: both routes must carry `XIHE_API_BASE`, because the
 * `openai-compat` route selects provider `openai`, whose default endpoint is `api.openai.com` —
 * that mismatch is what made `--llm-mode=real` report `llmReady=invalid_credentials` for a valid
 * MiMo key (BL-205 ①). The fake lanes are asserted value-for-value against the pre-refactor
 * behaviour, so "extract, don't change" is a fact rather than an intention.
 *
 * Run: node --test scripts/lib/llm-env.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_REAL_API_BASE, llmEnv } from './llm-env.mjs';

const REAL_KEY = 'test-real-key-not-a-credential';

test('real lane, native route: provider xiaomi + key + an explicit MiMo base', () => {
    assert.deepEqual(llmEnv({ realKey: REAL_KEY, realRoute: 'native' }), {
        XIHE_LLM_PROVIDER: 'xiaomi',
        XIHE_XIAOMI_API_KEY: REAL_KEY,
        XIHE_API_BASE: DEFAULT_REAL_API_BASE,
    });
});

test('real lane, openai-compat route: provider openai + key + the SAME MiMo base (BL-205 ①)', () => {
    assert.deepEqual(llmEnv({ realKey: REAL_KEY, realRoute: 'openai-compat' }), {
        XIHE_LLM_PROVIDER: 'openai',
        XIHE_OPENAI_API_KEY: REAL_KEY,
        XIHE_API_BASE: DEFAULT_REAL_API_BASE,
    });
});

test('both real routes pin XIHE_API_BASE — the openai provider default must never win', () => {
    for (const realRoute of ['native', 'openai-compat']) {
        const env = llmEnv({ realKey: REAL_KEY, realRoute });
        assert.equal(
            env.XIHE_API_BASE,
            DEFAULT_REAL_API_BASE,
            `${realRoute}: real lane must set XIHE_API_BASE explicitly`,
        );
        assert.notEqual(env.XIHE_API_BASE, 'https://api.openai.com/v1');
    }
});

test('real lane honours an explicit endpoint override and ignores a blank one', () => {
    assert.equal(
        llmEnv({ realKey: REAL_KEY, realRoute: 'openai-compat', realApiBase: 'https://example.test/v1' })
            .XIHE_API_BASE,
        'https://example.test/v1',
    );
    assert.equal(
        llmEnv({ realKey: REAL_KEY, realRoute: 'openai-compat', realApiBase: '   ' }).XIHE_API_BASE,
        DEFAULT_REAL_API_BASE,
    );
});

test('fake mock lane carries no fake keys and no base (must stay ready without a server)', () => {
    assert.deepEqual(llmEnv({ llmMode: 'mock' }), { XIHE_LLM_PROVIDER: 'mock' });
});

test('fake missing lane carries no fake keys and no base (readiness must stay not-ready)', () => {
    assert.deepEqual(llmEnv({ llmMode: 'missing' }), { XIHE_LLM_PROVIDER: 'openai' });
});

test('fake invalid lane points at the fake server with an intentionally invalid key', () => {
    assert.deepEqual(llmEnv({ llmMode: 'invalid', fakeLlmPort: 12645 }), {
        XIHE_LLM_PROVIDER: 'openai',
        XIHE_OPENAI_API_KEY: 'sk-fake-invalid-key',
        XIHE_DEEPSEEK_API_KEY: 'fake-deepseek-key',
        XIHE_API_BASE: 'http://127.0.0.1:12645/openai/v1',
    });
});

test('fake keyed lanes use the fake base with the per-provider /openai/v1 prefix', () => {
    for (const llmMode of ['success', 'real', 'approval']) {
        assert.deepEqual(llmEnv({ llmMode, fakeLlmPort: 12645 }), {
            XIHE_LLM_PROVIDER: 'openai',
            XIHE_OPENAI_API_KEY: 'sk-fake-openai-key',
            XIHE_DEEPSEEK_API_KEY: 'fake-deepseek-key',
            XIHE_API_BASE: 'http://127.0.0.1:12645/openai/v1',
        });
    }
});

test('a fake keyed lane without a usable port fails closed instead of emitting :undefined', () => {
    for (const fakeLlmPort of [undefined, null, 0, -1, 'not-a-port']) {
        assert.throws(
            () => llmEnv({ llmMode: 'success', fakeLlmPort }),
            TypeError,
            `fakeLlmPort=${JSON.stringify(fakeLlmPort)} must be rejected`,
        );
    }
    assert.equal(
        llmEnv({ llmMode: 'success', fakeLlmPort: '12645' }).XIHE_API_BASE,
        'http://127.0.0.1:12645/openai/v1',
        'a numeric string port is accepted (mise/env call sites pass strings)',
    );
});

test('no lane leaks a stale `realKey` into the fake key names', () => {
    const env = llmEnv({ realKey: '', realRoute: 'openai-compat', llmMode: 'mock' });
    assert.equal(env.XIHE_OPENAI_API_KEY, undefined);
    assert.equal(env.XIHE_XIAOMI_API_KEY, undefined);
});
