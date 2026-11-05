/**
 * Self-tests for `check-provider-catalog.mjs` (BL-206).
 *
 * Three constructed fixtures prove each verdict fires:
 *   1. a consistent catalog → no findings;
 *   2. `defaultApiType` outside `supportedApiTypes` → check 1;
 *   3. tools contradictions → check 2 (provider claims tools, default says none) and
 *      check 3 (provider cannot do tools, yet declares a tool-capable type).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkCatalog } from './check-provider-catalog.mjs';

const type = (apiTypeId, tools, version = 1) => ({ apiTypeId, version, capability: { tools, vision: false } });

test('fixture 1: consistent catalog has no findings', () => {
  const catalog = [
    {
      id: 'good',
      supportedApiTypes: [type('openai-chat-completions', true)],
      defaultApiType: { apiTypeId: 'openai-chat-completions', version: 1 },
      supports: { tools: true },
    },
    {
      id: 'no-tools',
      supportedApiTypes: [type('plain-completions', false)],
      defaultApiType: { apiTypeId: 'plain-completions', version: 1 },
      supports: { tools: false },
    },
  ];
  assert.deepEqual(checkCatalog(catalog), []);
});

test('fixture 2: defaultApiType outside supportedApiTypes is reported (check 1)', () => {
  const catalog = [
    {
      id: 'mismatch',
      supportedApiTypes: [type('openai-chat-completions', true)],
      defaultApiType: { apiTypeId: 'anthropic-messages', version: 1 },
      supports: { tools: true },
    },
  ];
  const findings = checkCatalog(catalog);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].provider, 'mismatch');
  assert.equal(findings[0].check, 1);
  assert.match(findings[0].reason, /not in supportedApiTypes/u);
});

test('fixture 3: tools contradictions are reported (checks 2 and 3)', () => {
  const catalog = [
    {
      // BL-206 shape: provider supports tools, but the DEFAULT type does not.
      id: 'default-without-tools',
      supportedApiTypes: [type('responses-no-tools', false), type('openai-chat-completions', true)],
      defaultApiType: { apiTypeId: 'responses-no-tools', version: 1 },
      supports: { tools: true },
    },
    {
      // Opposite direction: provider cannot do tools, yet advertises a tool-capable type.
      id: 'claims-tools-it-cannot-do',
      supportedApiTypes: [type('tool-type', true)],
      defaultApiType: { apiTypeId: 'tool-type', version: 1 },
      supports: { tools: false },
    },
  ];
  const findings = checkCatalog(catalog);
  assert.equal(findings.length, 2);
  const shape = findings.map((finding) => `${finding.provider}#${finding.check}`).sort();
  assert.deepEqual(shape, ['claims-tools-it-cannot-do#3', 'default-without-tools#2']);
  assert.match(findings.find((f) => f.check === 2).reason, /BL-206/u);
});
