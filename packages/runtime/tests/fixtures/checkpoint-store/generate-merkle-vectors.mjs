#!/usr/bin/env node
// Regenerate merkle-vectors.json for PLAN-0653 checkpoint store v1.
//
// Usage (Node 24+; no dependencies):
//   node tests/fixtures/checkpoint-store/generate-merkle-vectors.mjs
//
// Formula is the frozen one from src/checkpoint_store/FORMAT.md §4:
//   leaf     = SHA-256(0x00 || path || 0x00 || mode || 0x00 || decimal(size) || 0x00 || blob_hash_hex)
//   internal = SHA-256(0x01 || left32 || right32)
//   odd node promoted; empty root = 64 zero chars.
// This script is intentionally independent of the Rust implementation so a
// wrong leaf/root implementation cannot make its own tests pass.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sha = (data) => createHash('sha256').update(data).digest();
const hex = (buffer) => buffer.toString('hex');
const blobHash = (content) => hex(sha(Buffer.from(content)));

const blob = (content) => ({
  hash: blobHash(content),
});

const leaf = (entry) =>
  sha(
    Buffer.concat([
      Buffer.from([0]),
      Buffer.from(entry.path),
      Buffer.from([0]),
      Buffer.from(entry.mode),
      Buffer.from([0]),
      Buffer.from(String(entry.size)),
      Buffer.from([0]),
      Buffer.from(entry.blob_hash),
    ]),
  );

function merkleRoot(entries) {
  if (entries.length === 0) return '0'.repeat(64);
  let level = entries.map(leaf);
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) {
        next.push(level[i]);
      } else {
        next.push(sha(Buffer.concat([Buffer.from([1]), level[i], level[i + 1]])));
      }
    }
    level = next;
  }
  return hex(level[0]);
}

const a = blob('a');
const bb = blob('bb');
const vectors = [
  {
    name: 'empty',
    entries: [],
    merkle_root: merkleRoot([]),
  },
  {
    name: 'single',
    entries: [{ path: 'a.txt', mode: '100644', size: 1, blob_hash: a.hash }],
    merkle_root: merkleRoot([
      { path: 'a.txt', mode: '100644', size: 1, blob_hash: a.hash },
    ]),
  },
  {
    name: 'pair',
    entries: [
      { path: 'a.txt', mode: '100644', size: 1, blob_hash: a.hash },
      { path: 'b.txt', mode: '100755', size: 2, blob_hash: bb.hash },
    ],
    merkle_root: merkleRoot([
      { path: 'a.txt', mode: '100644', size: 1, blob_hash: a.hash },
      { path: 'b.txt', mode: '100755', size: 2, blob_hash: bb.hash },
    ]),
  },
];

const fixture = {
  source: 'packages/runtime/src/checkpoint_store/FORMAT.md §4 (PLAN-0653 T0.2/T1.4)',
  generated_by:
    'tests/fixtures/checkpoint-store/generate-merkle-vectors.mjs (Node 24 crypto), independent of the Rust implementation: leaf = SHA-256(0x00 || path_utf8 || 0x00 || mode_ascii || 0x00 || decimal_size_ascii || 0x00 || blob_hash_hex); internal = SHA-256(0x01 || left32 || right32); odd nodes promoted; empty root = 64 zero chars',
  vectors,
};

writeFileSync(join(here, 'merkle-vectors.json'), `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${join(here, 'merkle-vectors.json')}`);
