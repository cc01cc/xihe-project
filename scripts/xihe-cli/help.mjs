// PLAN-0643 T4.7 (design D9) — the single source of truth for `xihe --help`.
//
// The CLI used to carry one 57-line `helpText()` string array in `xihe.mjs` and answer
// **every** `--help` with the whole list, so `xihe provider --help` printed 57 unrelated
// lines (review round-3 F7: the early return fired before dispatch). The registry below
// groups commands by their dispatch group:
//
//   * bare `--help` (or `xihe help`)        -> every group, alphabetical, with summaries
//   * `<group> --help` / `xihe help <group>` -> only that group's commands
//   * unknown group                          -> null, the caller raises INVALID_ARGUMENT (exit 2)
//
// `--json` keeps the pre-T4.7 envelope: `{ ok: true, data: { help: '<text>' } }`.
// `coverage.mjs` imports `HELP_GROUPS` instead of regex-slicing a function body, so the
// registry stays the one place a command's usage line can live.

export const HELP_CLI_PREFIX = 'node scripts/xihe.mjs';

/**
 * One command row: `<group> <command>` plus its argument tail and a one-line summary.
 * `args === ''` covers single-command groups (`status`, `models`, `api`, …).
 */
const cmd = (name, args, summary) =>
  Object.freeze({ name, usage: args === '' ? name : `${name} ${args}`, summary });

