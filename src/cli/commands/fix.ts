import { EXIT_ENVIRONMENT, EXIT_NO_USABLE_NODE, EXIT_OK, EXIT_USAGE } from '../../exit-codes.ts';
import { UsageError } from '../../errors.ts';
import { GroupNotSwitchableError, TargetGroupMissingError, repairTarget, type RepairOutcome } from '../../heal/repair.ts';
import { isQuiet, openRuntime, targetsFor } from '../runtime.ts';
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
      return `${outcome.group}: 保持 ${plan.to ?? '当前节点'}（可用，未做改动）`;
    case 'switch':
      return `${outcome.group}: ${dryRun ? '将切换' : '已切换'} ${plan.from ?? '（无）'} → ${plan.to}`;
    case 'no-candidate':
      return `${outcome.group}: 无可用节点，未做改动（探测了 ${outcome.probedNodes} 个节点）`;
  }
}

export async function run(context: CommandContext): Promise<number> {
  const quiet = isQuiet(context);
  const dryRun = optBoolean(context.values, 'dry-run');
  const runtime = await openRuntime(context);
  const targets = targetsFor(runtime, context);
  const client = runtime.controller.client;

  const outcomes: RepairOutcome[] = [];
  const failures: { group: string; error: Error }[] = [];
  const skipped: { group: string; error: Error }[] = [];

  for (const target of targets) {
    try {
      const outcome = await repairTarget({
        config: runtime.config,
        target,
        client,
        ...(runtime.config.probe.runtimeConfigPath
          ? { runtimeConfigPath: runtime.config.probe.runtimeConfigPath }
          : {}),
        dryRun,
        onNotice: (message) => {
          if (!quiet) process.stderr.write(`  ${message}\n`);
        },
      });
      outcomes.push(outcome);
      const line = `${timestamp()} ${summarize(outcome, dryRun)}`;
      if (quiet) {
        process.stdout.write(line + '\n');
      } else {
        process.stdout.write(`\n${line}\n`);
        process.stdout.write(`  依据：${outcome.plan.reason}\n`);
        if (outcome.plan.action === 'switch' && !dryRun) {
          process.stdout.write('  已通过控制端点更新该组选择；未修改任何配置文件。\n');
        }
      }
    } catch (err) {
      const error = err as Error;
      // 组不存在于当前订阅：多订阅场景下的正常情况，跳过而不是整体失败
      if (error instanceof TargetGroupMissingError) {
        skipped.push({ group: target.name, error });
        process.stdout.write(
          `${timestamp()} ${target.name}: 跳过（当前订阅没有这个组）` +
          (quiet ? '\n' : `\n  ${error.message.split('\n')[1] ?? ''}\n`),
        );
        continue;
      }
      failures.push({ group: target.name, error });
      if (error instanceof GroupNotSwitchableError) {
        if (quiet) process.stdout.write(`${timestamp()} ${target.name}: 跳过（组类型不可切换）\n`);
        else process.stderr.write(`\n${target.name}: ${error.message}\n`);
      } else if (quiet) {
        // 精简模式只把一行摘要写到 stdout（计划任务的日志），
        // 完整错误写到 stderr，保留事后排查所需的细节。
        process.stdout.write(`${timestamp()} ${target.name}: 执行失败 — ${error.message.split('\n')[0]}\n`);
        process.stderr.write(`${timestamp()} ${target.name} 执行失败：\n${error.stack ?? error.message}\n`);
      } else {
        process.stderr.write(`\n${target.name}: 执行失败 — ${error.message}\n`);
      }
    }
  }

  // 一个组都没能处理：区分「用法/配置问题」与「环境故障」，便于脚本正确告警
  if (outcomes.length === 0) {
    // 全部目标都只是"当前订阅里没有" → 这是配置与订阅不匹配，属于用法问题
    if (skipped.length === targets.length && targets.length > 0) {
      const first = skipped[0]!.error;
      process.stderr.write(
        `\n当前订阅里没有任何已配置的目标组。\n${first.message}\n`,
      );
      return EXIT_USAGE;
    }
    return failures.length > 0 && failures.every((f) => f.error instanceof UsageError)
      ? EXIT_USAGE
      : EXIT_ENVIRONMENT;
  }

  const noCandidate = outcomes.filter((o) => o.plan.action === 'no-candidate').length;
  if (noCandidate > 0 && noCandidate === outcomes.length) return EXIT_NO_USABLE_NODE;
  return EXIT_OK;
}
