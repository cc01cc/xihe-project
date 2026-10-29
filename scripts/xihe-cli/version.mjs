import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkVersions,
  parseJsonVersionText,
  parsePomVersionText,
  parseTomlVersionText,
} from '../check-versions.mjs';

export const CLI_VERSION_LABEL = 'development checkout';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

export const VERSION_MANIFESTS = [
  { name: 'ui', manifest: 'packages/ui/package.json', parse: parseJsonVersionText },
  { name: 'cp', manifest: 'packages/control-plane/pom.xml', parse: parsePomVersionText },
  { name: 'agent', manifest: 'packages/agent/pyproject.toml', parse: parseTomlVersionText },
  { name: 'runtime', manifest: 'packages/runtime/Cargo.toml', parse: parseTomlVersionText },
];

function classifyReadError(error) {
  if (error?.code === 'ENOENT') return 'MANIFEST_MISSING';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'MANIFEST_UNREADABLE';
  return 'MANIFEST_INVALID';
}

function safeErrorMessage(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = typeof error?.message === 'string' ? error.message.split(/\r?\n/, 1)[0] : 'unknown error';
  return `${code ? `${code}: ` : ''}${message}`.slice(0, 200);
}

export function readModuleVersions({ root = projectRoot, fsImpl = fs } = {}) {
  return VERSION_MANIFESTS.map(({ name, manifest, parse }) => {
    try {
      const text = fsImpl.readFileSync(path.join(root, manifest), 'utf8');
      const version = parse(text, manifest);
      return { name, manifest, version };
    } catch (error) {
      return {
        name,
        manifest,
        error: { code: classifyReadError(error), message: safeErrorMessage(error) },
      };
    }
  });
}

export function runVersion({ check = false, root = projectRoot, fsImpl = fs } = {}) {
  const modules = readModuleVersions({ root, fsImpl });
  const manifestsOk = modules.every((module) => typeof module.version === 'string');
  const data = {
    version: CLI_VERSION_LABEL,
    ok: manifestsOk,
    modules,
  };
  let exitCode = manifestsOk ? 0 : 1;
  if (check) {
    const result = checkVersions(root);
    data.check = {
      ok: result.ok,
      failureCount: result.failures.length,
      checkCount: result.checks.length,
      failures: result.failures,
    };
    if (!result.ok) exitCode = 1;
  }
  return { exitCode, data };
}
