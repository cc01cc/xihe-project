// BL-162: contract gate for docs/api/openapi.yaml.
//
// Wiring: `mise run check:openapi`; the same task is a dependency of `test:cp` and `validate`, so a
// contract drift fails the CP test wave instead of relying on someone remembering to run this by hand
// (that was the pre-BL-162 state: zero references from mise.toml / pom.xml / scripts/).
//
// Scope — deliberately narrow, see .local/evidence/bl-162-openapi-gate.md §blind spots:
//   * text-level structure only: 3.1 header, unique paths, path-parameter declarations, Problem Details;
//   * a few hand-written *frozen contract slices* (checkpoint revert, session read projection);
//   * it does NOT parse YAML, resolve $ref, validate against the OpenAPI 3.1 schema, or diff Spring
//     routes against the documented paths — "implemented route missing from the contract" is NOT
//     caught here (BL-320 covers it in RouteContractParityTest).
//   * it does NOT catch YAML *duplicate keys* either: oxfmt is a formatter, and duplicate keys are
//     last-key-wins rather than a syntax error (task-246, measured — two such keys shipped here).
//     Do not add a hand-rolled key scan; that coverage lives in
//     packages/control-plane/src/test/java/com/cc01cc/p/xihe/cp/api/OpenApiDuplicateKeyTest.java
//     (SnakeYAML compose walk, key path + line, shrink-only baseline), because the repo declares no
//     YAML parser for Node and this gate must stay dependency-free and offline.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CONTRACT = 'docs/api/openapi.yaml'
const DEFAULT_CONTRACT_FILE = new URL('../docs/api/openapi.yaml', import.meta.url)
// Test seam: tests point at a temporary copy; production always uses docs/api/openapi.yaml.
const CONTRACT_FILE = process.env.XH_OPENAPI_CONTRACT
  ? path.resolve(process.env.XH_OPENAPI_CONTRACT)
  : DEFAULT_CONTRACT_FILE

// BL-451: reuse the repo's existing mature YAML parser (oxfmt / oxc) instead of adding a
// dependency or hand-writing a parser. oxfmt parses YAML and reports source line:column.
const OXFMT_BIN = new URL('../packages/ui/node_modules/oxfmt/bin/oxfmt', import.meta.url)
const FIX_COMMAND = '`mise run check:openapi` (test:cp runs it automatically too)'

/** A gate failure a reader can act on: what broke, where the first break is, and how to fix it. */
class ContractError extends Error {
  constructor(code, message, hint) {
    super(message)
    this.code = code
    this.hint = hint
  }
}

function fail(code, message, hint) {
  throw new ContractError(code, message, hint)
}

/** Reject raw control bytes (0x00–0x08, 0x0B–0x1F) before any parser sees them. */
function checkBytes(buffer) {
  let line = 1
  let column = 1
  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i]
    if (byte <= 0x08 || (byte >= 0x0b && byte <= 0x1f)) {
      fail(
        'non-printable-byte',
        `illegal control byte 0x${byte.toString(16).padStart(2, '0')} at ${line}:${column} (offset ${i})`,
        '文档必须是 UTF-8 且不含 0x00–0x08/0x0B–0x1F 控制字节；删掉不可打印字符后重跑',
      )
    }
    if (byte === 0x0a) {
      line += 1
      column = 1
    } else {
      column += 1
    }
  }
}

/** Parse YAML with oxfmt; syntax errors are fatal and carry source line:column. */
function checkYamlSyntax(buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xh-openapi-'))
  const file = path.join(dir, 'openapi.yaml')
  try {
    fs.writeFileSync(file, buffer)
    const result = spawnSync(process.execPath, [fileURLToPath(OXFMT_BIN), '--write', file], {
      encoding: 'utf8',
      timeout: 30_000,
    })
    if (result.error) {
      fail(
        'yaml-parser-unavailable',
        `cannot run oxfmt YAML parser: ${result.error.message}`,
        '确认 packages/ui 的 oxfmt 依赖存在；本门禁复用仓库已有成熟解析器，不新增依赖',
      )
    }
    if (result.status !== 0) {
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
      const location = output.match(/:(\d+):(\d+)\]/)
      const errorLine = output.match(/x (Syntax error: [^\n]+)/)
      fail(
        'yaml-syntax-error',
        `YAML parse failed${location ? ` at ${location[1]}:${location[2]}` : ''}${errorLine ? ` — ${errorLine[1].trim()}` : ''}`,
        output.split('\n').slice(0, 8).join(' '),
      )
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function parsePaths(text) {
  return [...text.matchAll(/^  (\/[^:]+):\s*$/gm)].map((match) => match[1])
}

function sliceBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker)
  if (start < 0) {
    fail(
      'missing-contract-block',
      `contract block not found: ${startMarker.trim()}`,
      '一个冻结契约块被删除或改名了；确认这是有意的契约变更，并同批更新本脚本的断言锚点',
    )
  }
  const end = text.indexOf(endMarker, start + startMarker.length)
  return end < 0 ? text.slice(start) : text.slice(start, end)
}

