import { EXIT_ENVIRONMENT, EXIT_NO_USABLE_NODE, EXIT_OK, EXIT_USAGE } from '../../exit-codes.ts';
import { UsageError } from '../../errors.ts';
import { GroupNotSwitchableError, repairTarget, type RepairOutcome } from '../../heal/repair.ts';
import { interactive } from '../format.ts';
import { isQuiet, openRuntime, planTargets } from '../runtime.ts';
import { optBoolean, type CommandContext } from '../context.ts';

function timestamp(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function summarize(outcome: RepairOutcome, dryRun: boolean): string {
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
      return `${outcome.group}：没有可用节点，未做改动`;
  }
}

export async function run(context: CommandContext): Promise<number> {
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
