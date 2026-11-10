#!/usr/bin/env node
/**
 * task-237 / PLAN-0763 M4: tests for the openapi -> markdown inventory generator (gen-api-docs.mjs).
 *
 * What is worth pinning here:
 *   1. The rows carry the fields the contract actually has — method/path, operationId, security (all
 *      three shapes: a scheme, an explicit 'security: []' meaning public, and absent meaning
 *      undeclared), summary, and the 公开/服务间 face.
 *   2. Grouping has three deliberate shapes, and all three are exercised so the degradation cannot
 *      rot: x-tagGroups + tags => two levels; tags only => one section per tag; no tags => one
 *      section per path prefix (plus an explicit TODO in the header).
 *   3. An operation the contract does not place is NOT folded into a real group — it shows up as
 *      其它 so a half-tagged contract is visible.
 *   4. '--check' is the whole point: pass on a fresh file, fail loudly (line numbers + fix hint) the
 *      moment the committed file drifts.
 *
 * Run: node --test scripts/gen-api-docs.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./gen-api-docs.mjs', import.meta.url))
const REAL_CONTRACT = fileURLToPath(new URL('../docs/api/openapi.yaml', import.meta.url))
const REAL_OUTPUT = fileURLToPath(new URL('../docs/api/inventory.generated.md', import.meta.url))
const LF = String.fromCharCode(10)

const BASE_FIXTURE = [
  'openapi: 3.1.0',
  'info: { title: Fixture, version: 1.0.0 }',
  'paths:',
  '  /api/v1/things:',
  '    get:',
  '      operationId: listThings',
  '      summary: List things',
  '      security: [{ bearerAuth: [] }]',
  '    post:',
  '      operationId: createThing',
  '      security: []',
  '  /api/v1/things/{thingId}:',
  '    delete:',
  '      operationId: deleteThing',
  '  /internal/v1/things/sync:',
  '    post:',
  '      operationId: syncThings',
  '      summary: Sync things from the runtime',
  '      security: [{ bearerAuth: [] }]',
  '',
].join(LF)

// Tags but no x-tagGroups: the generator must degrade to one flat section per tag.
const TAGGED_FIXTURE = [
  'openapi: 3.1.0',
  'info: { title: Fixture, version: 1.0.0 }',
  'paths:',
  '  /api/v1/things:',
  '    get:',
  '      operationId: listThings',
  '      tags: [things]',
  '      security: [{ bearerAuth: [] }]',
  '  /api/v1/other:',
  '    get:',
  '      operationId: getOther',
  '      tags: [auth]',
  '      security: [{ bearerAuth: [] }]',
  '',
].join(LF)

// x-tagGroups present: two levels, with one operation whose tag belongs to no group.
const GROUPED_FIXTURE = [
  'openapi: 3.1.0',
  'info: { title: Fixture, version: 1.0.0 }',
  'tags:',
  '  - { name: auth }',
  '  - { name: things }',
  '  - { name: service }',
  '  - { name: orphan }',
  'x-tagGroups:',
  '  - name: public',
  '    tags: [things, auth]',
  '  - name: internal',
  '    tags: [service]',
  'paths:',
  '  /api/v1/login:',
  '    post:',
  '      operationId: login',
  '      tags: [auth]',
  '      security: []',
  '  /api/v1/things:',
  '    get:',
  '      operationId: listThings',
  '      tags: [things]',
  '      security: [{ bearerAuth: [] }]',
  '  /internal/v1/sync:',
  '    post:',
  '      operationId: sync',
  '      tags: [service]',
  '      security: [{ bearerAuth: [] }]',
  '  /api/v1/orphaned:',
  '    get:',
  '      operationId: orphaned',
  '      tags: [orphan]',
  '      security: [{ bearerAuth: [] }]',
  '',
].join(LF)

/** A throwaway bundle (contract + output in a temp dir) that never touches docs/api/. */
function fixture(yamlText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-api-docs-'))
  const contract = path.join(dir, 'openapi.yaml')
  const output = path.join(dir, 'inventory.generated.md')
  fs.writeFileSync(contract, yamlText, 'utf8')
  return {
    contract,
    output,
    run(...args) {
      return spawnSync(process.execPath, [SCRIPT, ...args], {
        encoding: 'utf8',
        env: { ...process.env, XH_OPENAPI_CONTRACT: contract, XH_API_DOCS_OUT: output },
      })
    },
    generate() {
      const result = this.run()
      assert.equal(result.status, 0, result.stderr)
      return fs.readFileSync(output, 'utf8')
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('generates one row per operation with method/path, operationId, security, summary and face', () => {
  const fx = fixture(BASE_FIXTURE)
  try {
    const text = fx.generate()
    // Three security shapes, three distinct cells.
    assert.match(text, /\| `GET \/api\/v1\/things` \| `listThings` \| `bearerAuth` \| List things \| 公开 \|/u)
    assert.match(text, /\| `POST \/api\/v1\/things` \| `createThing` \| `public` \| — \| 公开 \|/u)
    assert.match(text, /`DELETE \/api\/v1\/things\/\{thingId\}` \| `deleteThing` \| — \| — \| 公开 \|/u)
    // Service-to-service face comes from the path prefix while the contract has no tags.
    assert.match(text, /`POST \/internal\/v1\/things\/sync` \| `syncThings` \| `bearerAuth` \| Sync things from the runtime \| 服务间 \|/u)
  } finally {
    fx.cleanup()
  }
})

test('no tags => one flat section per path prefix, with counts in the header', () => {
  const fx = fixture(BASE_FIXTURE)
  try {
    const text = fx.generate()
    assert.match(text, /\*\*4\*\* operations ／ \*\*2\*\* 个分组 ／ \*\*0\*\* 个 tag；面分布 公开 3 · 服务间 1/u)
    assert.match(text, /## \/api\/v1（3 operations）/u)
    assert.match(text, /## \/internal\/v1（1 operations）/u)
    // A flat section renders the table directly, with no '### <tag>' heading.
    assert.doesNotMatch(text, /^### /mu)
  } finally {
    fx.cleanup()
  }
})

test('no tags => the header says so and carries an explicit TODO until M1 lands', () => {
  const fx = fixture(BASE_FIXTURE)
  try {
    const text = fx.generate()
    assert.match(text, /当前 0 个 operation 声明了 `tags`/u)
    assert.match(text, /TODO\(PLAN-0763 M1\)/u)
  } finally {
    fx.cleanup()
  }
})

test('tags without x-tagGroups => one flat section per tag', () => {
  const fx = fixture(TAGGED_FIXTURE)
  try {
    const text = fx.generate()
    assert.match(text, /## things（1 operations）/u)
    assert.match(text, /## auth（1 operations）/u)
    assert.match(text, /但\*\*无\*\* `x-tagGroups`/u)
    assert.equal(text.split('## ').length - 1, 2, 'expected exactly two flat sections')
    assert.doesNotMatch(text, /当前 0 个 operation 声明了 `tags`/u)
  } finally {
    fx.cleanup()
  }
})

test('x-tagGroups => two levels in x-tagGroups order, tags keep their declared order', () => {
  const fx = fixture(GROUPED_FIXTURE)
  try {
    const text = fx.generate()
    assert.match(text, /## public（2 operations · 公开 · 2 tags）/u)
    assert.match(text, /## internal（1 operations · 服务间 · 1 tags）/u)
    // Tag order comes from x-tagGroups (things before auth), not from the alphabet.
    const things = text.indexOf('### things（1）')
    const auth = text.indexOf('### auth（1）')
    assert.ok(things !== -1 && auth !== -1, 'both tags must get a heading')
    assert.ok(things < auth, 'x-tagGroups order must win over alphabetical order')
    // Level order follows x-tagGroups too.
    assert.ok(text.indexOf('## public') < text.indexOf('## internal'))
  } finally {
    fx.cleanup()
  }
})

test('an operation tagged outside every group is reported as 其它, never folded into a real group', () => {
  const fx = fixture(GROUPED_FIXTURE)
  try {
    const text = fx.generate()
    assert.match(text, /## 其它（1 operations · 未归组，按 path 前缀兜底）/u)
    assert.match(text, /`GET \/api\/v1\/orphaned` \| `orphaned` \| `bearerAuth` \|/u)
  } finally {
    fx.cleanup()
  }
})

test('--check passes on a freshly generated file', () => {
  const fx = fixture(BASE_FIXTURE)
  try {
    fx.generate()
    const checked = fx.run('--check')
    assert.equal(checked.status, 0, checked.stderr)
    assert.match(checked.stdout, /OK/u)
  } finally {
    fx.cleanup()
  }
})

test('--check fails with line numbers and a fix hint when the inventory drifts', () => {
  const fx = fixture(BASE_FIXTURE)
  try {
    const before = fx.generate()
    // One changed character is enough: the gate compares bytes.
    fs.writeFileSync(fx.output, before.replace('List things', 'List things '), 'utf8')
    const checked = fx.run('--check')
    assert.equal(checked.status, 1)
    assert.match(checked.stderr, /已落后于/u)
    assert.match(checked.stderr, /differing lines: 1/u)
    assert.match(checked.stderr, /committed: .*List things /u)
    assert.match(checked.stderr, /generated: .*List things \|/u)
    assert.match(checked.stderr, /fix: mise run gen:api-docs/u)
  } finally {
    fx.cleanup()
  }
})

test('--check fails closed when the generated file is missing', () => {
  const fx = fixture(BASE_FIXTURE)
  try {
    const checked = fx.run('--check')
    assert.equal(checked.status, 1)
    assert.match(checked.stderr, /不存在；先跑 mise run gen:api-docs/u)
  } finally {
    fx.cleanup()
  }
})

test('a missing contract is a preflight failure (exit 2), never a silent pass', () => {
  const fx = fixture(BASE_FIXTURE)
  try {
    fs.rmSync(fx.contract)
    const result = fx.run()
    assert.equal(result.status, 2)
    assert.match(result.stderr, /contract not found/u)
  } finally {
    fx.cleanup()
  }
})

test('the committed inventory.generated.md is up to date with the committed contract', () => {
  // The same assertion 'mise run check:api-docs' makes, so a stale file fails node --test too.
  const result = spawnSync(process.execPath, [SCRIPT, '--check'], {
    encoding: 'utf8',
    env: { ...process.env, XH_OPENAPI_CONTRACT: REAL_CONTRACT, XH_API_DOCS_OUT: REAL_OUTPUT },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /OK/u)
})
