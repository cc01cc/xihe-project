#!/usr/bin/env node
// L2 Phase 3 (PLAN-0630-era efficiency line): static Spring-context census for the control-plane
// test suite.
//
// WHY static: the authoritative count of Spring context *creations* needs a full run (that is
// context-census-dynamic.mjs). This script answers the question that has to be answered BEFORE any
// run: which annotations split the suite into N contexts, and which attribute is responsible at each
// split. It reads test sources only - no Maven, no container, no production change.
//
// MODEL (Spring Framework, test context cache):
//   MergedContextConfiguration key = f(locations, classes, contextInitializers, activeProfiles,
//     propertySourceProperties, contextCustomizers, parent)
//   - @SpringBootTest(...)            -> ContextCustomizer (webEnvironment/args/properties/classes)
//   - @DynamicPropertySource          -> DynamicPropertiesContextCustomizer keyed by the DECLARING
//                                        CLASS, so every class with its own method splits the cache
//   - @MockitoBean/@MockBean/@SpyBean -> MockitoContextCustomizer (set of mocked types)
//   - @TestPropertySource/@ActiveProfiles -> part of the key directly
//   - @Import/@TestConfiguration      -> extra `classes` in the key
//   - @DirtiesContext                 -> does NOT change the key; it closes the context, so the NEXT
//                                        class with the same key pays a fresh startup again.
// Hence: distinct keys = floor(context count); dirties add re-creations on top.
//
// USAGE node scripts/l2/context-census.mjs [--root <dir>] [--json]

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const rootIndex = args.indexOf('--root');
const ROOT = resolve(rootIndex >= 0 ? args[rootIndex + 1] : 'packages/control-plane/src/test/java');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith('.java')) {
      out.push(full);
    }
  }
  return out;
}

/** Strip block and line comments; keeps string literals (they carry annotation properties). */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:"'\\])\/\/[^\n]*/g, (match, lead) => lead);
}

/** Balanced-paren argument text of `@Name(...)` starting at `from`; null when there is no paren. */
function annotationArgs(text, at) {
  const open = text.indexOf('(', at);
  if (open < 0 || open - at > 64) {
    return '';
  }
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
}

function collectArgs(text, name) {
  const found = [];
  const needle = `@${name}`;
  let index = text.indexOf(needle);
  while (index >= 0) {
    // ignore @XxxMapping-ish false hits: next char must not be a word char
    const after = text[index + needle.length];
    if (after === undefined || !/[\w]/.test(after)) {
      found.push(normaliseArgs(annotationArgs(text, index + needle.length)));
    }
    index = text.indexOf(needle, index + needle.length);
  }
  return found;
}

function normaliseArgs(raw) {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/\s*=\s*/g, '=')
    .trim();
}

function sortedList(values) {
  return [...values].sort().join('|');
}

function mockedTypes(text) {
  const types = [];
  for (const name of ['MockitoBean', 'MockitoSpyBean', 'MockBean', 'SpyBean']) {
    const pattern = new RegExp(`@${name}\\b[^;\\n]*?\\b(?:private|protected|public)?\\s*([\\w.]+)\\s+\\w+`, 'g');
    for (const match of text.matchAll(pattern)) {
      types.push(match[1]);
    }
  }
  return types.sort();
}

function classInfo(file) {
  const raw = readFileSync(file, 'utf8');
  const text = stripComments(raw);
  const decl = /(?:^|\n)\s*(?:public\s+|final\s+|abstract\s+)*(?:class|record)\s+(\w+)(?:<[^>]*>)?(?:\s+extends\s+([\w.]+))?/.exec(text);
  const dirties = [];
  for (const match of text.matchAll(/@DirtiesContext\b[^;)*]*/g)) {
    dirties.push(normaliseArgs(match[0].replace(/^@DirtiesContext/, '')));
  }
  return {
    file,
    name: decl ? decl[1] : file.replace(/.*[\\/]/, '').replace(/\.java$/, ''),
    extendsName: decl && decl[2] ? decl[2].replace(/<.*$/, '') : null,
    springBootTests: collectArgs(text, 'SpringBootTest'),
    testPropertySources: collectArgs(text, 'TestPropertySource'),
    activeProfiles: collectArgs(text, 'ActiveProfiles'),
    imports: collectArgs(text, 'Import'),
    testConfigurations: (text.match(/@TestConfiguration\b/g) || []).length,
    // Spring keys DynamicPropertiesContextCustomizer by the DECLARING class, so a per-class
    // @DynamicPropertySource is a per-class cache key - a boolean would hide exactly the biggest
    // splitter in this suite (32 classes declare their own).
    dynamicDeclarer: text.includes('@DynamicPropertySource') ? null : undefined,
    mocks: mockedTypes(text),
    dirties,
  };
}

const files = walk(ROOT);
const byName = new Map();
const infos = files.map((file) => {
  const info = classInfo(file);
  byName.set(info.name, info);
  return info;
});

// Inheritance: a subclass that declares nothing still shares its base's cache key.
function resolveInherited(info, seen = new Set()) {
  if (!info.extendsName || seen.has(info.name)) {
    return info;
  }
  const base = byName.get(info.extendsName);
  if (!base) {
    return info;
  }
  seen.add(info.name);
  const resolvedBase = resolveInherited(base, seen);
  return {
    ...info,
    springBootTests: info.springBootTests.length ? info.springBootTests : resolvedBase.springBootTests,
    testPropertySources: info.testPropertySources.length ? info.testPropertySources : resolvedBase.testPropertySources,
    activeProfiles: info.activeProfiles.length ? info.activeProfiles : resolvedBase.activeProfiles,
    imports: info.imports.length ? info.imports : resolvedBase.imports,
    // Declared here -> this class owns the key; otherwise inherit the base's declarer name so every
    // sibling that shares the base's dynamic source also shares its cache key.
    dynamicDeclarer: info.dynamicDeclarer === null ? info.name : resolvedBase.dynamicDeclarer,
  };
}

