#!/usr/bin/env node
/**
 * task-237: generate `docs/api/inventory.generated.md` from `docs/api/openapi.yaml`, and gate
 * 「inventory 不会静默落后于契约」 with `--check`.
 *
 * Why this exists (user question, 2026-11-10): 「openapi 应该有直接从它生成 md 的工具吧?」
 * `docs/api/inventory.md` is hand-maintained and nothing ties it to the contract:
 * `scripts/validate-openapi.mjs` states in its own header that it does NOT parse YAML and only
 * checks text-level structure plus a few frozen slices — so a route can be added or removed with
 * no trace in the docs. This script closes that specific gap. It does NOT replace the manual file:
 * that one carries route-migration mappings, caller lists and error contracts which the contract
 * cannot express (see the note at the top of the generated file).
 *
 * Why not a markdown-generator dependency: `@redocly/cli` / `widdershins` / `js-yaml` / `yaml`
 * are all absent and this session cannot install packages. The repo already ships a mature YAML
 * parser — PyYAML in the agent venv (the same interpreter `scripts/l2/run-shards-sequential.mjs`
 * drives). Workspace rules forbid hand-writing a YAML parser, so parsing is delegated to PyYAML
 * while every formatting/policy decision stays here in Node.
 *
 * Wiring: `mise run check:api-docs` (`--check`). See mise.toml for why this joins the
 * `validate` chain next to `check:openapi` instead of being bolted onto `test:cp`.
 *
 * Output is deterministic — no timestamps, stable ordering — so `--check` can be a byte compare.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LF = String.fromCharCode(10)
/** Markdown code-span delimiter, kept in a constant so the render code stays template-free. */
const TICK = String.fromCharCode(96)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')

// Test seams, same shape as validate-openapi.mjs#XH_OPENAPI_CONTRACT: tests point both paths at
// throwaway fixtures; production always uses the two files under docs/api/.
const CONTRACT = process.env.XH_OPENAPI_CONTRACT
  ? path.resolve(process.env.XH_OPENAPI_CONTRACT)
  : path.join(REPO, 'docs', 'api', 'openapi.yaml')
const OUTPUT = process.env.XH_API_DOCS_OUT
  ? path.resolve(process.env.XH_API_DOCS_OUT)
  : path.join(REPO, 'docs', 'api', 'inventory.generated.md')
const CHECK_ONLY = process.argv.includes('--check')

const METHOD_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE']
/** A single verbose operation must not blow up one table row. */
const SUMMARY_CAP = 100
/** Escaped pipe, so a summary containing '|' cannot break the table. */
const ESC_PIPE = String.fromCharCode(92) + '|'

/**
 * PyYAML lives in the agent venv. Ordered candidates: explicit override first, then the Windows and
 * POSIX venv layouts. A missing interpreter is a preflight failure (exit 2), never a silent pass:
 * a gate that cannot run must not look green.
 */
const PYTHON_CANDIDATES = [
  process.env.XH_PYTHON,
  path.join(REPO, 'packages', 'agent', '.venv', 'Scripts', 'python.exe'),
  path.join(REPO, 'packages', 'agent', '.venv', 'bin', 'python'),
].filter(Boolean)

/**
 * The parse step, deliberately tiny: flatten paths x methods into one plain record per operation
 * and let Node own every presentation decision. Only fields the tables use are extracted, so the
 * JSON payload stays small.
 */
