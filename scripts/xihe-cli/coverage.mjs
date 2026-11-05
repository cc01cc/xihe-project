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
const testSource = fs.readFileSync(path.join(root, 'scripts/xihe-cli.test.mjs'), 'utf8');

// spec/cli-contract.md §1: the 16 pre-existing groups (denominator A).
const EXISTING_GROUPS = [
    'provider', 'credential', 'agent', 'session', 'chat', 'skill', 'workspace', 'job',
    'checkpoint', 'scheduled-task', 'audit', 'status', 'dev', 'config', 'verify', 'test',
];
// PLAN-0643 M1 delivered these two groups (verify V1 `groups.added >= 2`).
const ADDED_GROUPS = ['auth', 'api'];
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
const groups = new Set();
const dispatchCommands = new Set();
let currentGroup = null;
for (const line of cliSource.split('\n')) {
    const groupHit = line.match(/if \(group === '([\w-]+)'/);
    const commandHit = line.match(/(?:else )?if \(command === '([\w-]+)'/);
    if (groupHit) {
        groups.add(groupHit[1]);
        currentGroup = groupHit[1];
        if (commandHit) dispatchCommands.add(`${groupHit[1]} ${commandHit[1]}`);
    } else if (commandHit && currentGroup) {
        dispatchCommands.add(`${currentGroup} ${commandHit[1]}`);
    }
    if (/^ {4}\}/.test(line)) currentGroup = null;
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
const added = ADDED_GROUPS.map((group) => ({ group, present: groupPresent(group) }));
const matrix = MATRIX.map((name) => {
    const row = commands.find((command) => command.name === name);
    return { command: name, present: row.present, tested: row.tested };
});
const uncovered = commands.filter((command) => !command.present || !command.tested);

const report = {
    commands,
    groups: {
        existing: { total: existing.length, present: existing.filter((row) => row.present).length, missing: existing.filter((row) => !row.present).map((row) => row.group) },
        added: { total: added.length, present: added.filter((row) => row.present).length, names: added.map((row) => row.group) },
        total: existing.length + added.length,
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
            ` | added ${box.added.present}/${box.added.total}\n` +
            `matrix: ${matrixBox.covered}/${matrixBox.total} covered\n` +
            `commands: ${summary.present}/${summary.commands} present, ${summary.tested}/${summary.commands} tested\n`,
    );
    if (uncovered.length) process.stdout.write(`uncovered: ${uncovered.map((c) => c.name).join(', ')}\n`);
}
process.exit(strict && uncovered.length ? 1 : 0);