const resolved = infos.map((info) => resolveInherited(info));

function contextKey(info) {
  return JSON.stringify({
    boot: sortedList(info.springBootTests),
    props: sortedList(info.testPropertySources),
    profiles: sortedList(info.activeProfiles),
    imports: sortedList(info.imports),
    testConfigs: info.testConfigurations,
    dynamic: info.dynamicDeclarer ?? null,
    mocks: sortedList(info.mocks),
  });
}

const clusters = new Map();
for (const info of resolved) {
  const key = contextKey(info);
  if (!clusters.has(key)) {
    clusters.set(key, []);
  }
  clusters.get(key).push(info);
}

const ordered = [...clusters.entries()]
  .map(([key, members]) => ({ key, members, parsed: JSON.parse(key) }))
  .sort((a, b) => b.members.length - a.members.length);

// Which single attribute separates each cluster from its nearest neighbour (the "真凶" ranking).
const splitCauses = new Map();
const ATTRIBUTES = ['boot', 'props', 'profiles', 'imports', 'testConfigs', 'dynamic', 'mocks'];
for (let i = 0; i < ordered.length; i++) {
  let nearest = null;
  for (let j = 0; j < ordered.length; j++) {
    if (i === j) continue;
    const differing = ATTRIBUTES.filter((attribute) => ordered[i].parsed[attribute] !== ordered[j].parsed[attribute]);
    if (nearest === null || differing.length < nearest.differing.length) {
      nearest = { differing, other: ordered[j] };
    }
  }
  if (nearest && nearest.differing.length === 1) {
    const attribute = nearest.differing[0];
    const entry = splitCauses.get(attribute) ?? { clusters: 0 };
    entry.clusters += 1;
    splitCauses.set(attribute, entry);
  }
}

const dirtyClasses = resolved.filter((info) => info.dirties.length > 0);
const dirtiesCreatesExtra = dirtyClasses.reduce((sum, info) => {
  const high = info.dirties.some((args) => args.includes('BEFORE_EACH_TEST_METHOD'));
  return sum + (high ? 2 : 1); // class-level close costs at least one extra startup downstream
}, 0);

const report = {
  root: relative(process.cwd(), ROOT).replace(/\\/g, '/'),
  testFiles: infos.length,
  classesWithSpringBootTest: resolved.filter((info) => info.springBootTests.length > 0).length,
  distinctContextKeys: ordered.length,
  predictedCreations: ordered.length + dirtiesCreatesExtra,
  dirtiesClasses: dirtyClasses.map((info) => ({
    name: info.name,
    args: info.dirties,
    contextKeyShare: clusters.get(contextKey(info)).length,
  })),
  dirtiesExtraCreations: dirtiesCreatesExtra,
  splitCauses: [...splitCauses.entries()].map(([attribute, value]) => ({ attribute, ...value })),
  clusters: ordered.map((cluster, index) => ({
    rank: index + 1,
    size: cluster.members.length,
    key: cluster.parsed,
    sample: cluster.members.slice(0, 4).map((info) => info.name),
  })),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

console.log(`# Spring context census (static) - ${report.root}`);
console.log('');
console.log(`test files ................. ${report.testFiles}`);
console.log(`classes w/ @SpringBootTest . ${report.classesWithSpringBootTest}`);
console.log(`distinct cache keys ........ ${report.distinctContextKeys}   <-- floor for context count`);
console.log(`@DirtiesContext classes .... ${report.dirtiesClasses.length} (>= ${report.dirtiesExtraCreations} extra creations)`);
console.log(`predicted creations ........ ${report.predictedCreations}`);
console.log('');
console.log('## Clusters (rank, size, distinguishing key)');
console.log('');
console.log('| # | classes | webEnvironment / boot | profiles | dynamic | mocks | props | imports | sample |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const cluster of report.clusters) {
  const k = cluster.key;
  const boot = k.boot.replace(/"/g, "'").slice(0, 46) || '-';
  console.log(`| ${cluster.rank} | ${cluster.size} | ${boot} | ${k.profiles || '-'} | ${k.dynamic} | `
    + `${k.mocks || '-'} | ${(k.props || '-').slice(0, 28)} | ${(k.imports || '-').slice(0, 20)} | ${cluster.sample[0]} |`);
}
console.log('');
console.log('## Single-attribute splits (the "真凶" ranking)');
console.log('');
if (!report.splitCauses.length) {
  console.log('none');
} else {
  console.log('| attribute | clusters split by it alone |');
  console.log('|---|---|');
  for (const cause of report.splitCauses.sort((a, b) => b.clusters - a.clusters)) {
    console.log(`| ${cause.attribute} | ${cause.clusters} |`);
  }
}
console.log('');
console.log('## @DirtiesContext inventory (each needs a justification)');
console.log('');
console.log('| class | annotation | shares key with N classes |');
console.log('|---|---|---|');
for (const info of report.dirtiesClasses) {
  console.log(`| ${info.name} | ${info.args.join(' ') || '(bare)'} | ${info.contextKeyShare} |`);
}