export const HELP_GROUPS = Object.freeze([
  {
    name: 'agent',
    summary: 'Agent principals and their workspace bindings',
    commands: Object.freeze([
      cmd('agent bind', '--principal <p> --workspace <wsId>', 'Bind an agent principal to a workspace'),
      cmd('agent create', '--scope personal|workspace|instance --name <n> [--template <t>] [--default-model <p>:<m>] [--allow-model <p>:<m> ...]', 'Create an agent principal'),
      cmd('agent disable', '--principal <p>', 'Disable an agent principal'),
      cmd('agent list', '[--workspace <wsId>] [--scope <scope>]', 'List agent principals'),
      cmd('agent unbind', '--principal <p> --workspace <wsId>', 'Remove a workspace binding'),
    ]),
  },
  {
    name: 'api',
    summary: 'Raw /api/v1 request escape hatch (guarded)',
    commands: Object.freeze([
      cmd('api', '[METHOD] <path> [--yes] [--allow-dangerous] [--body-file <file> | --stdin] [--raw] [--timeout <ms>] [--max-bytes <bytes>]', 'Forward one guarded request to the control plane'),
    ]),
  },
  {
    name: 'api-input-types',
    summary: 'Read the CP api-input-types catalog',
    commands: Object.freeze([
      cmd('api-input-types list', '', 'List the CP api-input-types catalog'),
    ]),
  },
  {
    name: 'audit',
    summary: 'Audit log reads',
    commands: Object.freeze([
      cmd('audit list', '[--type <type>] [--page <n>] [--size <n>]', 'List audit log entries'),
    ]),
  },
  {
    name: 'auth',
    summary: 'CLI authentication against the control plane',
    commands: Object.freeze([
      cmd('auth login', '[--email <account>] [--force] [--no-cache]', 'Log in and cache the CLI token'),
      cmd('auth logout', '[--force]', 'Drop the cached CLI token'),
      cmd('auth status', '', 'Show the cached token state'),
    ]),
  },
  {
    name: 'chat',
    summary: 'Chat messages, runs and approvals',
    commands: Object.freeze([
      cmd('chat approvals', '', 'List pending approvals'),
      cmd('chat approve|reject', '<requestId> [--feedback <text>]', 'Approve or reject a pending request'),
      cmd('chat cancel', '<runId> [--reason <text>]', 'Cancel a chat run (idempotent while it is still cancelling)'),
      cmd('chat run', '<runId> [--attempts] [--trace]', 'Inspect a chat run with attempts or trace'),
      cmd('chat send', '--session <sessionId> --branch <branchId> --content <text> [--as <participantId>] [--idempotency-key <key>]', 'Send a chat message'),
    ]),
  },
  {
    name: 'checkpoint',
    summary: 'Workspace checkpoint reads and revert previews',
    commands: Object.freeze([
      cmd('checkpoint list', '<wsId>', 'List workspace checkpoints'),
      cmd('checkpoint preview-revert', '<wsId> <sliceRef>', 'Preview a checkpoint revert'),
    ]),
  },
  {
    name: 'config',
    summary: 'Configuration reads and writes across layers',
    commands: Object.freeze([
      cmd('config export', '[--layer instance] [--include-secrets] [--out <file>] [--force]', 'Export a configuration layer'),
      cmd('config get', '<domain> [--layer instance|user|workspace] [--include-meta] [--workspace <wsId>]', 'Read configuration entries'),
      cmd('config import', '[file]', 'Import configuration from a file'),
      cmd('config meta', '<domain> [--layer instance|user|workspace] [--workspace <wsId>]', 'Show configuration metadata'),
      cmd('config put', '<domain> --layer user|workspace --file <entries.json> [--workspace <wsId>]', 'Write layered configuration entries'),
      cmd('config set', '<domain> <key> <value> --layer instance', 'Set one instance-layer key'),
      cmd('config unset', '<domain> <key>', 'Remove one instance-layer key'),
    ]),
  },
  {
    name: 'config-locks',
    summary: 'Configuration lock administration',
    commands: Object.freeze([
      cmd('config-locks delete', '<domain> <key> [--revision <n>] [--clear-value]', 'Delete one configuration lock'),
      cmd('config-locks list', '[<domain>]', 'List configuration locks'),
      cmd('config-locks set', '<domain> <key> --reason <text> [--value <v>] [--revision <n>]', 'Create or update one configuration lock'),
    ]),
  },
  {
    name: 'credential',
    summary: 'Credential lifecycle and reveal',
    commands: Object.freeze([
      cmd('credential bind', '<id> --workspace <wsId> --agent <principalId[,principalId...]>', 'Bind a credential to agents'),
      cmd('credential create', '--kind token|key_pair --owner-type <USER|WORKSPACE> --owner-id <id> --label <label> [--delivery-tier <tier>] (--secret-env <NAME> | --access-key-env <NAME> --secret-key-env <NAME>)', 'Create a credential'),
      cmd('credential delete', '<id> --workspace <wsId> [--yes]', 'Delete a credential'),
      cmd('credential events', '<id> --workspace <wsId>', 'List credential events'),
      cmd('credential list', '[--owner-type USER|WORKSPACE --owner-id <id>]', 'List credentials'),
      cmd('credential precheck', '--permissions <atom[,atom...]>', 'Check a permission set against the CP'),
      cmd('credential references', '<id> --workspace <wsId>', 'List credential references'),
      cmd('credential replace', '<id> --kind token|key_pair --workspace <wsId> (--secret-env <NAME> | --access-key-env <NAME> --secret-key-env <NAME>)', 'Replace a credential secret'),
      cmd('credential reveal', '<id> --workspace <wsId> (--password-env <NAME> | TTY) [--out <file> [--force]]', 'Reveal a credential on explicit request'),
      cmd('credential rotate', '[--batch-size <n>] [--max-batches <n>] [--dry-run]', 'Rotate credentials in batches'),
      cmd('credential unbind', '<id> --workspace <wsId> --agent <principalId[,principalId...]>', 'Remove credential agent bindings'),
    ]),
  },
  {
    name: 'dev',
    summary: 'Developer environment checks and bootstrap',
    commands: Object.freeze([
      cmd('dev check', '[--json]', 'Check the developer environment'),
      cmd('dev init', '--provider <id> --scope <USER|WORKSPACE> --label <label> [--models <id,id>] [--api-key-env <name>]', 'Bootstrap a provider connection'),
    ]),
  },
  {
    name: 'events',
    summary: 'Server-sent event tailing',
    commands: Object.freeze([
      cmd('events tail', '<sessionId> [--follow] [--timeout <seconds>] [--since <id>]', 'Tail one session event stream'),
    ]),
  },
  {
    name: 'job',
    summary: 'Workspace job reads and cancellation',
    commands: Object.freeze([
      cmd('job cancel', '<wsId> <jobId>', 'Cancel a workspace job'),
      cmd('job list', '<wsId>', 'List workspace jobs'),
      cmd('job output', '<wsId> <jobId> [--stream stdout|stderr] [--offset <n>] [--limit <n>]', 'Read one job output stream'),
    ]),
  },
  {
    name: 'me',
    summary: 'Current principal information',
    commands: Object.freeze([
      cmd('me permissions', '', 'List the current principal permissions'),
    ]),
  },
  {
    name: 'models',
    summary: 'Model catalog reads',
    commands: Object.freeze([
      cmd('models', '', 'List the models available to the current principal'),
    ]),
  },
  {
    name: 'provider',
    summary: 'Provider connections and rate limits',
    commands: Object.freeze([
      cmd('provider add', '<id> --scope <USER|WORKSPACE> --label <label> [--models <id,id>] [--api-key-env <name>]', 'Add a provider connection'),
      cmd('provider catalog', '', 'List non-secret provider definitions'),
      cmd('provider delete', '<id> [--yes]', 'Delete a provider connection'),
      cmd('provider limit set', '--connection <c> [--max-inflight N] [--max-queue N] [--tokens N --window S] [--model <p>:<m> --max-inflight N ...]', 'Set connection rate limits'),
      cmd('provider limit show', '--connection <c>', 'Show connection rate limits'),
      cmd('provider list', '[--scope <USER|WORKSPACE>]', 'List provider connections'),
      cmd('provider update', '<id> [--label <label>] [--base-url <url>] [--models <id,id>] [--api-key-env <name>]', 'Update a provider connection'),
      cmd('provider verify', '<id>', 'Verify a provider connection'),
    ]),
  },
  {
    name: 'scheduled-task',
    summary: 'Workspace scheduled tasks',
    commands: Object.freeze([
      cmd('scheduled-task create', '<wsId> --kind delay_once|cron --target session_wakeup|job_dispatch (--cron-expr <5fields> | --at <iso> [--timezone <tz>]) (--session <id> --prompt <text> | --payload-file <json>)', 'Create a scheduled task'),
      cmd('scheduled-task delete', '<wsId> <taskId> [--yes]', 'Cancel a scheduled task (scheduled -> cancelled)'),
      cmd('scheduled-task list', '<wsId> [--page <n>] [--size <n>]', 'List scheduled tasks'),
      cmd('scheduled-task postpone', '<wsId> <taskId> --at <iso>', 'Move a scheduled task'),
      cmd('scheduled-task remove', '<wsId> <taskId> [--yes]', 'Cancel a missed or expired task'),
      cmd('scheduled-task rerun', '<wsId> <taskId>', 'Rerun a missed or expired task'),
    ]),
  },
  {
    name: 'session',
    summary: 'Sessions and participants',
    commands: Object.freeze([
      cmd('session export', '<sessionId> --branch <branchId>', 'Export a session branch as Markdown'),
      cmd('session get', '<sessionId>', 'Show one session'),
      cmd('session list', '[--workspace <wsId>]', 'List sessions'),
      cmd('session participants add', '--session <sessionId> --principal <principalId> --kind AGENT|HUMAN [--role MEMBER|GUARD] [--wake ALL_MESSAGES|MENTION] [--respond ALWAYS|WHEN_MENTIONED|JUDGE|MUTED]', 'Add a session participant'),
      cmd('session participants list', '--session <sessionId> [--workspace <wsId>]', 'List session participants'),
      cmd('session participants policy', '--session <sessionId> --participant <participantId> [--wake MENTION|ALL_MESSAGES|SCHEDULE [--interval <seconds> [--jitter <seconds>] [--max-concurrent <n>]]] [--respond ALWAYS|WHEN_MENTIONED|JUDGE|MUTED]', 'Update participant wake/respond policy'),
      cmd('session participants remove', '--session <sessionId> --participant <participantId>', 'Disable a participant (soft disable: rows, cursors and audit are kept)'),
    ]),
  },
  {
    name: 'skill',
    summary: 'Skill catalog and bindings',
    commands: Object.freeze([
      cmd('skill bind', '--skill <id> --subject <user|agent_principal> --subject-id <id> [--scope instance|workspace --workspace <wsId>]', 'Bind a skill to a subject'),
      cmd('skill delete', '<skillId> [--yes]', 'Delete a skill'),
      cmd('skill import', '--file <request.json>', 'Import a skill from a request file'),
      cmd('skill list', '[--scope instance|workspace] [--workspace <wsId>]', 'List skills'),
      cmd('skill show', '<skillId> [--include-body]', 'Show one skill'),
      cmd('skill unbind', '<bindingId> [--yes]', 'Remove a skill binding'),
    ]),
  },
  {
    name: 'status',
    summary: 'Stack status summary',
    commands: Object.freeze([
      cmd('status', '', 'Collect CP, agent, runtime and PostgreSQL status'),
    ]),
  },
  {
    name: 'test',
    summary: 'Real-path E2E test runner',
    commands: Object.freeze([
      cmd('test real', '<e2e/real/spec.spec.ts> [--route <native|openai-compat>]', 'Run one real-path E2E spec'),
    ]),
  },
  {
    name: 'verify',
    summary: 'Smoke verification against a stack',
    commands: Object.freeze([
      cmd('verify', '--stack <n> --email <account> --workspace <wsId> [--wait-seconds <n>] [--yes]', 'Verify a stack end to end'),
    ]),
  },
  {
    name: 'version',
    summary: 'CLI and stack version information',
    commands: Object.freeze([
      cmd('version', '[--check]', 'Show CLI and stack versions'),
    ]),
  },
  {
    name: 'workspace',
    summary: 'Workspaces, members and roots',
    commands: Object.freeze([
      cmd('workspace create', '--name <n> --storage-mode direct_attach (--host-path <dir> | --roots <dir,...>) [--execution-mode <m>] [--idempotency-key <k>]', 'Create a direct_attach workspace'),
      cmd('workspace delete', '<wsId> [--yes]', 'Delete a workspace'),
      cmd('workspace get', '<wsId>', 'Show one workspace'),
      cmd('workspace list', '', 'List workspaces'),
      cmd('workspace members', '<wsId> [--add <user> --role EDITOR|VIEWER | --set-role <userId> --role EDITOR|VIEWER | --remove <userId>] [--yes]', 'Manage workspace members'),
      cmd('workspace roots', '<wsId> (--add <path> [--alias <a>] | --rename <rootId> --alias <a> | --reposition <rootId> --position <n> | --remove <rootId>) [--yes]', 'Manage workspace roots'),
    ]),
  },
]);