function checkHeader(text) {
  if (!/^openapi:\s*3\.1\.0\s*$/m.test(text)) {
    fail(
      'openapi-header',
      'the document does not declare `openapi: 3.1.0`',
      '文档头必须是 `openapi: 3.1.0`；改用 3.0 / 3.1.1 需同步 CP 的 springdoc 配置与客户端工具链',
    )
  }
}

function checkPaths(text) {
  const paths = parsePaths(text)
  if (paths.length === 0) {
    fail('no-paths', 'no path was parsed under `paths:`', '确认 `paths:` 下的键缩进为两个空格且以 `/` 开头')
  }
  const duplicates = [...new Set(paths.filter((path, index) => paths.indexOf(path) !== index))]
  if (duplicates.length > 0) {
    fail(
      'duplicate-path',
      `path declared more than once: ${duplicates[0]} (+${duplicates.length - 1} more duplicate name(s))`,
      '`paths:` 下的键必须唯一；重复通常是两次粘贴同一 block 或合并冲突残留 —— 删掉后一份',
    )
  }
  for (const path of paths) {
    if (!path.includes('{')) continue
    const block = text.slice(
      text.indexOf(`  ${path}:`),
      text.indexOf('\n  /', text.indexOf(`  ${path}:`) + 4),
    )
    for (const name of path.matchAll(/\{([^}]+)\}/g)) {
      // Boundary-aware on purpose: a plain substring test lets `name: itemIdX` satisfy `name: itemId`
      // (observed during the BL-162 refutation — the check reported green while the declaration no
      // longer named the path parameter). The delimiter keeps the claim "this parameter is declared".
      const literal = name[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (!new RegExp(`name: ${literal}(?=[,\\s])`).test(block)) {
        fail(
          'missing-path-parameter',
          `route ${path} declares path parameter {${name[1]}} but its operation never declares it`,
          `在该路径的每个 operation 下补 \`parameters:\`（in: path, name: ${name[1]}, required: true, schema: { type: string }）`,
        )
      }
    }
  }
}

function checkProblemDetails(text) {
  if (!text.includes('application/problem+json') || !text.includes('ProblemDetails')) {
    fail(
      'problem-details',
      'the RFC 9457 Problem Details schema is not declared',
      '所有错误响应都依赖 `ProblemDetails` / `application/problem+json`；删除它会让客户端无法解析 `code`/`requestId`',
    )
  }
}

// PLAN-0641 M3: the checkpoint-revert risk grading is a cross-layer contract — the wire fields and
// the 409 gate codes must stay declared on the document, not only in prose. Scoped slices keep the
// assertions honest: a name that appears elsewhere cannot satisfy them.
function checkCheckpointRevert(text) {
  const revertRequest = sliceBetween(
    text,
    '\n    CheckpointRevertRequest:',
    '\n    CheckpointRevertPreviewEntry:',
  )
  for (const field of ['force:', 'acknowledgeNestedRepos:']) {
    if (!revertRequest.includes(field)) {
      fail(
        'checkpoint-revert-request',
        `CheckpointRevertRequest must declare ${field}`,
        '这两个字段是跨层风险分级契约（PLAN-0641 M3）；删改需同批改 Runtime 侧并通过契约评审',
      )
    }
  }
  for (const schema of ['CheckpointRevertPreviewResponse', 'CheckpointRevertResponse']) {
    const block = sliceBetween(text, `\n    ${schema}:`, '\n    Checkpoint')
    if (!block.includes('nestedRepoAffected:')) {
      fail(
        'checkpoint-revert-response',
        `${schema} must declare nestedRepoAffected`,
        '嵌套仓库影响面是客户端预览确认的依据（PLAN-0641 M3）',
      )
    }
  }
  const affected = sliceBetween(text, '\n    CheckpointNestedRepoAffected:', '\n    Checkpoint')
  for (const field of ['repoPath:', 'kind:', 'dirty:', 'headMoved:']) {
    if (!affected.includes(field)) {
      fail(
        'checkpoint-nested-repo',
        `CheckpointNestedRepoAffected must declare ${field}`,
        '预览条目字段必须与 Runtime 上报一致（PLAN-0641 M3）',
      )
    }
  }
  const publicExecute = sliceBetween(
    text,
    '\n  /api/v1/workspaces/{workspaceId}/checkpoints/revert:',
    '\n  /',
  )
  const runtimeExecute = sliceBetween(
    text,
    '\n  /internal/v1/runtime/workspaces/{workspaceId}/checkpoints/revert:',
    '\n  /',
  )
  // PLAN-0641 M4: the legacy-slice boundary is decided CP-side, so only the public operation names
  // CROSS_ROOT_LEGACY_SLICE and the legacyRoots body; the Runtime pair keeps the M3 codes.
  for (const code of ['NESTED_REPO_DIRTY', 'NESTED_REPO_UNCONFIRMED', 'CROSS_ROOT_LEGACY_SLICE']) {
    if (!publicExecute.includes(code)) {
      fail(
        'checkpoint-revert-public-codes',
        `public checkpoint revert must name ${code}`,
        '公开面的 409 拒绝码是客户端分支的依据（PLAN-0641 M3/M4）',
      )
    }
  }
  if (!publicExecute.includes('legacyRoots')) {
    fail(
      'checkpoint-revert-legacy-roots',
      'public checkpoint revert must document the legacyRoots body',
      'legacy slice 边界由 CP 决定，请求体必须显式声明（PLAN-0641 M4）',
    )
  }
  for (const code of ['NESTED_REPO_DIRTY', 'NESTED_REPO_UNCONFIRMED']) {
    if (!runtimeExecute.includes(code)) {
      fail(
        'checkpoint-revert-runtime-codes',
        `runtime checkpoint revert must name ${code}`,
        'Runtime 侧只保留 M3 的两个码，不承担 legacy 边界判定（PLAN-0641 M4）',
      )
    }
  }
}

