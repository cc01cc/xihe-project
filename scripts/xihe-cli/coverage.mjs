#!/usr/bin/env node
// PLAN-0643 T5.5 — command/test coverage report for the XH CLI.
//
// Sources of truth:
//   * command registry: `scripts/xihe.mjs` dispatch (`group === '…'` / `command === '…'` blocks)
//     plus the usage lines in `helpText()` (the only evidence for 3-level commands such as
//     `session participants list`).
//   * contract snapshot: `plans/PLAN-0643-…/spec/cli-contract.md` §1 (16 existing groups +
//     auth/api) and §2 (the "本期" command column). The snapshot is frozen here on purpose: the
//     contract lives in the workspace `plans/` tree, outside this repository, so the gate must
//     stay dependency-free and reproducible inside A03-xihe.
//   * test evidence: top-level `test('…')` blocks in `scripts/xihe-cli.test.mjs`.
//
// Usage:
//   node scripts/xihe-cli/coverage.mjs           # human summary, exit 0
//   node scripts/xihe-cli/coverage.mjs --json    # JSON report
//   node scripts/xihe-cli/coverage.mjs --strict  # exit 1 when any command is absent/untested
//
// Zero dependencies, Node 24 (ESM). See PLAN-0643 verify V1/V2.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const cliSource = fs.readFileSync(path.join(root, 'scripts/xihe.mjs'), 'utf8');
// M6-2 moved the chat/session subcommand dispatch into its own module; its
// `command === '…'` branches are part of the registry and must be scanned too.
const chatSessionSource = fs.readFileSync(path.join(root, 'scripts/xihe-cli/chat-session.mjs'), 'utf8');
const testSource = fs.readFileSync(path.join(root, 'scripts/xihe-cli.test.mjs'), 'utf8');

// spec/cli-contract.md §1: the 16 pre-existing groups (denominator A).
const EXISTING_GROUPS = [
    'provider', 'credential', 'agent', 'session', 'chat', 'skill', 'workspace', 'job',
    'checkpoint', 'scheduled-task', 'audit', 'status', 'dev', 'config', 'verify', 'test',
];
// PLAN-0643 M1 delivered auth/api (verify V1 `groups.added >= 2`); M6-1 adds the
// config-locks admin group (T2.5); M6-3 adds me/models/api-input-types/events (T4.x).
const ADDED_GROUPS = ['auth', 'api', 'config-locks', 'me', 'models', 'api-input-types', 'events'];
// verify V2 (M6-3 re-judge): the `groups.added >= 12` list mixes NEW groups with
// EXISTING groups extended by this plan. Each extension is evidenced by one
// flagship command delivered for that group (the first of its kind on the group).
const EXTENDED_GROUPS = [
    { group: 'config', via: 'config put' },
    { group: 'chat', via: 'chat run' },
    { group: 'session', via: 'session export' },
    { group: 'provider', via: 'provider catalog' },
    { group: 'workspace', via: 'workspace create' },
    { group: 'scheduled-task', via: 'scheduled-task create' },
];
// spec/cli-contract.md §2 "本期" column: the command matrix (denominator B, >= 25).
const MATRIX = [
    'config get', 'config meta', 'config unset', 'config set', 'config put', 'config export',
    'config-locks list', 'config-locks set', 'config-locks delete',
    'chat run', 'chat cancel', 'chat approvals', 'chat approve', 'chat reject',
    'session list', 'session get', 'session export',
    'provider catalog', 'models', 'api-input-types', 'me permissions',
    'workspace create', 'workspace delete', 'workspace members', 'workspace roots',
    'scheduled-task create', 'scheduled-task delete', 'scheduled-task rerun',
    'scheduled-task remove', 'scheduled-task postpone',
    'events tail', 'api-input-types list', 'api',
];

// --- registry --------------------------------------------------------------------------------
// Walk the dispatch blocks by indentation: a group block opens at 4 spaces and closes at 4 spaces.
// A line may name several groups (`if (group === 'me' || group === 'models' …)`), so every
// occurrence is captured — the old single-match regex silently dropped the 2nd/3rd group.
const groups = new Set();
const dispatchCommands = new Set();
let currentGroup = null;
for (const line of cliSource.split('\n')) {
    const groupHits = [...line.matchAll(/group === '([\w-]+)'/g)];
    const commandHit = line.match(/(?:else )?if \(command === '([\w-]+)'/);
    if (groupHits.length > 0) {
        for (const hit of groupHits) groups.add(hit[1]);
        currentGroup = groupHits[0][1];
        if (commandHit) {
            for (const hit of groupHits) dispatchCommands.add(`${hit[1]} ${commandHit[1]}`);
        }
    } else if (commandHit && currentGroup) {
        dispatchCommands.add(`${currentGroup} ${commandHit[1]}`);
    }
    if (/^ {4}\}/.test(line)) currentGroup = null;
}
// chat-session.mjs dispatchers map to their groups by function name; each
// `command === 'x'` branch (all alternates captured) registers `<group> <cmd>`.
const DISPATCHER_GROUPS = { runChatCommand: 'chat', runSessionCommand: 'session' };
let moduleGroup = null;
for (const line of chatSessionSource.split('\n')) {
    const fnHit = line.match(/async function (runChatCommand|runSessionCommand)\b/);
    if (fnHit) {
        moduleGroup = DISPATCHER_GROUPS[fnHit[1]];
        continue;
    }
    if (moduleGroup) {
        for (const m of line.matchAll(/command === '([\w-]+)'/g)) {
            dispatchCommands.add(`${moduleGroup} ${m[1]}`);
        }
    }
    if (/^}/.test(line)) moduleGroup = null;
}
// 3-level commands only appear in helpText() usage lines (`xihe <g> <cmd> <sub>`).
const helpText = cliSource.slice(cliSource.indexOf('function helpText()'), cliSource.indexOf('export async function runCommand'));
const usageCommands = new Set();
for (const m of helpText.matchAll(/xihe(?:\.mjs)? ([a-z][\w-]*)(?: ([a-z][\w-]*))?/g)) {
    usageCommands.add(m[2] ? `${m[1]} ${m[2]}` : m[1]);
}

