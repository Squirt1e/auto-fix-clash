import { isGroup, isRealNode } from '../../controller/client.ts';
import { findGroupName } from '../../config.ts';
import { TargetGroupMissingError } from '../../heal/repair.ts';
import { EXIT_ENVIRONMENT, EXIT_NO_USABLE_NODE, EXIT_OK } from '../../exit-codes.ts';
import { describeEndpoints, ProbeEngine, type NodeProbeResult } from '../../probe/engine.ts';
import { loadNodeDefinitions } from '../../heal/repair.ts';
import { pad, formatMs } from '../format.ts';
import { isQuiet, openRuntime, targetsFor } from '../runtime.ts';
import { optBoolean, type CommandContext } from '../context.ts';

const VERDICT_LABEL: Record<NodeProbeResult['verdict'], string> = {
  ok: '可用',
  blocked: '被拒绝',
  dead: '死节点',
  'country-policy': '国家受限',
};

const VERDICT_ORDER: Record<NodeProbeResult['verdict'], number> = {
  ok: 0,
  'country-policy': 1,
  blocked: 2,
  dead: 3,
};

/** 表格用的短依据：去掉冗长的原始错误细节，保留结论。 */
function compactReason(result: NodeProbeResult): string {
  switch (result.verdict) {
    case 'ok':
      return `通过 ${result.statusCode}`;
    case 'blocked':
      return `目标站点拒绝该出口（HTTP ${result.statusCode}）`;
    case 'country-policy':
      return `出口国家不符合策略`;
    case 'dead': {
      const attempts = /重试 (\d+) 次/.exec(result.reason);
      const cause = /（([^）]*)）/.exec(result.reason)?.[1] ?? '';
      const short = cause.split('；')[0]?.split('：')[0]?.trim() ?? '';
      return `无 HTTP 响应${attempts ? `（重试 ${attempts[1]} 次）` : ''}${short ? `：${short}` : ''}`;
    }
  }
}