const PY_SOURCE = `
import json, sys
import yaml

with open(sys.argv[1], encoding='utf-8') as handle:
    doc = yaml.safe_load(handle)

paths = doc.get('paths') or {}
methods = {'get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'}
operations = []
for raw_path, item in paths.items():
    if not isinstance(item, dict):
        continue
    for raw_method, operation in item.items():
        method = str(raw_method).lower()
        if method not in methods or not isinstance(operation, dict):
            continue
        declared = operation.get('security')
        schemes = []
        if isinstance(declared, list):
            for requirement in declared:
                if isinstance(requirement, dict):
                    schemes.extend(str(key) for key in requirement.keys())
        tags = [str(tag) for tag in (operation.get('tags') or []) if isinstance(tag, str)]
        operations.append({
            'method': method.upper(),
            'path': str(raw_path),
            'operationId': str(operation.get('operationId') or ''),
            'summary': str(operation.get('summary') or '').strip(),
            'tags': tags,
            'security': sorted(set(schemes)),
            'securityDeclared': 'security' in operation,
        })

print(json.dumps({
    'openapi': str(doc.get('openapi') or ''),
    'hasGlobalSecurity': 'security' in doc,
    'tagGroups': [
        {
            'name': str(group.get('name') or ''),
            'tags': [str(tag) for tag in (group.get('tags') or [])],
        }
        for group in (doc.get('x-tagGroups') or [])
        if isinstance(group, dict)
    ],
    'declaredTags': [
        str(tag.get('name') if isinstance(tag, dict) else tag)
        for tag in (doc.get('tags') or [])
    ],
    'operations': operations,
}, ensure_ascii=False))
`

function fail(code, message) {
  console.error('[gen-api-docs] ' + message)
  process.exit(code)
}

function rel(absolutePath) {
  return path.relative(REPO, absolutePath).split(path.sep).join('/')
}

function findPython() {
  const found = PYTHON_CANDIDATES.find((candidate) => fs.existsSync(candidate))
  if (!found) {
    fail(
      2,
      'PyYAML interpreter not found; tried:' +
        LF +
        PYTHON_CANDIDATES.map((candidate) => '  ' + candidate).join(LF) +
        LF +
        'hint: mise run setup:agent (uv sync in packages/agent), or set XH_PYTHON to a python with PyYAML',
    )
  }
  return found
}

function parseContract(python) {
  if (!fs.existsSync(CONTRACT)) fail(2, 'contract not found: ' + CONTRACT)
  const result = spawnSync(python, ['-', CONTRACT], {
    input: PY_SOURCE,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) fail(2, 'cannot run ' + python + ': ' + result.error.message)
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim()
    const yamlMissing = stderr.indexOf('No module named') !== -1 && stderr.indexOf('yaml') !== -1
    fail(
      2,
      'python parse failed (exit ' + result.status + '): ' +
        stderr +
        (yamlMissing ? LF + 'hint: PyYAML missing in this interpreter; mise run setup:agent' : ''),
    )
  }
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    fail(2, 'python emitted invalid JSON: ' + error.message)
  }
}

/** Path-prefix fallback, used only for operations the contract does not place in a group. */
function prefixFace(routePath) {
  if (routePath.indexOf('/internal/') === 0) return '服务间'
  if (routePath.indexOf('/api/') === 0) return '公开'
  return '其它'
}

/** /api/v1, /internal/v1, /actuator, ... — fallback grouping key when an operation carries no tag. */
function apiPrefix(routePath) {
  const segments = routePath.split('/').filter(Boolean)
  if (segments.length === 0) return '/'
  const family = segments[0]
  if (family === 'api' || family === 'internal') return '/' + family + '/' + (segments[1] || '')
  return '/' + family
}

/** x-tagGroups name → 面 column. public / internal are the two levels PLAN-0763 M1 defined. */
function faceOfGroup(groupName) {
  if (groupName === 'public') return '公开'
  if (groupName === 'internal') return '服务间'
  return groupName
}

function methodRank(method) {
  const index = METHOD_ORDER.indexOf(method)
  return index === -1 ? METHOD_ORDER.length : index
}

function compareOperations(left, right) {
  if (left.path !== right.path) return left.path < right.path ? -1 : 1
  const byMethod = methodRank(left.method) - methodRank(right.method)
  if (byMethod !== 0) return byMethod
  if (left.operationId === right.operationId) return 0
  return left.operationId < right.operationId ? -1 : 1
}

