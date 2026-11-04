/**
 * PLAN-0664 (BL-267): e2e-host CLI 三处易错的**纯判定**层。
 *
 * 为什么单独一个模块：`scripts/e2e-host.mjs` 是 2700 行的编排脚本，参数判定混在里面只能靠
 * "跑一遍看结果"验证；而这三条恰恰是"跑一遍已经晚了"的错误（一次真栈跑 10–25 分钟）。把判定
 * 抽成无 IO、无 `process.env` 读取的纯函数后，三条行为都能用 `node --test` 秒级钉住。
 *
 * 契约（与 `scripts/lib/e2e-rounds.mjs`、`llm-env.mjs` 同构）：
 * - 不读 env、不读文件、不 spawn、不绑定端口：调用方传值，本模块只回答"该说什么/该不该停"。
 * - 返回 `{ action: 'ok' | 'warn' | 'refuse', message }`；调用方负责打印与退出码。
 * - 消息必须同时给出「冲突双方取值」与「至少一条可执行修法」——只说"参数冲突"等于没说。
 *
 * 三条判定（BL-267 来源：PLAN-0660 M4 第一跑三错叠加作废）：
 * 1. `--batch=<name>` 与显式 spec 路径是**并集**（不是覆盖），会静默多跑整批 ⇒ 警告。
 * 2. `--llm-mode`（或 `XIHE_E2E_LLM_MODE`）与批声明的 `llmMode` 不一致 ⇒ **拒绝启动**。
 * 3. `--retries`（Playwright 每用例重试）与 `XIHE_E2E_RETRY_ROUNDS`（整轮重跑）语义并列 ⇒ 警告。
 */

/**
 * `--help` 里两行重试语义：分开定义，并写明叠加关系。
 * `e2e-host.mjs` 直接插值这两行（测试断言两行都在，防止再退回单行含糊描述）。
 */
export const RETRY_HELP_LINES = Object.freeze([
  '--retries=<n>              Playwright 每个用例失败后的重试次数（透传给 Playwright；默认取 e2e/playwright.config.ts 的 1）',
  'XIHE_E2E_RETRY_ROUNDS=<n>  整轮重跑次数（含首轮，默认 2，最大 5；轮间重置 DB 状态）；与 --retries 可叠加：总尝试 = 轮数 × (1 + retries)',
]);

/** 规整路径分隔符，供 `--only` 匹配使用。 */
function normalizeSpecPath(value) {
  return String(value).replaceAll('\\', '/').replace(/\/+$/, '');
}