// PLAN-0668 M2: the session read projection is a cross-layer contract. Lineage must be declared on
// `Session` (detail view) and required on `SessionSummary` (list view); `archived` stays required on
// `Session`. Assertions are schema-scoped so a same-named field elsewhere cannot satisfy them.
function checkSessionReadProjection(text) {
  const sessionBlock = sliceBetween(text, '\n    Session: {', '\n    SessionForkResponse:')
  for (const field of ['kind:', 'spawnedFromSessionId:', 'spawnedFromRunId:', 'spawnedAt:']) {
    if (!sessionBlock.includes(field)) {
      fail(
        'session-lineage',
        `Session must declare lineage field ${field}`,
        '会话树/委派树读取依赖这四个血缘字段（PLAN-0668 M2 / BL-270）',
      )
    }
  }
  if (!/required: \[[^\]]*\barchived\b/.test(sessionBlock)) {
    fail(
      'session-archived',
      'Session.required must include archived',
      'archived 是 detail view 的必填字段；改成可选会让客户端把"未归档"读成"未知"',
    )
  }
  const sessionSummaryBlock = sliceBetween(text, '\n    SessionSummary:', '\n    Session: {')
  for (const field of ['kind', 'spawnedFromSessionId', 'spawnedAt']) {
    if (!new RegExp(`required: \\[[^\\]]*\\b${field}\\b`).test(sessionSummaryBlock)) {
      fail(
        'session-summary-required',
        `SessionSummary.required must include ${field}`,
        '列表面必须与详见面同批携带血缘字段，否则侧边栏要发 N+1（PLAN-0655 T1.5）',
      )
    }
  }
}

const CHECKS = [checkHeader, checkPaths, checkProblemDetails, checkCheckpointRevert, checkSessionReadProjection]
const FROZEN_SLICES = ['checkpoint-revert', 'session-read']

function reportFailure(error, paths) {
  console.error(
    [
      `✗ OpenAPI contract invalid: ${CONTRACT}`,
      `  paths parsed: ${paths.length}`,
      `  first failure: [${error.code}] ${error.message}`,
      `  hint: ${error.hint}`,
      `  fix: ${FIX_COMMAND}`,
    ].join('\n'),
  )
}

let buffer
try {
  buffer = fs.readFileSync(CONTRACT_FILE)
} catch (error) {
  console.error(`✗ cannot read ${CONTRACT}: ${error.message}`)
  process.exit(1)
}

const paths = parsePaths(buffer.toString('utf8'))
try {
  checkBytes(buffer)
  checkYamlSyntax(buffer)
  const text = buffer.toString('utf8')
  for (const check of CHECKS) check(text)
} catch (error) {
  if (error instanceof ContractError) {
    reportFailure(error, paths)
  } else {
    console.error(`✗ OpenAPI contract check crashed: ${error.message}`)
    console.error(error.stack)
  }
  process.exit(1)
}

console.log(
  `✓ OpenAPI contract passed — paths: ${paths.length} | structural: header, unique paths, path params,`
    + ` problem+json | frozen slices: ${FROZEN_SLICES.join(', ')}`,
)
