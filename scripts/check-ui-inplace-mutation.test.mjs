import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// BL-365: the gate must stay report-only and near-zero false positives.
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-ui-inplace-mutation.mjs');

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-inplace-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return root;
}
const run = (root, ...args) => spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });

test('clean component has no findings and still exits 0', () => {
  const root = fixture({ 'packages/ui/src/a.vue': 'const x = agent.name;\n' });
  const out = run(root);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /0 finding\(s\) — report only/);
});

test('a single field write is reported with file:line', () => {
  const root = fixture({ 'packages/ui/src/B.vue': 'function f(agent) {\n  agent.contextPolicy = merged;\n}\n' });
  const out = run(root);
  assert.equal(out.status, 0);
  const line = out.stdout.split('\n').find((x) => x.includes('agent.contextPolicy'));
  assert.ok(line?.startsWith('[ui-inplace] packages/ui/src/B.vue:2 '), line);
});

test('comparisons, ref replacement and declarations are not reported', () => {
  const root = fixture({
    'packages/ui/src/C.vue': [
      'if (item.status === "done") {}',
      'if (row.count >= 1 && item.total <= 2) {}',
      'message.value = "x";',
      'const agent = props.agent;',
      'let session = null;',
    ].join('\n'),
  });
  const out = run(root, '--json');
  const payload = JSON.parse(out.stdout);
  assert.equal(payload.count, 0, JSON.stringify(payload.findings));
  assert.equal(payload.reportOnly, true);
});

test('stores and test directories are out of scope', () => {
  const root = fixture({
    'packages/ui/src/stores/chat.ts': 'message.runStatus = "succeeded";\n',
    'packages/ui/src/__tests__/x.spec.ts': 'agent.contextPolicy = merged;\n',
  });
  const out = run(root, '--json');
  assert.equal(JSON.parse(out.stdout).count, 0);
});