const HEADER_LINES = Object.freeze([
  'XH development and operations CLI',
  '',
  'Usage:',
  `  ${HELP_CLI_PREFIX} <group> [<command>] [options]`,
  `  ${HELP_CLI_PREFIX} <group> --help        only that group's commands`,
  `  ${HELP_CLI_PREFIX} --help                every group`,
  '  mise run xihe -- provider list [--scope <USER|WORKSPACE>]',
]);

const GLOBAL_LINES = Object.freeze([
  'Global options: --json (machine envelope), --base-url <url>, --workspace <wsId>, --help.',
  'Exit codes: 0 = success; 1 = business/runtime failure; 2 = usage error (unknown command/option, missing argument, forbidden api target).',
  'Set XIHE_CLI_LEGACY_EXIT_CODES=1 to restore the pre-0643 codes for one batch.',
]);

// Group help keeps only the global lines: the notes below name commands from other
// groups (`credential rotate`, `verify`, …), which would leak across `<group> --help`.
const FULL_ONLY_LINES = Object.freeze([
  'xihe api only forwards /api/v1/**; /api/v1/mcp and --include-secrets need --allow-dangerous;',
  'mutating methods need --yes; request bodies come from stdin or --body-file (never argv).',
  '',
  'Secrets are read from environment variables or a no-echo TTY prompt; never pass secret values as arguments.',
  'credential rotate authenticates with XIHE_CP_API_TOKEN (CP service Bearer) and never prints credential values.',
  'credential create/replace/reveal read secrets only from --*-env <NAME> or a no-echo TTY prompt; reveal prints plaintext only on explicit request (stdout or --out file).',
  'verify writes a principal/session/chat run into the target stack and calls the model provider; use an isolated stack and workspace.',
  'Real E2E uses XIHE_E2E_REAL_XIAOMI_KEY and does not test Provider Connection leases.',
]);

