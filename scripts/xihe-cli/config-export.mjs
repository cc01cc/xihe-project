import fs from 'node:fs';
import path from 'node:path';
import { CliError, confirmAction, requestText } from './provider.mjs';

const MAX_EXPORT_BYTES = 8_000_000;

function identityOf(stat) {
  return `${stat.dev}:${stat.ino}`;
}

function lstatBig(fsImpl, filePath) {
  return fsImpl.lstatSync(filePath, { bigint: true });
}

// Shared secure file writer for `config export` and `credential reveal --out`.
// PLAN-0574 T1.2 / decision #13:
// - new file: exclusive create (`wx`)
// - existing regular file: only after interactive confirmation or --force
// - directories, symlinks, junctions and other non-regular targets: rejected
// - replacement is detected with fstat/lstat ino+dev as bigint. H: is ReFS
//   (evidence/m0-file-probe-h.md): timestamps are delayed/merged and must never
//   be used as the identity or "unchanged" signal.
export async function writeExportFile({
  filePath,
  content,
  force = false,
  confirm = confirmAction,
  fsImpl = fs,
  stdin,
  stderr = process.stderr,
  label = 'export',
  codePrefix = 'EXPORT',
}) {
  const codes = {
    unsafe: `${codePrefix}_TARGET_UNSAFE`,
    write: `${codePrefix}_WRITE_FAILED`,
    replaced: `${codePrefix}_TARGET_REPLACED`,
  };
  const unsafe = (reason, file) => new CliError(codes.unsafe, `Refusing to write the ${label}: ${reason}.`, { file }, 1);

  const resolved = path.resolve(filePath);
  let before = null;
  try {
    before = lstatBig(fsImpl, resolved);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw unsafe('the target could not be inspected safely', resolved);
    }
  }

  if (before) {
    if (before.isSymbolicLink()) throw unsafe('the target is a symbolic link or junction', resolved);
    if (before.isDirectory()) throw unsafe('the target is a directory', resolved);
    if (!before.isFile()) throw unsafe('the target is not a regular file', resolved);
    if (!force) {
      await confirm({
        message: `Overwrite existing ${label} file ${resolved}?`,
        stdin,
        output: stderr,
      });
    }
  }

  const created = !before;
  let fd;
  try {
    fd = created
      ? fsImpl.openSync(resolved, 'wx')
      : fsImpl.openSync(resolved, 'r+');
  } catch (error) {
    throw new CliError(codes.write, created
      ? `The ${label} file could not be created; no content was written.`
      : `The existing ${label} file could not be opened for writing; it was not modified.`, {
      file: resolved,
      code: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
      residual: false,
    }, 1);
  }

  let identity;
  try {
    const opened = fsImpl.fstatSync(fd, { bigint: true });
    const current = lstatBig(fsImpl, resolved);
    if (current.isSymbolicLink() || !current.isFile() || identityOf(opened) !== identityOf(current)) {
      throw new CliError(codes.replaced, `The ${label} target was replaced or cannot be verified after opening; nothing was written.`, {
        file: resolved,
        residual: false,
      }, 1);
    }
    identity = identityOf(opened);
  } catch (error) {
    fsImpl.closeSync(fd);
    if (error instanceof CliError) throw error;
    throw unsafe('the target could not be verified after opening; nothing was written', resolved);
  }

  const buffer = Buffer.from(content, 'utf8');
  try {
    let offset = 0;
    while (offset < buffer.length) {
      offset += fsImpl.writeSync(fd, buffer, offset, buffer.length - offset, offset);
    }
    fsImpl.ftruncateSync(fd, buffer.length);
    fsImpl.fsyncSync(fd);
  } catch (error) {
    try { fsImpl.closeSync(fd); } catch { /* fd already unusable */ }
    let residual = true;
    if (created) {
      // Only remove a file we created and whose identity is still unchanged.
      try {
        if (identityOf(lstatBig(fsImpl, resolved)) === identity) {
          fsImpl.unlinkSync(resolved);
          residual = false;
        }
      } catch { /* keep residual=true: the target is no longer verifiable */ }
    }
    throw new CliError(codes.write, residual
      ? `Writing the ${label} failed; a partial or replaced file may remain at the target.`
      : `Writing the ${label} failed; the file created by this run was removed.`, {
      file: resolved,
      code: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
      residual,
    }, 1);
  }

  try { fsImpl.closeSync(fd); } catch { /* content is already flushed */ }

  try {
    const after = lstatBig(fsImpl, resolved);
    if (after.isSymbolicLink() || !after.isFile() || identityOf(after) !== identity) {
      throw new CliError(codes.replaced, `The ${label} target changed while it was written; inspect the target manually.`, {
        file: resolved,
        residual: true,
      }, 1);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(codes.replaced, `The ${label} target could not be verified after writing; inspect the target manually.`, {
      file: resolved,
      residual: true,
    }, 1);
  }

  return { path: resolved, bytes: buffer.length, created };
}

export async function runConfigExport({
  apiBase,
  fetchImpl,
  options,
  positionals,
  token,
  json = false,
  stdout = process.stdout,
  stderr = process.stderr,
  confirm = confirmAction,
  stdin,
  fsImpl = fs,
}) {
  if (positionals.length !== 0) throw new CliError('INVALID_ARGUMENT', 'config export takes no positional arguments.', {}, 1);
  const layer = options['--layer'] ?? 'instance';
  if (layer !== 'instance') {
    throw new CliError('INVALID_ARGUMENT', 'Only the instance layer can be exported (--layer instance).', {}, 1);
  }
  const includeSecrets = options['--include-secrets'] === true;
  const outPath = options['--out'];
  if (outPath !== undefined && String(outPath).trim() === '') {
    throw new CliError('INVALID_ARGUMENT', '--out requires a file path.', {}, 1);
  }
  if (includeSecrets) {
    stderr.write('Warning: this export contains secrets. Terminal scrollback, tool logs, backups and other local users may read them.\n');
  }

  const response = await requestText(
    `/api/v1/config/export?layer=${encodeURIComponent(layer)}&includeSecrets=${includeSecrets}`,
    { apiBase, fetchImpl, token, maxBytes: MAX_EXPORT_BYTES },
  );
  if (response.text.length === 0) {
    throw new CliError('CP_RESPONSE_INVALID', 'CP returned an empty configuration export.', {}, 1);
  }

  if (outPath !== undefined) {
    const file = await writeExportFile({
      filePath: outPath,
      content: response.text,
      force: options['--force'] === true,
      confirm,
      fsImpl,
      stdin,
      stderr,
    });
    if (!json) {
      stdout.write(`Exported configuration to ${file.path} (${file.bytes} bytes, includeSecrets=${includeSecrets}).\n`);
    }
    return {
      mode: 'file',
      layer,
      includeSecrets,
      file,
      contentType: response.contentType,
      cacheControl: response.cacheControl,
    };
  }

  return {
    mode: 'stdout',
    layer,
    includeSecrets,
    content: response.text,
    contentType: response.contentType,
    cacheControl: response.cacheControl,
  };
}
