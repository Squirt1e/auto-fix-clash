import { EXIT_ENVIRONMENT, EXIT_NO_USABLE_NODE, EXIT_OK, EXIT_USAGE } from '../../exit-codes.ts';
import { UsageError } from '../../errors.ts';
import { policyForDomain, repairDomains, type DomainRepairIssue } from '../../heal/domain-repair.ts';
import { GroupNotSwitchableError, repairTarget, type RepairOutcome } from '../../heal/repair.ts';
import { parseDomainPattern, type DomainTargetConfig } from '../../targets/domain.ts';
import type { ResolvedBinding } from '../../routes/resolver.ts';
import { loadRuntimeRuleMetadata } from '../../routes/runtime-rules.ts';
import { interactive } from '../format.ts';
import { isQuiet, openRuntime, planTargets } from '../runtime.ts';
import { optBoolean, type CommandContext } from '../context.ts';

export type FixRequest =
  | { mode: 'domain'; targets: DomainTargetConfig[]; force: boolean; scheduled: boolean }
  | { mode: 'legacy'; force: boolean };

export function resolveFixRequest(
  context: CommandContext,
  configuredDomains: DomainTargetConfig[],
): FixRequest {
  if (context.positionals.length > 1) throw new UsageError('afc fix 一次只接受一个域名范围。');
  const positional = context.positionals[0];
  const scheduled = optBoolean(context.values, 'scheduled');
  const force = optBoolean(context.values, 'force');
  const legacy = typeof context.values['group'] === 'string' ||
    optBoolean(context.values, 'all') || optBoolean(context.values, 'no-auto');

  if (positional && legacy) throw new UsageError('域名位置参数不能与 --group/--all/--no-auto 同时使用。');
  if (scheduled && positional) throw new UsageError('计划任务模式从配置读取域名，不能再提供位置参数。');
  if (scheduled && legacy) throw new UsageError('计划任务域名模式不能与旧的组选项同时使用。');
  if (scheduled && force) throw new UsageError('计划任务不会使用 --force；强制换点只能手动执行。');
  if (legacy) return { mode: 'legacy', force };

  const targets = positional
    ? [{ pattern: parseDomainPattern(positional).input, extraProbes: [], countryAllow: [], countryDeny: [] }]
    : configuredDomains;
  return { mode: 'domain', targets, force, scheduled };
}

export function formatRouteBinding(binding: ResolvedBinding, targets: DomainTargetConfig[]): string {
  const lines = [`${binding.pattern} → ${binding.group}`];
  for (const evidence of binding.evidence) {
    const target = targets.find((candidate) =>
      parseDomainPattern(candidate.pattern).input === evidence.pattern);
    const policy = target ? policyForDomain(target, evidence.witness) : undefined;
    const confidence = policy?.confidence === 'service' ? '功能已验证' : '只能证明 HTTPS 可达';
    lines.push(
      `  ${evidence.witness}：规则 #${evidence.rule.index + 1} ` +
      `${evidence.rule.type}${evidence.rule.payload ? `,${evidence.rule.payload}` : ''} → ` +
      `${evidence.policy}（${confidence}）`,
    );
  }
  return lines.join('\n') + '\n';
}