function flatten(text) {
  return String(text).replace(/\s+/gu, ' ').trim()
}

function tableCell(text) {
  return flatten(text).split('|').join(ESC_PIPE)
}

function clipSummary(text) {
  const flat = flatten(text)
  if (flat.length <= SUMMARY_CAP) return flat
  return flat.slice(0, SUMMARY_CAP - 1) + '…'
}

function codeCell(text) {
  return TICK + flatten(text) + TICK
}

function securityCell(operation) {
  if (operation.security.length > 0) {
    return operation.security.map((name) => TICK + name + TICK).join(' ')
  }
  if (operation.securityDeclared) return TICK + 'public' + TICK
  return '—'
}

/**
 * Two-level sections, driven entirely by the contract (PLAN-0763 M1):
 *   level 1 = the top-level `x-tagGroups` entry a tag belongs to (public / internal);
 *   level 2 = `operation.tags[0]`.
 * An operation the contract does not place — untagged, or tagged with a tag that appears in no
 * x-tagGroups entry — lands in a fallback section keyed by path prefix. Keeping those visible as
 * leftovers is deliberate: silently folding them into a real group would hide a half-tagged contract.
 */
function buildSections(model) {
  const twoLevel = model.tagGroups.length > 0
  const tagToGroup = new Map()
  const declaredTags = new Map()
  const declaredOrder = []
  for (const group of model.tagGroups) {
    declaredOrder.push(group.name)
    declaredTags.set(group.name, group.tags.slice())
    for (const tag of group.tags) if (!tagToGroup.has(tag)) tagToGroup.set(tag, group.name)
  }
  const buckets = new Map()
  const sectionFace = new Map()
  const fallbackSections = new Set()
  for (const operation of model.operations) {
    const tagged = operation.tags.length > 0
    const tag = tagged ? operation.tags[0] : apiPrefix(operation.path)
    // Degraded contracts (pre-M1: tags without x-tagGroups, or no tags at all) still produce one
    // flat section per tag/prefix — a single level, so the file stays readable instead of collapsing
    // everything into one bucket.
    const section = twoLevel ? (tagToGroup.has(tag) ? tagToGroup.get(tag) : '其它') : tag
    if (!buckets.has(section)) {
      buckets.set(section, new Map())
      const groupName = twoLevel ? tagToGroup.get(tag) : undefined
      if (groupName === undefined) fallbackSections.add(section)
      else sectionFace.set(section, faceOfGroup(groupName))
    }
    const byTag = buckets.get(section)
    const key = twoLevel ? tag : ''
    if (!byTag.has(key)) byTag.set(key, [])
    byTag.get(key).push(operation)
  }
  const sections = []
  const titles = twoLevel
    ? declaredOrder.filter((title) => buckets.has(title)).concat(
        Array.from(buckets.keys())
          .filter((title) => declaredOrder.indexOf(title) === -1)
          .sort(),
      )
    : Array.from(buckets.keys()).sort()
  for (const title of titles) {
    const byTag = buckets.get(title)
    const section = {
      title,
      flat: !twoLevel,
      fallback: fallbackSections.has(title),
      face: sectionFace.get(title),
      byTag,
      tagOrder: [],
    }
    if (twoLevel) {
      const declared = declaredTags.get(title) || []
      const present = Array.from(byTag.keys())
      const head = declared.filter((tag) => byTag.has(tag))
      const tail = present.filter((tag) => head.indexOf(tag) === -1).sort()
      section.tagOrder = head.concat(tail)
    } else {
      section.tagOrder = ['']
    }
    sections.push(section)
  }
  return sections
}

function operationCount(section) {
  return section.tagOrder.reduce((total, tag) => total + section.byTag.get(tag).length, 0)
}

function operationFace(operation, section) {
  if (section.fallback) return prefixFace(operation.path)
  return section.face
}