function specBasename(spec) {
  const normalized = normalizeSpecPath(spec);
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

/**
 * 坑 2：显式 llm-mode 与批声明不一致 ⇒ refuse（逃生阀存在时降级为 warn）。
 *
 * 显式来源有两处：`--llm-mode=` 与 `XIHE_E2E_LLM_MODE`。**两者都拒绝**：wrapper 注入 env 绕过去
 * 等于闸门不存在（Lead 2026-11-05 裁定）。arg 优先展示来源，env 次之。
 */
export function decideLlmMode({ batchName, batchLlmMode, argMode, envMode, allowOverride = false }) {
  const explicit = argMode
    ? { source: '--llm-mode', value: argMode }
    : envMode
      ? { source: 'XIHE_E2E_LLM_MODE', value: envMode }
      : null;
  if (!batchName || !batchLlmMode || !explicit) return { action: 'ok', mode: batchLlmMode ?? explicit?.value };
  if (explicit.value === batchLlmMode) return { action: 'ok', mode: explicit.value };

  const detail =
    `llm-mode 冲突：--batch=${batchName} 声明的车道是 llmMode=${batchLlmMode}，` +
    `但显式指定了 ${explicit.source}=${explicit.value}。\n` +
    '           二者会得到不同的 spec gate 通过集合，"批通过"将不代表该车道通过。\n' +
    '           修法：去掉 --llm-mode / 清掉 XIHE_E2E_LLM_MODE，或改用与声明一致的 --batch；' +
    '确实要跨车道调试时加 --allow-llm-mode-override。';
  if (allowOverride) {
    return { action: 'warn', mode: explicit.value, message: `${detail}\n           （已按 --allow-llm-mode-override 继续）` };
  }
  return { action: 'refuse', mode: explicit.value, message: detail };
}

/**
 * 坑 1：`--batch` 展开的 specs 与位置参数是**并集**。位置参数不会收窄批次，只是追加。
 * 只警告，不阻断：DEV-017 §6 已把"批 + 单 spec"写进复用道配方（Lead 2026-11-05 裁定）。
 */
export function warnBatchPlusSpecs({ batchName, batchSpecs = [], positionalSpecs = [] }) {
  if (!batchName || positionalSpecs.length === 0) return { action: 'ok' };
  const alreadyInBatch = positionalSpecs.filter((spec) => batchSpecs.includes(spec));
  const added = positionalSpecs.filter((spec) => !batchSpecs.includes(spec));
  const appended = added.length > 0
    ? `位置参数里的 ${added.length} 个 spec 只是追加，不会收窄。`
    : `位置参数里的 ${positionalSpecs.length} 个 spec 已在批内，本次仍按整批运行。`;
  return {
    action: 'warn',
    message:
      `--batch=${batchName} 含 ${batchSpecs.length} 个 spec（展开后全部运行），${appended}\n` +
      '           只想跑其中一个：省略 --batch，或 --only=<完整路径|basename|唯一子串>，或 --grep=<用例名>。',
  };
}

/**
 * 坑 3：`--retries`（Playwright 每用例重试）与 `XIHE_E2E_RETRY_ROUNDS`（整轮重跑）同时生效。
 *
 * 只在 **env 被显式设置且 > 1** 时警告：`XIHE_E2E_RETRY_ROUNDS` 的默认值就是 2，
 * 若把默认值也算进来，仓库里最常见的 `--batch=mock-full --retries=0` 会天天报噪（兼容性不许）。
 */
export function decideRetrySemantics({ retriesArg, retryRoundsEnv }) {
  if (retriesArg === undefined || retriesArg === null || retryRoundsEnv === undefined || retryRoundsEnv === null) {
    return { action: 'ok' };
  }
  const retries = Number.parseInt(String(retriesArg).trim(), 10);
  const rounds = Number.parseInt(String(retryRoundsEnv).trim(), 10);
  if (!Number.isFinite(retries) || !Number.isFinite(rounds) || rounds <= 1) return { action: 'ok' };
  return {
    action: 'warn',
    message:
      `两处都会生效：本轮最多跑 ${rounds} 轮 × 每轮每用例最多 ${1 + Math.max(retries, 0)} 次尝试` +
      ` = 最多 ${rounds * (1 + Math.max(retries, 0))} 次尝试/用例。\n` +
      '           取证时建议 --retries=0 且 XIHE_E2E_RETRY_ROUNDS=1，避免"重试后通过"掩盖真故障。',
  };
}

/**
 * `--only`：把批展开的 specs 收窄到指定目标。
 *
 * 匹配语义（Lead 2026-11-05 收敛要求，**不许静默取全部**）：
 * 1. 先按**精确匹配**：完整相对路径相等、basename 完全相等、或路径后缀（`e2e/real/x.spec.ts`）。
 * 2. 无精确匹配时才按**子串**；子串命中 > 1 ⇒ refuse 并列出候选（否则就是"坑 1"换皮）。
 * 3. 零命中 ⇒ refuse 并列出该批可用 specs。
 *
 * 多个 `--only` 取并集；每个模式独立解析（单个模式多命中即拒绝，不做"取第一个"的猜测）。
 */
export function resolveOnlyPatterns({ batchName, batchSpecs = [], onlyPatterns = [] }) {
  if (onlyPatterns.length === 0) return { action: 'ok', specs: [...batchSpecs] };
  if (!batchName) {
    return {
      action: 'refuse',
      message: '--only 需要配合 --batch=<name> 使用（它只用于收窄批次；显式 spec 请直接写在命令行）。',
    };
  }
  const selected = [];
  for (const rawPattern of onlyPatterns) {
    const pattern = normalizeSpecPath(rawPattern);
    if (!pattern) {
      return { action: 'refuse', message: '--only 的取值为空；请给出完整相对路径、basename 或唯一子串。' };
    }
    const exact = batchSpecs.filter((spec) => {
      const normalized = normalizeSpecPath(spec);
      return normalized === pattern || specBasename(spec) === pattern || normalized.endsWith(`/${pattern}`);
    });
    if (exact.length === 1) {
      selected.push(exact[0]);
      continue;
    }
    if (exact.length > 1) {
      return {
        action: 'refuse',
        message:
          `--only=${rawPattern} 精确命中 ${exact.length} 个 spec，拒绝猜：\n` +
          exact.map((spec) => `             - ${spec}`).join('\n') +
          '\n           改用完整相对路径（如 e2e/real/<file>.spec.ts）重试。',
      };
    }
    const partial = batchSpecs.filter((spec) => normalizeSpecPath(spec).includes(pattern));
    if (partial.length === 1) {
      selected.push(partial[0]);
      continue;
    }
    if (partial.length > 1) {
      return {
        action: 'refuse',
        message:
          `--only=${rawPattern} 子串命中 ${partial.length} 个 spec，拒绝静默全跑（那会重演 --batch 的坑）：\n` +
          partial.map((spec) => `             - ${spec}`).join('\n') +
          '\n           改用更长的子串或完整相对路径。',
      };
    }
    return {
      action: 'refuse',
      message:
        `--only=${rawPattern} 在批 ${batchName} 里零命中。可用 specs：\n` +
        batchSpecs.map((spec) => `             - ${spec}`).join('\n'),
    };
  }
  const unique = [...new Set(selected)];
  if (unique.length === 0) {
    return {
      action: 'refuse',
      message:
        `--only 过滤后为空（批 ${batchName} 的 specs 未被选中）：\n` +
        batchSpecs.map((spec) => `             - ${spec}`).join('\n'),
    };
  }
  return { action: 'ok', specs: unique };
}

/**
 * `--check-cli` 的汇总行：只回答"将要跑什么"，不派生端口、不建目录、不启进程。
 */
export function formatCheckCliSummary({ batchName, llmMode, specs = [], positionalSpecs = [] }) {
  const lines = [
    `batch=${batchName || '(none)'} llmMode=${llmMode ?? '(default)'} batchSpecs=${specs.length} positionalSpecs=${positionalSpecs.length}`,
  ];
  for (const spec of specs) lines.push(`  - ${spec}`);
  for (const spec of positionalSpecs) lines.push(`  + ${spec}`);
  return lines.join('\n');
}