function timestamp(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

export function formatRouteIssue(
  issue: DomainRepairIssue,
  options: { quiet: boolean; verbose: boolean; now?: Date },
): string {
  const subject = issue.group ?? issue.witness ?? issue.pattern ?? '目标';
  const apiIndex = options.verbose && issue.ruleIndex !== undefined
    ? ` (API index ${issue.ruleIndex})`
    : '';
  return options.quiet
    ? `${timestamp(options.now)} ${subject}：${issue.reason}${apiIndex}\n`
    : `  ${subject}：${issue.reason}${apiIndex}\n`;
}

export function summarize(outcome: RepairOutcome, dryRun: boolean): string {
  const { plan } = outcome;
  switch (plan.action) {
    case 'keep':
      return `${outcome.group}：保持 ${plan.to ?? '当前节点'}（可用）`;
    case 'switch': {
      // 原来是"委托给其它组"的状态时点一句：这次会把该组钉到具体节点上
      const wasDelegate = outcome.currentProbe === undefined && plan.from !== undefined;
      const note = wasDelegate ? '（该组原本委托给其它组，现已改为固定节点）' : '';
      return `${outcome.group}：${dryRun ? '将切换' : '已切换'} ${plan.from ?? '（无）'} → ${plan.to}${note}`;
    }
    case 'no-candidate':
      return `${outcome.group}：没有其它可用节点，未做改动`;
    case 'stale':
      return `${outcome.group}：选择已变化为 ${plan.to ?? '（无）'}，未覆盖用户操作`;
  }
}

async function runLegacy(context: CommandContext): Promise<number> {
  const quiet = isQuiet(context);
  const verbose = optBoolean(context.values, 'verbose');
  const dryRun = optBoolean(context.values, 'dry-run');
  const runtime = await openRuntime(context);
  const client = runtime.controller.client;

  const { plans, skipped: skippedPlans } = await planTargets(runtime, context, client);
  if (plans.length === 0) {
    process.stderr.write(
      skippedPlans.length > 0
        ? `没有可处理的组：\n${skippedPlans.map((s) => `  ${s.groupName}：${s.reason}`).join('\n')}\n`
        : '没有可处理的组。用 afc groups 查看当前订阅的代理组。\n',
    );
    return EXIT_USAGE;
  }

  const outcomes: RepairOutcome[] = [];
  const failures: { group: string; error: Error }[] = [];

  for (const plan of plans) {
    try {
      const outcome = await repairTarget({
        config: runtime.config,
        target: plan.target,
        client,
        ...(runtime.config.probe.runtimeConfigPath
          ? { runtimeConfigPath: runtime.config.probe.runtimeConfigPath }
          : {}),
        dryRun,
        force: optBoolean(context.values, 'force'),
        // 过程提示只在终端里显示（管道/日志下不产生噪音）
        onNotice: (message) => {
          if (!quiet && interactive()) process.stderr.write(`  ${message}\n`);
        },
      });
      outcomes.push(outcome);
      const summary = summarize(outcome, dryRun);
      if (quiet) {
        // 计划任务的日志：带时间戳的一行摘要
        process.stdout.write(`${timestamp()} ${summary}\n`);
      } else {
        process.stdout.write(summary + '\n');
        // 详细依据只在 --verbose 时展开
        if (verbose) {
          process.stdout.write(`  判据：${plan.note}\n`);
          process.stdout.write(`  依据：${outcome.plan.reason}\n`);
        }
      }
    } catch (err) {
      const error = err as Error;
      failures.push({ group: plan.groupName, error });
      if (error instanceof GroupNotSwitchableError) {
        if (quiet) process.stdout.write(`${timestamp()} ${plan.groupName}: 跳过（组类型不可切换）\n`);
        else process.stdout.write(`${plan.groupName}：跳过（组类型不可切换）\n`);
        if (verbose) process.stderr.write(`${error.message}\n`);
      } else if (quiet) {
        // 精简模式只把一行摘要写到 stdout（计划任务的日志），
        // 完整错误写到 stderr，保留事后排查所需的细节。
        process.stdout.write(`${timestamp()} ${plan.groupName}: 执行失败 — ${error.message.split('\n')[0]}\n`);
        process.stderr.write(`${timestamp()} ${plan.groupName} 执行失败：\n${error.stack ?? error.message}\n`);
      } else {
        process.stderr.write(`${plan.groupName}：执行失败 — ${error.message}\n`);
      }
    }
  }

  // 哪些组没被纳入：默认只说个数量，避免刷屏
  if (skippedPlans.length > 0 && !quiet) {
    if (verbose) {
      process.stdout.write(`\n未处理的组：\n${skippedPlans.map((s) => `  ${s.groupName}：${s.reason}`).join('\n')}\n`);
    } else {
      process.stdout.write(`\n另有 ${skippedPlans.length} 个组未纳入（--verbose 查看原因）。\n`);
    }
  }

  if (outcomes.length === 0) {
    return failures.length > 0 && failures.every((f) => f.error instanceof UsageError)
      ? EXIT_USAGE
      : EXIT_ENVIRONMENT;
  }

  const noCandidate = outcomes.filter((o) => o.plan.action === 'no-candidate').length;
  if (noCandidate > 0 && noCandidate === outcomes.length) return EXIT_NO_USABLE_NODE;
  return EXIT_OK;
}

export async function run(context: CommandContext): Promise<number> {
  // 先做纯参数校验，错误组合不能为了报用法错误而触发控制器发现。
  const shape = resolveFixRequest(context, []);
  if (shape.mode === 'legacy') return await runLegacy(context);

  const quiet = isQuiet(context);
  const verbose = optBoolean(context.values, 'verbose');
  const dryRun = optBoolean(context.values, 'dry-run');
  const runtime = await openRuntime(context);
  const request = resolveFixRequest(context, runtime.config.domains);
  if (request.mode !== 'domain') return await runLegacy(context);

  if (request.targets.length === 0) {
    if (!quiet) process.stdout.write('没有登记要修复的域名。用 afc schedule add <域名> 添加。\n');
    return EXIT_OK;
  }

  const runtimeRules = loadRuntimeRuleMetadata(runtime.config.probe.runtimeConfigPath);
  const report = await repairDomains({
    config: runtime.config,
    targets: request.targets,
    client: runtime.controller.client,
    force: request.force,
    dryRun,
    ...(runtimeRules ? { runtimeRules: runtimeRules.rules } : {}),
    onNotice: (message) => {
      if (!quiet && interactive()) process.stderr.write(`  ${message}\n`);
    },
  });

  if (!quiet) {
    for (const binding of report.bindings) {
      process.stdout.write(formatRouteBinding(binding, request.targets));
    }
  }

  for (const outcome of report.outcomes) {
    const line = summarize(outcome, dryRun);
    process.stdout.write(quiet ? `${timestamp()} ${line}\n` : `${line}\n`);
    if (verbose && !quiet) process.stdout.write(`  依据：${outcome.plan.reason}\n`);
  }
  if (report.issues.length > 0) {
    const sections = [
      { heading: '已跳过的路由', issues: report.issues.filter((issue) => issue.kind === 'policy-skipped') },
      { heading: '无法完整解析的路由', issues: report.issues.filter((issue) => issue.kind !== 'policy-skipped') },
    ];
    for (const section of sections) {
      if (section.issues.length === 0) continue;
      if (!quiet) process.stderr.write(`${section.heading}：\n`);
      for (const issue of section.issues) {
        process.stderr.write(formatRouteIssue(issue, { quiet, verbose }));
      }
    }
  }
  return report.exitCode;
}