const groupPresent = (group) => groups.has(group);
const commandPresent = (name) =>
    name.includes(' ') ? dispatchCommands.has(name) || usageCommands.has(name) : groupPresent(name);

// --- test evidence ---------------------------------------------------------------------------
const marks = [...testSource.matchAll(/^test\('([^']+)'/gm)].map((m) => ({ name: m[1], index: m.index }));
const blocks = marks.map((mark, i) => ({
    name: mark.name,
    body: testSource.slice(mark.index, i + 1 < marks.length ? marks[i + 1].index : testSource.length),
}));

function commandsOf(block) {
    // A block may execute several commands; extract `['group', 'sub']` pairs from argv arrays.
    const found = new Set();
    for (const m of block.body.matchAll(/\[\s*'([\w-]+)'(?:\s*,\s*'([\w-]+)')?/g)) {
        found.add(m[2] ? `${m[1]} ${m[2]}` : m[1]);
    }
    return found;
}

// --- report ----------------------------------------------------------------------------------
const allNames = [...new Set([...EXISTING_GROUPS, ...ADDED_GROUPS, ...MATRIX])];
const commands = allNames.map((name) => {
    const [group] = name.split(' ');
    const lower = name.toLowerCase();
    const tests = blocks.filter((block) => {
        if (block.name.toLowerCase().includes(lower)) return true;
        return commandsOf(block).has(name) || (name.includes(' ') && commandsOf(block).has(name.split(' ')[0]));
    }).map((block) => block.name);
    return { name, group, present: commandPresent(name), tested: tests.length > 0, testNames: tests };
});

const existing = EXISTING_GROUPS.map((group) => ({ group, present: groupPresent(group) }));
// verify V2: `groups.added` counts new groups AND extended existing groups
// (12-item list: 6 new + 6 extended on task/0643).
const addedNew = ADDED_GROUPS.map((group) => ({ group, present: groupPresent(group), kind: 'new' }));
const addedExtended = EXTENDED_GROUPS.map(({ group, via }) => ({
    group, present: commandPresent(via), kind: 'extended', via,
}));
const added = [...addedNew, ...addedExtended];
const matrix = MATRIX.map((name) => {
    const row = commands.find((command) => command.name === name);
    return { command: name, present: row.present, tested: row.tested };
});
const uncovered = commands.filter((command) => !command.present || !command.tested);

const report = {
    commands,
    groups: {
        existing: { total: existing.length, present: existing.filter((row) => row.present).length, missing: existing.filter((row) => !row.present).map((row) => row.group) },
        added: {
            total: added.length,
            present: added.filter((row) => row.present).length,
            names: addedNew.map((row) => row.group),
            extensions: addedExtended,
        },
        total: existing.length + ADDED_GROUPS.length,
    },
    matrix: {
        total: matrix.length,
        covered: matrix.filter((row) => row.present).length,
        items: matrix,
    },
    summary: {
        commands: commands.length,
        present: commands.filter((command) => command.present).length,
        tested: commands.filter((command) => command.tested).length,
        untested: uncovered.map((command) => command.name),
    },
};

const strict = process.argv.includes('--strict');
if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
    const { groups: box, matrix: matrixBox, summary } = report;
    process.stdout.write(
        `groups: existing ${box.existing.present}/${box.existing.total}` +
            `${box.existing.missing.length ? ` missing=${box.existing.missing.join(',')}` : ''}` +
            ` | added ${box.added.present}/${box.added.total}` +
            ` (new ${addedNew.filter((row) => row.present).length}/${addedNew.length}` +
            ` + extended ${addedExtended.filter((row) => row.present).length}/${addedExtended.length})\n` +
            `matrix: ${matrixBox.covered}/${matrixBox.total} covered\n` +
            `commands: ${summary.present}/${summary.commands} present, ${summary.tested}/${summary.commands} tested\n`,
    );
    if (uncovered.length) process.stdout.write(`uncovered: ${uncovered.map((c) => c.name).join(', ')}\n`);
}
process.exit(strict && uncovered.length ? 1 : 0);