const TABLE_HEAD = '| METHOD path | operationId | security | summary | 面 |'
const TABLE_RULE = '| --- | --- | --- | --- | --- |'

function rowLine(operation, section) {
  const summary = clipSummary(operation.summary)
  return (
    '| ' +
    codeCell(operation.method + ' ' + operation.path) +
    ' | ' +
    codeCell(operation.operationId) +
    ' | ' +
    securityCell(operation) +
    ' | ' +
    (summary === '' ? '—' : tableCell(summary)) +
    ' | ' +
    operationFace(operation, section) +
    ' |'
  )
}

function render(model) {
  const operations = model.operations.slice().sort(compareOperations)
  const sections = buildSections({ tagGroups: model.tagGroups, operations })
  const faceCounts = new Map()
  for (const section of sections) {
    for (const tag of section.tagOrder) {
      for (const operation of section.byTag.get(tag)) {
        const face = operationFace(operation, section)
        faceCounts.set(face, (faceCounts.get(face) || 0) + 1)
      }
    }
  }
  const taggedCount = operations.filter((operation) => operation.tags.length > 0).length
  const undeclaredSecurity = operations.filter((operation) => !operation.securityDeclared).length
  const tagCount = model.tagGroups.reduce((total, group) => total + group.tags.length, 0)

  const lines = []
  lines.push('# Xihe API inventory（生成版）')
  lines.push('')
  lines.push(
    '> **生成文件，请勿手改。** 由 ' +
      codeCell('scripts/gen-api-docs.mjs') +
      ' 从 ' +
      codeCell('docs/api/openapi.yaml') +
      ' 生成。',
  )
  lines.push(
    '> 重新生成：' +
      codeCell('mise run gen:api-docs') +
      ' ｜ 校验是否落后：' +
      codeCell('mise run check:api-docs') +
      '（不一致 exit 1）。',
  )
  lines.push(
    '> 人工叙述版（含路由迁移对照、调用方、错误契约 —— 这些 yaml 表达不了）仍在' +
      ' [inventory.md](./inventory.md)，本文件**不替代**它。',
  )
  lines.push('')
  lines.push('- 契约：' + codeCell('docs/api/openapi.yaml') + '（OpenAPI ' + model.openapi + '）')
  lines.push(
    '- 规模：**' +
      String(operations.length) +
      '** operations ／ **' +
      String(sections.length) +
      '** 个分组 ／ **' +
      String(tagCount) +
      '** 个 tag；面分布 ' +
      Array.from(faceCounts.entries())
        .sort()
        .map((entry) => entry[0] + ' ' + String(entry[1]))
        .join(' · '),
  )
  lines.push(
    '- security 列：' +
      codeCell('bearerAuth') +
      ' = 声明了 bearer 方案；' +
      codeCell('public') +
      ' = 显式 ' +
      codeCell('security: []') +
      '；' +
      codeCell('—') +
      ' = 未声明（全局 security ' +
      (model.hasGlobalSecurity ? '存在' : '为空') +
      '，实际语义也按公开处理）。未声明共 ' +
      String(undeclaredSecurity) +
      ' 个操作。',
  )
  if (model.tagGroups.length > 0) {
    lines.push(
      '- 分组口径：两级 —— 顶层 ' +
        codeCell('x-tagGroups') +
        '（' +
        model.tagGroups.map((group) => group.name + ' ' + String(group.tags.length) + ' tags').join(' / ') +
        '）÷ ' +
        codeCell('operation.tags[0]') +
        '（' +
        String(taggedCount) +
        ' / ' +
        String(operations.length) +
        ' 个操作带 tag）。',
    )
  } else if (taggedCount > 0) {
    lines.push(
      '- 分组口径：契约有 ' +
        codeCell('operation.tags') +
        '（' +
        String(taggedCount) +
        ' / ' +
        String(operations.length) +
        ' 个操作带 tag）但**无** ' +
        codeCell('x-tagGroups') +
        '，故按 tag 单级分组。',
    )
  } else {
    lines.push(
      '- 分组口径：**当前 0 个 operation 声明了 ' +
        codeCell('tags') +
        '**（PLAN-0763 M1 尚未落地），故按 path 前缀兜底分组；tag 落地后本文件自动改为两级分组。' +
        ' <!-- TODO(PLAN-0763 M1): 契约有 tags + x-tagGroups 后删除本行 -->',
    )
  }
  lines.push('')

  for (const section of sections) {
    const count = operationCount(section)
    if (section.flat) {
      lines.push('## ' + section.title + '（' + String(count) + ' operations）')
      lines.push('')
      lines.push(TABLE_HEAD)
      lines.push(TABLE_RULE)
      for (const operation of section.byTag.get('')) lines.push(rowLine(operation, section))
      lines.push('')
      continue
    }
    if (section.fallback) {
      lines.push('## ' + section.title + '（' + String(count) + ' operations · 未归组，按 path 前缀兜底）')
    } else {
      lines.push(
        '## ' + section.title + '（' + String(count) + ' operations · ' + section.face + ' · ' + String(section.tagOrder.length) + ' tags）',
      )
    }
    lines.push('')
    for (const tag of section.tagOrder) {
      const tagOperations = section.byTag.get(tag)
      lines.push('### ' + tag + '（' + String(tagOperations.length) + '）')
      lines.push('')
      lines.push(TABLE_HEAD)
      lines.push(TABLE_RULE)
      for (const operation of tagOperations) lines.push(rowLine(operation, section))
      lines.push('')
    }
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join(LF) + LF
}

function summariseDiff(currentText, generatedText) {
  const currentLines = currentText.split(LF)
  const generatedLines = generatedText.split(LF)
  const total = Math.max(currentLines.length, generatedLines.length)
  const mismatchLines = []
  let mismatchCount = 0
  for (let index = 0; index < total; index += 1) {
    if (currentLines[index] === generatedLines[index]) continue
    mismatchCount += 1
    if (mismatchLines.length < 5) mismatchLines.push(index + 1)
  }
  const details = mismatchLines.map((lineNumber) => {
    const committed = currentLines[lineNumber - 1]
    const generated = generatedLines[lineNumber - 1]
    return (
      '    line ' +
      String(lineNumber) +
      LF +
      '      committed: ' +
      (committed === undefined ? '(缺失)' : committed) +
      LF +
      '      generated: ' +
      (generated === undefined ? '(缺失)' : generated)
    )
  })
  return (
    'differing lines: ' +
    String(mismatchCount) +
    ' / ' +
    String(total) +
    LF +
    'first mismatches (committed vs generated):' +
    LF +
    details.join(LF)
  )
}

const python = findPython()
const model = parseContract(python)
const generated = render(model)

if (CHECK_ONLY) {
  if (!fs.existsSync(OUTPUT)) {
    fail(1, rel(OUTPUT) + ' 不存在；先跑 mise run gen:api-docs')
  }
  const committed = fs.readFileSync(OUTPUT, 'utf8')
  if (committed === generated) {
    console.log(
      '[gen-api-docs] OK ' +
        rel(OUTPUT) +
        ' 与契约一致（' +
        String(model.operations.length) +
        ' operations）',
    )
    process.exit(0)
  }
  fail(
    1,
    rel(OUTPUT) +
      ' 已落后于 ' +
      rel(CONTRACT) +
      LF +
      summariseDiff(committed, generated) +
      LF +
      'fix: mise run gen:api-docs',
  )
}

fs.writeFileSync(OUTPUT, generated, 'utf8')
console.log(
  '[gen-api-docs] wrote ' +
    rel(OUTPUT) +
    ' — ' +
    String(model.operations.length) +
    ' operations, ' +
    String(generated.split(LF).length) +
    ' lines',
)