export async function run(context: CommandContext): Promise<number> {
  const quiet = isQuiet(context);
  const json = optBoolean(context.values, 'json');
  const runtime = await openRuntime(context);
  const targets = targetsFor(runtime, context);
  const client = runtime.controller.client;

  const allProxies = await client.proxies();

  const report: unknown[] = [];
  let anyUsable = false;
  let anyProbed = false;

  const availableGroups = Object.entries(allProxies)
    .filter(([, info]) => isGroup(info))
    .map(([name]) => name);

  // 先把每个目标解析成具体组，并收集所有需要节点定义的成员名 ——
  // 再据此挑选「当前生效」的节点定义文件（多订阅/多客户端下这一步很关键）。
  interface PlannedTarget { target: (typeof targets)[number]; groupName: string; groupCandidates: string[] }
  const planned: PlannedTarget[] = [];
  for (const target of targets) {
    const groupName = findGroupName(target, availableGroups);
    if (!groupName) {
      // 多订阅切换后组名对不上是正常情况：多目标时跳过，单目标时直接报错并给指引
      if (targets.length > 1) {
        process.stderr.write(`${target.name}: 跳过（当前订阅没有这个组）\n`);
        report.push({ group: target.name, missing: true, verdicts: [] });
        continue;
      }
      throw new TargetGroupMissingError(target, availableGroups);
    }
    const groupInfo = allProxies[groupName]!;
    planned.push({
      target,
      groupName,
      groupCandidates: (groupInfo.all ?? []).filter((name) => isRealNode(allProxies[name])),
    });
  }

  const needed = [...new Set(planned.flatMap((p) => p.groupCandidates))];
  const definitions = loadNodeDefinitions({
    ...(runtime.config.probe.runtimeConfigPath ? { runtimeConfigPath: runtime.config.probe.runtimeConfigPath } : {}),
    neededNodeNames: needed,
  });

  for (const { target, groupName, groupCandidates: groupInfoCandidates } of planned) {
    const groupInfo = allProxies[groupName]!;
    const candidates = groupInfoCandidates.filter((name) => definitions.nodeNames.includes(name));

    if (candidates.length === 0) {
      if (!quiet && !json) process.stdout.write(`代理组 ${groupName}：没有可探测的真实节点。\n`);
      report.push({ group: groupName, current: groupInfo.now, verdicts: [], candidatesConsidered: 0 });
      continue;
    }

    const current = groupInfo.now;
    const engine = await ProbeEngine.create({
      config: runtime.config,
      proxies: definitions.proxies,
      nodeNames: candidates,
    });

    let results: NodeProbeResult[];
    try {
      // --json 时必须让 stdout 保持纯 JSON：人类可读的表头一律不发到 stdout
      if (!quiet && !json) {
        process.stdout.write(
          `\n代理组 ${groupName}（当前：${current ?? '（无）'}）\n` +
          `判据：${describeEndpoints(target)}\n` +
          `候选：${candidates.length} 个，探测并发上限 ${runtime.config.probe.concurrency}\n\n`,
        );
      }
      results = await engine.probeAll(candidates, target, (result, index) => {
        if (quiet) return;
        const label = VERDICT_LABEL[result.verdict];
        process.stderr.write(`  [${index + 1}/${candidates.length}] ${label} ${result.node} — ${result.reason}\n`);
      });
    } finally {
      await engine.close();
    }

    anyProbed = true;
    const usable = results.filter((r) => r.verdict === 'ok');
    if (usable.length > 0) anyUsable = true;

    const ordered = [...results].sort((a, b) => {
      const byVerdict = VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict];
      if (byVerdict !== 0) return byVerdict;
      return (a.ttfbMs ?? Number.POSITIVE_INFINITY) - (b.ttfbMs ?? Number.POSITIVE_INFINITY);
    });

    const counts = results.reduce<Record<string, number>>((acc, r) => {
      acc[r.verdict] = (acc[r.verdict] ?? 0) + 1;
      return acc;
    }, {});

    report.push({
      group: groupName,
      current,
      currentUsable: results.find((r) => r.node === current)?.verdict === 'ok',
      summary: counts,
      verdicts: ordered,
    });

    // 体检不得改变当前选择
    const after = await client.proxy(groupName);
    if (after.now !== current) {
      process.stderr.write(
        `警告：体检后发现 ${groupName} 的当前选择从 ${current ?? '（无）'} 变成 ${after.now ?? '（无）'}，` +
        '请检查是否有其它程序在同时切换该组。\n',
      );
    }

    if (json) continue;

    process.stdout.write(
      pad('节点', 30) + pad('判定', 10) + pad('状态码', 8) + pad('出口', 6) + pad('耗时', 9) + '依据\n',
    );
    process.stdout.write('-'.repeat(100) + '\n');
    for (const r of ordered) {
      const marker = r.node === current ? '* ' : '  ';
      // 表格里只放一句短依据；完整原因在 --json 输出里
      const reason = compactReason(r);
      process.stdout.write(
        marker + pad(r.node, 28) +
        pad(VERDICT_LABEL[r.verdict], 10) +
        pad(r.statusCode === undefined ? '—' : String(r.statusCode), 8) +
        pad(r.country ?? '—', 6) +
        pad(formatMs(r.ttfbMs), 9) +
        reason + '\n',
      );
    }
    process.stdout.write(
      `\n汇总：可用 ${counts['ok'] ?? 0} / 国家受限 ${counts['country-policy'] ?? 0} / ` +
      `被拒绝 ${counts['blocked'] ?? 0} / 死节点 ${counts['dead'] ?? 0}（共 ${results.length}，* 为当前节点）\n`,
    );
  }

  if (json) {
    process.stdout.write(JSON.stringify({ controller: runtime.controller.endpoint, targets: report }, null, 2) + '\n');
  }

  if (!anyProbed) return EXIT_ENVIRONMENT;
  return anyUsable ? EXIT_OK : EXIT_NO_USABLE_NODE;
}
