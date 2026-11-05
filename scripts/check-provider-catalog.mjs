#!/usr/bin/env node
/**
 * Provider catalog self-check (BL-206) — **report only, never non-zero**.
 *
 * WHY
 *   `BL-206` was filed as "xiaomi's default apiType does not support tool calls". The real
 *   defect is narrower: the provider *does* support tools (`supports.tools: true`, and one of
 *   its api types has `capability.tools: true`) — the **default** just points at a capability
 *   that has `tools: false`. Keeping that distinction is what makes the fix "change the default"
 *   rather than "change the capability declaration".
 *
 *   Changing product defaults needs a ruling (decision sheet A1), but "is the catalog
 *   internally consistent?" can be checked today — and if several providers have the same
 *   shape, this is a pattern, not an incident.
 *
 * CHECKS (per provider record)
 *   1. ERROR-class WARN: `defaultApiType` must appear in `supportedApiTypes`
 *      (same apiTypeId AND same version) — otherwise a new connection starts on a
 *      combination the provider does not declare.
 *   2. WARN: if provider-level `supports.tools === true`, the capability of the
 *      `defaultApiType` should not say `tools: false` (that is exactly BL-206).
 *   3. WARN: if provider-level `supports.tools === false`, every capability should say
 *      `tools: false` (a provider that cannot do tools must not advertise a tool-capable type).
 *
 * OUTPUT
 *   `[catalog] OK` on a clean catalog, or one line per finding:
 *   `[catalog] WARN provider=<id> <reason>`
 *   Exit code is always 0: this script reports, it does not gate. Wiring it into `validate`
 *   is a separate decision (it would need a run proving the gate does not go red).
 *
 * USAGE
 *   node scripts/check-provider-catalog.mjs                       # real catalog
 *   node scripts/check-provider-catalog.mjs --json                # machine-readable findings
 *   node scripts/check-provider-catalog.mjs --file <path>         # another catalog file
 *   node --test scripts/check-provider-catalog.test.mjs           # self-tests (3 fixtures)
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CATALOG = join(HERE, '../packages/control-plane/src/main/resources/provider-catalog/providers.json');

const sameType = (a, b) =>
  Boolean(a && b) && String(a.apiTypeId) === String(b.apiTypeId) && Number(a.version ?? 1) === Number(b.version ?? 1);

/**
 * @param {Array<object>} catalog provider records
 * @returns {Array<{provider: string, check: 1|2|3, reason: string}>} findings (empty = OK)
 */
export function checkCatalog(catalog) {
  const findings = [];
  for (const provider of Array.isArray(catalog) ? catalog : []) {
    const id = provider?.id ?? '(no id)';
    const types = Array.isArray(provider?.supportedApiTypes) ? provider.supportedApiTypes : [];
    const def = provider?.defaultApiType ?? null;
    const providerTools = provider?.supports?.tools;

    // 1. default must be one of the declared types.
    if (!def) {
      findings.push({ provider: id, check: 1, reason: 'has no defaultApiType' });
    } else if (!types.some((type) => sameType(type, def))) {
      findings.push({
        provider: id,
        check: 1,
        reason: `defaultApiType ${def.apiTypeId}@${def.version ?? 1} is not in supportedApiTypes`,
      });
    }

    const defaultType = def ? types.find((type) => sameType(type, def)) : undefined;
    const defaultTools = defaultType?.capability?.tools;

    // 2. provider claims tools, but the default capability does not.
    if (providerTools === true && defaultTools === false) {
      findings.push({
        provider: id,
        check: 2,
        reason: `provider supports.tools=true but defaultApiType ${def.apiTypeId} capability.tools=false`
          + ' (new connections start on a tool-less api type; BL-206 shape)',
      });
    }

    // 3. provider cannot do tools, but advertises a tool-capable type.
    if (providerTools === false) {
      const capable = types.filter((type) => type?.capability?.tools === true).map((type) => type.apiTypeId);
      if (capable.length > 0) {
        findings.push({
          provider: id,
          check: 3,
          reason: `provider supports.tools=false but declares tool-capable types: ${capable.join(', ')}`,
        });
      }
    }
  }
  return findings;
}

function main(argv) {
  const json = argv.includes('--json');
  const fileArg = argv.indexOf('--file');
  const file = fileArg >= 0 ? resolve(argv[fileArg + 1]) : DEFAULT_CATALOG;
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    // A broken path/JSON is reported, never thrown as a gate: the exit code stays 0.
    console.error(`[catalog] SKIP cannot read ${file}: ${error.message}`);
    return;
  }
  const findings = checkCatalog(catalog);
  if (json) {
    console.log(JSON.stringify({ file, ok: findings.length === 0, findings }, null, 2));
    return;
  }
  if (findings.length === 0) {
    console.log(`[catalog] OK (${Array.isArray(catalog) ? catalog.length : 0} providers)`);
    return;
  }
  for (const finding of findings) {
    console.log(`[catalog] WARN provider=${finding.provider} ${finding.reason}`);
  }
  console.log(`[catalog] ${findings.length} finding(s) in ${Array.isArray(catalog) ? catalog.length : 0} providers`
    + ' — report only (exit 0); product defaults are NOT changed by this script');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
