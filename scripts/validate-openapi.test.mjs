#!/usr/bin/env node
/** BL-451 / PLAN-0732: validate-openapi YAML + byte gates (no new dependency). */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./validate-openapi.mjs', import.meta.url))
const DOC = fileURLToPath(new URL('../docs/api/openapi.yaml', import.meta.url))

function fixture(name, transform) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-openapi-'))
  const file = path.join(dir, name)
  fs.copyFileSync(DOC, file)
  if (transform) {
    const buffer = fs.readFileSync(file)
    fs.writeFileSync(file, Buffer.concat([buffer, transform]))
  }
  return { dir, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

function run(file) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, XH_OPENAPI_CONTRACT: file },
  })
}

test('valid contract ⇒ exit 0 and paths count matches yaml', () => {
  const fx = fixture('openapi.yaml')
  try {
    const result = run(fx.file)
    assert.equal(result.status, 0, result.stderr)
    // 动态断言：validator 报出的 paths 数必须与 yaml 顶层 path 键数一致（不硬编码存量数，
    // 契约合法增删 path 时本测试不应红——272→270 存量漂移的根因就是硬编码，task-218）。
    const yamlText = fs.readFileSync(fx.file, 'utf8')
    const yamlPaths = (yamlText.match(/^  \/[^:]+:\s*$/gm) || []).length
    assert.match(result.stdout, new RegExp('paths: ' + yamlPaths))
  } finally {
    fx.cleanup()
  }
})

test('unclosed flow sequence ⇒ exit 1 with YAML line:column', () => {
  const fx = fixture('unclosed.yaml', Buffer.from('broken: [unclosed\n'))
  try {
    const result = run(fx.file)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /yaml-syntax-error/)
    assert.match(result.stderr, /\b\d+:\d+\b/)
  } finally {
    fx.cleanup()
  }
})

test('bad indentation ⇒ exit 1 with YAML syntax error', () => {
  const fx = fixture('indent.yaml', Buffer.from('\n bad: [\n  - x\n - y\n'))
  try {
    const result = run(fx.file)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /yaml-syntax-error/)
  } finally {
    fx.cleanup()
  }
})

test('illegal 0x14 byte ⇒ exit 1 before YAML parser', () => {
  const fx = fixture('byte.yaml', Buffer.from([0x14]))
  try {
    const result = run(fx.file)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /non-printable-byte/)
    assert.match(result.stderr, /0x14/)
  } finally {
    fx.cleanup()
  }
})