const renderGroup = (group) =>
  group.commands.map((command) => `  ${HELP_CLI_PREFIX} ${command.usage}  # ${command.summary}`);

/** Group names in display order (alphabetical), used by tests and the coverage report. */
export function groupNames() {
  return HELP_GROUPS.map((group) => group.name);
}

/** The registry entry for one group, or null when the name is unknown. */
export function findGroup(name) {
  const wanted = typeof name === 'string' ? name.trim() : '';
  if (wanted === '') return null;
  return HELP_GROUPS.find((group) => group.name === wanted) ?? null;
}

/** Full help: every group, in alphabetical order, plus the global and full-only notes. */
export function helpText() {
  const lines = [...HEADER_LINES, '', 'Commands by group:'];
  for (const group of HELP_GROUPS) {
    lines.push('', `${group.name} — ${group.summary}`, ...renderGroup(group));
  }
  lines.push('', ...GLOBAL_LINES, ...FULL_ONLY_LINES);
  return lines.join('\n');
}

/** One group's help, or null when the group is unknown (the caller turns that into exit 2). */
export function groupHelpText(name) {
  const group = findGroup(name);
  if (group === null) return null;
  return [
    HEADER_LINES[0],
    '',
    `${group.name} — ${group.summary}`,
    ...renderGroup(group),
    '',
    ...GLOBAL_LINES,
  ].join('\n');
}
